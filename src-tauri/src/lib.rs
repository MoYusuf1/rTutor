mod bridge;
mod db;
mod llm;
pub mod log;
mod material;
pub use rtutor_mcp as mcp;
mod pty;

use db::{err, exec, Res};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_dialog::DialogExt;

const PROMPT: &str = include_str!("../prompts/teach.md");

struct Store {
    db: Mutex<Connection>,
    // a second, read-only connection: opening lessons, paging and searching (the tutor's too) don't wait behind writes
    reader: Mutex<Connection>,
    open: Mutex<Opens>,
    http: reqwest::Client, // one pooled client: connections are reused across turns
    stops: Mutex<std::collections::HashMap<i64, futures_util::future::AbortHandle>>, // running API turns, by lesson
    // material read from files, waiting to be added: the page holds only a token, never the text (a book is
    // megabytes, and would otherwise cross to the page and back)
    extracted: Mutex<std::collections::HashMap<u64, (String, String, std::time::Instant)>>,
}

/// The lesson currently being taught, kept in memory so each turn only appends.
#[derive(Default)]
struct Open {
    lesson: i64,
    messages: Arc<Vec<Value>>,
    lens: Vec<usize>, // serialized size of each message, for the compaction budget
    system: Option<Arc<str>>,
}

/// The lessons being taught, most recent last. A few, so two lessons running turns at once don't reload each
/// other's whole history every turn.
#[derive(Default)]
struct Opens(Vec<Open>);

impl Opens {
    const KEEP: usize = 3;
    fn get(&mut self, lesson: i64) -> Option<&mut Open> {
        self.0.iter_mut().find(|o| o.lesson == lesson)
    }
    /// The lesson's history, loaded (dropping the least recently used) if it isn't here yet.
    fn load(&mut self, lesson: i64, messages: impl FnOnce() -> Res<Vec<(Value, usize)>>) -> Res<&mut Open> {
        if let Some(i) = self.0.iter().position(|o| o.lesson == lesson) {
            let o = self.0.remove(i);
            self.0.push(o);
        } else {
            if self.0.len() >= Self::KEEP {
                self.0.remove(0);
            }
            self.0.push(Open::load(lesson, messages()?));
        }
        Ok(self.0.last_mut().expect("just pushed"))
    }
}

impl Open {
    /// `messages` come with their stored sizes, so nothing is serialized again to measure them.
    fn load(lesson: i64, messages: Vec<(Value, usize)>) -> Self {
        let (messages, lens) = messages.into_iter().unzip();
        Open { lesson, messages: Arc::new(messages), lens, system: None }
    }
    fn push(&mut self, msg: Value, len: usize) {
        self.lens.push(len);
        Arc::make_mut(&mut self.messages).push(msg);
    }
}

const HANDOFF: &str = "[rTutor: you are taking over this lesson from a different tutor model. Read your lesson state and the recent \
turns, then continue exactly where it left off. Do not restart the probe or the plan.]";

/// Where the history sent to non-Anthropic providers starts. It only moves forward, in steps, so the
/// prompt prefix stays byte-identical (and cached) between cuts. Sizes are serialized characters.
fn cut_point(messages: &[Value], lens: &[usize], from: usize) -> usize {
    // ponytail: characters / 4 approximates tokens; swap in real token counts if cuts land badly
    const ABOVE: usize = 60_000 * 4; // cut once the kept history passes ~60k tokens…
    const KEEP: usize = 16_000 * 4; //  …back to the last ~16k tokens
    if lens[from..].iter().sum::<usize>() <= ABOVE {
        return from;
    }
    let (mut i, mut size) = (lens.len(), 0);
    while i > from + 1 && size + lens[i - 1] <= KEEP {
        i -= 1;
        size += lens[i];
    }
    // the kept history has to start with one of the learner's turns
    let user = |j: &usize| messages[*j]["role"] == "user";
    (i..messages.len()).find(user).or_else(|| (from + 1..i).rev().find(user)).unwrap_or(from)
}

/// The HTTP client for API providers. reqwest is built without a TLS crypto provider (see Cargo.toml), so ring is
/// installed first; building a client without one panics.
fn http_client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::new()
}

impl Store {
    fn new(db: Connection, path: &std::path::Path) -> Res<Store> {
        let reader = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(err)?;
        Ok(Store { db: Mutex::new(db), reader: Mutex::new(reader), open: Mutex::default(), http: http_client(), stops: Mutex::default(), extracted: Mutex::default() })
    }
    fn db(&self) -> Res<std::sync::MutexGuard<'_, Connection>> {
        self.db.lock().map_err(err)
    }
    fn reader(&self) -> Res<std::sync::MutexGuard<'_, Connection>> {
        self.reader.lock().map_err(err)
    }
    /// Sources changed or a lesson was deleted: rebuild the prompt / history on next use.
    fn forget(&self, lesson: Option<i64>) {
        if let Ok(mut opens) = self.open.lock() {
            opens.0.retain(|o| Some(o.lesson) != lesson);
            opens.0.iter_mut().for_each(|o| o.system = None);
        }
    }
}

// ---------- API keys: in the OS keyring, never in the database ----------

fn key_entry(provider: &str) -> Res<keyring::Entry> {
    keyring::Entry::new("rtutor", provider).map_err(err)
}

fn read_key(provider: &str) -> Res<String> {
    match key_entry(provider)?.get_password() {
        Ok(k) => Ok(k),
        // keys saved when the app was called rlearn: move them over on first use
        Err(keyring::Error::NoEntry) => match keyring::Entry::new("rlearn", provider).and_then(|e| e.get_password()) {
            Ok(k) => {
                let _ = key_entry(provider)?.set_password(&k);
                Ok(k)
            }
            Err(_) => Ok(String::new()),
        },
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

// Local servers need no key; a missing OS keyring must not block them.
fn provider_key(provider: &llm::Provider) -> Res<String> {
    if provider.id == "ollama" {
        Ok(String::new())
    } else {
        read_key(&provider.id)
    }
}

/// Uses the same transport and tools as a lesson, without creating lesson history.
#[tauri::command]
async fn test_provider(store: State<'_, Store>, provider: llm::Provider) -> Res<String> {
    let key = provider_key(&provider)?;
    let channel = Channel::new(|_| Ok(()));
    let messages = [json!({ "role": "user", "content": "Connection check: call write_lesson once with markdown exactly RTUTOR_CONNECTED, then end your turn." })];
    let reply = llm::chat(&store.http, &provider, &key, "Follow the connection check exactly. Do not ask questions.", &messages, &channel).await?;
    if !reply.content.iter().any(|b| b["name"] == "write_lesson" && b["input"]["markdown"].as_str().is_some_and(|s| s.trim() == "RTUTOR_CONNECTED")) {
        return Err("The provider responded, but did not call the lesson tool. Check that this model supports tool calling.".into());
    }
    Ok(format!("Connected to {}. Lesson tool calling works.", if reply.usage.model.is_empty() { &provider.model } else { &reply.usage.model }))
}

// ---------- teaching ----------

fn system_prompt(c: &Connection, lesson: i64) -> Res<String> {
    Ok(format!("{PROMPT}{}", material(c, lesson)?))
}

/// The learner's attached material for a lesson, as a prompt section ("" when there is none). Small material
/// goes in whole; a textbook goes in as its contents, and the tutor reads parts with its tools.
fn material(c: &Connection, lesson: i64) -> Res<String> {
    const INLINE: i64 = 12_000; // words
    let notes = db::subject_of_lesson(c, lesson)?.map(|s| s.2).unwrap_or_default();
    let mut s = if notes.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n# Your notes on this subject\n\nYou wrote these in earlier lessons (`subject_notes`). Rely on them instead of re-reading the material.\n\n{notes}\n")
    };
    let index = db::material_index(c, lesson)?;
    if index.is_empty() {
        return Ok(s);
    }
    s.push_str(
        "\n\n# The learner's material\n\nThe learner added the material below for this subject. It defines what the lessons \
         cover: probe against it, plan from its ideas, teach in its terms, and say where things come from (material and \
         page or part). Never ask the learner to paste it again.\n",
    );
    if index.iter().map(|m| m.2).sum::<i64>() <= INLINE {
        for (name, body) in db::sources_for(c, lesson)? {
            s.push_str(&format!("\n<source name=\"{}\">\n{body}\n</source>\n", name.replace('"', "'")));
        }
        return Ok(s);
    }
    s.push_str(
        "\nIt is too long to include here, so these are its contents. Read the part you are about to teach with \
         `read_material` before you teach it, and use `search_material` to find where a topic is covered. Base \
         explanations and quizzes on what the material actually says. Never read it all: a few parts per step is plenty.\n",
    );
    if notes.trim().is_empty() {
        s.push_str(
            "\nYou have no notes on this subject yet. Before the first lesson goes far, skim these contents (and search a \
             little) to map which source covers what, which are reference (dictionaries) and which teach in order, and save \
             that map with `subject_notes`. Every later lesson starts from it.\n",
        );
    }
    for (id, name, words, file, labels) in index {
        s.push_str(&format!("\n## Material {id}: {name} ({words} words, {} parts)\n", labels.len()));
        if !file.is_empty() {
            s.push_str(&format!("File: {file}\n"));
        }
        s.push_str(&contents(&labels));
    }
    Ok(s)
}

/// The stop button during an API turn: drops the stream; the reply so far is discarded.
#[tauri::command]
fn stop_turn(store: State<Store>, lesson: i64) -> Res<()> {
    if let Some(stop) = store.stops.lock().map_err(err)?.remove(&lesson) {
        stop.abort();
    }
    Ok(())
}

/// The tutor's notes on a whole subject: what its material covers and where, and what the learner has shown
/// across lessons. Kept in the database and as notes.md in the subject's folder, and given to every lesson.
#[tauri::command]
fn set_subject_notes(store: State<Store>, lesson: i64, markdown: String) -> Res<()> {
    let c = store.db()?;
    let (id, name, _) = db::subject_of_lesson(&c, lesson)?.ok_or("This lesson isn't in a subject.")?;
    exec(&c, "UPDATE folders SET notes = ?2 WHERE id = ?1", params![id, markdown])?;
    let dir = material::subject_dir(&name);
    let _ = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join("notes.md"), format!("# {name}: tutor's notes\n\n{markdown}\n")));
    store.forget(None);
    Ok(())
}

/// A source's contents as numbered parts. A long book's would cost thousands of tokens in every brief, so past
/// `LINES` parts it lists ranges (each named by its first part) and `search_material` finds the exact one.
fn contents(labels: &[String]) -> String {
    const LINES: usize = 40;
    let per = labels.len().div_ceil(LINES).max(1);
    let mut s = String::new();
    for (i, group) in labels.chunks(per).enumerate() {
        let a = i * per + 1;
        match group.len() {
            1 => s.push_str(&format!("{a}. {}\n", group[0])),
            n => s.push_str(&format!("{a}–{}. {}\n", a + n - 1, group[0])),
        }
    }
    s
}

/// What a terminal agent is told the first time it teaches a lesson: the lesson so far, so it continues instead of
/// starting over, plus the learner's material. Not `full` (back to a lesson it was briefed on): just where it stands.
fn brief<R: tauri::Runtime>(app: &tauri::AppHandle<R>, lesson: i64, full: bool) -> Res<String> {
    let store = app.state::<Store>();
    let c = store.db()?;
    let (title, state, count): (String, String, i64) = c
        .query_row("SELECT title, state, (SELECT COUNT(*) FROM sections WHERE lesson_id = ?1) FROM lessons WHERE id = ?1", [lesson], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(err)?;
    let mut s = format!("# Lesson: {title}\n\n");
    if !full {
        if !state.is_empty() {
            s.push_str(&format!("Your lesson state:\n\n{state}\n\n"));
        }
        let last: Option<String> = c.query_row("SELECT markdown FROM sections WHERE lesson_id = ?1 ORDER BY id DESC LIMIT 1", [lesson], |r| r.get(0)).optional().map_err(err)?;
        if let Some(last) = last {
            s.push_str(&format!("The canvas ends with:\n\n{last}\n"));
        }
        s.push_str("\n---\n\n");
        return Ok(s);
    }
    if let Some(dir) = lesson_dir(&c, lesson)? {
        s.push_str(&format!(
            "Its folder is {} (lesson.md is the canvas so far, notes.md your lesson notes). rTutor keeps these files; \
             change them only through its tools. The subject's material is in ../sources.\n\n",
            dir.display()
        ));
    }
    if count == 0 {
        s.push_str("A new lesson: start with the probe.\n");
    } else {
        s.push_str("This lesson is already under way. Continue exactly where it left off; don't restart the probe or the plan.\n\n");
        if !state.is_empty() {
            s.push_str(&format!("Your lesson state:\n\n{state}\n\n"));
        }
        // only the newest three, read straight from the table: a long canvas costs the same as a short one
        let mut last: Vec<String> = c
            .prepare_cached("SELECT markdown FROM sections WHERE lesson_id = ?1 ORDER BY id DESC LIMIT 3")
            .and_then(|mut q| q.query_map([lesson], |r| r.get(0))?.collect())
            .map_err(err)?;
        last.reverse();
        s.push_str(&format!("The latest of the canvas's {count} sections:\n\n{}\n", last.join("\n\n---\n\n")));
    }
    s.push_str(&material(&c, lesson)?);
    s.push_str("\n---\n\n");
    Ok(s)
}

/// A lesson's title, without loading the lesson.
fn lesson_title<R: tauri::Runtime>(app: &tauri::AppHandle<R>, lesson: i64) -> Res<String> {
    app.state::<Store>().db()?.query_row("SELECT title FROM lessons WHERE id = ?1", [lesson], |r| r.get(0)).map_err(err)
}

/// Appends a terminal agent's turn to the lesson history, which the page and API providers read back.
fn record<R: tauri::Runtime>(app: &tauri::AppHandle<R>, lesson: i64, msg: Value) -> Res<()> {
    record_all(app, lesson, vec![msg])
}

/// Appends messages in one transaction (a tool call and its result are one write, not two).
fn record_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>, lesson: i64, msgs: Vec<Value>) -> Res<()> {
    let store = app.state::<Store>();
    let c = store.db()?;
    let mut opens = store.open.lock().map_err(err)?;
    let mut o = opens.get(lesson);
    let tx = c.unchecked_transaction().map_err(err)?;
    let mut seq = match &o { Some(o) => o.messages.len(), None => db::next_seq(&tx, lesson)? };
    let mut stored = Vec::with_capacity(msgs.len());
    for msg in msgs {
        let len = db::append_message(&tx, lesson, seq, &msg)?;
        stored.push((msg, len));
        seq += 1;
    }
    tx.commit().map_err(err)?;
    if let Some(o) = o.as_mut() {
        for (msg, len) in stored {
            o.push(msg, len);
        }
    }
    Ok(())
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
    let key = provider_key(&provider)?;
    let (messages, system, from) = {
        let c = store.db()?;
        let mut opens = store.open.lock().map_err(err)?;
        let o = opens.load(lesson, || db::messages(&c, lesson))?;
        if let Some(mut content) = content {
            // a different provider than last turn: tell it to continue, not start over
            if db::last_provider(&c, lesson)?.is_some_and(|prev| prev != provider.id) {
                content = match content {
                    Value::String(t) => Value::String(format!("{t}\n\n{HANDOFF}")),
                    Value::Array(mut blocks) => {
                        blocks.push(json!({ "type": "text", "text": HANDOFF }));
                        Value::Array(blocks)
                    }
                    other => other,
                };
            }
            let msg = json!({ "role": "user", "content": content });
            let len = db::append_message(&c, lesson, o.messages.len(), &msg)?;
            o.push(msg, len);
        }
        if o.system.is_none() {
            o.system = Some(system_prompt(&c, lesson)?.into());
        }
        // Anthropic summarizes long histories on its servers. For the others rTutor cuts old turns and puts the
        // tutor's own lesson state in their place, which the database still has in full.
        let mut k = db::compaction(&c, lesson)?;
        let server_compacts = provider.kind == "anthropic" && llm::compacts(&provider.model);
        if !server_compacts {
            let cut = cut_point(&o.messages, &o.lens, k.from.min(o.messages.len().saturating_sub(1)));
            if cut > k.from && !k.state.is_empty() {
                (k.from, k.snapshot) = (cut, k.state.clone());
                exec(&c, "UPDATE lessons SET compact_from = ?2, compact_state = ?3 WHERE id = ?1", params![lesson, cut as i64, k.snapshot])?;
            }
        }
        let base = o.system.clone().unwrap_or_default();
        let (from, system) = if server_compacts || k.from == 0 {
            (0, base)
        } else {
            let section = format!(
                "\n\n# Lesson so far\n\nOlder turns of this lesson are left out to save tokens. This is your own lesson state from \
                 when they were cut; every turn after that follows in full.\n\n{}\n",
                k.snapshot
            );
            (k.from.min(o.messages.len()), Arc::from(format!("{base}{section}")))
        };
        (o.messages.clone(), system, from) // Arc clones: no copying
    };

    let started = std::time::Instant::now();
    let (stop, registration) = futures_util::future::AbortHandle::new_pair();
    store.stops.lock().map_err(err)?.insert(lesson, stop);
    let turn = futures_util::future::Abortable::new(llm::chat(&store.http, &provider, &key, &system, &messages[from..], &on_event), registration).await;
    store.stops.lock().map_err(err)?.remove(&lesson);
    // stopped: the learner's message stays in the history, the half-finished reply doesn't
    let mut reply = match turn {
        Err(_) => {
            log::note(format!("api   {} stopped by the learner", provider.id));
            return Err("Stopped.".into());
        }
        Ok(Err(e)) => {
            log::note(format!("api   {} error: {e}", provider.id));
            return Err(e);
        }
        Ok(Ok(r)) => r,
    };
    reply.usage.ms = started.elapsed().as_millis() as u64;
    let u = &reply.usage;
    log::note(format!(
        "api   {} {} in + {} cached / {} out  {:.1}s  stop={}",
        u.model, u.input + u.cache_write, u.cache_read, u.output, u.ms as f64 / 1000.0, reply.stop_reason
    ));
    drop(messages); // last other reference, so the push below appends in place
    if reply.stop_reason == "refusal" {
        reply.content.retain(|b| b["type"] != "tool_use"); // a refusal can cut a tool call off mid-input
    }
    let msg = json!({ "role": "assistant", "content": reply.content });
    let c = store.db()?;
    db::record_turn(&c, lesson, &provider.id, &reply.usage)?;
    let mut opens = store.open.lock().map_err(err)?;
    if let Some(o) = opens.get(lesson) {
        let len = db::append_message(&c, lesson, o.messages.len(), &msg)?;
        o.push(msg, len);
    } else {
        db::append_message(&c, lesson, db::next_seq(&c, lesson)?, &msg)?; // learner switched lessons mid-turn
    }
    Ok(reply)
}

// ---------- lessons ----------

#[tauri::command]
fn tree(store: State<Store>) -> Res<Value> {
    let mut t = db::tree(&*store.reader()?)?;
    // each subject's folder on disk: where its agent runs
    for f in t["folders"].as_array_mut().into_iter().flatten() {
        if f["parent"].is_null() {
            f["dir"] = json!(material::subject_dir(f["name"].as_str().unwrap_or_default()).display().to_string());
        }
    }
    Ok(t)
}

// ---------- lesson folders: ~/rtutor/<subject>/<lesson>/ mirrors each lesson as files ----------

/// The lesson's folder, made (and remembered) the first time it's needed. None for a lesson outside a subject.
fn lesson_dir(c: &Connection, lesson: i64) -> Res<Option<std::path::PathBuf>> {
    let (dir, title): (String, String) = c.query_row("SELECT dir, title FROM lessons WHERE id = ?1", [lesson], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
    if !dir.is_empty() && std::path::Path::new(&dir).is_dir() {
        return Ok(Some(dir.into()));
    }
    let Some((_, subject, _)) = db::subject_of_lesson(c, lesson)? else { return Ok(None) };
    let dir = material::fresh_dir(&material::subject_dir(&subject), &title);
    std::fs::create_dir_all(&dir).map_err(err)?;
    exec(c, "UPDATE lessons SET dir = ?2 WHERE id = ?1", params![lesson, dir.display().to_string()])?;
    Ok(Some(dir))
}

/// Writes the whole lesson into its folder: the canvas as lesson.md, the tutor's notes as notes.md.
fn mirror_lesson(c: &Connection, lesson: i64) -> Res<()> {
    let Some(dir) = lesson_dir(c, lesson)? else { return Ok(()) };
    let l = db::lesson(c, lesson)?;
    let sections: Vec<&str> = l["sections"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    std::fs::write(dir.join("lesson.md"), format!("{}\n", sections.join("\n\n"))).map_err(err)?;
    std::fs::write(dir.join("notes.md"), l["state"].as_str().unwrap_or_default()).map_err(err)
}

#[tauri::command]
fn get_lesson(store: State<Store>, id: i64) -> Res<Value> {
    // Opening a lesson reads a page of it, never all of it: the newest messages and sections, what they need, and
    // the few facts the page would otherwise scan the history for. Older pages come as the learner scrolls up.
    let c = store.reader()?;
    let (title, folder, state): (String, Option<i64>, String) = c
        .query_row("SELECT title, folder_id, state FROM lessons WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(err)?;
    let count: i64 = c.query_row("SELECT COUNT(*) FROM sections WHERE lesson_id = ?1", [id], |r| r.get(0)).map_err(err)?;
    let sections = db::sections_page(&c, id, None, SECTIONS_PAGE)?;
    let messages = db::messages_page(&c, id, None, HISTORY_PAGE)?;
    let (opener, first) = db::firsts(&c, id)?;
    Ok(json!({
        "id": id, "title": title, "folder": folder, "state": state, "sectionCount": count, "firstSection": first,
        "sections": sections.iter().map(|(_, s)| s).collect::<Vec<_>>(),
        "sectionsBefore": if (sections.len() as i64) < count { sections.first().map(|(i, _)| *i) } else { None },
        "messages": messages.iter().map(|(_, m)| m).collect::<Vec<_>>(),
        "messagesBefore": messages.first().map(|(seq, _)| *seq).filter(|seq| *seq > 0),
        "toolResults": db::tool_results_for(&c, id, &db::tool_ids(&messages))?,
        "phase": db::last_phase(&c, id)?,
        "opener": opener,
    }))
}

/// Messages and canvas sections per page of a lesson.
const HISTORY_PAGE: usize = 120;
const SECTIONS_PAGE: usize = 40;

/// The page of chat history before message `before` (a seq), oldest first, with its saved answers.
#[tauri::command]
fn lesson_history(store: State<Store>, id: i64, before: i64) -> Res<Value> {
    let c = store.reader()?;
    let page = db::messages_page(&c, id, Some(before), HISTORY_PAGE)?;
    Ok(json!({
        "messages": page.iter().map(|(_, m)| m).collect::<Vec<_>>(),
        "before": page.first().map(|(seq, _)| *seq).filter(|seq| *seq > 0),
        "toolResults": db::tool_results_for(&c, id, &db::tool_ids(&page))?,
    }))
}

/// The page of canvas sections before section `before`, oldest first.
#[tauri::command]
fn lesson_sections(store: State<Store>, id: i64, before: i64) -> Res<Value> {
    let page = db::sections_page(&*store.reader()?, id, Some(before), SECTIONS_PAGE)?;
    Ok(json!({
        "sections": page.iter().map(|(_, s)| s).collect::<Vec<_>>(),
        "before": page.first().map(|(i, _)| *i),
    }))
}

#[tauri::command]
fn save_tool_result(store: State<Store>, lesson: i64, result: Value) -> Res<()> {
    db::save_tool_result(&*store.db()?, lesson, &result)
}

#[tauri::command]
fn create_lesson(store: State<Store>, folder: Option<i64>, title: String) -> Res<i64> {
    let c = store.db()?;
    exec(&c, "INSERT INTO lessons (folder_id, title, updated) VALUES (?1, ?2, ?3)", params![folder, title, db::now()])?;
    Ok(c.last_insert_rowid())
}

#[tauri::command]
fn add_section(store: State<Store>, lesson: i64, markdown: String) -> Res<()> {
    let c = store.db()?;
    exec(&c, "INSERT INTO sections (lesson_id, markdown) VALUES (?1, ?2)", params![lesson, markdown])?;
    // appended, not rewritten: each new section costs the same however long the lesson gets
    if let Some(dir) = lesson_dir(&c, lesson)? {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("lesson.md")).map_err(err)?;
        write!(f, "{markdown}\n\n").map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn set_state(store: State<Store>, lesson: i64, markdown: String) -> Res<()> {
    let c = store.db()?;
    exec(&c, "UPDATE lessons SET state = ?2 WHERE id = ?1", params![lesson, markdown])?;
    if let Some(dir) = lesson_dir(&c, lesson)? {
        std::fs::write(dir.join("notes.md"), &markdown).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn rename_lesson(store: State<Store>, id: i64, title: String) -> Res<()> {
    let c = store.db()?;
    exec(&c, "UPDATE lessons SET title = ?2 WHERE id = ?1", params![id, title])?;
    // the folder follows the name
    let dir: String = c.query_row("SELECT dir FROM lessons WHERE id = ?1", [id], |r| r.get(0)).map_err(err)?;
    let old = std::path::Path::new(&dir);
    if let Some(parent) = old.parent().filter(|_| old.is_dir()) {
        let new = material::fresh_dir(parent, &title);
        if std::fs::rename(old, &new).is_ok() {
            exec(&c, "UPDATE lessons SET dir = ?2 WHERE id = ?1", params![id, new.display().to_string()])?;
        }
    }
    Ok(())
}

#[tauri::command]
fn bookmark_lesson(store: State<Store>, id: i64, on: bool) -> Res<()> {
    exec(&*store.db()?, "UPDATE lessons SET bookmarked = ?2 WHERE id = ?1", params![id, on]).map(drop)
}

#[tauri::command]
fn delete_lesson(store: State<Store>, id: i64) -> Res<()> {
    let c = store.db()?;
    let dir: String = c.query_row("SELECT dir FROM lessons WHERE id = ?1", [id], |r| r.get(0)).unwrap_or_default();
    exec(&c, "DELETE FROM lessons WHERE id = ?1", [id])?;
    material::remove_lesson_dir(&dir);
    drop(c);
    store.forget(Some(id));
    Ok(())
}

#[tauri::command]
fn search(store: State<Store>, query: String) -> Res<Vec<Value>> {
    db::search(&*store.reader()?, &query)
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
    let c = store.db()?;
    let (old, top): (String, bool) = c.query_row("SELECT name, parent_id IS NULL FROM folders WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
    exec(&c, "UPDATE folders SET name = ?2 WHERE id = ?1", params![id, name])?;
    if top {
        material::rename_subject(&old, &name);
        // the files moved with their folder
        let (from, to) = (material::subject_dir(&old).display().to_string(), material::subject_dir(&name).display().to_string());
        exec(&c, "UPDATE sources SET file = ?2 || substr(file, length(?1) + 1) WHERE file LIKE ?1 || '%'", params![from, to])?;
        exec(&c, "UPDATE lessons SET dir = ?2 || substr(dir, length(?1) + 1) WHERE dir LIKE ?1 || '%'", params![from, to])?;
    }
    store.forget(None);
    Ok(())
}

#[tauri::command]
fn delete_folder(store: State<Store>, id: i64) -> Res<()> {
    let c = store.db()?;
    let files = db::files_within(&c, id)?;
    let lesson_dirs: Vec<String> = c
        .prepare("WITH RECURSIVE down(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM folders f JOIN down ON f.parent_id = down.id)
                  SELECT dir FROM lessons WHERE folder_id IN (SELECT id FROM down)")
        .and_then(|mut q| q.query_map([id], |r| r.get(0))?.collect())
        .map_err(err)?;
    exec(&c, "DELETE FROM folders WHERE id = ?1", [id])?; // cascades to everything inside
    lesson_dirs.iter().for_each(|d| material::remove_lesson_dir(d));
    material::remove_files(&files);
    drop(c);
    store.forget(None);
    *store.open.lock().map_err(err)? = Opens::default();
    Ok(())
}

/// Drag and drop in the sidebar: put a lesson or folder into `folder` (None = top level).
#[tauri::command]
fn move_item(store: State<Store>, kind: String, id: i64, folder: Option<i64>) -> Res<()> {
    let c = store.db()?;
    match kind.as_str() {
        "lesson" => {
            exec(&c, "UPDATE lessons SET folder_id = ?2 WHERE id = ?1", params![id, folder])?;
            // its folder moves into the new subject's (a lesson outside any subject keeps no folder)
            let dir: String = c.query_row("SELECT dir FROM lessons WHERE id = ?1", [id], |r| r.get(0)).map_err(err)?;
            if let (false, Some((_, subject, _))) = (dir.is_empty(), db::subject_of_lesson(&c, id)?) {
                let old = std::path::Path::new(&dir);
                let parent = material::subject_dir(&subject);
                if old.parent() != Some(parent.as_path()) {
                    let new = material::fresh_dir(&parent, &old.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                    if std::fs::create_dir_all(&parent).and_then(|_| std::fs::rename(old, &new)).is_ok() {
                        exec(&c, "UPDATE lessons SET dir = ?2 WHERE id = ?1", params![id, new.display().to_string()])?;
                    }
                }
            }
            1
        }
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

/// Reads a file's text and keeps it until `add_source` (or `forget_source`). The page gets a token, a name and a
/// word count: the text itself never leaves Rust.
fn read_material(app: &tauri::AppHandle, path: std::path::PathBuf) -> Res<Value> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    const MAX_BYTES: u64 = 200 * 1024 * 1024;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if std::fs::metadata(&path).map_err(err)?.len() > MAX_BYTES {
        return Err(format!("{name} is over 200 MB. Split it into smaller files, or add the chapters you need."));
    }
    // a damaged file can make the PDF reader panic or spin: it gets a minute, on its own thread
    // ponytail: a reader that spins keeps its thread until the app quits; a child process could be killed instead
    let (tx, rx) = std::sync::mpsc::channel();
    let p = path.clone();
    std::thread::spawn(move || {
        let _ = tx.send(std::panic::catch_unwind(|| material::extract(&p)));
    });
    let text = match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(Ok(text)) => text?,
        Ok(Err(_)) => return Err(format!("Couldn't read {name}: the file looks damaged.")),
        Err(_) => return Err(format!("Reading {name} took over a minute, so it was stopped. Is it a very large scan?")),
    };
    if text.is_empty() {
        return Err(format!("No text found in {name}. Scanned PDFs need OCR first."));
    }
    let words = text.split_whitespace().count();
    let token = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let store = app.state::<Store>();
    let mut held = store.extracted.lock().map_err(err)?;
    held.retain(|_, (_, _, at)| at.elapsed() < std::time::Duration::from_secs(60 * 60)); // read an hour ago and never added
    held.insert(token, (name.clone(), text, std::time::Instant::now()));
    Ok(json!({ "token": token, "name": name, "words": words }))
}

/// Opens the file picker and reads each file (kept by `add_source`).
#[tauri::command]
async fn pick_source(app: tauri::AppHandle) -> Res<Vec<Value>> {
    let Some(files) = app.dialog().file().add_filter("Material", &["pdf", "txt", "md", "srt", "vtt"]).blocking_pick_files() else {
        return Ok(vec![]);
    };
    let paths: Vec<_> = files.into_iter().filter_map(|f| f.into_path().ok()).collect();
    tauri::async_runtime::spawn_blocking(move || paths.into_iter().map(|p| read_material(&app, p)).collect()).await.map_err(err)?
}

/// A file dropped onto the window.
#[tauri::command]
async fn read_source(app: tauri::AppHandle, path: String) -> Res<Value> {
    tauri::async_runtime::spawn_blocking(move || read_material(&app, path.into())).await.map_err(err)?
}

/// Material read but not added after all (its chip was removed): its text is let go. No token (the page loaded
/// afresh, so nothing it held is wanted): all of it.
#[tauri::command]
fn forget_source(store: State<Store>, token: Option<u64>) {
    if let Ok(mut m) = store.extracted.lock() {
        match token {
            Some(t) => drop(m.remove(&t)),
            None => m.clear(),
        }
    }
}

/// Stores material: split into searchable parts, and written as a Markdown file in its subject's folder.
#[tauri::command]
async fn add_source(app: tauri::AppHandle, folder: Option<i64>, lesson: Option<i64>, token: u64) -> Res<i64> {
    // splitting a book and writing its file are the slow parts: both run with the database free for everyone else
    // (the tutor's tool calls, the chat), and off the main thread
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<Store>();
        let (name, text, _) = store.extracted.lock().map_err(err)?.remove(&token).ok_or("That file was already added, or read too long ago. Add it again.")?;
        // the same file twice (by name, ignoring case and extension) isn't added again
        let twin = |c: &Connection| -> Res<()> {
            let twin: Option<String> = c
                .prepare_cached("SELECT name FROM sources WHERE folder_id IS ?1 AND lesson_id IS ?2")
                .and_then(|mut q| q.query_map(params![folder, lesson], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>())
                .map_err(err)?
                .into_iter()
                .find(|n| material::stem(n) == material::stem(&name));
            match twin {
                Some(twin) => Err(format!("{name} looks like {twin}, which is already here, so it wasn't added again.")),
                None => Ok(()),
            }
        };
        let subject = {
            let c = store.db()?;
            twin(&c)?;
            let home: Option<i64> = match (folder, lesson) {
                (Some(f), _) => Some(f),
                (None, Some(l)) => c.query_row("SELECT folder_id FROM lessons WHERE id = ?1", [l], |r| r.get(0)).map_err(err)?,
                _ => None,
            };
            home.map(|f| db::subject_of(&c, f)).transpose()?
        };
        let parts = material::chunk(&text);
        // ponytail: a material file that can't be written (read-only home, odd name) just means no file; the parts still work
        let file = subject.as_deref().map(|s| material::write_file(s, &name, &text).map(|p| p.display().to_string()).unwrap_or_default()).unwrap_or_default();
        let words = text.split_whitespace().count() as i64;
        drop(text);
        let c = store.db()?;
        let tx = c.unchecked_transaction().map_err(err)?;
        twin(&tx)?; // again: the same file may have been dropped twice at once, and the lock was let go above
        // the text is kept once, as searchable parts (plus the Markdown file); `body` stays empty
        exec(&tx, "INSERT INTO sources (folder_id, lesson_id, name, body, words, file) VALUES (?1, ?2, ?3, '', ?4, ?5)", params![folder, lesson, name, words, file])?;
        let id = tx.last_insert_rowid();
        db::insert_parts(&tx, id, &parts).map_err(err)?;
        tx.commit().map_err(err)?;
        drop(c);
        store.forget(None);
        // agents already teaching this subject were briefed without it: the next message briefs them again
        if let Some(s) = subject {
            app.state::<bridge::Bridge>().material_changed(&material::subject_dir(&s).display().to_string());
        }
        Ok(id)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn get_source(store: State<Store>, id: i64) -> Res<Value> {
    store
        .db()?
        .query_row(&format!("SELECT s.name, {}, s.file FROM sources s WHERE s.id = ?1", db::SOURCE_TEXT), [id], |r| {
            Ok(json!({ "name": r.get::<_, String>(0)?, "body": r.get::<_, String>(1)?, "file": r.get::<_, String>(2)? }))
        })
        .map_err(err)
}

#[tauri::command]
fn delete_source(store: State<Store>, id: i64) -> Res<()> {
    let c = store.db()?;
    let file: Option<String> = c.query_row("SELECT file FROM sources WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(err)?;
    exec(&c, "DELETE FROM sources WHERE id = ?1", [id])?;
    material::remove_files(&file.into_iter().collect::<Vec<_>>());
    store.forget(None);
    Ok(())
}

/// The tutor's `search_material` tool.
#[tauri::command]
fn material_search(store: State<Store>, lesson: i64, query: String) -> Res<String> {
    let hits = db::search_parts(&*store.reader()?, lesson, &query)?;
    if hits.is_empty() {
        return Ok("Nothing in the material matches. Try other words, or read the parts listed in its contents.".into());
    }
    Ok(hits
        .iter()
        .map(|h| format!("material {} \"{}\", part {} ({}):\n{}", h["material"], h["name"].as_str().unwrap_or_default(), h["part"], h["label"].as_str().unwrap_or_default(), h["snippet"].as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// An agent's tool call that only reads or saves data, run without the window (None: the page runs it).
pub(crate) fn agent_tool<R: tauri::Runtime>(app: &tauri::AppHandle<R>, lesson: i64, tool: &str, input: &Value) -> Option<Res<String>> {
    let store = app.state::<Store>();
    let text = |k: &str| input[k].as_str().map(str::to_owned);
    let num = |k: &str| input[k].as_i64().or_else(|| input[k].as_str()?.trim().parse().ok());
    Some(match tool {
        "search_material" => text("query").ok_or_else(|| "search_material needs a query.".to_owned()).and_then(|q| material_search(store, lesson, q)),
        "read_material" => match (num("material"), num("part")) {
            (Some(m), Some(p)) => material_read(store, lesson, m, p),
            _ => Err("read_material needs a material number and a part number.".into()),
        },
        "update_state" => text("markdown").ok_or_else(|| "update_state needs a markdown string.".to_owned()).and_then(|m| set_state(store, lesson, m).map(|_| "Lesson state saved.".into())),
        "subject_notes" => text("markdown")
            .ok_or_else(|| "subject_notes needs a markdown string.".to_owned())
            .and_then(|m| set_subject_notes(store, lesson, m).map(|_| "Subject notes saved. Every lesson in this subject will start from them.".into())),
        "phase" => match input["phase"].as_str() {
            Some(p @ ("probe" | "plan" | "teach" | "review")) => Ok(format!("Phase: {p}.")),
            _ => Err("phase is one of probe, plan, teach, review.".into()),
        },
        _ => return None,
    })
}

/// The tutor's `read_material` tool.
#[tauri::command]
fn material_read(store: State<Store>, lesson: i64, material: i64, part: i64) -> Res<String> {
    match db::read_part(&*store.reader()?, lesson, material, part)? {
        Some((name, label, body, total)) => Ok(format!("\"{name}\", part {part} of {total} ({label}):\n\n{body}")),
        None => Err(format!("This lesson has no material {material} with a part {part}.")),
    }
}

/// What the API usage line shows: lesson totals and the latest turn.
#[tauri::command]
fn stats(store: State<Store>, lesson: Option<i64>) -> Res<Value> {
    match lesson {
        Some(id) => db::lesson_stats(&*store.db()?, id),
        None => Ok(json!({})),
    }
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

/// The app used to be called rlearn: its database, log and ~/rlearn library move over once.
fn renamed(dir: &std::path::Path) {
    let Some(old) = dir.parent().map(|p| p.join("app.rlearn.desktop")) else { return };
    if old.join("rlearn.db").is_file() && !dir.join("rtutor.db").exists() {
        for (from, to) in [("rlearn.db", "rtutor.db"), ("rlearn.db-wal", "rtutor.db-wal"), ("rlearn.db-shm", "rtutor.db-shm"), ("rlearn.log", "rtutor.log")] {
            let _ = std::fs::rename(old.join(from), dir.join(to));
        }
    }
    let (from, to) = (material::subject_dir("x").parent().map(|p| p.with_file_name("rlearn")), material::subject_dir("x").parent().map(|p| p.to_owned()));
    if let (Some(from), Some(to)) = (from, to) {
        if from.is_dir() && !to.exists() {
            let _ = std::fs::rename(&from, &to);
        }
    }
}

/// The library folder after the rename: file paths saved under ~/rlearn point into ~/rtutor.
fn renamed_paths(c: &Connection) {
    if let Some(lib) = material::subject_dir("x").parent() {
        let (from, to) = (lib.with_file_name("rlearn").display().to_string(), lib.display().to_string());
        let _ = c.execute("UPDATE sources SET file = ?2 || substr(file, length(?1) + 1) WHERE file LIKE ?1 || '/%'", params![from, to]);
        let _ = c.execute("UPDATE settings SET value = replace(value, ?1 || '/', ?2 || '/') WHERE key = 'app'", params![from, to]);
    }
}

/// Material files written before sources had their own folder move into ~/rtutor/<subject>/sources/.
fn relocate_sources(c: &Connection) {
    let files: Vec<(i64, String)> = c
        .prepare("SELECT id, file FROM sources WHERE file != ''")
        .and_then(|mut q| q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .unwrap_or_default();
    for (id, file) in files {
        if let Some(moved) = material::into_sources(&file) {
            let _ = c.execute("UPDATE sources SET file = ?2 WHERE id = ?1", params![id, moved]);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // one window: opening rTutor again (from the launcher, or an agent) brings the open one forward
    if bridge::focus_running(&mcp::data_dir()) {
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Term::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            renamed(&dir);
            log::init(&dir);
            log::note(format!("rTutor {} started", env!("CARGO_PKG_VERSION")));
            let c = db::open(&dir.join("rtutor.db"))?;
            // one-time moves of files from older layouts: run once, not on every launch
            if c.query_row("SELECT 1 FROM settings WHERE key = 'done:layout-v1'", [], |_| Ok(())).is_err() {
                renamed_paths(&c);
                relocate_sources(&c);
                let _ = c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('done:layout-v1', '1')", []);
            }
            // lessons made before they had folders get one, with their page and notes written out
            let pending: Vec<i64> = c.prepare("SELECT id FROM lessons WHERE dir = ''").and_then(|mut q| q.query_map([], |r| r.get(0))?.collect()).unwrap_or_default();
            for id in pending {
                let _ = mirror_lesson(&c, id);
            }
            app.manage(Store::new(c, &dir.join("rtutor.db"))?);
            app.manage(bridge::Bridge::start(app.handle(), &dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send, lesson_history, lesson_sections, test_provider, save_tool_result, set_api_key, has_api_key, tree, get_lesson, create_lesson, add_section, rename_lesson, bookmark_lesson,
            delete_lesson, search, export_lesson, create_folder, rename_folder, delete_folder, move_item, pick_source, add_source,
            get_source, delete_source, read_source, forget_source, material_search, material_read, get_settings, save_settings, stats, set_state,
            pty::term_open, pty::term_write, pty::term_resize, pty::term_close, pty::pick_folder, pty::mcp_command, pty::installed_agents, pty::agent_models,
            stop_turn, set_subject_notes, log::log_listen, log::log_note, bridge::agent_stop, bridge::agent_listen, bridge::agent_send, bridge::agent_result, bridge::agent_use
        ])
        .run(tauri::generate_context!())
        .expect("error while running rTutor");
}

#[cfg(test)]
mod contents_tests {
    #[test]
    fn two_lessons_taught_at_once_keep_their_histories() {
        let mut opens = super::Opens::default();
        let mut loads = 0;
        for lesson in [1, 2, 1, 2, 3, 1, 4, 2] {
            opens.load(lesson, || { loads += 1; Ok(vec![]) }).unwrap();
        }
        // 1, 2 and 3 load once each; 4 pushes out 2 (the least recent), which loads again
        assert_eq!(loads, 5);
        assert_eq!(opens.0.iter().map(|o| o.lesson).collect::<Vec<_>>(), [1, 4, 2]);
    }

    #[test]
    fn a_long_book_is_listed_in_ranges() {
        let short: Vec<String> = (1..=3).map(|i| format!("Part {i}")).collect();
        assert_eq!(super::contents(&short), "1. Part 1\n2. Part 2\n3. Part 3\n");
        let long: Vec<String> = (1..=250).map(|i| format!("Part {i}")).collect();
        let listed = super::contents(&long);
        assert!(listed.lines().count() <= 40, "{listed}");
        assert!(listed.starts_with("1–7. Part 1\n8–14. Part 8\n") && listed.ends_with("246–250. Part 246\n"), "{listed}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn history_is_cut_in_steps_at_a_learner_turn() {
        use serde_json::json;
        let roles = ["user", "assistant", "user", "assistant", "user", "assistant"];
        let msgs: Vec<_> = roles.iter().map(|r| json!({ "role": r })).collect();
        let small = vec![1000; 6];
        assert_eq!(super::cut_point(&msgs, &small, 0), 0); // under budget: no cut
        let big = vec![50_000 * 4; 6]; // each message alone is over the keep budget
        let cut = super::cut_point(&msgs, &big, 0);
        assert!(cut > 0 && msgs[cut]["role"] == "user");
        assert!(super::cut_point(&msgs, &big, cut) >= cut); // never moves back
        let tail = vec![10, 10, 10, 10, 70_000 * 4, 10];
        assert_eq!(super::cut_point(&msgs, &tail, 0), 4); // keeps the latest turns that fit
    }

}
