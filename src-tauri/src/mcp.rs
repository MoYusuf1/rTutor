//! `rlearn --mcp`: the MCP server (JSON-RPC over stdio) a coding agent starts to power rlearn.
//! It forwards every tool call to the running app over the localhost bridge (see bridge.rs).

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

pub const INSTRUCTIONS: &str = "rlearn is a tutoring app that is already open on this computer, and you are its tutor. Don't \
look for it or launch it, and don't run commands for it: you reach it only through these MCP tools. Call `next` right away and \
follow what it returns. After every step, call `next` again to wait for the learner. Teach only through rlearn's tools; the \
learner reads the app, not this terminal.";

fn tools() -> Vec<Value> {
    let mut tools = crate::llm::tools();
    tools.insert(0, json!({ "name": "next",
        "description": "Wait for the learner's next message in rlearn (already open) and return it. Call it first, before anything else, and again whenever you have finished responding. The first call also returns how to teach.",
        "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }));
    tools.push(json!({ "name": "say",
        "description": "Show a short chat message to the learner in rlearn's chat pane. Use it for conversation, never for lesson content.",
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
            "serverInfo": { "name": "rlearn", "version": env!("CARGO_PKG_VERSION") },
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

/// Where the running app's data directory is, the way Tauri resolves it.
fn data_dir() -> std::path::PathBuf {
    let home = || std::path::PathBuf::from(std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_default());
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(Into::into).unwrap_or_else(|| home().join("AppData/Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME").map(Into::into).unwrap_or_else(|| home().join(".local/share"))
    };
    base.join("app.rlearn.desktop")
}

fn connect() -> Option<(TcpStream, String)> {
    let info: Value = serde_json::from_str(&std::fs::read_to_string(crate::bridge::file(&data_dir())).ok()?).ok()?;
    let stream = TcpStream::connect(("127.0.0.1", info["port"].as_u64()? as u16)).ok()?;
    Some((stream, info["token"].as_str()?.to_owned()))
}

/// The command line of the agent that started us (Linux only), so rlearn can offer to start it next time.
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

fn forward(agent: Option<u64>, tool: &str, input: &Value) -> (String, bool) {
    const CLOSED: &str = "rlearn isn't open. Ask the learner to open it, then call next again.";
    let Some(agent) = agent else { return (CLOSED.into(), true) };
    let Some((mut stream, token)) = connect() else { return (CLOSED.into(), true) };
    if writeln!(stream, "{}", json!({ "token": token, "agent": agent, "tool": tool, "input": input })).is_err() {
        return (CLOSED.into(), true);
    }
    let mut line = String::new();
    match BufReader::new(stream).read_line(&mut line) {
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
            let agent = agent.clone();
            std::thread::spawn(move || presence(name, agent));
        }
        if msg["method"] == "tools/call" {
            let (out, agent) = (stdout.clone(), agent.clone());
            std::thread::spawn(move || {
                // give a just-started presence connection a moment to register
                for _ in 0..20 {
                    if agent.lock().unwrap().is_some() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let id = agent.lock().unwrap().clone();
                let (text, error) = forward(id, msg["params"]["name"].as_str().unwrap_or_default(), &msg["params"]["arguments"]);
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
        assert_eq!(names, ["next", "write_lesson", "quiz", "update_state", "ask", "search_material", "read_material", "subject_notes", "phase", "say"]);
        assert!(list["result"]["tools"][2]["inputSchema"]["properties"]["correct_index"].is_object());
        let bad = handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).unwrap();
        assert_eq!(bad["error"]["code"], -32601);
    }
}
