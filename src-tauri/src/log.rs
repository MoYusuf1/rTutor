//! A plain diagnostic log, one line per fact (like riptv's `--logs`): agents connecting, messages queued and
//! delivered, every tool call with its time, API turns, errors. It's always on, kept small, and lives at
//! <data dir>/rtutor.log so a person, or an agent, can read why a lesson stalled. The app shows it live.
//! Lesson content is never written here: only what happened, not what was said.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;

const MAX: u64 = 2 * 1024 * 1024; // past this the log starts over (the previous one is kept as rtutor.log.old)

static FILE: OnceLock<PathBuf> = OnceLock::new();
static PAGE: Mutex<Option<Channel<String>>> = Mutex::new(None);
// the open log and how much it holds, so a line costs one write (no open, no stat) until it's time to start over
static OUT: Mutex<Option<(std::fs::File, u64)>> = Mutex::new(None);

pub fn path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("rtutor.log")
}

/// Where lines go; set once at startup (the app) or on first use (`rtutor --mcp`).
pub fn init(data_dir: &std::path::Path) {
    let _ = FILE.set(path(data_dir));
}

fn stamp() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let day = (ms / 1000) % 86_400;
    format!("{:02}:{:02}:{:02}.{:03}Z", day / 3600, day / 60 % 60, day % 60, ms % 1000)
}

/// Appends one line to the log and shows it in the app's Log tab.
pub fn note(line: impl AsRef<str>) {
    let line = format!("{} {}", stamp(), line.as_ref());
    if let (Some(path), Ok(mut out)) = (FILE.get(), OUT.lock()) {
        if out.as_ref().is_some_and(|(_, size)| *size > MAX) {
            *out = None;
            let _ = std::fs::rename(path, path.with_extension("log.old"));
        }
        if out.is_none() {
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let size = f.metadata().map_or(0, |m| m.len());
                *out = Some((f, size));
            }
        }
        if let Some((f, size)) = out.as_mut() {
            if writeln!(f, "{line}").is_ok() {
                *size += line.len() as u64 + 1;
            }
        }
    }
    if let Some(page) = PAGE.lock().ok().and_then(|p| p.clone()) {
        let _ = page.send(line);
    }
}

/// The page's Log tab: the latest lines now, new ones as they happen.
#[tauri::command]
pub fn log_listen(on_line: Channel<String>) -> (String, Vec<String>) {
    if let Ok(mut page) = PAGE.lock() {
        *page = Some(on_line);
    }
    let path = FILE.get().cloned().unwrap_or_default();
    (path.display().to_string(), tail(&path, 400))
}

/// The last `n` lines of a file, reading only its end (the log can hold megabytes; the tab shows a few hundred).
fn tail(path: &std::path::Path, n: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return vec![] };
    let len = f.metadata().map_or(0, |m| m.len());
    let start = len.saturating_sub(64 * 1024); // 400 lines are well under 64 KB
    let mut buf = Vec::new();
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_to_end(&mut buf).is_err() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // the first line was cut in the middle
    }
    lines[lines.len().saturating_sub(n)..].iter().map(|l| (*l).to_owned()).collect()
}

/// Something the page noticed (a failed call, a stalled agent).
#[tauri::command]
pub fn log_note(line: String) {
    note(format!("app   {line}"));
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_tail_is_read_from_the_end() {
        let p = std::env::temp_dir().join(format!("rtutor-tail-{}.log", std::process::id()));
        let lines: Vec<String> = (0..20_000).map(|i| format!("line {i}")).collect();
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let t = super::tail(&p, 3);
        assert_eq!(t, ["line 19997", "line 19998", "line 19999"]);
        assert_eq!(super::tail(&p, 400).len(), 400);
    }
}
