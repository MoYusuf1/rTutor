//! The terminal panel: one real shell in a pseudo-terminal, alive for as long as the app runs.
//! The page keeps a single xterm.js instance, so its scrollback survives hiding the panel.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Manager};

#[derive(Default)]
pub struct Term(Mutex<Option<Session>>);

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Takes the longest prefix of `pending` that is complete UTF-8, so a character split across two
/// reads is never mangled. Bytes that are actually invalid get replaced instead of stalling the stream.
fn take_text(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(_) => String::from_utf8(std::mem::take(pending)).unwrap_or_default(),
        Err(e) if e.error_len().is_none() => {
            let valid: Vec<u8> = pending.drain(..e.valid_up_to()).collect();
            String::from_utf8(valid).unwrap_or_default()
        }
        Err(_) => String::from_utf8_lossy(&std::mem::take(pending)).into_owned(),
    }
}

/// Starts the shell if it isn't running yet; its output streams to `out`.
#[tauri::command]
pub fn term_open(app: AppHandle, cols: u16, rows: u16, out: Channel<String>) -> Result<(), String> {
    let term = app.state::<Term>();
    let mut slot = term.0.lock().map_err(err)?;
    if slot.is_some() {
        return Ok(());
    }
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(err)?;
    let mut cmd = CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave); // the shell holds the only copy, so its exit closes the pty
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            pending.extend_from_slice(&buf[..n]);
            let text = take_text(&mut pending);
            if !text.is_empty() && out.send(text).is_err() {
                break;
            }
        }
        let _ = out.send("\r\n\x1b[2m[shell exited; reopen the terminal to start a new one]\x1b[0m\r\n".into());
        if let Ok(mut slot) = handle.state::<Term>().0.lock() {
            *slot = None;
        }
    });
    *slot = Some(Session { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
pub fn term_write(app: AppHandle, data: String) -> Result<(), String> {
    let term = app.state::<Term>();
    let mut slot = term.0.lock().map_err(err)?;
    let s = slot.as_mut().ok_or("The terminal isn't running.")?;
    s.writer.write_all(data.as_bytes()).map_err(err)?;
    s.writer.flush().map_err(err)
}

#[tauri::command]
pub fn term_resize(app: AppHandle, cols: u16, rows: u16) -> Result<(), String> {
    let term = app.state::<Term>();
    let slot = term.0.lock().map_err(err)?;
    match slot.as_ref() {
        Some(s) => s.master.resize(size(cols, rows)).map_err(err),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::take_text;

    #[test]
    fn a_real_shell_runs_in_a_pty() {
        use portable_pty::{native_pty_system, CommandBuilder};
        use std::io::{Read, Write};
        let pair = native_pty_system().openpty(super::size(80, 24)).unwrap();
        let mut child = pair.slave.spawn_command(CommandBuilder::new("sh")).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"echo rlearn-$((40 + 2))\nexit\n").unwrap();
        let (mut out, mut buf) = (String::new(), [0u8; 4096]);
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
            if out.contains("rlearn-42") { break; }
        }
        let _ = child.kill();
        assert!(out.contains("rlearn-42"), "{out}"); // the shell evaluated the command, not just echoed it
    }

    #[test]
    fn utf8_split_across_reads_is_held_back_not_mangled() {
        let bytes = "é✓".as_bytes(); // 2 + 3 bytes
        let mut pending = bytes[..3].to_vec(); // "é" plus the first byte of "✓"
        assert_eq!(take_text(&mut pending), "é");
        pending.extend_from_slice(&bytes[3..]);
        assert_eq!(take_text(&mut pending), "✓");
        let mut bad = vec![b'a', 0xff, b'b'];
        assert_eq!(take_text(&mut bad), "a\u{fffd}b");
    }
}
