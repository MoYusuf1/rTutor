//! `rtutor-mcp`: the MCP server (JSON-RPC over stdio) a coding agent starts to power rTutor. It forwards every
//! tool call to the running app over the localhost bridge (the app's bridge.rs).
//!
//! Its own small program, not the app: an agent's tool server should cost a few megabytes, not load a web view.
//! The app links this crate too, for the shared tool list and rules, and still answers to `rtutor --mcp`.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

/// The rules that matter most, kept short. They sit in the server instructions, which agents keep in their system
/// prompt (so they survive when the agent compacts its conversation), and `next` repeats them now and then.
macro_rules! core_rules {
    () => {
        "How to teach, always: write in plain English (short sentences, everyday words, one idea at a time). Lesson content goes \
on the canvas with write_lesson; chat stays one or two lines. End every step with something for the learner to do, usually \
a question; never ask them to type \"ready\". After an answer, explain it and show the idea another way before the next \
question. If they don't get something, teach it again slower with an example instead of moving on. Keep update_state current."
    };
}
pub const RULES: &str = core_rules!();

pub const INSTRUCTIONS: &str = concat!("rTutor is a tutoring app that is already open on this computer, and you are its tutor. Don't \
look for it or launch it, and don't run commands for it: you reach it only through these MCP tools. Call `next` right away and \
follow what it returns. After every step, call `next` again to wait for the learner. Teach only through rTutor's tools; the \
learner reads the app, not this terminal.\n\n", core_rules!());

fn tools() -> Vec<Value> {
    let mut tools = lesson_tools();
    tools.insert(0, json!({ "name": "next",
        "description": "Wait for the learner's next message in rTutor (already open) and return it. Call it first, before anything else, and again whenever you have finished responding. The first call also returns how to teach.",
        "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }));
    tools.push(json!({ "name": "say",
        "description": "Show a short chat message to the learner in rTutor's chat pane. Use it for conversation, never for lesson content.",
        "input_schema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"], "additionalProperties": false } }));
    tools
}

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tool_text(text: &str, error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": error })
}

/// The answer to one JSON-RPC message that can be answered at once; None for notifications and tool calls.
pub fn handle(msg: &Value) -> Option<Value> {
    let id = msg.get("id")?; // no id: a notification, never answered
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "rtutor", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => json!({
            "tools": tools().iter().map(|t| json!({
                "name": t["name"], "description": t["description"], "inputSchema": t["input_schema"],
            })).collect::<Vec<_>>()
        }),
        "tools/call" => return None,
        method => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } })),
    };
    Some(reply(id, result))
}

/// The lesson tools (the app runs them; the tutor decides when), for API models and agents alike.
pub fn lesson_tools() -> Vec<Value> {
    let obj = |props: Value| {
        let required: Vec<&String> = props.as_object().unwrap().keys().collect();
        json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
    };
    vec![
        json!({ "name": "write_lesson",
            "description": "Append one section of lesson content to the lesson canvas (the large left pane). All teaching content goes here: explanations, the plan, dependency maps. Markdown, with $inline$ / $$display$$ LaTeX and ```mermaid diagrams.",
            "input_schema": obj(json!({ "markdown": { "type": "string" } })) }),
        json!({ "name": "quiz",
            "description": "Ask ONE graded multiple-choice question in the chat pane. The app adds an \"I don't know\" option, grades the answer instantly, reveals your explanation and records a result card on the canvas. The tool result tells you what the learner picked.",
            "input_schema": obj(json!({
                "question": { "type": "string" },
                "options": { "type": "array", "items": { "type": "string" }, "description": "2-3 parallel options with no hints of correctness" },
                "correct_index": { "type": "integer", "description": "0-based index of the correct option" },
                "explanation": { "type": "string", "description": "Why the correct option is right and what the tempting wrong ones get wrong. Shown only after the learner answers." }
            })) }),
        json!({ "name": "true_false",
            "description": "Ask ONE graded true-or-false question in the chat pane. The app adds \"I don't know\", grades instantly, reveals your explanation and records a result card on the canvas. Good for quick checks of a single fact or a common misconception.",
            "input_schema": obj(json!({
                "statement": { "type": "string", "description": "A claim that is clearly true or clearly false" },
                "answer": { "type": "boolean", "description": "Whether the statement is true" },
                "explanation": { "type": "string", "description": "Why. Shown only after the learner answers." }
            })) }),
        json!({ "name": "short_answer",
            "description": "Ask ONE question the learner answers in their own words (a word, a phrase, a translation, a sentence). The app shows their answer next to yours on the canvas; YOU judge it from the tool result (accept equivalent wording and small spelling slips) and say briefly whether it was right. Good for recall and production: harder than recognizing the answer in a list.",
            "input_schema": obj(json!({
                "question": { "type": "string" },
                "answer": { "type": "string", "description": "A model answer" },
                "explanation": { "type": "string", "description": "Why, or what to notice. Shown after the learner answers." }
            })) }),
        json!({ "name": "update_state",
            "description": "Replace your lesson state: a short Markdown note (under ~300 words) of what the learner reliably knows, their misconceptions and recent misses, the plan's nodes with status, and the next step. Call it after the plan is agreed and after every node's quiz-check. It is what you (or another tutor model) will rely on when older turns are summarized away, so keep it accurate and complete.",
            "input_schema": obj(json!({ "markdown": { "type": "string" } })) }),
        json!({ "name": "ask",
            "description": "Ask an ungraded multiple-choice question in the chat pane (goals, preferences, what to do next). The learner can also type their own answer.",
            "input_schema": obj(json!({ "question": { "type": "string" }, "options": { "type": "array", "items": { "type": "string" } } })) }),
        json!({ "name": "search_material",
            "description": "Search the learner's material (textbooks, slides, transcripts they added) for a topic. Returns the best-matching parts with a snippet each. Only useful when the lesson has material.",
            "input_schema": obj(json!({ "query": { "type": "string", "description": "A few key words" } })) }),
        json!({ "name": "read_material",
            "description": "Read one part of the learner's material, by the material and part numbers from its contents or a search result.",
            "input_schema": obj(json!({ "material": { "type": "integer" }, "part": { "type": "integer" } })) }),
        json!({ "name": "subject_notes",
            "description": "Replace your notes on the whole subject (not just this lesson): which material covers what and where, which sources are reference and which teach in order, and what the learner has shown across lessons. Every later lesson starts from these notes, so it never has to re-read the material to find its way. Under ~500 words.",
            "input_schema": obj(json!({ "markdown": { "type": "string" } })) }),
        json!({ "name": "phase",
            "description": "Say which phase the lesson is in whenever it changes: probe (finding what the learner knows), plan, teach, or review (testing what was taught). The app offers the learner matching shortcuts.",
            "input_schema": obj(json!({ "phase": { "type": "string", "enum": ["probe", "plan", "teach", "review"] } })) }),
    ]
}

/// Where the running app tells agents how to reach it.
pub fn bridge_file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("bridge.json")
}

/// One line in `<data dir>/mcp.log` (the app keeps rtutor.log to itself, so the two never fight over rotating it).
fn note(line: impl AsRef<str>) {
    use std::sync::OnceLock;
    static OUT: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();
    let out = OUT.get_or_init(|| {
        let path = data_dir().join("mcp.log");
        // started over once it passes a megabyte; it holds only connections and cancels
        let fresh = std::fs::metadata(&path).map_or(false, |m| m.len() > 1024 * 1024);
        std::fs::OpenOptions::new().create(true).append(!fresh).write(true).truncate(fresh).open(path).ok().map(Mutex::new)
    });
    if let Some(Ok(mut f)) = out.as_ref().map(|m| m.lock()) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let _ = writeln!(f, "{secs} [{}] {}", std::process::id(), line.as_ref());
    }
}

/// Where the running app's data directory is, the way Tauri resolves it.
pub fn data_dir() -> std::path::PathBuf {
    let home = || std::path::PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default());
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(Into::into).unwrap_or_else(|| home().join("AppData/Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(Into::into).unwrap_or_else(|| home().join(".local/share"))
    };
    base.join("app.rtutor.desktop")
}

fn connect() -> Option<(TcpStream, String)> {
    let info: Value = serde_json::from_str(&std::fs::read_to_string(bridge_file(&data_dir())).ok()?).ok()?;
    let stream = TcpStream::connect(("127.0.0.1", info["port"].as_u64()? as u16)).ok()?;
    Some((stream, info["token"].as_str()?.to_owned()))
}

/// The command line of the agent that started us (Linux only), so rTutor can offer to start it next time.
fn parent_cmd() -> String {
    #[cfg(target_os = "linux")]
    {
        let ppid = std::os::unix::process::parent_id();
        if let Ok(raw) = std::fs::read(format!("/proc/{ppid}/cmdline")) {
            return raw
                .split(|b| *b == 0)
                .filter(|a| !a.is_empty())
                .map(|a| {
                    let a = String::from_utf8_lossy(a);
                    if a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@".contains(c)) { a.into_owned() } else { format!("'{}'", a.replace('\'', r"'\''")) }
                })
                .collect::<Vec<_>>()
                .join(" ");
        }
    }
    String::new()
}

/// Keeps a presence connection to the app open for as long as we live, reconnecting if the app restarts.
fn presence(name: String, agent: Arc<Mutex<Option<u64>>>) {
    let cwd = std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let cmd = parent_cmd();
    loop {
        if let Some((mut stream, token)) = connect() {
            let hello = json!({ "token": token, "hello": { "name": name, "cwd": cwd, "cmd": cmd } });
            if writeln!(stream, "{hello}").is_ok() {
                let mut lines = BufReader::new(stream).lines();
                if let Some(Ok(line)) = lines.next() {
                    *agent.lock().unwrap() = serde_json::from_str::<Value>(&line).ok().and_then(|v| v["id"].as_u64());
                    for _ in lines.by_ref() {} // until the app closes
                }
            }
            *agent.lock().unwrap() = None;
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    }
}

/// Tool calls in flight, by JSON-RPC id, so a cancelled one can hang up on the app (which then stops waiting).
type Calls = Arc<Mutex<std::collections::HashMap<String, TcpStream>>>;

fn forward(agent: Option<u64>, tool: &str, input: &Value, id: &Value, calls: &Calls) -> (String, bool) {
    const CLOSED: &str = "rTutor isn't open. Ask the learner to open it, then call next again.";
    let Some(agent) = agent else { return (CLOSED.into(), true) };
    let Some((mut stream, token)) = connect() else { return (CLOSED.into(), true) };
    if writeln!(stream, "{}", json!({ "token": token, "agent": agent, "tool": tool, "input": input })).is_err() {
        return (CLOSED.into(), true);
    }
    if let Ok(clone) = stream.try_clone() {
        calls.lock().unwrap().insert(id.to_string(), clone);
    }
    let mut line = String::new();
    let read = BufReader::new(stream).read_line(&mut line);
    calls.lock().unwrap().remove(&id.to_string());
    match read {
        Ok(1..) => {
            let v: Value = serde_json::from_str(&line).unwrap_or_default();
            (v["text"].as_str().unwrap_or_default().to_owned(), v["error"] == true)
        }
        _ => (CLOSED.into(), true),
    }
}

/// Serves until stdin closes (when the agent exits). Tool calls run on their own threads: `next` and
/// `quiz` wait on the learner, and other calls mustn't queue behind them.
pub fn serve() {
        let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let agent = Arc::new(Mutex::new(None::<u64>));
    let calls: Calls = Arc::default();
    let send = |out: &Mutex<std::io::Stdout>, v: Value| {
        let mut out = out.lock().unwrap();
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    };
    let mut started = false;
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if msg["method"] == "initialize" && !std::mem::replace(&mut started, true) {
            let name = msg["params"]["clientInfo"]["name"].as_str().unwrap_or("agent").to_owned();
            note(format!("mcp   started by {name}"));
            let agent = agent.clone();
            std::thread::spawn(move || presence(name, agent));
        }
        if msg["method"] == "notifications/cancelled" {
            let id = msg["params"]["requestId"].to_string();
            if let Some(stream) = calls.lock().unwrap().remove(&id) {
                note(format!("mcp   the agent cancelled call {id}"));
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
        if msg["method"] == "tools/call" {
            let (out, agent, calls) = (stdout.clone(), agent.clone(), calls.clone());
            std::thread::spawn(move || {
                // give a just-started presence connection a moment to register
                for _ in 0..20 {
                    if agent.lock().unwrap().is_some() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let id = *agent.lock().unwrap();
                let (text, error) = forward(id, msg["params"]["name"].as_str().unwrap_or_default(), &msg["params"]["arguments"], &msg["id"], &calls);
                send(&out, reply(&msg["id"], tool_text(&text, error)));
            });
        } else if let Some(answer) = handle(&msg) {
            send(&stdout, answer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::handle;
    use serde_json::json;

    #[test]
    fn speaks_enough_mcp_for_tools() {
        let init = handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-11-25" } })).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
        assert!(init["result"]["instructions"].as_str().unwrap().contains("next"));
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let list = handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        let names: Vec<_> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["next", "write_lesson", "quiz", "true_false", "short_answer", "update_state", "ask", "search_material", "read_material", "subject_notes", "phase", "say"]);
        assert!(list["result"]["tools"][2]["inputSchema"]["properties"]["correct_index"].is_object());
        let bad = handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).unwrap();
        assert_eq!(bad["error"]["code"], -32601);
    }
}
