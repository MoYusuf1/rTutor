mod cli;
mod db;
mod llm;

use db::{err, exec, Res};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_dialog::DialogExt;

const PROMPT: &str = include_str!("../prompts/teach.md");

struct Store {
    db: Mutex<Connection>,
    open: Mutex<Open>,
    http: reqwest::Client, // one pooled client: connections are reused across turns
}

/// The lesson currently being taught, kept in memory so each turn only appends.
#[derive(Default)]
struct Open {
    lesson: i64,
    messages: Arc<Vec<Value>>,
    system: Option<Arc<str>>,
}

impl Store {
    fn db(&self) -> Res<std::sync::MutexGuard<'_, Connection>> {
        self.db.lock().map_err(err)
    }
    /// Sources changed or a lesson was deleted: rebuild the prompt / history on next use.
    fn forget(&self, lesson: Option<i64>) {
        if let Ok(mut o) = self.open.lock() {
            o.system = None;
            if lesson.map_or(false, |l| l == o.lesson) {
                *o = Open::default();
            }
        }
    }
}

// ---------- API keys: in the OS keyring, never in the database ----------

fn key_entry(provider: &str) -> Res<keyring::Entry> {
    keyring::Entry::new("rlearn", provider).map_err(err)
}

fn read_key(provider: &str) -> Res<String> {
    match key_entry(provider)?.get_password() {
        Ok(k) => Ok(k),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("Couldn't read the API key from the system keyring: {e}")),
    }
}

#[tauri::command]
fn set_api_key(provider: String, key: String) -> Res<()> {
    let entry = key_entry(&provider)?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        };
    }
    entry.set_password(&key).map_err(err)
}

#[tauri::command]
fn has_api_key(provider: String) -> Res<bool> {
    Ok(!read_key(&provider)?.is_empty())
}

// ---------- teaching ----------

fn system_prompt(c: &Connection, lesson: i64) -> Res<String> {
    let sources = db::sources_for(c, lesson)?;
    if sources.is_empty() {
        return Ok(PROMPT.to_owned());
    }
    let mut s = String::from(PROMPT);
    s.push_str(
        "\n\n# The learner's material\n\nThe learner attached the material below. Internalize it before you start: it defines \
         what this lesson covers. Probe the learner against its content, build the plan from its ideas, and teach in its \
         terms. When you rely on a specific part, say where it comes from.\n",
    );
    for (name, body) in sources {
        s.push_str(&format!("\n<source name=\"{}\">\n{body}\n</source>\n", name.replace('"', "'")));
    }
    Ok(s)
}

/// One model turn. `content` is the learner's message or tool results; `None` resumes a paused turn.
#[tauri::command]
async fn send(
    store: State<'_, Store>,
    provider: llm::Provider,
    lesson: i64,
    content: Option<Value>,
    on_event: Channel<llm::Event>,
) -> Res<llm::Reply> {
    let key = read_key(&provider.id)?;
    let (messages, system) = {
        let c = store.db()?;
        let mut o = store.open.lock().map_err(err)?;
        if o.lesson != lesson {
            *o = Open { lesson, messages: Arc::new(db::messages(&c, lesson)?), system: None };
        }
        if let Some(content) = content {
            let msg = json!({ "role": "user", "content": content });
            db::append_message(&c, lesson, o.messages.len(), &msg)?;
            Arc::make_mut(&mut o.messages).push(msg);
        }
        if o.system.is_none() {
            o.system = Some(system_prompt(&c, lesson)?.into());
        }
        (o.messages.clone(), o.system.clone().unwrap_or_default()) // Arc clones: no copying
    };

    let mut reply = llm::chat(&store.http, &provider, &key, &system, &messages, &on_event).await?;
    drop(messages); // last other reference, so the push below appends in place
    if reply.stop_reason == "refusal" {
        reply.content.retain(|b| b["type"] != "tool_use"); // a refusal can cut a tool call off mid-input
    }
    let msg = json!({ "role": "assistant", "content": reply.content });
    let c = store.db()?;
    let mut o = store.open.lock().map_err(err)?;
    if o.lesson == lesson {
        db::append_message(&c, lesson, o.messages.len(), &msg)?;
        Arc::make_mut(&mut o.messages).push(msg);
    } else {
        db::append_message(&c, lesson, db::next_seq(&c, lesson)?, &msg)?; // learner switched lessons mid-turn
    }
    Ok(reply)
}

// ---------- lessons ----------

#[tauri::command]
fn tree(store: State<Store>) -> Res<Value> {
    db::tree(&*store.db()?)
}

#[tauri::command]
fn get_lesson(store: State<Store>, id: i64) -> Res<Value> {
    let c = store.db()?;
    let mut lesson = db::lesson(&c, id)?;
    let messages = Arc::new(db::messages(&c, id)?);
    lesson["messages"] = json!(*messages);
    *store.open.lock().map_err(err)? = Open { lesson: id, messages, system: None };
    Ok(lesson)
}

#[tauri::command]
fn create_lesson(store: State<Store>, folder: Option<i64>, title: String) -> Res<i64> {
    let c = store.db()?;
    exec(&c, "INSERT INTO lessons (folder_id, title, updated) VALUES (?1, ?2, ?3)", params![folder, title, db::now()])?;
    Ok(c.last_insert_rowid())
}

#[tauri::command]
fn add_section(store: State<Store>, lesson: i64, markdown: String) -> Res<()> {
    exec(&*store.db()?, "INSERT INTO sections (lesson_id, markdown) VALUES (?1, ?2)", params![lesson, markdown]).map(drop)
}

#[tauri::command]
fn rename_lesson(store: State<Store>, id: i64, title: String) -> Res<()> {
    exec(&*store.db()?, "UPDATE lessons SET title = ?2 WHERE id = ?1", params![id, title]).map(drop)
}

#[tauri::command]
fn bookmark_lesson(store: State<Store>, id: i64, on: bool) -> Res<()> {
    exec(&*store.db()?, "UPDATE lessons SET bookmarked = ?2 WHERE id = ?1", params![id, on]).map(drop)
}

#[tauri::command]
fn delete_lesson(store: State<Store>, id: i64) -> Res<()> {
    exec(&*store.db()?, "DELETE FROM lessons WHERE id = ?1", [id])?;
    store.forget(Some(id));
    Ok(())
}

#[tauri::command]
fn search(store: State<Store>, query: String) -> Res<Vec<Value>> {
    db::search(&*store.db()?, &query)
}

/// Saves the lesson as Markdown. The path comes from the native save dialog, never from the page.
#[tauri::command]
async fn export_lesson(app: tauri::AppHandle, id: i64) -> Res<bool> {
    let lesson = db::lesson(&*app.state::<Store>().db()?, id)?;
    let title = lesson["title"].as_str().unwrap_or("Lesson").to_owned();
    let body: Vec<&str> = lesson["sections"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let file: String = title.chars().map(|c| if r#"/\:*?"<>|"#.contains(c) { '-' } else { c }).collect();
    let Some(path) = app.dialog().file().set_file_name(format!("{file}.md")).add_filter("Markdown", &["md"]).blocking_save_file() else {
        return Ok(false);
    };
    std::fs::write(path.into_path().map_err(err)?, format!("# {title}\n\n{}\n", body.join("\n\n"))).map_err(err)?;
    Ok(true)
}

// ---------- folders ----------

#[tauri::command]
fn create_folder(store: State<Store>, parent: Option<i64>, name: String) -> Res<i64> {
    let c = store.db()?;
    exec(&c, "INSERT INTO folders (parent_id, name) VALUES (?1, ?2)", params![parent, name])?;
    Ok(c.last_insert_rowid())
}

#[tauri::command]
fn rename_folder(store: State<Store>, id: i64, name: String) -> Res<()> {
    exec(&*store.db()?, "UPDATE folders SET name = ?2 WHERE id = ?1", params![id, name]).map(drop)
}

#[tauri::command]
fn delete_folder(store: State<Store>, id: i64) -> Res<()> {
    exec(&*store.db()?, "DELETE FROM folders WHERE id = ?1", [id])?; // cascades to everything inside
    store.forget(None);
    *store.open.lock().map_err(err)? = Open::default();
    Ok(())
}

/// Drag and drop in the sidebar: put a lesson or folder into `folder` (None = top level).
#[tauri::command]
fn move_item(store: State<Store>, kind: String, id: i64, folder: Option<i64>) -> Res<()> {
    let c = store.db()?;
    match kind.as_str() {
        "lesson" => exec(&c, "UPDATE lessons SET folder_id = ?2 WHERE id = ?1", params![id, folder])?,
        "folder" => {
            if let Some(f) = folder {
                if db::is_within(&c, f, id)? {
                    return Err("A folder can't go inside itself.".into());
                }
            }
            exec(&c, "UPDATE folders SET parent_id = ?2 WHERE id = ?1", params![id, folder])?
        }
        _ => return Err("Only lessons and folders can be moved.".into()),
    };
    store.forget(None); // inherited material depends on where a lesson sits
    Ok(())
}

// ---------- sources: material the tutor teaches from ----------

/// Text from a file, as compact as it can be without losing content.
fn extract(path: &std::path::Path) -> Res<String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let raw = if ext == "pdf" {
        let p = path.to_owned();
        // the PDF parser can panic on malformed files; keep that from taking the app down
        std::panic::catch_unwind(move || pdf_extract::extract_text(&p))
            .map_err(|_| "This PDF couldn't be read.".to_owned())?
            .map_err(err)?
    } else {
        std::fs::read_to_string(path).map_err(|_| "Only text, Markdown, subtitle and PDF files can be added.".to_owned())?
    };
    let subtitles = matches!(ext.as_str(), "srt" | "vtt");
    let mut out = String::with_capacity(raw.len());
    let mut blank = 0;
    for line in raw.lines().map(str::trim_end) {
        // subtitle files: drop cue numbers, timestamps and the header, keep the words
        if subtitles && (line.contains("-->") || line == "WEBVTT" || line.trim().parse::<u32>().is_ok()) {
            continue;
        }
        blank = if line.trim().is_empty() { blank + 1 } else { 0 };
        if blank < 2 {
            out.push_str(line);
            out.push('\n');
        }
    }
    Ok(out.trim().to_owned())
}

/// Opens the file picker and returns the extracted text (stored by `add_source`).
#[tauri::command]
async fn pick_source(app: tauri::AppHandle) -> Res<Option<Value>> {
    let Some(file) = app.dialog().file().add_filter("Material", &["pdf", "txt", "md", "srt", "vtt"]).blocking_pick_file() else {
        return Ok(None);
    };
    let path = file.into_path().map_err(err)?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let text = tauri::async_runtime::spawn_blocking(move || extract(&path)).await.map_err(err)??;
    if text.is_empty() {
        return Err(format!("No text found in {name}. Scanned PDFs need OCR first."));
    }
    let words = text.split_whitespace().count();
    Ok(Some(json!({ "name": name, "text": text, "words": words })))
}

#[tauri::command]
fn add_source(store: State<Store>, folder: Option<i64>, lesson: Option<i64>, name: String, text: String) -> Res<i64> {
    let c = store.db()?;
    let words = text.split_whitespace().count() as i64;
    exec(&c, "INSERT INTO sources (folder_id, lesson_id, name, body, words) VALUES (?1, ?2, ?3, ?4, ?5)", params![folder, lesson, name, text, words])?;
    store.forget(None);
    Ok(c.last_insert_rowid())
}

#[tauri::command]
fn get_source(store: State<Store>, id: i64) -> Res<Value> {
    store
        .db()?
        .query_row("SELECT name, body FROM sources WHERE id = ?1", [id], |r| Ok(json!({ "name": r.get::<_, String>(0)?, "body": r.get::<_, String>(1)? })))
        .map_err(err)
}

#[tauri::command]
fn delete_source(store: State<Store>, id: i64) -> Res<()> {
    exec(&*store.db()?, "DELETE FROM sources WHERE id = ?1", [id])?;
    store.forget(None);
    Ok(())
}

// ---------- settings ----------

#[tauri::command]
fn get_settings(store: State<Store>) -> Res<Value> {
    db::setting(&*store.db()?)
}

#[tauri::command]
fn save_settings(store: State<Store>, settings: Value) -> Res<()> {
    exec(&*store.db()?, "INSERT OR REPLACE INTO settings (key, value) VALUES ('app', ?1)", [settings.to_string()]).map(drop)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Store { db: Mutex::new(db::open(&dir.join("rlearn.db"))?), open: Mutex::default(), http: reqwest::Client::new() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send, set_api_key, has_api_key, tree, get_lesson, create_lesson, add_section, rename_lesson, bookmark_lesson,
            delete_lesson, search, export_lesson, create_folder, rename_folder, delete_folder, move_item, pick_source, add_source,
            get_source, delete_source, get_settings, save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running rlearn");
}

#[cfg(test)]
mod tests {
    use super::extract;

    #[test]
    fn subtitles_keep_only_the_words() {
        let dir = std::env::temp_dir().join("learn-extract-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("talk.srt");
        std::fs::write(&f, "1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nGeneral idea\n").unwrap();
        assert_eq!(extract(&f).unwrap(), "Hello there\n\nGeneral idea"); // runs of blank lines collapse to one
    }

    /// Timing on a real file: SOURCE=/path/to/file.pdf cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn extract_real_file() {
        let path = std::env::var("SOURCE").unwrap();
        let t = std::time::Instant::now();
        let text = extract(std::path::Path::new(&path)).unwrap();
        println!("{} words, {} bytes in {:?}", text.split_whitespace().count(), text.len(), t.elapsed());
    }
}
