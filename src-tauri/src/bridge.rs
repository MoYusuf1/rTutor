//! How a coding agent running in a terminal (Claude Code, Codex, anything that speaks MCP) powers rTutor.
//!
//! The agent starts `rtutor --mcp`, which connects here over localhost. One long-lived "presence" connection
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
use tauri::{ipc::Channel, AppHandle, Manager, Runtime};

use crate::log::note;

/// True once the other end of `stream` has hung up (the agent gave up on the call).
fn closed(stream: &TcpStream) -> bool {
    let mut buf = [0u8; 1];
    let _ = stream.set_nonblocking(true);
    let gone = matches!(stream.peek(&mut buf), Ok(0)) || matches!(stream.peek(&mut buf), Err(e) if e.kind() != std::io::ErrorKind::WouldBlock);
    let _ = stream.set_nonblocking(false);
    gone
}

/// How long `next` waits before telling the agent to ask again. Below the tool timeouts rTutor sets up.
const WAIT: Duration = Duration::from_secs(20 * 60);

/// What `next` says, once a turn, to an agent that ends a step without giving the learner anything to do.
const FINISH_STEP: &str = "Not yet: this step ended without anything for the learner to do, so they would be left \
waiting. Finish it with one question on what you just taught (quiz, true_false or short_answer), or ask what they'd like \
next, then call next.";

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
    inbox: VecDeque<Item>, // what the learner said, waiting for the agent of its subject
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
    waiting: bool, // inside `next`: it will see the learner's message at once
    #[serde(skip)]
    stopped: bool,
    #[serde(skip)]
    unanswered: Option<(i64, String)>, // the last message it got, until it does something with it
    #[serde(skip)]
    owes: bool, // it showed the learner something after its last question: the step isn't finished
    #[serde(skip)]
    reminded: bool, // it was told once this turn to finish the step with a question
    #[serde(skip)]
    lesson: i64, // the lesson its latest message came from; its tool calls apply there
    #[serde(skip)]
    briefed: HashSet<i64>,
}

/// If rTutor is already running, asks it to come forward and returns true (this launch should then exit).
pub fn focus_running(data_dir: &std::path::Path) -> bool {
    let ask = || -> Option<bool> {
        let info: Value = serde_json::from_str(&std::fs::read_to_string(file(data_dir)).ok()?).ok()?;
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], info["port"].as_u64()? as u16));
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(300)).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        writeln!(s, "{}", json!({ "token": info["token"], "focus": true })).ok()?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).ok()?;
        Some(line.trim() == "ok")
    };
    ask().unwrap_or(false) // a stale file from a crash, or another program on that port: start normally
}

/// Where `rtutor --mcp` finds the running app.
pub fn file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("bridge.json")
}

fn random() -> String {
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from the OS; two draws make a 128-bit token
    (0..2).map(|_| format!("{:016x}", std::collections::hash_map::RandomState::new().build_hasher().finish())).collect()
}

impl Bridge {
    /// Listens on a free localhost port and writes it, with a fresh token, where `rtutor --mcp` looks.
    pub fn start<R: Runtime>(app: &AppHandle<R>, data_dir: &std::path::Path) -> std::io::Result<Bridge> {
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

fn serve<R: Runtime>(app: &AppHandle<R>, stream: TcpStream) -> std::io::Result<()> {
    let bridge = app.state::<Bridge>();
    let mut lines = BufReader::new(stream.try_clone()?).lines();
    let Some(Ok(first)) = lines.next() else { return Ok(()) };
    let msg: Value = serde_json::from_str(&first).unwrap_or_default();
    if msg["token"].as_str() != Some(bridge.token.as_str()) {
        return Ok(()); // not ours (or a browser poking at the port)
    }
    let mut out = stream;
    if msg.get("focus").is_some() {
        // rTutor was opened again: bring this window forward instead of starting a second app
        for w in app.webview_windows().into_values() {
            let _ = (w.unminimize(), w.show(), w.set_focus());
        }
        return writeln!(out, "ok");
    }
    if let Some(hello) = msg.get("hello") {
        let id = {
            let mut s = bridge.lock();
            s.seq += 1;
            let id = s.seq;
            let text = |k: &str| hello[k].as_str().unwrap_or_default().to_owned();
            s.agents.push(Agent { id, name: text("name"), cwd: text("cwd"), cmd: text("cmd"), busy: false, waiting: false, stopped: false, unanswered: None, owes: false, reminded: false, lesson: 0, briefed: HashSet::new() });
            if s.active.is_none() {
                s.active = Some(id);
            }
            note(format!("agent {}#{id} connected in {}", text("name"), text("cwd")));
            bridge.changed(&s);
            id
        };
        writeln!(out, "{}", json!({ "id": id }))?;
        for _ in lines.by_ref() {} // blocks until the agent exits
        let mut s = bridge.lock();
        note(format!("agent #{id} disconnected"));
        s.agents.retain(|a| a.id != id);
        if s.active == Some(id) {
            s.active = s.agents.first().map(|a| a.id);
        }
        bridge.changed(&s);
        return Ok(());
    }
    let agent = msg["agent"].as_u64().unwrap_or_default();
    let tool = msg["tool"].as_str().unwrap_or_default();
    let started = Instant::now();
    let (text, error, delivery) = match call(app, &bridge, agent, tool, &msg["input"], &out) {
        Ok((t, d)) => (t, false, d),
        Err(t) => (t, true, None),
    };
    let sent = !closed(&out) && writeln!(out, "{}", json!({ "text": text, "error": error })).is_ok();
    if tool != "next" {
        note(format!("agent #{agent} {tool} {}ms{}", started.elapsed().as_millis(), if error { format!(" error: {}", text.lines().next().unwrap_or_default()) } else { String::new() }));
    }
    // a learner's message counts as delivered only once the agent has actually received it
    if let Some((lesson, learner)) = delivery {
        if sent {
            note(format!("agent #{agent} received the learner's message (lesson {lesson})"));
            crate::record(app, lesson, json!({ "role": "user", "content": learner })).map_err(std::io::Error::other)?;
        } else {
            note(format!("agent #{agent} gave up on next before reading the message; it waits for the next call"));
            let mut s = bridge.lock();
            let dir = s.agents.iter().find(|a| a.id == agent).map(|a| a.cwd.clone()).unwrap_or_default();
            s.inbox.push_front(Item { lesson, text: learner, dir, own: false });
            if let Some(a) = s.agents.iter_mut().find(|a| a.id == agent) {
                (a.busy, a.briefed, a.unanswered) = (false, HashSet::new(), None); // it never saw the brief either
            }
            bridge.changed(&s);
        }
    }
    Ok(())
}

/// What `next` returns: how to teach (first time), the lesson so far (first time in this lesson), the message.
/// `switched`: the learner moved here from another lesson this agent teaches.
fn compose<R: Runtime>(app: &AppHandle<R>, first: bool, new_lesson: bool, switched: bool, lesson: i64, text: &str) -> Result<String, String> {
    let mut out = String::new();
    if first {
        out.push_str(crate::PROMPT);
        out.push_str("\n\n---\n\n");
    }
    if switched {
        // one agent teaches every lesson of its subject; without this it asks the learner which one to continue
        out.push_str(&format!(
            "[The learner is now in the lesson \"{}\". Teach this one. Don't ask which lesson to continue: the lesson you were on is saved and picks up when they go back to it.]\n\n",
            crate::lesson_title(app, lesson)?
        ));
    }
    if new_lesson {
        out.push_str(&crate::brief(app, lesson)?);
    }
    out.push_str(&format!("The learner says:\n\n{text}"));
    // a style rule stated once fades over a long conversation; one line each turn keeps it
    out.push_str("\n\n(Reply in plain English: short sentences, everyday words, one idea at a time.)");
    Ok(out)
}

/// A learner's message waiting to be picked up.
#[derive(Clone)]
struct Item {
    lesson: i64,
    text: String,
    dir: String, // the subject's folder: the agent running in it teaches this
    own: bool,   // wait for the subject's own agent (one is starting), don't hand it to another
}

/// True when `cwd` is `dir` or somewhere inside it.
fn within(cwd: &str, dir: &str) -> bool {
    !dir.is_empty() && std::path::Path::new(cwd).starts_with(dir)
}

impl S {
    /// Which agent a message goes to: the one running in its subject's folder, else (unless the message waits for
    /// its own) the active agent, which teaches any subject without one.
    fn owner(&self, item: &Item) -> Option<u64> {
        self.agents.iter().find(|a| within(&a.cwd, &item.dir)).map(|a| a.id).or(if item.own { None } else { self.active })
    }
    /// The first message waiting for `agent`.
    fn next_for(&self, agent: u64) -> Option<usize> {
        self.inbox.iter().position(|item| self.owner(item) == Some(agent))
    }
}

/// A message `next` handed over: (lesson, the learner's words), recorded only once the agent has it.
type Delivery = Option<(i64, String)>;

fn call<R: Runtime>(app: &AppHandle<R>, bridge: &Bridge, agent: u64, tool: &str, input: &Value, stream: &TcpStream) -> Result<(String, Delivery), String> {
    let mut s = bridge.lock();
    let Some(a) = s.agents.iter_mut().find(|a| a.id == agent) else {
        return Err("rTutor restarted. Call next again.".into());
    };
    if tool == "next" {
        // asking again without having acted on the last message means it never really got it (an agent can
        // end its turn while a call is still out): hand the same message over again
        if let Some((lesson, text)) = a.unanswered.clone() {
            (a.busy, a.waiting, a.lesson) = (true, false, lesson);
            note(format!("agent #{agent} asked again without answering; handing the message over again"));
            bridge.changed(&s);
            drop(s);
            // it may have missed the brief too, so it comes along again
            return Ok((compose(app, true, true, false, lesson, &format!("(You may have missed this.) {text}"))?, None));
        }
        // a step that ends on something to read, with nothing to do, leaves the learner waiting: send it back once
        if a.owes && !a.reminded {
            a.reminded = true;
            note(format!("agent #{agent} ended a step without a question; reminded it"));
            return Ok((FINISH_STEP.into(), None));
        }
        (a.busy, a.waiting, a.stopped) = (false, true, false);
        note(format!("agent #{agent} waiting for the learner"));
        bridge.changed(&s);
        let deadline = Instant::now() + WAIT;
        loop {
            if s.next_for(agent).is_some() {
                break;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            // an agent can abandon a call (end its turn, time out): stop waiting for it, or a message would go nowhere
            let gone = closed(stream);
            if left.is_zero() || gone || !s.agents.iter().any(|a| a.id == agent) {
                if let Some(a) = s.agents.iter_mut().find(|a| a.id == agent) {
                    a.waiting = false;
                }
                note(format!("agent #{agent} stopped waiting ({})", if gone { "it dropped the call" } else { "timed out; it should ask again" }));
                bridge.changed(&s);
                return Ok(("Nothing from the learner yet. Call next again.".into(), None));
            }
            s = bridge.cv.wait_timeout(s, left.min(Duration::from_secs(1))).unwrap_or_else(|e| e.into_inner()).0;
        }
        let i = s.next_for(agent).unwrap_or_default();
        let Item { lesson, text, .. } = s.inbox.remove(i).ok_or("rTutor restarted. Call next again.")?;
        let a = s.agents.iter_mut().find(|a| a.id == agent).ok_or("rTutor restarted. Call next again.")?;
        let first = a.briefed.is_empty();
        let new_lesson = a.briefed.insert(lesson);
        let switched = a.lesson != 0 && a.lesson != lesson;
        (a.lesson, a.busy, a.waiting, a.unanswered) = (lesson, true, false, Some((lesson, text.clone())));
        (a.owes, a.reminded) = (false, false); // the learner has the floor again
        bridge.changed(&s);
        drop(s);
        return Ok((compose(app, first, new_lesson, switched, lesson, &text)?, Some((lesson, text))));
    }
    // a lesson tool: the page runs it and answers with a tool_result
    a.unanswered = None;
    match tool {
        "quiz" | "true_false" | "short_answer" | "ask" => a.owes = false,
        "write_lesson" | "say" => a.owes = true,
        _ => {}
    }
    if a.stopped {
        return Err("The learner pressed stop. Drop what you were doing, don't send anything else, and call next to wait for them.".into());
    }
    let lesson = a.lesson;
    if lesson == 0 {
        return Err("No lesson yet. Call next to get the learner's first message.".into());
    }
    let Some(page) = s.page.clone() else { return Err("The rTutor window isn't ready. Try again.".into()) };
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
            return Err("The rTutor window reloaded. Call next.".into());
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
    if result["is_error"] == true { Err(text) } else { Ok((text, None)) }
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

/// `own`: the subject's own agent is starting, so the message waits for it rather than going to another agent.
#[tauri::command]
pub fn agent_send<R: Runtime>(app: AppHandle<R>, bridge: tauri::State<Bridge>, lesson: i64, text: String, own: Option<bool>) -> Result<(), String> {
    let dir = {
        let store = app.state::<crate::Store>();
        let c = store.db()?;
        crate::db::subject_of_lesson(&c, lesson)?.map(|(_, name, _)| crate::material::subject_dir(&name).display().to_string()).unwrap_or_default()
    };
    let mut s = bridge.lock();
    let item = Item { lesson, text, dir, own: own.unwrap_or(false) };
    let owner = s.owner(&item);
    let waiting = s.agents.iter().any(|a| Some(a.id) == owner && a.waiting);
    note(format!("learner message queued for lesson {lesson} ({}){}", item.dir, if owner.is_none() { "; no agent for this subject yet" } else if waiting { "" } else { "; its agent isn't waiting for one right now" }));
    s.inbox.push_back(item); // with no agent yet, it waits for one to connect
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

/// The learner pressed stop: that agent's next lesson tool call is refused, and its unsent messages are dropped.
#[tauri::command]
pub fn agent_stop(bridge: tauri::State<Bridge>, id: Option<u64>, lesson: Option<i64>) {
    let mut s = bridge.lock();
    let agent = id.or(s.active);
    // its queued messages go, and so do the lesson's own (one may be waiting for an agent that's still starting)
    let keep: VecDeque<Item> = s.inbox.iter().filter(|i| s.owner(i) != agent && Some(i.lesson) != lesson).cloned().collect();
    s.inbox = keep;
    if let Some(a) = s.agents.iter_mut().find(|a| Some(a.id) == agent) {
        (a.stopped, a.busy, a.unanswered, a.owes) = (true, false, None, false);
    }
    note("learner pressed stop");
    bridge.changed(&s);
}

#[tauri::command]
pub fn agent_use(bridge: tauri::State<Bridge>, id: u64) {
    let mut s = bridge.lock();
    if s.agents.iter().any(|a| a.id == id) {
        s.active = Some(id);
        bridge.changed(&s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct Agent {
        port: u16,
        token: String,
        id: u64,
        _presence: TcpStream,
    }

    impl Agent {
        fn join(dir: &std::path::Path) -> Agent {
            let info: Value = serde_json::from_str(&std::fs::read_to_string(file(dir)).unwrap()).unwrap();
            let (port, token) = (info["port"].as_u64().unwrap() as u16, info["token"].as_str().unwrap().to_owned());
            let mut presence = TcpStream::connect(("127.0.0.1", port)).unwrap();
            writeln!(presence, "{}", json!({ "token": token, "hello": { "name": "codex-mcp-client", "cwd": "/tmp", "cmd": "" } })).unwrap();
            let mut line = String::new();
            BufReader::new(presence.try_clone().unwrap()).read_line(&mut line).unwrap();
            let id = serde_json::from_str::<Value>(&line).unwrap()["id"].as_u64().unwrap();
            Agent { port, token, id, _presence: presence }
        }
        /// Starts a tool call; the reply is read from the returned stream.
        fn call(&self, tool: &str) -> TcpStream {
            let mut s = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
            writeln!(s, "{}", json!({ "token": self.token, "agent": self.id, "tool": tool, "input": {} })).unwrap();
            s
        }
    }

    fn reply(s: TcpStream) -> String {
        let mut out = String::new();
        BufReader::new(s).read_to_string(&mut out).unwrap();
        serde_json::from_str::<Value>(&out).map(|v| v["text"].as_str().unwrap_or_default().to_owned()).unwrap_or_default()
    }

    fn app(name: &str) -> (tauri::App<tauri::test::MockRuntime>, std::path::PathBuf) {
        // lesson folders go to a temporary library, never the real ~/rtutor
        static LIBRARY: std::sync::Once = std::sync::Once::new();
        LIBRARY.call_once(|| std::env::set_var("RTUTOR_LIBRARY", std::env::temp_dir().join(format!("rtutor-library-{}", std::process::id()))));
        let app = tauri::test::mock_app();
        let dir = std::env::temp_dir().join(format!("rtutor-bridge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = crate::db::open(&dir.join("test.db")).unwrap();
        c.execute_batch("INSERT INTO folders (id, name) VALUES (1, 'Somali'); INSERT INTO lessons (id, folder_id, title, updated) VALUES (1, 1, 'Greetings', 0);").unwrap();
        app.manage(crate::Store { db: Mutex::new(c), open: Mutex::default(), http: crate::http_client(), stops: Mutex::default() });
        app.manage(Bridge::start(app.handle(), &dir).unwrap());
        (app, dir)
    }

    fn send(app: &tauri::App<tauri::test::MockRuntime>, text: &str) {
        agent_send(app.handle().clone(), app.state::<Bridge>(), 1, text.into(), None).unwrap();
    }

    fn history(app: &tauri::App<tauri::test::MockRuntime>) -> usize {
        crate::db::messages(&*app.state::<crate::Store>().db().unwrap(), 1).unwrap().len()
    }

    #[test]
    fn each_subject_goes_to_the_agent_running_in_its_folder() {
        let agent = |id: u64, cwd: &str| super::Agent {
            id, name: "codex".into(), cwd: cwd.into(), cmd: String::new(), busy: false, waiting: true, stopped: false,
            unanswered: None, owes: false, reminded: false, lesson: 0, briefed: HashSet::new(),
        };
        let item = |dir: &str, own: bool| Item { lesson: 1, text: "hi".into(), dir: dir.into(), own };
        let mut s = S { agents: vec![agent(1, "/home/me/rtutor"), agent(2, "/home/me/rtutor/Somali")], active: Some(1), ..S::default() };
        assert_eq!(s.owner(&item("/home/me/rtutor/Somali", false)), Some(2), "the Somali agent teaches Somali");
        assert_eq!(s.owner(&item("/home/me/rtutor/Physics", false)), Some(1), "a subject without its own agent goes to the active one");
        assert_eq!(s.owner(&item("/home/me/rtutor/Physics", true)), None, "unless its own agent is on the way");
        s.agents[1].cwd = "/home/me/rtutor/Somali/Greetings".into();
        assert_eq!(s.owner(&item("/home/me/rtutor/Somali", false)), Some(2), "an agent in a lesson folder belongs to its subject");
        s.inbox.push_back(item("/home/me/rtutor/Physics", false));
        s.inbox.push_back(item("/home/me/rtutor/Somali", false));
        assert_eq!((s.next_for(1), s.next_for(2)), (Some(0), Some(1)));
    }

    #[test]
    fn a_second_launch_finds_the_running_app() {
        let (_app, dir) = app("focus");
        assert!(focus_running(&dir), "the running app answered");
        std::fs::write(file(&dir), r#"{"port":1,"token":"stale"}"#).unwrap();
        assert!(!focus_running(&dir), "a stale file from a crash doesn't stop a launch");
    }

    #[test]
    fn a_message_survives_an_agent_that_drops_its_call() {
        let (app, dir) = app("dropped");
        let agent = Agent::join(&dir);
        // the agent asks, then gives up on the call (ends its turn) before the learner writes
        let first = agent.call("next");
        std::thread::sleep(Duration::from_millis(300));
        first.shutdown(std::net::Shutdown::Both).unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        send(&app, "Hello, teach me");
        // asking again gets the message: it wasn't handed to the dropped call
        let text = reply(agent.call("next"));
        assert!(text.contains("The learner says:\n\nHello, teach me"), "{text}");
        assert_eq!(history(&app), 1, "recorded once, when it was received");
    }

    #[test]
    fn a_step_that_ends_without_a_question_is_sent_back_once() {
        let (app, dir) = app("finish");
        let agent = Agent::join(&dir);
        send(&app, "Teach me greetings");
        assert!(reply(agent.call("next")).contains("Teach me greetings"));
        let _ = reply(agent.call("write_lesson")); // shows the learner something (no page here, so it errs; it still counts)
        assert_eq!(reply(agent.call("next")), FINISH_STEP, "waiting now would leave the learner with nothing to do");
        // reminded once: the next call waits for the learner as usual
        send(&app, "ok");
        assert!(reply(agent.call("next")).contains("The learner says:\n\nok"));
    }

    #[test]
    fn an_agent_is_told_when_the_learner_switches_lessons() {
        let (app, dir) = app("switch");
        app.state::<crate::Store>().db().unwrap().execute_batch("INSERT INTO lessons (id, folder_id, title, updated) VALUES (2, 1, 'Numbers', 0);").unwrap();
        let agent = Agent::join(&dir);
        send(&app, "Teach me greetings");
        let first = reply(agent.call("next"));
        assert!(!first.contains("is now in the lesson"), "nothing to switch from yet");
        let _ = reply(agent.call("phase")); // it acts on the message
        agent_send(app.handle().clone(), app.state::<Bridge>(), 2, "Now numbers".into(), None).unwrap();
        let text = reply(agent.call("next"));
        assert!(text.contains(r#"is now in the lesson "Numbers""#) && text.contains("Don't ask which lesson"), "{text}");
    }

    #[test]
    fn an_agent_that_asks_again_without_answering_gets_the_message_again() {
        let (app, dir) = app("again");
        let agent = Agent::join(&dir);
        send(&app, "What does iska warran mean?");
        assert!(reply(agent.call("next")).contains("iska warran"));
        // it never acted on it (its call was lost on its side) and asks again
        let again = reply(agent.call("next"));
        assert!(again.contains("You may have missed this") && again.contains("iska warran"), "{again}");
        assert_eq!(history(&app), 1, "the repeat isn't a second message");
    }
}
