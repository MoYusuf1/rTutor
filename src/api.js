// API providers (Anthropic, OpenAI-compatible): the provider settings, and the tutor loop that streams each turn
// and runs its tool calls here.
import { invoke, Channel } from "@tauri-apps/api/core";
import { $, el, toast } from "./dom.js";
import { app, fmt, saveSettings } from "./state.js";
import { liveMarkdown, log, note, say, thinking, workBody } from "./chat.js";
import { partialField } from "./markdown.js";
import { executeTool, forTutor } from "./tools.js";
import { setWorking } from "./composer.js";
import { showWho } from "./who.js";
import { handOverToApi } from "./agents.js";

export const PRESETS = {
  nvidia: { label: "NVIDIA", kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", model: "moonshotai/kimi-k3", logo: "nvidia" },
  anthropic: { label: "Anthropic", kind: "anthropic", baseUrl: "", model: "claude-opus-5-5", logo: "anthropic" },
  openai: { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "", logo: "openai" },
  openrouter: { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "", logo: "openrouter" },
  ollama: { label: "Ollama", kind: "openai", baseUrl: "http://localhost:11434/v1", model: "", keyless: true },
  custom: { label: "Custom", kind: "openai", baseUrl: "", model: "" },
};
export const provider = (id = app.settings.api) => ({ id, ...PRESETS[id], ...app.settings.providers[id] });

/** The chosen provider has a model and (unless it needs none) a key. */
export async function ready() {
  const p = provider();
  if (!p.model) return false;
  return p.keyless || (await invoke("has_api_key", { provider: p.id }).catch(() => false));
}

// ---------- the provider dialog ----------

let chosen = null;

async function pickProvider(id) {
  chosen = id;
  $("#p-status").textContent = "";
  const p = provider(id);
  for (const b of $("#p-list").children) b.setAttribute("aria-checked", String(b.dataset.id === id));
  $("#p-model").value = p.model;
  $("#p-base").value = p.baseUrl ?? "";
  $("#p-base-row").hidden = p.kind !== "openai";
  $("#p-key-row").hidden = !!p.keyless;
  $("#p-key").value = "";
  $("#p-key").placeholder = !p.keyless && (await invoke("has_api_key", { provider: id }).catch(() => false)) ? "••••••••••••" : "";
}

$("#p-list").append(
  ...Object.entries(PRESETS).map(([id, p]) => {
    const b = el("button", "", p.label);
    b.type = "button";
    b.dataset.id = id;
    b.setAttribute("role", "radio");
    b.onclick = () => pickProvider(id);
    return b;
  }),
);

export async function openModel() {
  $("#pop").hidden = true;
  await pickProvider(app.settings.api);
  $("#settings").showModal();
  $("#p-model").focus();
}

$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  const s = app.settings;
  s.api = chosen;
  s.active = "api";
  s.providers[chosen] = { model: $("#p-model").value.trim(), baseUrl: $("#p-base").value.trim() };
  try {
    if ($("#p-key").value.trim()) await invoke("set_api_key", { provider: chosen, key: $("#p-key").value.trim() });
    await invoke("save_settings", { settings: s });
  } catch (e) {
    toast(e);
  }
  showWho();
  handOverToApi(); // a message that was waiting for an agent goes to the provider just chosen
});

$("#p-test").onclick = async () => {
  const button = $("#p-test");
  button.disabled = true;
  $("#p-status").textContent = "Connecting… This uses a small provider request.";
  const p = { ...provider(chosen), model: $("#p-model").value.trim(), baseUrl: $("#p-base").value.trim() };
  try {
    const key = $("#p-key").value.trim();
    if (key && !p.keyless) await invoke("set_api_key", { provider: p.id, key });
    $("#p-status").textContent = await invoke("test_provider", { provider: p });
  } catch (e) {
    $("#p-status").textContent = `Connection failed: ${e}`;
  } finally {
    button.disabled = false;
  }
};

export function useApi() {
  app.settings.active = "api";
  saveSettings();
}

// ---------- status: what the provider reports about each turn ----------

// context window by model family; unknown models just show the size
const windowOf = (m = "") => (/haiku/.test(m) ? 2e5 : /^claude-(opus|sonnet|fable|mythos)-[45]/.test(m) ? 1e6 : 0);

function seg(label, value, frac, title) {
  const s = el("span", "seg");
  s.title = title ?? "";
  s.append(label);
  if (frac != null) {
    const b = el("span", `bar${frac > 0.9 ? " full" : frac > 0.7 ? " warn" : ""}`);
    const i = el("i");
    i.style.width = `${Math.min(100, Math.round(frac * 100))}%`;
    b.append(i);
    s.append(b);
  }
  if (value) s.append(el("b", "", value));
  return s;
}

/** The usage line: context and cache share of the last turn, and what the lesson cost so far. */
export async function meter() {
  const s = await invoke("stats", { lesson: app.lesson?.id ?? null }).catch(() => ({}));
  const parts = [];
  const last = s.last;
  if (last) {
    const ctx = last.input + last.cache_read + last.cache_write;
    const win = windowOf(last.model);
    parts.push(seg("context", fmt(ctx), win ? ctx / win : null, win ? `${fmt(ctx)} of ${fmt(win)} tokens` : `${fmt(ctx)} tokens sent last turn`));
    if (ctx) parts.push(seg("cached", `${Math.round((last.cache_read / ctx) * 100)}%`, null, "Share of last turn's prompt read from cache"));
  }
  const t = s.totals;
  if (t?.turns && t.cost != null) parts.push(seg("lesson", `$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}`, null, `${t.turns} turns, ${fmt(t.input)} in, ${fmt(t.output)} out`));
  const box = el("div", "meter");
  box.append(...parts);
  return box;
}

// ---------- the tutor loop ----------

let busy = null; // the lesson an API turn is running for
let turn = { live: new Map(), invalid: {}, truncated: false }; // the latest reply's streamed sections and problems

export const apiWorking = () => busy === app.lesson?.id;

/** Streams one turn into the chat and canvas as it arrives. */
async function streamTurn(content) {
  const mine = app.gen;
  thinking(true);
  const views = new Map();
  const live = new Map(); // tool_use id → live canvas section

  const ch = new Channel();
  ch.onmessage = (e) => {
    if (mine !== app.gen) return;
    if (e.type === "start") {
      const b = e.block;
      const view = { buf: "" };
      if (b.type === "text") (view.md = liveMarkdown(log())), (view.md.box.className = "msg bot");
      else if ((b.type === "thinking" || b.type === "reasoning") && workBody()) view.md = liveMarkdown(workBody());
      else if (b.type === "tool_use" && b.name === "write_lesson") {
        view.md = liveMarkdown($("#canvas-body"));
        view.lesson = true;
        live.set(b.id, view.md);
      } else if (b.type === "server_tool_use") view.note = note("Searching the web…");
      else if (b.type === "fallback") note(`Continued on ${b.to?.model ?? "a fallback model"}.`);
      else if (b.type === "compaction") note("Earlier turns summarized to save tokens.");
      if (b.type === "text" || view.lesson) thinking(false);
      views.set(e.index, view);
    } else if (e.type === "delta") {
      const v = views.get(e.index);
      if (!v) return;
      v.buf += e.text;
      if (v.lesson) v.md.set(partialField(v.buf, "markdown"));
      else if (v.md) v.md.set(v.buf);
    } else if (e.type === "stop") {
      const v = views.get(e.index);
      if (v?.note) v.note.textContent = `Searched the web: ${partialField(v.buf, "query")}`;
      else if (v?.md && !v.lesson) v.md.finish();
    }
  };

  try {
    const reply = await invoke("send", { provider: provider(), lesson: app.lesson.id, content, onEvent: ch });
    const kept = new Set(reply.content.filter((b) => b.type === "tool_use").map((b) => b.id));
    for (const [id, view] of live) if (!kept.has(id)) view.box.remove(); // e.g. dropped by a fallback
    return { reply, live };
  } finally {
    if (mine === app.gen) thinking(false);
  }
}

const pendingCalls = () => (Array.isArray(app.lesson?.last) ? app.lesson.last.filter((b) => b.type === "tool_use") : []);

/** Runs a call once: a call already answered (the lesson was reopened mid-turn) gets its saved result. */
async function runTool(call) {
  const l = app.lesson;
  if (l.toolResults[call.id]) {
    turn.live.get(call.id)?.box.remove();
    return l.toolResults[call.id];
  }
  const result = await executeTool(call, turn);
  if (result.abandoned) return result;
  await invoke("save_tool_result", { lesson: l.id, result });
  l.toolResults[call.id] = result;
  return result;
}

const MAX_ROUNDS = 25; // model calls per learner message

/** `first`: the learner's message; undefined continues with pending tool calls. */
async function runLoop(first) {
  const mine = app.gen;
  const me = app.lesson;
  busy = me.id;
  let content = first;
  let rounds = 0; // a model that keeps calling tools would otherwise spend tokens without end
  try {
    for (;;) {
      if (++rounds > MAX_ROUNDS) {
        note("The tutor took too many steps in a row, so it was stopped. Send a message to carry on.");
        break;
      }
      if (content === undefined) {
        const calls = pendingCalls();
        if (!calls.length) break;
        content = [];
        for (const call of calls) {
          const r = await runTool(call);
          if (r.abandoned || mine !== app.gen) return; // asked again when the lesson is reopened
          content.push(forTutor(r)); // all results go back in ONE message
        }
      }
      const { reply, live } = await streamTurn(content);
      me.last = reply.content;
      if (mine !== app.gen) return; // saved by Rust; picked up when the lesson is reopened
      turn = { live, invalid: reply.invalid, truncated: reply.stop_reason === "max_tokens" };
      if (reply.stop_reason === "refusal") {
        note(`The model declined to continue${reply.stop_details?.category ? ` (${reply.stop_details.category})` : ""}. Try rephrasing.`);
        break;
      }
      content = reply.stop_reason === "pause_turn" ? null : undefined; // null resumes a paused web search
    }
  } catch (e) {
    if (mine === app.gen && e !== "Stopped.") note(`Something went wrong: ${e}`);
  } finally {
    if (busy === me.id) busy = null;
    setWorking(); // the sidebar refreshes itself when a title changes (canvas.js), not after every turn
  }
}

/** `shown`: what the chat shows for it, or null when it is already there (a message handed over from an agent). */
export async function sendToApi(text, shown) {
  if (busy === app.lesson.id) return note("One moment, the tutor is still answering.");
  if (!(await ready())) return openModel();
  if (shown != null) say(shown, "user");
  runLoop(text);
}

export async function stopApi() {
  if (busy === app.lesson.id) await invoke("stop_turn", { lesson: app.lesson.id }).catch(() => {});
}

/** A lesson closed in the middle of a quiz: ask it again. */
export function resumeApi() {
  if (pendingCalls().length) runLoop();
}
