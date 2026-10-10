//! Claude Code and Codex as providers. rlearn runs the official CLI the learner is already signed into
//! (their subscription; rlearn never sees the credentials). The CLIs get no tools here, so the tutor writes
//! <lesson>, <quiz> and <ask> blocks, and `Actions` turns them into the same tool_use blocks the API
//! providers produce, while the text streams in. Everything downstream stays provider-agnostic.

use crate::llm::{log, n, Acc, Event, Provider};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const MCP_PROTOCOL: &str = "\n\n# Your tools in this session

Your tools are write_lesson, quiz, ask and update_state (they appear as mcp__rlearn__…), with the rules above. After a quiz or \
ask, end your turn: write nothing more, because the learner's answer arrives in the next message. Don't run shell commands \
or read files; everything you need is in this conversation. No web search is available.";

const TOOL_NAMES: [&str; 4] = ["write_lesson", "quiz", "ask", "update_state"];

const MCP_TOOLS: &str = "mcp__rlearn__write_lesson,mcp__rlearn__quiz,mcp__rlearn__ask,mcp__rlearn__update_state";

const MATERIAL: &str = "\n\n# The learner's material";

/// The conversation as plain text, with past actions written back in the tag format.
pub fn transcript(messages: &[Value], tags: bool) -> String {
    let mut s = String::from("# Conversation so far\n");
    for m in messages {
        let tutor = m["role"] == "assistant";
        let Some(blocks) = m["content"].as_array() else {
            s += &format!("\n## {}\n{}\n", if tutor { "Tutor" } else { "Learner" }, m["content"].as_str().unwrap_or_default());
            continue;
        };
        s += if tutor { "\n## Tutor\n" } else { "\n## Learner\n" };
        for b in blocks {
            match (b["type"].as_str(), b["name"].as_str()) {
                (Some("text"), _) => s += &format!("{}\n", b["text"].as_str().unwrap_or_default()),
                (Some("tool_use"), Some(name @ ("write_lesson" | "update_state"))) if tags => {
                    let tag = if name == "write_lesson" { "lesson" } else { "state" };
                    s += &format!("<{tag}>\n{}\n</{tag}>\n", b["input"]["markdown"].as_str().unwrap_or_default().trim_end())
                }
                (Some("tool_use"), Some(name)) if tags => s += &format!("<{name}>\n{}\n</{name}>\n", b["input"]),
                (Some("tool_use"), Some(name @ ("write_lesson" | "update_state"))) => {
                    s += &format!("[called {name}]\n{}\n", b["input"]["markdown"].as_str().unwrap_or_default().trim_end())
                }
                (Some("tool_use"), Some(name)) => s += &format!("[called {name}] {}\n", b["input"]),
                (Some("tool_result"), _) => {
                    let c = &b["content"];
                    s += &format!("[app] {}\n", c.as_str().map(String::from).unwrap_or_else(|| c.to_string()));
                }
                _ => {} // thinking, web search and other provider-internal blocks
            }
        }
    }
    s + "\n# Your turn\nWrite the tutor's next turn only.\n"
}

#[derive(Default, Clone, Copy, PartialEq)]
enum Mode {
    #[default]
    Text,
    Markdown(u64, &'static str), // <lesson> / <state>: body streamed as a JSON string
    Json(u64, &'static str),
}

/// Streaming parser: text between tags becomes chat text, tagged blocks become tool calls.
#[derive(Default)]
pub struct Actions {
    line: String,
    emitted: usize, // bytes of `line` already streamed as text
    mode: Mode,
    text: Option<u64>,
    next: u64,
    stamp: u128,
}

const KEY_BASE: u64 = 1 << 40;

impl Actions {
    fn key(&mut self) -> u64 {
        self.next += 1;
        KEY_BASE + self.next
    }

    fn id(&mut self) -> String {
        if self.stamp == 0 {
            self.stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(1, |d| d.as_nanos());
        }
        format!("toolu_cli_{}_{}", self.stamp, self.next) // unique across the whole lesson
    }

    pub fn feed(&mut self, chunk: &str, acc: &mut Acc, ch: &Channel<Event>) {
        let mut rest = chunk;
        while let Some(i) = rest.find('\n') {
            self.line.push_str(&rest[..i]);
            self.end_line(acc, ch);
            rest = &rest[i + 1..];
        }
        self.line.push_str(rest);
        // stream a partial line right away unless it could still turn out to be a tag
        if self.mode == Mode::Text && !self.line.trim_start().starts_with('<') && self.line.len() > self.emitted {
            let part = self.line[self.emitted..].to_owned();
            self.emitted = self.line.len();
            self.say(&part, acc, ch);
        }
    }

    fn end_line(&mut self, acc: &mut Acc, ch: &Channel<Event>) {
        let line = std::mem::take(&mut self.line);
        let emitted = std::mem::replace(&mut self.emitted, 0);
        let tag = line.trim();
        match self.mode {
            Mode::Text => {
                let name = match tag {
                    "<lesson>" => "write_lesson",
                    "<state>" => "update_state",
                    "<quiz>" => "quiz",
                    "<ask>" => "ask",
                    _ => return self.say(&format!("{}\n", &line[emitted..]), acc, ch),
                };
                self.close_text(acc, ch);
                let key = self.key();
                let id = self.id();
                acc.start(key, json!({ "type": "tool_use", "id": id, "name": name, "input": {} }), ch);
                self.mode = if name == "write_lesson" || name == "update_state" {
                    acc.push(key, "{\"markdown\":\"", ch); // streamed as a JSON string so the canvas fills in live
                    Mode::Markdown(key, if name == "write_lesson" { "</lesson>" } else { "</state>" })
                } else {
                    Mode::Json(key, if name == "quiz" { "</quiz>" } else { "</ask>" })
                };
            }
            Mode::Markdown(key, close) if tag == close => {
                acc.push(key, "\"}", ch);
                acc.stop(key, ch);
                self.mode = Mode::Text;
            }
            Mode::Markdown(key, _) => {
                let escaped = serde_json::to_string(&format!("{line}\n")).unwrap_or_default();
                acc.push(key, &escaped[1..escaped.len() - 1], ch);
            }
            Mode::Json(key, close) if tag == close => {
                acc.stop(key, ch);
                self.mode = Mode::Text;
            }
            Mode::Json(key, _) => acc.push(key, &format!("{line}\n"), ch),
        }
    }

    fn say(&mut self, s: &str, acc: &mut Acc, ch: &Channel<Event>) {
        let key = match self.text {
            Some(k) => k,
            None if s.trim().is_empty() => return,
            None => {
                let k = self.key();
                acc.start(k, json!({ "type": "text", "text": "" }), ch);
                self.text = Some(k);
                k
            }
        };
        acc.push(key, s, ch);
    }

    fn close_text(&mut self, acc: &mut Acc, ch: &Channel<Event>) {
        if let Some(k) = self.text.take() {
            acc.stop(k, ch);
        }
    }

    /// End of output: flush the last line and close anything left open.
    pub fn finish(&mut self, acc: &mut Acc, ch: &Channel<Event>) {
        if !self.line.is_empty() {
            self.end_line(acc, ch);
        }
        match self.mode {
            Mode::Markdown(key, _) => {
                acc.push(key, "\"}", ch);
                acc.stop(key, ch);
            }
            Mode::Json(key, _) => acc.stop(key, ch),
            Mode::Text => {}
        }
        self.mode = Mode::Text;
        self.close_text(acc, ch);
    }
}

fn tail(s: &str) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join("\n")
}

pub async fn run(p: &Provider, system: &str, messages: &[Value], ch: &Channel<Event>, acc: &mut Acc) -> Result<(), String> {
    let claude = p.kind == "claude-code";
    let dir = std::env::temp_dir().join("rlearn-cli"); // empty folder: the CLI sees no project files
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // the material can exceed the 128 KB per-argument limit, so it travels on stdin with the conversation
    let (instructions, material) = match system.find(MATERIAL) {
        Some(i) => system.split_at(i),
        None => (system, ""),
    };
    // rlearn's own binary is the MCP server that gives both CLIs the lesson tools.
    // RLEARN_MCP_BIN lets tests point at the built app, since inside a test this process is the test runner.
    let exe = match std::env::var_os("RLEARN_MCP_BIN") {
        Some(path) => std::path::PathBuf::from(path),
        None => std::env::current_exe().map_err(|e| e.to_string())?,
    };
    let instructions = format!("{instructions}{MCP_PROTOCOL}");
    let history = transcript(messages, false);
    let mut cmd;
    let input;
    if claude {
        let mcp = json!({ "mcpServers": { "rlearn": { "command": exe, "args": ["--mcp"] } } }).to_string();
        cmd = Command::new("claude");
        cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence"])
            // no built-in tools, no personal settings, hooks or commands: only rlearn's server and tools
            .args(["--tools", "", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", &mcp])
            .args(["--allowedTools", MCP_TOOLS, "--max-turns", "12", "--system-prompt", &instructions])
            .env_remove("ANTHROPIC_API_KEY"); // use the signed-in subscription, never an API key from the environment
        if !p.model.is_empty() {
            cmd.args(["--model", &p.model]);
        }
        input = format!("{}\n\n{history}", material.trim());
    } else {
        cmd = Command::new("codex");
        cmd.args(["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only"])
            .args(["-c", &format!("mcp_servers.rlearn.command={}", json!(exe)), "-c", "mcp_servers.rlearn.args=[\"--mcp\"]"])
            .env_remove("OPENAI_API_KEY");
        for tool in TOOL_NAMES {
            cmd.args(["-c", &format!("mcp_servers.rlearn.tools.{tool}.approval_mode=\"approve\"")]); // non-interactive: pre-approve
        }
        if !p.model.is_empty() {
            cmd.args(["-m", &p.model]);
        }
        cmd.arg("-");
        input = format!("{instructions}{material}\n\n{history}"); // Codex takes the tutor's instructions on stdin
    }
    let name = if claude { "Claude Code" } else { "Codex" };
    let mut child = cmd
        .current_dir(&dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{name} isn't installed, or isn't on the PATH."),
            _ => e.to_string(),
        })?;

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await; // dropped afterwards, which closes stdin
    });
    // stderr goes to the Agent panel line by line as it arrives, and the tail is kept for error messages
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let err_ch = ch.clone();
    let errors = tokio::spawn(async move {
        let (mut lines, mut all) = (BufReader::new(stderr).lines(), String::new());
        while let Ok(Some(line)) = lines.next_line().await {
            log(&err_ch, format!("stderr  {line}"));
            all.push_str(&line);
            all.push('\n');
        }
        all
    });
    log(ch, format!("{} {}", if claude { "claude -p" } else { "codex exec" }, if p.model.is_empty() { "(default model)".into() } else { format!("--model {}", p.model) }));

    let mut actions = Actions::default();
    let mut failure: Option<String> = None;
    // Claude Code runs several model messages per turn (tool call, result, next call…) and block indexes restart
    // in each one, so every message gets its own key range. Thinking blocks are not kept: they only make sense
    // inside Claude Code's own session.
    let (mut base, mut tools) = (0u64, std::collections::HashSet::new());
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            log(ch, line);
            continue;
        };
        // everything except per-token text updates, which would flood the panel
        if v["type"] != "stream_event" || v["event"]["type"] != "content_block_delta" {
            log(ch, if line.len() > 600 { format!("{}…", &line[..line.floor_char_boundary(600)]) } else { line.clone() });
        }
        if claude {
            let e = &v["event"];
            let usage = &mut acc.reply.usage;
            match v["type"].as_str() {
                Some("stream_event") => {
                    let key = base + e["index"].as_u64().unwrap_or(0);
                    match e["type"].as_str() {
                        Some("message_start") => base += 1 << 20,
                        Some("content_block_start") if e["content_block"]["type"] == "tool_use" => {
                            actions.finish(acc, ch); // text before the call stays its own block
                            let mut block = e["content_block"].clone();
                            let name = block["name"].as_str().unwrap_or_default().trim_start_matches("mcp__rlearn__").to_owned();
                            block["name"] = json!(name);
                            acc.start(key, block, ch);
                            tools.insert(key);
                        }
                        Some("content_block_delta") => match e["delta"]["type"].as_str() {
                            Some("text_delta") => actions.feed(e["delta"]["text"].as_str().unwrap_or_default(), acc, ch),
                            Some("input_json_delta") if tools.contains(&key) => acc.push(key, e["delta"]["partial_json"].as_str().unwrap_or_default(), ch),
                            _ => {}
                        },
                        Some("content_block_stop") if tools.contains(&key) => acc.stop(key, ch),
                        _ => {}
                    }
                }
                Some("system") if v["subtype"] == "init" => {
                    usage.model = v["model"].as_str().unwrap_or_default().to_owned();
                    usage.subscription = v["apiKeySource"] == "none"; // signed-in subscription, not an API key
                }
                Some("rate_limit_event") => usage.limits = v["rate_limit_info"].clone(),
                Some("result") => {
                    let u = &v["usage"];
                    (usage.input, usage.cache_read, usage.cache_write, usage.output) =
                        (n(&u["input_tokens"]), n(&u["cache_read_input_tokens"]), n(&u["cache_creation_input_tokens"]), n(&u["output_tokens"]));
                    usage.cost = v["total_cost_usd"].as_f64(); // what the turn would cost at API prices
                    if v["is_error"] == true {
                        failure = Some(v["result"].as_str().unwrap_or("Claude Code failed.").to_owned());
                    }
                }
                _ => {}
            }
        } else if v["type"] == "item.completed" && v["item"]["type"] == "agent_message" {
            actions.feed(&format!("{}\n", v["item"]["text"].as_str().unwrap_or_default()), acc, ch);
        } else if v["type"] == "item.started" && v["item"]["type"] == "mcp_tool_call" && v["item"]["server"] == "rlearn" {
            // Codex reports each call whole: arguments are complete when it starts
            let it = &v["item"];
            actions.finish(acc, ch);
            base += 1;
            let key = (1 << 50) + base;
            let id = format!("toolu_codex_{}_{base}", std::process::id());
            acc.start(key, json!({ "type": "tool_use", "id": id, "name": it["tool"], "input": {} }), ch);
            acc.push(key, &it["arguments"].to_string(), ch);
            acc.stop(key, ch);
        } else if v["type"] == "turn.completed" {
            let u = &v["usage"]; // Codex counts cached tokens inside input_tokens
            let usage = &mut acc.reply.usage;
            (usage.input, usage.cache_read, usage.output) =
                (n(&u["input_tokens"]).saturating_sub(n(&u["cached_input_tokens"])), n(&u["cached_input_tokens"]), n(&u["output_tokens"]));
            usage.model = if p.model.is_empty() { "Codex default".into() } else { p.model.clone() };
            usage.subscription = true;
        } else if v["type"] == "turn.failed" || v["type"] == "error" {
            let msg = v["error"]["message"].as_str().or(v["message"].as_str()).unwrap_or("Codex failed.");
            failure = Some(msg.to_owned());
        }
    }
    actions.finish(acc, ch);
    let _ = writer.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = errors.await.unwrap_or_default();
    if let Some(f) = failure {
        return Err(f);
    }
    if !status.success() {
        return Err(format!("{name} stopped: {}", tail(&stderr)));
    }
    let any_tool = acc.reply.content.iter().any(|b| b["type"] == "tool_use");
    acc.reply.stop_reason = if any_tool { "tool_use" } else { "end_turn" }.into();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagged_blocks_become_tool_calls_even_when_split_across_chunks() {
        let ch: Channel<Event> = Channel::new(|_| Ok(()));
        let mut acc = Acc::default();
        let mut a = Actions::default();
        let text = "Let's begin.\n<les|son>\n# Title\n```mermaid\nA-->B\n```\n</lesson>\n<quiz>\n{\"question\":\"Q\",\"options\":[\"a\",\"b\"],\"correct_index\":1,\"explanation\":\"e\"}\n</quiz>\n";
        for chunk in text.split('|') {
            a.feed(chunk, &mut acc, &ch);
        }
        a.finish(&mut acc, &ch);
        acc.finish(&ch);
        let c = &acc.reply.content;
        assert_eq!(c.len(), 3);
        assert_eq!(c[0]["text"], "Let's begin.\n");
        assert_eq!(c[1]["name"], "write_lesson");
        assert_eq!(c[1]["input"]["markdown"], "# Title\n```mermaid\nA-->B\n```\n");
        assert_eq!(c[2]["name"], "quiz");
        assert_eq!(c[2]["input"]["correct_index"], 1);
        assert!(acc.reply.invalid.is_empty());
    }

    #[test]
    fn unterminated_and_invalid_blocks_are_reported_not_lost() {
        let ch: Channel<Event> = Channel::new(|_| Ok(()));
        let mut acc = Acc::default();
        let mut a = Actions::default();
        a.feed("<quiz>\n{not json}\n</quiz>\n<lesson>\nhalf a lesson", &mut acc, &ch);
        a.finish(&mut acc, &ch);
        acc.finish(&ch);
        assert_eq!(acc.reply.invalid.len(), 1);
        assert_eq!(acc.reply.content[1]["input"]["markdown"], "half a lesson\n");
    }

    #[test]
    fn transcript_for_tool_using_cli_writes_call_records_not_tags() {
        let history = vec![json!({ "role": "assistant", "content": [
            { "type": "tool_use", "id": "1", "name": "write_lesson", "input": { "markdown": "# A" } },
            { "type": "tool_use", "id": "2", "name": "quiz", "input": { "question": "Q" } }
        ] })];
        let t = transcript(&history, false);
        assert!(t.contains("[called write_lesson]\n# A") && t.contains("[called quiz] {\"question\":\"Q\"}") && !t.contains("<lesson>"));
    }

    #[test]
    fn state_blocks_become_update_state_calls() {
        let ch: Channel<Event> = Channel::new(|_| Ok(()));
        let mut acc = Acc::default();
        let mut a = Actions::default();
        a.feed("<state>\nKnows: plan reads the cloud\nNext: modules\n</state>\n", &mut acc, &ch);
        a.finish(&mut acc, &ch);
        acc.finish(&ch);
        let b = &acc.reply.content[0];
        assert_eq!((b["name"].as_str(), b["input"]["markdown"].as_str()), (Some("update_state"), Some("Knows: plan reads the cloud\nNext: modules\n")));
    }

    #[test]
    fn transcript_writes_past_actions_back_as_tags() {
        let history = vec![
            json!({ "role": "user", "content": "teach me" }),
            json!({ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "x" },
                { "type": "tool_use", "id": "1", "name": "write_lesson", "input": { "markdown": "# A\n" } },
                { "type": "tool_use", "id": "2", "name": "quiz", "input": { "question": "Q" } }
            ] }),
            json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "2", "content": "chose a" }] }),
        ];
        let t = transcript(&history, true);
        assert!(t.contains("## Learner\nteach me"));
        assert!(t.contains("<lesson>\n# A\n</lesson>"));
        assert!(t.contains("<quiz>\n{\"question\":\"Q\"}\n</quiz>"));
        assert!(t.contains("[app] chose a"));
        assert!(!t.contains("thinking")); // provider-internal blocks stay out
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// Real run against the signed-in CLI (uses a little of the subscription):
    /// CLI=claude-code cargo test --lib live -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn one_real_turn() {
        let kind = std::env::var("CLI").unwrap_or_else(|_| "claude-code".into());
        let p: Provider = serde_json::from_value(json!({ "id": kind, "kind": kind, "model": std::env::var("MODEL").unwrap_or_default() })).unwrap();
        let ch: Channel<Event> = Channel::new(|_| Ok(()));
        let mut acc = Acc::default();
        let msgs = vec![json!({ "role": "user", "content": "Test: put a lesson section whose markdown is just `# Hello` on the canvas, then quiz me on what 1+1 is with options 1 and 2." })];
        run(&p, "You are a tutor.", &msgs, &ch, &mut acc).await.unwrap();
        acc.finish(&ch);
        println!("{}", serde_json::to_string_pretty(&json!({ "content": acc.reply.content, "usage": acc.reply.usage })).unwrap());
        assert!(acc.reply.content.iter().any(|b| b["name"] == "quiz"));
    }
}
