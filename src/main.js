// rTutor's page: wires the modules together and starts up. Each module owns one part of the window:
//   sidebar.js  subjects, lessons, search          start.js     the new-lesson screen
//   lesson.js   opening a lesson, its chat replay  canvas.js    the lesson's sections and notes
//   chat.js     messages and the Thinking block   cards.js     question cards
//   tools.js    what each tutor tool call does      composer.js  the chat box, send and stop
//   agents.js   terminal agents over the bridge     api.js       API providers and their turn loop
//   terminal.js the drawer: terminals and the Log  who.js       who teaches, and switching
//   state.js    what they share: the library, the open lesson, the settings
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { $, store } from "./dom.js";
import { icon } from "./icons.js";
import { app } from "./state.js";
import { note } from "./chat.js";
import { refresh, setCollapsed } from "./sidebar.js";
import { startNew } from "./start.js";
import { toggleSources } from "./lesson.js";
import { listenToAgents } from "./agents.js";
import { initTerminal, kindOf, listenToLog } from "./terminal.js";
import { PRESETS } from "./api.js";
import { showWho } from "./who.js";
import { startTimer } from "./timer.js";
import { saveSettings } from "./state.js";

for (const e of document.querySelectorAll("[data-icon]")) e.innerHTML = icon(e.dataset.icon);

// a click elsewhere, or Escape, closes whatever floats
addEventListener("click", (e) => {
  if (!e.target.closest("#menu")) $("#menu").hidden = true;
  if (!e.composedPath().some((n) => n.id === "pop" || n.id === "model")) $("#pop").hidden = true;
});
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  $("#menu").hidden = $("#pop").hidden = true;
  toggleSources(false);
});

listenToLog();
const s = Object.assign(app.settings, (await invoke("get_settings")) ?? {});
if (!["agent", "api"].includes(s.active)) s.active = "agent"; // older settings named a provider here
if (!PRESETS[s.api]) s.api = "nvidia";
if (s.main && !s.main.kind) s.main.kind = kindOf(s.main.cmd); // older settings named a command
await listenToAgents();
// the timer reads its lengths from the settings just loaded
startTimer({
  get: () => s.pomo,
  set: (pomo) => { s.pomo = pomo; saveSettings(); },
  note: (text) => app.lesson && note(text),
  opened: () => toggleSources(false),
});
await initTerminal();
showWho();
setCollapsed(store.get("learn.collapsed", false));
await refresh();
// agents start per subject, when a lesson in it opens (agents.js ensureAgent)
startNew(null);
