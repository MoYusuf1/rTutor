//! How a coding agent running in a terminal (Claude Code, Codex, anything that speaks MCP) powers rlearn.
//!
//! The agent starts `rlearn --mcp`, which connects here over localhost. One long-lived "presence" connection
//! per agent says it is alive (it closes when the agent exits); every tool call is its own short connection.
//! The agent pulls the learner's messages with `next`, and its lesson tools run in the page, which answers
//! them. A quiz call simply waits until the learner has answered.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager};

/// How long `next` waits before telling the agent to ask again. Below the tool timeouts rlearn sets up.
const WAIT: Duration = Duration::from_secs(20 * 60);

pub struct Bridge {
    s: Mutex<S>,
    cv: Condvar,
    token: String,
}

#[derive(Default)]
struct S {
    page: Option<Channel<Value>>,
    agents: Vec<Agent>,
    active: Option<u64>,
    inbox: VecDeque<(i64, String)>, // (lesson, what the learner said) for the active agent
    calls: HashMap<u64, Option<Value>>, // tool calls the page is running → its result, once there
    seq: u64,
}

#[derive(Serialize, Clone)]
struct Agent {
    id: u64,
    name: String, // the MCP client's name, e.g. "claude-code"
    cwd: String,
    cmd: String, // the command line that started it, when known
    busy: bool,
    #[serde(skip)]
    lesson: i64, // the lesson its latest message came from; its tool calls apply there
    #[serde(skip)]
    briefed: HashSet<i64>,
}

/// Where `rlearn --mcp` finds the running app.
pub fn file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("bridge.json")
}

fn random() -> String {
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from the OS; two draws make a 128-bit token
    (0..2).map(|_| format!("{:016x}", std::collections::hash_map::RandomState::new().build_hasher().finish())).collect()
}

impl Bridge {
    /// Listens on a free localhost port and writes it, with a fresh token, where `rlearn --mcp` looks.
    pub fn start(app: &AppHandle, data_dir: &std::path::Path) -> std::io::Result<Bridge> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let token = random();
        let info = json!({ "port": listener.local_addr()?.port(), "token": token });
        let path = file(data_dir);
        std::fs::write(&path, info.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = serve(&app, stream);
                });
            }
        });
        Ok(Bridge { s: Mutex::default(), cv: Condvar::new(), token })
    }

    fn lock(&self) -> MutexGuard<'_, S> {
        self.s.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn changed(&self, s: &S) {
        if let Some(page) = &s.page {
            let _ = page.send(json!({ "type": "agents", "agents": s.agents, "active": s.active }));
        }
        self.cv.notify_all();
    }
}

fn serve(app: &AppHandle, stream: TcpStream) -> std::io::Result<()> {
    let bridge = app.state::<Bridge>();
    let mut lines = BufReader::new(stream.try_clone()?).lines();
    let Some(Ok(first)) = lines.next() else { return Ok(()) };
    let msg: Value = serde_json::from_str(&first).unwrap_or_default();
    if msg["token"].as_str() != Some(bridge.token.as_str()) {
        return Ok(()); // not ours (or a browser poking at the port)
    }
    let mut out = stream;
    if let Some(hello) = msg.get("hello") {
        let id = {
            let mut s = bridge.lock();
            s.seq += 1;
            let id = s.seq;
            let text = |k: &str| hello[k].as_str().unwrap_or_default().to_owned();
            s.agents.push(Agent { id, name: text("name"), cwd: text("cwd"), cmd: text("cmd"), busy: false, lesson: 0, briefed: HashSet::new() });
            if s.active.is_none() {
                s.active = Some(id);
            }
            bridge.changed(&s);
            id
        };
        writeln!(out, "{}", json!({ "id": id }))?;
        for _ in lines.by_ref() {} // blocks until the agent exits
        let mut s = bridge.lock();
        s.agents.retain(|a| a.id != id);
        if s.active == Some(id) {
            s.active = s.agents.first().map(|a| a.id);
        }
        bridge.changed(&s);
        return Ok(());
    }
    let agent = msg["agent"].as_u64().unwrap_or_default();
    let (text, error) = match call(app, &bridge, agent, msg["tool"].as_str().unwrap_or_default(), &msg["input"]) {
        Ok(t) => (t, false),
        Err(t) => (t, true),
    };
    writeln!(out, "{}", json!({ "text": text, "error": error }))
}

fn call(app: &AppHandle, bridge: &Bridge, agent: u64, tool: &str, input: &Value) -> Result<String, String> {
    let mut s = bridge.lock();
    let Some(a) = s.agents.iter_mut().find(|a| a.id == agent) else {
        return Err("rlearn restarted. Call next again.".into());
    };
    if tool == "next" {
        a.busy = false;
        bridge.changed(&s);
        let deadline = Instant::now() + WAIT;
        loop {
            if s.active == Some(agent) && !s.inbox.is_empty() {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || !s.agents.iter().any(|a| a.id == agent) {
                return Ok("Nothing from the learner yet. Call next again.".into());
            }
            s = bridge.cv.wait_timeout(s, left).unwrap_or_else(|e| e.into_inner()).0;
        }
        let (lesson, text) = s.inbox.pop_front().unwrap_or_default();
        let a = s.agents.iter_mut().find(|a| a.id == agent).ok_or("rlearn restarted. Call next again.")?;
        let first = a.briefed.is_empty();
        let new_lesson = a.briefed.insert(lesson);
        (a.lesson, a.busy) = (lesson, true);
        bridge.changed(&s);
        drop(s);
        let mut out = String::new();
        if first {
            out.push_str(crate::PROMPT);
            out.push_str("\n\n---\n\n");
        }
        if new_lesson {
            out.push_str(&crate::brief(app, lesson)?);
        }
        crate::record(app, lesson, json!({ "role": "user", "content": text }))?;
        out.push_str(&format!("The learner says:\n\n{text}"));
        return Ok(out);
    }
    // a lesson tool: the page runs it and answers with a tool_result
    let lesson = a.lesson;
    if lesson == 0 {
        return Err("No lesson yet. Call next to get the learner's first message.".into());
    }
    let Some(page) = s.page.clone() else { return Err("The rlearn window isn't ready. Try again.".into()) };
    s.seq += 1;
    let id = s.seq;
    s.calls.insert(id, None);
    let _ = page.send(json!({ "type": "call", "id": id, "agent": agent, "lesson": lesson, "name": tool, "input": input }));
    let result = loop {
        if let Some(r) = s.calls.get_mut(&id).map(Option::take) {
            match r {
                Some(r) => break r,
                None => s = bridge.cv.wait(s).unwrap_or_else(|e| e.into_inner()),
            }
        } else {
            return Err("The rlearn window reloaded. Call next.".into());
        }
    };
    s.calls.remove(&id);
    drop(s);
    let use_id = format!("agent-{id}");
    let mut result = result;
    result["type"] = json!("tool_result");
    result["tool_use_id"] = json!(use_id);
    crate::record(app, lesson, json!({ "role": "assistant", "content": [{ "type": "tool_use", "id": use_id, "name": tool, "input": input }] }))?;
    crate::record(app, lesson, json!({ "role": "user", "content": [result.clone()] }))?;
    let text = result["content"].as_str().unwrap_or_default().to_owned();
    if result["is_error"] == true { Err(text) } else { Ok(text) }
}

// ---------- commands for the page ----------

/// The page subscribes to agent events. A reloaded page can't answer calls made to the old one.
#[tauri::command]
pub fn agent_listen(bridge: tauri::State<Bridge>, on_event: Channel<Value>) {
    let mut s = bridge.lock();
    s.page = Some(on_event);
    s.calls.clear();
    bridge.changed(&s);
}

#[tauri::command]
pub fn agent_send(bridge: tauri::State<Bridge>, lesson: i64, text: String) -> Result<(), String> {
    let mut s = bridge.lock();
    if s.active.is_none() {
        return Err("No agent is running. Open the terminal and start one.".into());
    }
    s.inbox.push_back((lesson, text));
    bridge.changed(&s);
    Ok(())
}

#[tauri::command]
pub fn agent_result(bridge: tauri::State<Bridge>, id: u64, result: Value) {
    let mut s = bridge.lock();
    if let Some(slot) = s.calls.get_mut(&id) {
        *slot = Some(result);
        bridge.cv.notify_all();
    }
}

#[tauri::command]
pub fn agent_use(bridge: tauri::State<Bridge>, id: u64) {
    let mut s = bridge.lock();
    if s.agents.iter().any(|a| a.id == id) {
        s.active = Some(id);
        bridge.changed(&s);
    }
}
