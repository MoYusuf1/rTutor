//! `rlearn --mcp`: a minimal MCP server (JSON-RPC over stdio) that gives Claude Code rlearn's tools.
//!
//! It answers every call at once. rlearn itself reads the calls from Claude Code's output stream as they
//! are written (that's how the lesson streams onto the canvas) and runs them in the app; a quiz's answer
//! reaches the tutor in the next turn. So this server needs no connection back to the app.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn reply(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// The answer to one JSON-RPC message, or None for notifications.
pub fn handle(msg: &Value) -> Option<Value> {
    let id = msg.get("id")?; // no id: a notification, never answered
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "rlearn", "version": env!("CARGO_PKG_VERSION") },
        }),
        "ping" => json!({}),
        "tools/list" => json!({
            "tools": crate::llm::tools().iter().map(|t| json!({
                "name": t["name"], "description": t["description"], "inputSchema": t["input_schema"],
            })).collect::<Vec<_>>()
        }),
        "tools/call" => {
            let text = match msg["params"]["name"].as_str().unwrap_or_default() {
                "write_lesson" => "Added to the lesson canvas.",
                "update_state" => "Lesson state saved.",
                "quiz" | "ask" => "It is on the learner's screen now. End your turn here; their answer arrives in the next message.",
                other => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("Unknown tool: {other}") } })),
            };
            json!({ "content": [{ "type": "text", "text": text }] })
        }
        method => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } })),
    };
    Some(reply(id, result))
}

/// Serves until stdin closes (when Claude Code exits).
pub fn serve() {
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(answer) = handle(&msg) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
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
        assert!(handle(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
        let list = handle(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        let names: Vec<_> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_owned()).collect();
        assert_eq!(names, ["write_lesson", "quiz", "update_state", "ask"]);
        assert!(list["result"]["tools"][1]["inputSchema"]["properties"]["correct_index"].is_object());
        let call = handle(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "quiz", "arguments": {} } })).unwrap();
        assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("End your turn"));
        let bad = handle(&json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" })).unwrap();
        assert_eq!(bad["error"]["code"], -32601);
    }
}
