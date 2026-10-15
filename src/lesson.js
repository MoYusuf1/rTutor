// The lesson view: opening a lesson (its canvas and its chat, replayed as they were), the Sources panel, the
// phase shortcuts, and the material viewer.
import { invoke } from "@tauri-apps/api/core";
import { $, el } from "./dom.js";
import { icon } from "./icons.js";
import { md } from "./markdown.js";
import { app, fmt, materialsFor } from "./state.js";
import { log, renderInto, say, thinking } from "./chat.js";
import { showLatest, showNotes, showSections } from "./canvas.js";
import { echo, openQuestion, questionOf, replayQuestion } from "./cards.js";
import { newestFirst } from "./lazy.js";
import { gearOf, learnerWords, PHASES, SUGGEST } from "./phases.js";
import { confirmDialog } from "./dialogs.js";
import { refresh, renderSidebar } from "./sidebar.js";
import { send } from "./composer.js";
import { ensureAgent, resumeAgentWork, usingAgent } from "./agents.js";
import { resumeApi } from "./api.js";
import { showWho } from "./who.js";

export function show(view) {
  for (const v of ["start", "lesson", "doc"]) $(`#${v}`).hidden = v !== view;
}

/** Leaving the open lesson: anything still waiting on the learner there is let go. */
export function leave() {
  app.gen++;
  openQuestion()?.abandon();
  thinking(false);
}

let stopChat = () => {};

/** The lesson view for `app.lesson`, empty, ready to fill. */
export function showLesson() {
  const l = app.lesson;
  show("lesson");
  $("#title").textContent = l.title;
  stopChat();
  log().replaceChildren();
  showSections([], l.title);
  showNotes(l.state);
  renderSources();
  renderSuggest();
}

/** One message of the history, as the chat showed it. `answered`: ids of the tool calls that have a result; a
 *  question without one is still open and is asked again live. */
function replay(m, toolResults, answered) {
  if (typeof m.content === "string") {
    if (m.role === "user") say(learnerWords(m.content), "user");
    else say(m.content);
    return;
  }
  if (m.role !== "assistant") return; // tool results: their answers show with their questions
  for (const b of m.content) {
    if (b.type === "text" && b.text.trim()) say(b.text);
    if (b.type !== "tool_use") continue;
    if (b.name === "say" && b.input?.text) say(b.input.text);
    const q = questionOf(b.name, b.input);
    if (q && typeof q.question === "string" && answered.has(b.id)) {
      const answer = toolResults[b.id]?.answer;
      replayQuestion(q, answer);
      const words = echo(b.name, q, answer);
      if (words) say(words, "user");
    }
  }
}

export async function openLesson(id) {
  leave();
  const mine = app.gen;
  // the lesson shows at once (title from the sidebar), and fills in when it arrives
  const known = app.data.lessons.find((x) => x.id === id);
  if (known) {
    app.lesson = { id, title: known.title, folder: known.folder, state: "", sections: 0, toolResults: {}, phase: null, last: null };
    showLesson();
    $("#lesson").classList.add("loading");
  }
  const l = await invoke("get_lesson", { id });
  if (mine !== app.gen) return; // the learner clicked something else meanwhile
  $("#lesson").classList.remove("loading");
  app.lesson = { id, title: l.title, folder: l.folder, state: l.state, sections: l.sections.length, toolResults: l.toolResults ?? {}, phase: null, last: null };
  app.target = l.folder;
  showLesson();
  showSections(l.sections, l.title);
  // the phase: the last one reported, else the gear the lesson started in, else teaching if it is under way
  for (const m of l.messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_use" && b.name === "phase") app.lesson.phase = b.input?.phase;
  }
  const first = l.messages[0]?.content;
  app.lesson.phase ??= (typeof first === "string" && gearOf(first)?.phase) || (l.sections.length ? "teach" : null);
  const results = app.lesson.toolResults;
  const answered = new Set();
  for (const m of l.messages) if (m.role === "user" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") answered.add(b.tool_use_id);
  stopChat = newestFirst({ box: log(), scroller: log(), items: l.messages, batch: 40, render: (m, frag) => renderInto(frag, () => replay(m, results, answered)) });
  // open on the newest part, not the top (diagrams and fonts settle a moment later, so look again)
  showLatest();
  setTimeout(() => mine === app.gen && showLatest(), 400);
  const last = l.messages.at(-1);
  app.lesson.last = last?.role === "assistant" ? last.content : null;
  renderSidebar();
  renderSuggest();
  ensureAgent();
  showWho();
  if (usingAgent()) resumeAgentWork();
  else resumeApi(); // closed in the middle of a quiz: ask it again
}

/** The material viewer. */
export async function openSource(s) {
  const { name, body } = await invoke("get_source", { id: s.id });
  leave();
  app.lesson = null;
  show("doc");
  renderSidebar();
  $("#doc-title").textContent = name;
  $("#doc-words").textContent = `${s.words.toLocaleString()} words`;
  $("#doc-body").replaceChildren(/\.md$/i.test(name) ? md(body) : el("pre", "plain", body));
  $("#doc").scrollTop = 0;
}

// ---------- the Sources panel (top right of a lesson): everything the tutor teaches this lesson from ----------

export function renderSources() {
  const l = app.lesson;
  const list = materialsFor(l.folder, l.id);
  const words = list.reduce((n, s) => n + s.words, 0);
  $("#sources-count").textContent = list.length || "";
  const head = el("header");
  head.append(el("h3", "", "Sources"), el("span", "sub", list.length ? `${list.length} in this subject · ${fmt(words)} words` : "None yet"));
  $("#sources-pop").replaceChildren(
    head,
    ...(list.length ? [] : [el("p", "empty", "Use + in the chat, or drop files anywhere, to add a textbook, slides, notes or a transcript.")]),
    ...list.map((s) => {
      const r = el("div", "src");
      const kind = (s.name.match(/\.(\w+)$/)?.[1] ?? "txt").toUpperCase();
      const text = el("button", "src-text");
      text.type = "button";
      text.title = "Open";
      text.append(el("span", "name", s.name.replace(/\.\w+$/, "")), el("small", "", `${s.words.toLocaleString()} words`));
      text.onclick = () => { toggleSources(false); openSource(s); };
      const x = el("button", "icon remove");
      x.type = "button";
      x.innerHTML = icon("trash", 16);
      x.title = "Remove";
      x.onclick = async () => {
        if (!(await confirmDialog([`Remove “${s.name}”?`, "The tutor won't teach from it anymore.", "Remove"]))) return;
        await invoke("delete_source", { id: s.id });
        await refresh();
        renderSources();
      };
      r.append(el("span", `kind kind-${kind.toLowerCase()}`, kind.slice(0, 4)), text, x);
      return r;
    }),
  );
}

export function toggleSources(open = $("#sources-pop").hidden) {
  $("#sources-pop").hidden = !open;
  $("#sources-btn").setAttribute("aria-expanded", String(open));
}
$("#sources-btn").onclick = () => toggleSources();

// ---------- the lesson's phase, and shortcuts that fit it ----------

export function renderSuggest() {
  const phase = app.lesson?.phase;
  const now = el("span", "now");
  now.title = "The lesson's current phase";
  if (PHASES[phase]) now.innerHTML = `<span class="gear-icon">${icon(phase, 15)}</span>`;
  now.append(el("b", "", PHASES[phase] ?? ""));
  $("#suggest").replaceChildren(
    ...(PHASES[phase] ? [now] : []),
    ...(SUGGEST[phase] ?? SUGGEST.none).map(([label, text]) => {
      const b = el("button", "", label);
      b.type = "button";
      b.onclick = () => send(text);
      return b;
    }),
  );
}
