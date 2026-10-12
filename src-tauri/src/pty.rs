//! The terminal panel: real shells in pseudo-terminals, one per tab. Coding agents run in them and power the app.
//! The page keeps one xterm.js instance per tab, so scrollback survives hiding the panel.

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Manager};

#[derive(Default)]
pub struct Term(Mutex<HashMap<u32, Session>>);

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn ChildKiller + Send + Sync>,
    id: u64,
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

/// Starts a shell for tab `tab` in `cwd` if it isn't running yet; its output streams to `out`.
/// `run` is typed into the new shell, e.g. the agent rTutor starts on launch.
#[tauri::command]
pub fn term_open(app: AppHandle, tab: u32, cwd: String, run: Option<String>, cols: u16, rows: u16, out: Channel<String>) -> Result<(), String> {
    let term = app.state::<Term>();
    let mut slot = term.0.lock().map_err(err)?;
    if slot.contains_key(&tab) {
        return Ok(());
    }
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(err)?;
    #[cfg(windows)]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    #[cfg(not(windows))]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if !cwd.is_empty() {
        let _ = std::fs::create_dir_all(&cwd); // e.g. ~/rtutor on first use
    }
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(cwd);
    } else if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave); // the shell holds the only copy, so its exit closes the pty
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let mut writer = pair.master.take_writer().map_err(err)?;
    if let Some(run) = run.filter(|r| !r.trim().is_empty()) {
        writer.write_all(format!("{run}\r").as_bytes()).map_err(err)?; // the shell reads it once it's up
    }

    static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    slot.insert(tab, Session { master: pair.master, writer, child: child.clone_killer(), id });
    drop(slot);
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            pending.extend_from_slice(&buf[..n]);
            let text = take_text(&mut pending);
            if !text.is_empty() {
                // Keep draining even if the window closes: ConPTY teardown can emit a final frame.
                let _ = out.send(text);
            }
        }
        let _ = out.send("\r\n\x1b[2m[shell exited; reopen the terminal to start a new one]\x1b[0m\r\n".into());
        finish_session(&handle, tab, id);
    });
    // On Windows, the read pipe stays open until the pseudoconsole is closed. Wait for the
    // shell independently, then close its session while the reader still drains final output.
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        finish_session(&handle, tab, id);
    });
    Ok(())
}

fn finish_session(app: &AppHandle, tab: u32, id: u64) {
    let term = app.state::<Term>();
    let session = term.0.lock().ok().and_then(|mut slot| {
        if slot.get(&tab).is_some_and(|s| s.id == id) { slot.remove(&tab) } else { None }
    });
    // Closing ConPTY can block while output drains; never hold the state lock during it.
    drop(session);
}

#[tauri::command]
pub fn term_write(app: AppHandle, tab: u32, data: String) -> Result<(), String> {
    let term = app.state::<Term>();
    let mut slot = term.0.lock().map_err(err)?;
    let s = slot.get_mut(&tab).ok_or("The terminal isn't running.")?;
    s.writer.write_all(data.as_bytes()).map_err(err)?;
    s.writer.flush().map_err(err)
}

#[tauri::command]
pub fn term_resize(app: AppHandle, tab: u32, cols: u16, rows: u16) -> Result<(), String> {
    let term = app.state::<Term>();
    let slot = term.0.lock().map_err(err)?;
    match slot.get(&tab) {
        Some(s) => s.master.resize(size(cols, rows)).map_err(err),
        None => Ok(()),
    }
}

/// Closing a tab ends its shell, and with it any agent running there.
#[tauri::command]
pub fn term_close(app: AppHandle, tab: u32) -> Result<(), String> {
    let session = app.state::<Term>().0.lock().map_err(err)?.remove(&tab);
    drop(session); // outside the lock: ConPTY teardown can block
    Ok(())
}

/// Which coding agents are installed, so the app can offer them by name. Looks on PATH and in the usual
/// per-user install folders (a desktop launcher's PATH often leaves those out).
#[tauri::command]
pub fn installed_agents() -> Vec<&'static str> {
    let home = std::path::PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default());
    let mut dirs: Vec<_> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for extra in [".local/bin", ".npm-global/bin", ".bun/bin", ".claude/local", ".cargo/bin", "AppData/Roaming/npm"] {
        dirs.push(home.join(extra));
    }
    dirs.extend(["/usr/local/bin", "/opt/homebrew/bin"].map(std::path::PathBuf::from));
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ""] } else { &[""] };
    ["claude", "codex"].into_iter().filter(|bin| dirs.iter().any(|d| exts.iter().any(|e| d.join(format!("{bin}{e}")).is_file()))).collect()
}

fn home() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default())
}

/// The models an agent offers and the effort levels each supports, read from the agent itself (never a
/// list baked into rTutor): Codex's model cache and config, Claude Code's own `--help`. `current` is the
/// model the agent uses when none is given.
#[tauri::command]
pub async fn agent_models(kind: String) -> serde_json::Value {
    use serde_json::{json, Value};
    tauri::async_runtime::spawn_blocking(move || match kind.as_str() {
        "codex" => {
            let dir = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home().join(".codex"));
            let cache: Value = std::fs::read_to_string(dir.join("models_cache.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let models: Vec<Value> = cache["models"].as_array().into_iter().flatten()
                .filter(|m| m["visibility"] == "list")
                .map(|m| json!({
                    "id": m["slug"], "name": m["display_name"], "about": m["description"], "default": m["default_reasoning_level"],
                    "levels": m["supported_reasoning_levels"].as_array().into_iter().flatten().map(|l| l["effort"].clone()).collect::<Vec<_>>(),
                }))
                .collect();
            let config = std::fs::read_to_string(dir.join("config.toml")).unwrap_or_default();
            let setting = |key: &str| config.lines().find_map(|l| l.trim().strip_prefix(key)?.trim_start().strip_prefix('=').map(|v| v.trim().trim_matches('"').to_owned()));
            json!({ "models": models, "current": setting("model"), "effort": setting("model_reasoning_effort") })
        }
        "claude" => {
            // `claude --help` lists the effort levels and the model aliases it accepts
            let help = std::process::Command::new(if cfg!(windows) { "claude.cmd" } else { "claude" }).arg("--help").output()
                .or_else(|_| std::process::Command::new(home().join(".local/bin/claude")).arg("--help").output())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            let (levels, mut aliases) = claude_options(&help);
            // the help text only gives examples; add every model family Claude Code has used or offered on this computer
            for family in claude_families(&home()) {
                if !aliases.contains(&family) {
                    aliases.push(family);
                }
            }
            let models: Vec<Value> = aliases.iter().map(|a| json!({ "id": a, "name": a[..1].to_uppercase() + &a[1..], "levels": levels, "default": "" })).collect();
            json!({ "models": models, "current": null, "effort": null, "levels": levels })
        }
        _ => json!({ "models": [] }),
    })
    .await
    .unwrap_or_default()
}

/// Model families ("haiku", "sonnet", ...) Claude Code has used here or offers this account, read from its own
/// files: usage stats, the extra models it lists, and the configured model. Each family name is an alias Claude
/// Code resolves to that family's newest model, so new versions need nothing from rTutor.
fn claude_families(home: &std::path::Path) -> Vec<String> {
    let read = |p: std::path::PathBuf| std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).unwrap_or_default();
    let stats = read(home.join(".claude/stats-cache.json"));
    let config = read(home.join(".claude.json"));
    let settings = read(home.join(".claude/settings.json"));
    let mut ids: Vec<String> = stats["modelUsage"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    ids.extend(config["additionalModelOptionsCache"].as_array().into_iter().flatten().filter_map(|m| m["value"].as_str().map(str::to_owned)));
    ids.extend(settings["model"].as_str().map(str::to_owned));
    let mut out = Vec::new();
    for id in ids {
        // claude-haiku-4-5-20251001 → haiku; a bare alias stays as it is
        let family = id.strip_prefix("claude-").unwrap_or(&id).split(['-', '[']).next().unwrap_or_default().to_lowercase();
        if !family.is_empty() && family.chars().all(|c| c.is_ascii_alphabetic()) && !out.contains(&family) {
            out.push(family);
        }
    }
    out
}

/// The effort levels and model aliases in `claude --help`.
fn claude_options(help: &str) -> (Vec<String>, Vec<String>) {
    let flat = help.split_whitespace().collect::<Vec<_>>().join(" ");
    let after = |flag: &str| flat.split(flag).nth(1).unwrap_or_default().split(" --").next().unwrap_or_default().to_owned();
    let levels = after("--effort <level>").split('(').nth(1).and_then(|s| s.split(')').next())
        .map(|s| s.split(',').map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect()).unwrap_or_default();
    let aliases = after("--model <model>").split('\'').skip(1).step_by(2).map(str::to_owned)
        .filter(|a| !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).collect();
    (levels, aliases)
}

/// Picks the folder a new terminal opens in.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().file().blocking_pick_folder()?.into_path().ok().map(|p| p.display().to_string())
}

/// What an agent needs to start rTutor's tool server (this executable), and where terminals open by default.
#[tauri::command]
pub fn mcp_command() -> Result<serde_json::Value, String> {
    let bin = std::env::current_exe().map_err(err)?.display().to_string();
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    Ok(serde_json::json!({ "bin": bin, "home": home }))
}

#[cfg(test)]
mod tests {
    use super::take_text;

    #[test]
    fn a_real_shell_runs_in_a_pty() {
        use portable_pty::{native_pty_system, CommandBuilder};
        use std::io::{Read, Write};
        use std::sync::{mpsc, Arc, Mutex};
        let pair = native_pty_system().openpty(super::size(80, 24)).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
        let reply = writer.clone();
        let (tx, rx) = mpsc::channel();
        // A real terminal (xterm in the app) answers ConPTY's inherited-cursor query.
        // Service output before spawning the shell, and continue through console teardown.
        let drain = std::thread::spawn(move || {
            let (mut out, mut buf) = (String::new(), [0u8; 4096]);
            let mut answered = false;
            let mut reported = false;
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
                if !answered && out.contains("\x1b[6n") {
                    reply.lock().unwrap().write_all(b"\x1b[1;1R").unwrap();
                    answered = true;
                }
                if !reported && out.contains("rtutor-42") {
                    let _ = tx.send(());
                    reported = true;
                }
            }
        });
        #[cfg(windows)]
        let shell = "cmd.exe";
        #[cfg(not(windows))]
        let shell = "sh";
        let mut child = pair.slave.spawn_command(CommandBuilder::new(shell)).unwrap();
        drop(pair.slave);
        #[cfg(windows)]
        writer.lock().unwrap().write_all(b"set /a rtutor_result=40+2\r\necho rtutor-%rtutor_result%\r\nexit\r\n").unwrap();
        #[cfg(not(windows))]
        writer.lock().unwrap().write_all(b"echo rtutor-$((40 + 2))\nexit\n").unwrap();
        let result = rx.recv_timeout(std::time::Duration::from_secs(20));
        let _ = child.kill();
        drop(writer);
        drop(pair.master);
        drain.join().unwrap();
        assert!(result.is_ok(), "The shell did not evaluate the command within 20 seconds: {result:?}");
    }

    #[test]
    fn claude_help_gives_its_effort_levels_and_models() {
        let help = "  --effort <level>    Effort level for the current session\n                      (low, medium, high, xhigh, max)\n  --environment <id>  x\n  --model <model>     Model for the current session. Provide\n   an alias for the latest model (e.g.\n   'fable', 'opus', or 'sonnet') or a\n   model's full name (e.g.\n   'claude-fable-5-1').\n  --name <n>";
        let (levels, models) = super::claude_options(help);
        assert_eq!(levels, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(models, ["fable", "opus", "sonnet"]);
        // families Claude Code has used here come from its own files
        let home = std::env::temp_dir().join(format!("rtutor-claude-home-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/stats-cache.json"), r#"{"modelUsage":{"claude-haiku-4-5-20251001":{},"claude-sonnet-5":{},"claude-3-opus":{}}}"#).unwrap();
        std::fs::write(home.join(".claude.json"), r#"{"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]"}]}"#).unwrap();
        assert_eq!(super::claude_families(&home), ["haiku", "sonnet", "fable"]);
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
