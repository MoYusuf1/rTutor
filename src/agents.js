// Terminal agents (Claude Code, Codex, any MCP client): each subject's agent runs in its folder, pulls the
// learner's messages through the bridge, and calls the lesson tools, which run here.
import { invoke, Channel } from "@tauri-apps/api/core";
import { $, el } from "./dom.js";
import { agentLook } from "./icons.js";
import { app, saveSettings, short, subjectDir } from "./state.js";
import { chatNode, note, refreshWork, say, step, thinking } from "./chat.js";
import { openQuestion } from "./cards.js";
import { executeTool } from "./tools.js";
import { renderStart } from "./start.js";
import { setWorking } from "./composer.js";
import { renderPop, showWho, openModel } from "./who.js";
import { sendToApi } from "./api.js";
import { closeTab, installed, newTab, quickStarts, renderTabs, selectTab, setDrawer, startAt, tabs } from "./terminal.js";

export let agents = []; // [{ id, name, cwd, cmd, busy, waiting }]
let activeAgent = null;
let agentLesson = null; // the lesson the agent is working on
let sentWaiting = false; // a message was sent and no agent has picked it up yet
let lastSent = "";
const starting = new Map(); // subject folder → { label, since }: agents rTutor is starting there

export const usingAgent = () => app.settings.active === "agent";

const within = (cwd = "", dir = "") => !!dir && (cwd === dir || cwd.startsWith(`${dir}/`) || cwd.startsWith(`${dir}\\`));

/** The agent teaching lesson `l`: the one in its subject's folder, else the active one (if its own isn't starting). */
export function agentFor(l = app.lesson) {
  const dir = l ? subjectDir(l.folder) : "";
  return agents.find((a) => within(a.cwd, dir)) ?? (starting.has(dir) ? undefined : agents.find((a) => a.id === activeAgent));
}

const startingFor = (l = app.lesson) => starting.get(l ? subjectDir(l.folder) : "");

/** Whether the tutor is on it: working, or about to have the message (connected or starting). */
const agentThinking = () => (sentWaiting && !!(agentFor() || startingFor())) || !!agentFor()?.busy;
export const agentWorking = () => agentLesson === app.lesson?.id && agentThinking();

/** What the "Thinking…" block says before the agent has the message; null once it works on it. */
export function agentStatus() {
  if (!sentWaiting) return null;
  const a = agentFor();
  if (a?.busy) return null;
  const secs = (since) => Math.round((Date.now() - since) / 1000);
  if (a) return `Waiting for ${agentLook(a.name).label} to pick this up…`;
  const s = startingFor();
  if (!s) return null;
  return secs(s.since) < 8 ? `Starting ${s.label}…` : `${s.label} is asking something in its terminal below`;
}

/** Opening or messaging a lesson: start its subject's agent there if it has none (with the agent picked to start
 *  automatically). It starts out of sight; if it isn't listening soon it's probably asking something, so its
 *  terminal opens. */
export async function ensureAgent(l = app.lesson) {
  const dir = l && subjectDir(l.folder);
  const kind = app.settings.main?.kind;
  if (!dir || !kind || !usingAgent() || agents.some((a) => within(a.cwd, dir)) || starting.has(dir) || tabs.some((t) => t.cwd === dir)) return;
  const [label, , cmd] = quickStarts()[kind];
  starting.set(dir, { label, since: Date.now() });
  const tab = await newTab(dir, cmd);
  invoke("log_note", { line: `starting ${label} for ${short(dir)}` }).catch(() => {});
  setTimeout(() => {
    if (!starting.has(dir)) return;
    invoke("log_note", { line: `the agent for ${short(dir)} isn't listening after 8s; showing its terminal` }).catch(() => {});
    setDrawer(true, { where: false });
    selectTab(tab);
    refreshWork();
  }, 8000);
  setTimeout(() => starting.delete(dir) && refreshWork(), 120000); // never came up: stop saying it's starting
}

/** Starts agent `kind` for the open subject, or asks where when no subject is open. Picking one is the choice to
 *  start it for every subject from now on. */
export function startAgent(kind) {
  $("#pop").hidden = true;
  const dir = subjectDir(app.lesson ? app.lesson.folder : app.target);
  if (!dir) return startAt(kind);
  app.settings.main = { kind };
  saveSettings();
  ensureAgent(app.lesson ?? { folder: app.target });
  if (app.lesson && sentWaiting) thinking(true);
  showWho();
}

/** No tutor runs for this subject and none is starting: say so where the learner looks, with the ways to get one. */
function needTutor() {
  const box = el("div", "card setup");
  box.append(el("div", "q", "No tutor is running for this subject yet. Your message will wait for one."));
  const row = el("div", "setup-row");
  for (const [kind, [label]] of Object.entries(quickStarts())) {
    const b = el("button", installed.includes(kind) ? "primary" : "", `Start ${label}`);
    b.type = "button";
    b.title = installed.includes(kind) ? "Starts it in this subject's folder" : "Not found on this computer; install it first";
    b.onclick = () => { startAgent(kind); box.remove(); };
    row.append(b);
  }
  const api = el("button", "", "Use an API key");
  api.type = "button";
  api.onclick = () => openModel();
  row.append(api);
  box.append(row);
  chatNode(box);
}

export async function sendToAgent(text, shown) {
  const l = app.lesson;
  if (sentWaiting && lastSent === text) return note("Already sent. It goes out as soon as the tutor picks it up."); // not twice
  lastSent = text;
  say(shown, "user");
  sentWaiting = true;
  agentLesson = l.id;
  await ensureAgent();
  if (!agentFor() && !startingFor()) needTutor();
  else thinking(true);
  await invoke("agent_send", { lesson: l.id, text, own: !!startingFor() }).catch((e) => { sentWaiting = false; thinking(false); note(String(e)); });
  // an agent that isn't waiting in `next` won't see the message until it is reminded
  setTimeout(() => {
    const a = agentFor();
    if (!sentWaiting || !a || a.waiting || a.busy) return;
    const tab = agentTab(a);
    // it may be asking something in its terminal (trust this folder? allow a tool?): show it
    if (tab) {
      step(`${agentLook(a.name).label} isn't listening yet; its terminal is open below`);
      setDrawer(true, { where: false });
      selectTab(tab);
    } else note(`${agentLook(a.name).label} isn't listening. In its terminal, tell it: ${NUDGE}`);
    invoke("log_note", { line: `agent hadn't picked up the message after 3s; ${tab ? "reminded it in its terminal" : "its terminal isn't rTutor's"}` }).catch(() => {});
  }, 3000);
}

/** The agent's own terminal tab, when it runs in one of rTutor's. */
export const agentTab = (a = agentFor()) => a && tabs.find((t) => t.cwd === a.cwd);
const NUDGE = "Call the rTutor next tool now and keep tutoring through rTutor's tools.";

export async function stopAgent() {
  sentWaiting = false;
  await invoke("agent_stop", { id: agentFor()?.id ?? null, lesson: app.lesson?.id ?? null }).catch(() => {});
  // interrupt it right away (Esc stops Claude Code and Codex mid-thought), then send it back to listening
  const tab = agentTab();
  if (tab) {
    await invoke("term_write", { tab: tab.id, data: "\x1b" }).catch(() => {});
    setTimeout(() => invoke("term_write", { tab: tab.id, data: `${NUDGE}\r` }).catch(() => {}), 700);
  }
}

/** Restarts an agent in its own terminal with the model and effort just picked. Its lesson memory is the lesson
 *  state and notes, so it picks up where it left off. */
export async function restartAgent(a, kind) {
  const tab = agentTab(a);
  if (!tab) return;
  const [label, , cmd] = quickStarts()[kind];
  invoke("log_note", { line: `restarting ${label} in ${short(tab.cwd)} with ${JSON.stringify(app.settings.agentPrefs?.[kind] ?? {})}` }).catch(() => {});
  starting.set(tab.cwd, { label, since: Date.now() }); // its messages wait for it rather than going to another agent
  closeTab(tab);
  await newTab(tab.cwd, cmd);
  if (app.lesson) note(`Switching ${label}'s model. It picks up from its notes.`);
}

/** A subject was renamed, so its folder moved: its agent, running in the old folder, restarts in the new one. */
export async function subjectMoved(from, to) {
  for (const tab of tabs.filter((t) => within(t.cwd, from))) {
    const a = agents.find((x) => x.cwd === tab.cwd);
    const kind = a && { claude: "claude", openai: "codex" }[agentLook(a.name).logo];
    closeTab(tab);
    if (kind) {
      starting.set(to, { label: quickStarts()[kind][0], since: Date.now() });
      await newTab(to, quickStarts()[kind][2]);
    }
  }
}

/** A subject was deleted: its agent stops (its folder is gone). */
export function subjectGone(dir) {
  for (const tab of tabs.filter((t) => within(t.cwd, dir))) closeTab(tab);
  starting.delete(dir);
}

/** The learner switched to an API provider while a message waited for an agent: it goes to the API instead. */
export async function handOverToApi() {
  if (!sentWaiting || !app.lesson || agentLesson !== app.lesson.id) return;
  sentWaiting = false;
  await invoke("agent_stop", { id: null, lesson: app.lesson.id }).catch(() => {});
  sendToApi(lastSent, null);
}

/** Reopening the lesson the agent is working on: show that it still is. */
export function resumeAgentWork() {
  if (app.lesson?.id === agentLesson && agentThinking()) thinking(true);
}

export function useAgent(id) {
  app.settings.active = "agent";
  saveSettings();
  invoke("agent_use", { id });
}

let agentShape = "";
const events = new Channel();
events.onmessage = async (e) => {
  if (e.type === "agents") {
    agents = e.agents;
    activeAgent = e.active;
    for (const a of agents) for (const d of starting.keys()) if (within(a.cwd, d)) starting.delete(d);
    if (agentFor()?.busy) sentWaiting = false;
    if (app.lesson?.id === agentLesson) thinking(!openQuestion() && agentThinking());
    refreshWork();
    setWorking();
    showWho();
    // which agents run where changes rarely; busy flips on every turn and needs only the lines above
    const shape = agents.map((a) => `${a.id}\t${a.cwd}`).join("\n");
    if (!$("#pop").hidden) renderPop();
    if (shape === agentShape) return;
    agentShape = shape;
    renderTabs();
    if (!$("#start").hidden) renderStart();
  } else if (e.type === "call") {
    const to = app.lesson?.id === e.lesson ? app.lesson : { id: e.lesson, sections: 1, state: "" };
    agentLesson = e.lesson;
    if (app.lesson?.id === e.lesson && !openQuestion() && !["say", "quiz", "ask", "true_false", "short_answer"].includes(e.name)) thinking(true); // its steps show as they happen
    let result;
    try {
      result = await executeTool({ id: `agent-${e.id}`, name: e.name, input: e.input ?? {} }, { live: new Map(), invalid: {}, truncated: false }, to);
    } catch (err) {
      result = { content: String(err), is_error: true };
    }
    await invoke("agent_result", { id: e.id, result: { content: result.content, is_error: !!result.is_error } });
    // what the learner answered is kept with the call, so the chat can show it again when the lesson reopens
    if (result.answer) invoke("save_tool_result", { lesson: e.lesson, result }).catch(() => {});
    if (app.lesson?.id === e.lesson) thinking(!openQuestion() && agentThinking());
  }
};

export const listenToAgents = () => invoke("agent_listen", { onEvent: events }).catch(() => {});
