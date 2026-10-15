// Who teaches: the button at the bottom of the sidebar and its menu of terminal agents and the API provider.
import { $, el } from "./dom.js";
import { icon, logo, agentLook } from "./icons.js";
import { app, saveSettings, short } from "./state.js";
import { agentFor, agentTab, agents, restartAgent, startAgent, useAgent, usingAgent } from "./agents.js";
import { meter, openModel, provider, ready, useApi } from "./api.js";
import { fillModels, installed, openTerminal, quickStarts } from "./terminal.js";

export { openModel };

/** Whether a lesson can start: an API provider must be set up (its settings open if not). A terminal agent
 *  needn't be running yet; the first message waits for one. */
export async function tutorReady() {
  if (usingAgent() || (await ready())) return true;
  openModel();
  return false;
}

export function showWho() {
  let name, sub, mark;
  if (usingAgent()) {
    const a = agentFor();
    const look = agentLook(a?.name);
    name = a ? look.label : "No agent";
    sub = a ? short(a.cwd) : app.settings.main?.kind ? `${quickStarts()[app.settings.main.kind][0]} starts with a lesson` : "";
    mark = a ? look.logo : "terminal";
  } else {
    const p = provider();
    name = p.label;
    sub = p.model || "Choose a model";
    mark = p.logo;
  }
  $("#who").textContent = name;
  $("#who-sub").textContent = sub;
  $("#who-logo").innerHTML = logo(mark, 22);
  $("#model").classList.toggle("off", usingAgent() && !agents.length);
}

function option(mark, title, tip, on, run) {
  const b = el("button", `opt-row${on ? " on" : ""}`);
  b.innerHTML = logo(mark, 22);
  b.append(el("span", "name", title));
  b.title = tip;
  b.onclick = run;
  return b;
}

/** The current subject's agent: switch its model or effort here; it restarts in its terminal with them. */
function modelSwitch(current) {
  const kind = current && { claude: "claude", openai: "codex" }[agentLook(current.name).logo];
  if (!kind || !agentTab(current)) return null;
  const box = el("div", "switch");
  const model = el("select");
  const effort = el("select");
  const label = (text, sel) => {
    const l = el("label", "", text);
    l.append(sel);
    return l;
  };
  box.append(label("Model", model), label("Effort", effort));
  for (const e of [box, model, effort]) e.onclick = (ev) => ev.stopPropagation();
  let timer;
  // picking a model then an effort restarts it once, not twice
  fillModels(kind, model, effort, () => { clearTimeout(timer); timer = setTimeout(() => restartAgent(current, kind), 1200); });
  return box;
}

/** One row per running agent, one per agent that could be started, and the API provider. */
export async function renderPop() {
  const pop = $("#pop");
  const parts = [];
  const mine = agentFor();
  for (const a of agents) {
    const look = agentLook(a.name);
    const b = option(look.logo, `${look.label} · ${short(a.cwd)}`, a.cwd || "Home folder", usingAgent() && a.id === mine?.id, () => {
      useAgent(a.id);
      showWho();
      renderPop();
    });
    const main = app.settings.main?.kind;
    if (main && quickStarts()[main]?.[1] === look.logo) {
      const auto = el("span", "auto", "Auto");
      auto.title = "Starts by itself for each subject you open. Click to stop that.";
      auto.onclick = (e) => { e.stopPropagation(); app.settings.main = null; saveSettings(); renderPop(); };
      b.append(auto);
    }
    parts.push(b);
  }
  for (const [kind, [label, mark]] of Object.entries(quickStarts())) {
    if (agents.some((a) => agentLook(a.name).logo === mark)) continue;
    const b = el("button", "opt-row");
    b.innerHTML = logo(mark, 22);
    b.append(el("span", "name muted", `Start ${label}`));
    b.title = installed.includes(kind) ? "Starts it in rTutor's terminal" : "Not found on this computer; install it first";
    b.onclick = () => startAgent(kind);
    parts.push(b);
  }
  const term = el("button", "opt-row");
  term.innerHTML = icon("terminal", 20);
  term.append(el("span", "name muted", "Other agent…"));
  term.title = "Open a terminal to start any coding agent";
  term.onclick = () => { pop.hidden = true; openTerminal(); };
  parts.push(term);
  const sw = modelSwitch(mine);
  if (sw) parts.push(sw);
  parts.push(el("hr"));
  const p = provider();
  const api = option(p.logo, p.label, p.model || "Not set up", !usingAgent(), async () => {
    if (!(await ready())) return openModel();
    useApi();
    showWho();
    renderPop();
  });
  const gear = el("button", "icon", "");
  gear.innerHTML = icon("gear", 18);
  gear.title = "API settings";
  gear.onclick = (e) => { e.stopPropagation(); openModel(); };
  const line = el("div", "api-row");
  line.append(api, gear);
  parts.push(line);
  if (!usingAgent() && app.lesson) parts.push(await meter());
  pop.replaceChildren(...parts);
}

$("#model").onclick = () => {
  const pop = $("#pop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderPop();
};
