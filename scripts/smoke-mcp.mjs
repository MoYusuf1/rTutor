import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const [binary, ...args] = process.argv.slice(2);
assert.ok(binary, "Pass the built app binary");
const requests = [
  { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  { id: 2, method: "tools/list" },
];
const result = spawnSync(binary, [...args, "--mcp"], {
  input: requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n") + "\n",
  encoding: "utf8", timeout: 60000, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
const replies = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
assert.equal(replies[0].result.serverInfo.name, "rlearn");
assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), ["next", "write_lesson", "quiz", "update_state", "ask", "search_material", "read_material", "phase", "say"]);
console.log("Built app MCP startup and tool discovery passed"); // tool calls need the running app (bridge.rs)
