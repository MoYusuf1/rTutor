//! Model providers. The conversation is always stored in Anthropic's message format (content blocks);
//! OpenAI-compatible APIs (OpenAI, NVIDIA, OpenRouter, Ollama, ...) get it converted. Both stream:
//! every block start / text delta / block stop is forwarded to the UI as it arrives.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use tauri::ipc::Channel;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub kind: String, // "anthropic" | "openai"
    #[serde(default)]
    pub base_url: String,
    pub model: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Start { index: usize, block: Value },
    Delta { index: usize, text: String },
    Stop { index: usize },
    /// A line for the Agent panel: what the provider is doing behind the scenes.
    Log { text: String },
}

pub(crate) fn log(ch: &Channel<Event>, text: impl Into<String>) {
    let _ = ch.send(Event::Log { text: text.into() });
}

#[derive(Serialize, Default)]
pub struct Reply {
    pub content: Vec<Value>,
    pub stop_reason: String,
    pub stop_details: Value,
    /// tool_use id -> raw input that wasn't valid JSON (sent back to the model as an error)
    pub invalid: Map<String, Value>,
    pub usage: Usage,
}

/// What one turn cost, normalized across providers. `input` is the uncached part of the prompt.
#[derive(Serialize, Default, Clone)]
pub struct Usage {
    pub model: String,
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub cost: Option<f64>,
    pub subscription: bool,
    pub limits: Value, // subscription windows (Claude Code: 5-hour and weekly), when the provider reports them
    pub ms: u64,
}

pub(crate) fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// Rough API prices, $ per million input / output tokens (cache reads 0.1x, cache writes 1.25x).
fn price(model: &str) -> Option<(f64, f64)> {
    const TABLE: [(&str, f64, f64); 8] = [
        ("claude-fable-5", 10.0, 50.0), ("claude-mythos-5", 10.0, 50.0), ("claude-opus-5-5", 4.0, 20.0), ("claude-opus-5", 5.0, 25.0),
        ("claude-opus-4", 5.0, 25.0), ("claude-sonnet-5", 2.0, 10.0), ("claude-sonnet-4-6", 3.0, 15.0), ("claude-haiku-4", 1.0, 5.0),
    ];
    TABLE.iter().find(|(prefix, ..)| model.starts_with(prefix)).map(|&(_, i, o)| (i, o))
}

pub(crate) fn api_cost(u: &Usage) -> Option<f64> {
    let (i, o) = price(&u.model)?;
    let input = u.input as f64 + u.cache_write as f64 * 1.25 + u.cache_read as f64 * 0.1;
    Some((input * i + u.output as f64 * o) / 1e6)
}

/// The tools the app runs in the UI; the model only decides when to call them.
pub fn tools() -> Vec<Value> {
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
        json!({ "name": "update_state",
            "description": "Replace your lesson state: a short Markdown note (under ~300 words) of what the learner reliably knows, their misconceptions and recent misses, the plan's nodes with status, and the next step. Call it after the plan is agreed and after every node's quiz-check. It is what you (or another tutor model) will rely on when older turns are summarized away, so keep it accurate and complete.",
            "input_schema": obj(json!({ "markdown": { "type": "string" } })) }),
        json!({ "name": "ask",
            "description": "Ask an ungraded multiple-choice question in the chat pane (goals, preferences, what to do next). The learner can also type their own answer.",
            "input_schema": obj(json!({ "question": { "type": "string" }, "options": { "type": "array", "items": { "type": "string" } } })) }),
    ]
}

pub async fn chat(http: &reqwest::Client, p: &Provider, key: &str, system: &str, messages: &[Value], ch: &Channel<Event>) -> Result<Reply, String> {
    let mut acc = Acc::default();
    match p.kind.as_str() {
        "anthropic" => anthropic(http, p, key, system, messages, ch, &mut acc).await?,
        "claude-code" | "codex" => crate::cli::run(p, system, messages, ch, &mut acc).await?,
        _ => openai(http, p, key, system, messages, ch, &mut acc).await?,
    }
    acc.finish(ch);
    let mut reply = acc.reply;
    reply.content = clean_fallback(reply.content);
    Ok(reply)
}

// ---------- stream accumulator ----------

#[derive(Default)]
pub(crate) struct Acc {
    pub(crate) reply: Reply,
    bufs: Vec<String>,
    stopped: Vec<bool>,
    keys: HashMap<u64, usize>, // provider's block index -> our index
}

impl Acc {
    pub(crate) fn start(&mut self, key: u64, block: Value, ch: &Channel<Event>) {
        let index = self.reply.content.len();
        self.keys.insert(key, index);
        self.bufs.push(String::new());
        self.stopped.push(false);
        self.reply.content.push(block.clone());
        let _ = ch.send(Event::Start { index, block });
    }

    pub(crate) fn push(&mut self, key: u64, text: &str, ch: &Channel<Event>) {
        if let Some(&index) = self.keys.get(&key) {
            self.bufs[index].push_str(text);
            let _ = ch.send(Event::Delta { index, text: text.to_owned() });
        }
    }

    fn block(&mut self, key: u64) -> Option<&mut Value> {
        let index = *self.keys.get(&key)?;
        self.reply.content.get_mut(index)
    }

    /// Writes the accumulated text into its field (text, thinking or the parsed tool input).
    pub(crate) fn stop(&mut self, key: u64, ch: &Channel<Event>) {
        let Some(&index) = self.keys.get(&key) else { return };
        if self.stopped[index] {
            return;
        }
        self.stopped[index] = true;
        let buf = std::mem::take(&mut self.bufs[index]);
        let b = &mut self.reply.content[index];
        let field = match b["type"].as_str() {
            Some("text") | Some("reasoning") => "text",
            Some("compaction") => "content",
            Some("thinking") => "thinking",
            Some("tool_use") | Some("server_tool_use") => "input",
            _ => "",
        };
        if field == "input" {
            if !buf.is_empty() {
                match serde_json::from_str::<Value>(&buf) {
                    Ok(v) => b["input"] = v,
                    Err(_) => {
                        b["input"] = json!({});
                        let id = b["id"].as_str().unwrap_or_default().to_owned();
                        self.reply.invalid.insert(id, Value::String(buf));
                    }
                }
            }
        } else if !field.is_empty() {
            let start = b[field].as_str().unwrap_or_default();
            b[field] = Value::String(format!("{start}{buf}"));
        }
        let _ = ch.send(Event::Stop { index });
    }

    pub(crate) fn finish(&mut self, ch: &Channel<Event>) {
        let keys: Vec<u64> = self.keys.keys().copied().collect();
        for k in keys {
            self.stop(k, ch);
        }
        if self.reply.stop_reason.is_empty() {
            self.reply.stop_reason = "end_turn".into();
        }
    }
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).map(String::from))
        .unwrap_or_else(|| body.to_owned());
    format!("{} {}: {msg}", status.as_u16(), status.canonical_reason().unwrap_or(""))
}

/// Reads a server-sent-event stream, calling `on` with each `data:` payload. `on` returns true to stop.
async fn sse(resp: reqwest::Response, mut on: impl FnMut(&str) -> Result<bool, String>) -> Result<(), String> {
    let status = resp.status();
    if !status.is_success() {
        return Err(api_error(status, &resp.text().await.unwrap_or_default()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
        buf.retain(|&b| b != b'\r');
        while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
            let event: Vec<u8> = buf.drain(..pos + 2).collect();
            let event = String::from_utf8_lossy(&event);
            let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect();
            if !data.is_empty() && on(&data.join("\n"))? {
                return Ok(());
            }
        }
    }
    Ok(())
}

// ---------- Anthropic ----------

fn starts(model: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| model.starts_with(p))
}

const COMPACTION: &str = "Summarize this tutoring session for the tutor who continues it. First copy the tutor's most recent \
lesson state (the latest update_state call) word for word. Then add what happened after it: nodes taught, quiz results and the \
learner's notes, open questions, and exactly where the lesson stopped. Keep it factual and specific; it replaces the turns above.";

fn compacts(model: &str) -> bool {
    starts(model, &["claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
                    "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5"])
}

async fn anthropic(http: &reqwest::Client, p: &Provider, key: &str, system: &str, messages: &[Value], ch: &Channel<Event>, acc: &mut Acc) -> Result<(), String> {
    let modern = starts(&p.model, &["claude-opus-5", "claude-fable-5", "claude-sonnet-5", "claude-mythos-5"]);
    let fallbacks = starts(&p.model, &["claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-mythos-5-1"]);
    // eager streaming lets the lesson text appear as it's written; a custom base URL may be a proxy that rejects the field
    let eager = p.base_url.is_empty();
    let mut tools: Vec<Value> = tools()
        .into_iter()
        .map(|mut t| {
            if eager {
                t["eager_input_streaming"] = json!(true);
            }
            t
        })
        .collect();

    // "reasoning" blocks come from other providers and Anthropic would reject them; only those messages are copied
    let messages: Vec<Cow<Value>> = messages
        .iter()
        .filter_map(|m| match m["content"].as_array() {
            Some(blocks) if blocks.iter().any(|b| b["type"] == "reasoning") => {
                let kept: Vec<&Value> = blocks.iter().filter(|b| b["type"] != "reasoning").collect();
                (!kept.is_empty()).then(|| Cow::Owned(json!({ "role": m["role"], "content": kept })))
            }
            _ => Some(Cow::Borrowed(m)),
        })
        .collect();

    let mut body = json!({
        "model": p.model, "max_tokens": 64000, "stream": true,
        "system": system, "messages": messages, "cache_control": { "type": "ephemeral" },
    });
    if modern {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
        body["output_config"] = json!({ "effort": "high" }); // teaching is intelligence-sensitive; Opus 5.5 defaults to medium
        tools.push(json!({ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }));
    }
    body["tools"] = json!(tools);

    let base = if p.base_url.is_empty() { "https://api.anthropic.com" } else { p.base_url.trim_end_matches('/') };
    let mut req = http
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01");
    let mut betas = vec![];
    if fallbacks {
        // on a safety decline the API retries on Anthropic's recommended model, inside the same stream
        body["fallbacks"] = json!("default");
        betas.push("server-side-fallback-2026-07-01");
    }
    if compacts(&p.model) {
        // past 150k input tokens the API summarizes older turns itself; rlearn just keeps appending
        body["context_management"] = json!({ "edits": [{ "type": "compact_20260112", "instructions": COMPACTION }] });
        betas.push("compact-2026-01-12");
    }
    if !betas.is_empty() {
        req = req.header("anthropic-beta", betas.join(","));
    }
    log(ch, format!("POST {base}/v1/messages  model={}  messages={}", p.model, messages.len()));
    let resp = req.json(&body).send().await.map_err(|e| e.to_string())?;
    log(ch, format!("HTTP {}", resp.status()));

    let streamed = sse(resp, |data| {
        let v: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
        let index = v["index"].as_u64().unwrap_or(0);
        match v["type"].as_str() {
            Some("message_start") => {
                let (m, u) = (&v["message"], &v["message"]["usage"]);
                let usage = &mut acc.reply.usage;
                usage.model = m["model"].as_str().unwrap_or(&p.model).to_owned();
                (usage.input, usage.cache_read, usage.cache_write) =
                    (n(&u["input_tokens"]), n(&u["cache_read_input_tokens"]), n(&u["cache_creation_input_tokens"]));
            }
            Some("content_block_start") => acc.start(index, v["content_block"].clone(), ch),
            Some("content_block_delta") => {
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => acc.push(index, d["text"].as_str().unwrap_or_default(), ch),
                    Some("thinking_delta") => acc.push(index, d["thinking"].as_str().unwrap_or_default(), ch),
                    Some("input_json_delta") => acc.push(index, d["partial_json"].as_str().unwrap_or_default(), ch),
                    Some("signature_delta") => {
                        if let Some(b) = acc.block(index) {
                            b["signature"] = d["signature"].clone();
                        }
                    }
                    _ if d["content"].is_string() => acc.push(index, d["content"].as_str().unwrap_or_default(), ch), // compaction summary
                    Some("citations_delta") => {
                        if let Some(b) = acc.block(index) {
                            if !b["citations"].is_array() {
                                b["citations"] = json!([]);
                            }
                            b["citations"].as_array_mut().unwrap().push(d["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => acc.stop(index, ch),
            Some("message_delta") => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    acc.reply.stop_reason = r.to_owned();
                }
                if !v["delta"]["stop_details"].is_null() {
                    acc.reply.stop_details = v["delta"]["stop_details"].clone();
                }
                if let Some(out) = v["usage"]["output_tokens"].as_u64() {
                    acc.reply.usage.output = out; // cumulative
                }
            }
            Some("error") => return Err(v["error"]["message"].as_str().unwrap_or("stream error").to_owned()),
            _ => {}
        }
        Ok(false)
    })
    .await;
    acc.reply.usage.cost = api_cost(&acc.reply.usage);
    streamed
}

/// After a mid-output server-side fallback, blocks before the last `fallback` marker must not be echoed back
/// except text and complete server-tool pairs (and their tool_use must not run).
pub fn clean_fallback(content: Vec<Value>) -> Vec<Value> {
    let Some(last) = content.iter().rposition(|b| b["type"] == "fallback") else { return content };
    let results: Vec<String> = content.iter().filter_map(|b| b["tool_use_id"].as_str().map(String::from)).collect();
    let paired = |b: &Value| match (b["type"].as_str(), b["id"].as_str(), b["tool_use_id"].as_str()) {
        (Some("server_tool_use"), Some(id), _) => results.iter().any(|r| r == id),
        (Some(t), _, Some(_)) => t.ends_with("_tool_result"),
        _ => false,
    };
    content
        .iter()
        .enumerate()
        .filter(|(i, b)| *i >= last || b["type"] == "text" || paired(b))
        .map(|(_, b)| b.clone())
        .collect()
}

// ---------- OpenAI-compatible ----------

fn text_of(blocks: &[Value]) -> String {
    blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n")
}

pub fn to_openai(system: &str, messages: &[Value]) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system })];
    let mut calls_seen = std::collections::HashSet::new();
    for m in messages {
        let Some(blocks) = m["content"].as_array() else {
            out.push(json!({ "role": m["role"], "content": m["content"] }));
            continue;
        };
        if m["role"] == "user" {
            for b in blocks.iter().filter(|b| b["type"] == "tool_result") {
                let content = b["content"].as_str().map(String::from).unwrap_or_else(|| b["content"].to_string());
                if calls_seen.contains(b["tool_use_id"].as_str().unwrap_or_default()) {
                    out.push(json!({ "role": "tool", "tool_call_id": b["tool_use_id"], "content": content }));
                } else {
                    out.push(json!({ "role": "user", "content": format!("[app] {content}") })); // its call was compacted away
                }
            }
            let text = text_of(blocks);
            if !text.is_empty() {
                out.push(json!({ "role": "user", "content": text }));
            }
        } else {
            // thinking, web search and fallback blocks are Anthropic-only; text and tool calls carry over
            calls_seen.extend(blocks.iter().filter(|b| b["type"] == "tool_use").filter_map(|b| b["id"].as_str().map(String::from)));
            let calls: Vec<Value> = blocks
                .iter()
                .filter(|b| b["type"] == "tool_use")
                .map(|b| json!({ "id": b["id"], "type": "function", "function": { "name": b["name"], "arguments": b["input"].to_string() } }))
                .collect();
            let text = text_of(blocks);
            let mut msg = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
            if !calls.is_empty() {
                msg["tool_calls"] = json!(calls);
            }
            out.push(msg);
        }
    }
    out
}

const REASONING: u64 = u64::MAX;
const TEXT: u64 = u64::MAX - 1;

async fn openai(http: &reqwest::Client, p: &Provider, key: &str, system: &str, messages: &[Value], ch: &Channel<Event>, acc: &mut Acc) -> Result<(), String> {
    let tools: Vec<Value> = tools()
        .into_iter()
        .map(|t| json!({ "type": "function", "function": { "name": t["name"], "description": t["description"], "parameters": t["input_schema"] } }))
        .collect();
    let mut body = json!({ "model": p.model, "stream": true, "messages": to_openai(system, messages), "tools": tools,
                           "stream_options": { "include_usage": true } });
    let url = format!("{}/chat/completions", p.base_url.trim_end_matches('/'));
    let send = |body: &Value| {
        let req = http.post(&url).json(body);
        if key.is_empty() { req } else { req.bearer_auth(key) }.send()
    };
    log(ch, format!("POST {url}  model={}  messages={}", p.model, messages.len()));
    let mut resp = send(&body).await.map_err(|e| e.to_string())?;
    log(ch, format!("HTTP {}", resp.status()));
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        // some OpenAI-compatible servers reject the usage option; retry once without it
        let text = resp.text().await.unwrap_or_default();
        if !text.contains("stream_options") {
            return Err(api_error(reqwest::StatusCode::BAD_REQUEST, &text));
        }
        body.as_object_mut().map(|o| o.remove("stream_options"));
        resp = send(&body).await.map_err(|e| e.to_string())?;
    }
    acc.reply.usage.model = p.model.clone();

    sse(resp, |data| {
        if data == "[DONE]" {
            return Ok(true);
        }
        let v: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
        if let Some(msg) = v["error"]["message"].as_str() {
            return Err(msg.to_owned());
        }
        if let Some(u) = v["usage"].as_object() {
            let cached = n(&u.get("prompt_tokens_details").map_or(Value::Null, |d| d["cached_tokens"].clone()));
            let usage = &mut acc.reply.usage;
            (usage.input, usage.cache_read, usage.output) =
                (n(&u["prompt_tokens"]).saturating_sub(cached), cached, n(&u["completion_tokens"]));
        }
        if let Some(m) = v["model"].as_str() {
            acc.reply.usage.model = m.to_owned();
        }
        let choice = &v["choices"][0];
        let d = &choice["delta"];
        let reasoning = d["reasoning_content"].as_str().or(d["reasoning"].as_str()).unwrap_or_default();
        if !reasoning.is_empty() {
            if !acc.keys.contains_key(&REASONING) {
                acc.start(REASONING, json!({ "type": "reasoning", "text": "" }), ch);
            }
            acc.push(REASONING, reasoning, ch);
        }
        if let Some(text) = d["content"].as_str().filter(|t| !t.is_empty()) {
            if !acc.keys.contains_key(&TEXT) {
                acc.start(TEXT, json!({ "type": "text", "text": "" }), ch);
            }
            acc.push(TEXT, text, ch);
        }
        for tc in d["tool_calls"].as_array().into_iter().flatten() {
            let i = tc["index"].as_u64().unwrap_or(0);
            if !acc.keys.contains_key(&i) {
                let id = tc["id"].as_str().map(String::from).unwrap_or_else(|| format!("call_{i}"));
                acc.start(i, json!({ "type": "tool_use", "id": id, "name": tc["function"]["name"], "input": {} }), ch);
            }
            acc.push(i, tc["function"]["arguments"].as_str().unwrap_or_default(), ch);
        }
        if let Some(r) = choice["finish_reason"].as_str() {
            acc.reply.stop_reason = match r {
                "tool_calls" => "tool_use",
                "length" => "max_tokens",
                "content_filter" => "refusal",
                _ => "end_turn",
            }
            .into();
        }
        Ok(false)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_history_to_openai() {
        let history = vec![
            json!({ "role": "user", "content": "teach me terraform" }),
            json!({ "role": "assistant", "content": [
                { "type": "thinking", "thinking": "plan", "signature": "x" },
                { "type": "text", "text": "Let's start." },
                { "type": "tool_use", "id": "t1", "name": "quiz", "input": { "question": "Q?" } }
            ] }),
            json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "chose a" }] }),
        ];
        let out = to_openai("SYS", &history);
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], json!({ "role": "system", "content": "SYS" }));
        assert_eq!(out[2]["content"], "Let's start."); // thinking dropped
        assert_eq!(out[2]["tool_calls"][0]["function"]["arguments"], r#"{"question":"Q?"}"#);
        assert_eq!(out[3], json!({ "role": "tool", "tool_call_id": "t1", "content": "chose a" }));
    }

    #[test]
    fn tool_results_without_their_call_become_text() {
        let history = vec![json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "gone", "content": "chose b" }] })];
        assert_eq!(to_openai("S", &history)[1], json!({ "role": "user", "content": "[app] chose b" }));
    }

    #[test]
    fn drops_unechoable_blocks_before_fallback() {
        let content = vec![
            json!({ "type": "thinking", "thinking": "a" }),
            json!({ "type": "text", "text": "partial" }),
            json!({ "type": "tool_use", "id": "t1", "name": "quiz", "input": {} }),
            json!({ "type": "server_tool_use", "id": "s1", "name": "web_search" }),
            json!({ "type": "fallback" }),
            json!({ "type": "tool_use", "id": "t2", "name": "quiz", "input": {} }),
        ];
        let kept: Vec<_> = clean_fallback(content).iter().map(|b| b["type"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kept, ["text", "fallback", "tool_use"]);
        let plain = vec![json!({ "type": "thinking" }), json!({ "type": "tool_use" })];
        assert_eq!(clean_fallback(plain.clone()), plain);
    }
}
