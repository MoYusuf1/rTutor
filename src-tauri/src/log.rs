//! A plain diagnostic log, one line per fact (like riptv's `--logs`): agents connecting, messages queued and
//! delivered, every tool call with its time, API turns, errors. It's always on, kept small, and lives at
//! <data dir>/rlearn.log so a person, or an agent, can read why a lesson stalled. The app shows it live.
//! Lesson content is never written here: only what happened, not what was said.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;

const MAX: u64 = 2 * 1024 * 1024; // past this the log starts over (the previous one is kept as rlearn.log.old)

static FILE: OnceLock<PathBuf> = OnceLock::new();
static PAGE: Mutex<Option<Channel<String>>> = Mutex::new(None);

pub fn path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("rlearn.log")
}

/// Where lines go; set once at startup (the app) or on first use (`rlearn --mcp`).
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
    if let Some(path) = FILE.get() {
        if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX) {
            let _ = std::fs::rename(path, path.with_extension("log.old"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
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
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<String> = text.lines().rev().take(400).map(str::to_owned).collect();
    (path.display().to_string(), lines.into_iter().rev().collect())
}

/// Something the page noticed (a failed call, a stalled agent).
#[tauri::command]
pub fn log_note(line: String) {
    note(format!("app   {line}"));
}
