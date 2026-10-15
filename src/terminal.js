// The bottom drawer: terminals where coding agents run, the "where should it run?" form, and the Log tab.
import { invoke, Channel } from "@tauri-apps/api/core";
import { $, el, store } from "./dom.js";
import { icon, logo, agentLook } from "./icons.js";
import { app, saveSettings, short, subjectDir } from "./state.js";
import { agents } from "./agents.js";
import { confirmDialog } from "./dialogs.js";

const drawer = $("#drawer");
export const tabs = []; // { id, cwd, term, fit, el, hint }
let current = null;
let nextTab = 1;
const launched = new Map(); // folder → the agent command rTutor typed there
let mcpBin = "";
let mcpConfig = ""; // a file holding Claude Code's MCP config
let home = "";
export let installed = []; // coding agents found on this computer

/** Reads what the drawer needs from the app: the MCP binary, the home folder, the agents installed. */
export async function initTerminal() {
  ({ bin: mcpBin, home, config: mcpConfig = "" } = await invoke("mcp_command").catch(() => ({ bin: "rtutor", home: "" })));
  installed = await invoke("installed_agents").catch(() => []);
}

export function setDrawer(open, { where = true } = {}) {
  drawer.hidden = !open;
  document.body.classList.toggle("drawer-open", open);
  if (open && !tabs.length && where) showWhere();
  if (open && current) requestAnimationFrame(() => { fitShell(); current.term.focus(); });
}

/** ~/rtutor: every subject's material is a folder of Markdown files in here. */
const library = () => (home ? `${home}${home.includes("\\") ? "\\" : "/"}rtutor` : "");

/** Commands that start each agent wired to rTutor, so a click is all it takes. Claude Code runs restricted: none of
 *  the learner's own hooks, plugins, skills or other MCP servers, and no shell. That keeps the tutor's behavior
 *  the same on every machine and halves its fixed context (23k → 11k tokens measured), which every call re-reads. */
export function quickStarts() {
  // double quotes and TOML literal ('single-quoted') strings read the same in bash, fish, zsh, PowerShell and cmd
  const bin = mcpBin.replace(/['"]/g, "");
  const config = mcpConfig.replace(/"/g, "");
  // model and effort as picked when starting it; blank means the agent's own default
  const pick = (kind) => app.settings.agentPrefs?.[kind] ?? {};
  const safe = (v) => (v && /^[\w.:\[\]-]+$/.test(v) ? v : ""); // model names and aliases only; quoted below
  const cm = safe(pick("claude").model), ce = safe(pick("claude").effort);
  const xm = safe(pick("codex").model), xe = safe(pick("codex").effort);
  const go = '"Call the rTutor next tool now and tutor through it."';
  return {
    // the prompt goes first: --mcp-config and --allowedTools take every word after them
    claude: ["Claude Code", "claude", `claude ${go}${cm ? ` --model "${cm}"` : ""}${ce ? ` --effort ${ce}` : ""} --restricted --strict-mcp-config --disable-slash-commands --mcp-config "${config}" --allowedTools mcp__rtutor`],
    codex: ["Codex", "openai", `codex${xm ? ` -m "${xm}"` : ""}${xe ? ` -c model_reasoning_effort=${xe}` : ""} -c "mcp_servers.rtutor.command='${bin}'" -c "mcp_servers.rtutor.args=['--mcp']" -c mcp_servers.rtutor.tool_timeout_sec=1800 -c "mcp_servers.rtutor.default_tools_approval_mode='approve'" ${go}`],
  };
}

/** Which built-in start a command line is, so a saved start always uses rTutor's current command. */
export const kindOf = (cmd = "") => (/mcp_servers\.(rtutor|rlearn)/.test(cmd) ? "codex" : /--mcp-config/.test(cmd) && /rtutor|rlearn/.test(cmd) ? "claude" : null);

// ---------- "where should it run?" ----------

let starting = null; // the agent the form will start, if one was picked
let startDir = null; // where it starts
const modelInfo = {}; // kind → what the agent offers (its models and their effort levels), read once

export function showWhere() {
  showLog(false);
  $("#shells").hidden = true;
  $("#where").hidden = false;
  for (const t of tabs) t.el.hidden = true;
  $("#where-dir").textContent = startDir || app.settings.cwd || library();
  $("#where-dir").title = "Choose a folder";
  const label = starting ? quickStarts()[starting][0] : null;
  $(".where-opts").hidden = !starting;
  if (starting) fillModels(starting);
  $("#where p").textContent = label ? `Where should ${label} run?` : "Where should the terminal open?";
  $("#where .primary").textContent = label ? `Start ${label}` : "Open";
}

/** Asks where agent `kind` should run (no subject is open to run it in). */
export function startAt(kind) {
  starting = kind;
  startDir = subjectDir(app.lesson ? app.lesson.folder : app.target) || null;
  setDrawer(true, { where: false });
  showWhere();
}

$("#where-dir").onclick = async () => {
  const dir = await invoke("pick_folder").catch(() => null);
  if (!dir) return;
  if (!starting) app.settings.cwd = dir;
  startDir = dir;
  $("#where-dir").textContent = dir;
  saveSettings();
};
$("#where").onsubmit = (e) => {
  e.preventDefault();
  const kind = starting;
  if (kind) {
    app.settings.main = { kind }; // picked to start: it starts for each subject from now on
    saveSettings();
  }
  const dir = $("#where-dir").textContent || library();
  starting = startDir = null;
  newTab(dir, kind ? quickStarts()[kind][2] : undefined);
};

/** The model and effort pickers for `kind`, filled from the agent itself. Effort levels follow the model. */
export async function fillModels(kind, model = $("#where-model"), effortSel = $("#where-effort"), changed = () => {}) {
  modelInfo[kind] ??= await invoke("agent_models", { kind }).catch(() => ({ models: [] }));
  const info = modelInfo[kind];
  const prefs = ((app.settings.agentPrefs ??= {})[kind] ??= {});
  const opt = (value, text) => Object.assign(el("option", "", text), { value });
  const now = info.models.find((m) => m.id === info.current);
  // the agent's own models, one typed in earlier, and "Other…" for any name the agent accepts (new models included)
  const custom = prefs.model && !info.models.some((m) => m.id === prefs.model) ? [opt(prefs.model, prefs.model)] : [];
  model.replaceChildren(opt("", now ? `Default (${now.name})` : "Default"), ...info.models.map((m) => opt(m.id, m.name)), ...custom, opt("__other", "Other…"));
  model.value = prefs.model ?? "";
  const levels = () => {
    const m = info.models.find((x) => x.id === (model.value || info.current)) ?? info.models[0];
    const list = m?.levels?.length ? m.levels : info.levels ?? [];
    const fallback = model.value ? m?.default : info.effort || m?.default;
    effortSel.replaceChildren(opt("", fallback ? `Default (${fallback})` : "Default"), ...list.map((l) => opt(l, l)));
    effortSel.value = list.includes(prefs.effort) ? prefs.effort : "";
    prefs.effort = effortSel.value;
  };
  levels();
  model.onchange = () => {
    if (model.value === "__other") {
      // type a model name in place of the menu; Enter keeps it, Escape goes back
      const typed = el("input", "model-name");
      typed.placeholder = kind === "claude" ? "e.g. haiku or claude-haiku-5-5" : "model name";
      typed.onclick = (e) => e.stopPropagation();
      model.replaceWith(typed);
      typed.focus();
      let finished = false;
      const finish = (keep) => {
        if (finished) return;
        finished = true;
        const v = typed.value.trim();
        typed.replaceWith(model);
        const ok = keep && /^[\w.:\[\]-]+$/.test(v);
        if (ok) prefs.model = v;
        fillModels(kind, model, effortSel, changed);
        if (ok) { saveSettings(); changed(); }
      };
      typed.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
      typed.onblur = () => finish(true);
      return;
    }
    prefs.model = model.value;
    levels();
    saveSettings();
    changed();
  };
  effortSel.onchange = () => { prefs.effort = effortSel.value; saveSettings(); changed(); };
}

// ---------- terminal tabs ----------

export async function newTab(cwd, run) {
  $("#where").hidden = true;
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 2000, cols: 100, rows: 24, // scrollback is per tab, and each subject can have one
    theme: { background: v("--sidebar"), foreground: v("--text"), cursor: v("--accent"), selectionBackground: v("--accent-soft") },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const box = el("div", "shell");
  // a plain terminal offers to start an agent in it; one that is starting (or running) one doesn't
  const hint = el("div", "hint");
  hint.hidden = !!run;
  hint.append(el("span", "", "Run your coding agent here"));
  for (const [label, logoName, cmd] of Object.values(quickStarts())) {
    const b = el("button");
    b.type = "button";
    b.innerHTML = logo(logoName, 18);
    b.append(label);
    b.onclick = () => {
      launched.set(cwd, cmd);
      hint.hidden = true;
      invoke("term_write", { tab: tab.id, data: `${cmd}\r` });
      term.focus();
    };
    hint.append(b);
  }
  const any = el("button", "link", "Other agent");
  any.type = "button";
  any.title = "Any agent that speaks MCP can power rTutor: add this server to it.";
  any.onclick = () => term.write(`\r\n\x1b[2mAdd this MCP server to your agent, then ask it to start rTutor:\x1b[0m\r\n  ${mcpBin} --mcp\r\n`);
  hint.append(any);
  const screen = el("div", "screen");
  box.append(hint, screen);
  $("#shells").append(box);
  term.open(screen);
  const tab = { id: nextTab++, cwd, term, fit, el: box, hint, run };
  tabs.push(tab);
  term.onData((data) => invoke("term_write", { tab: tab.id, data }).catch(() => {}));
  new ResizeObserver(() => tab === current && fitShell()).observe(screen);
  const out = new Channel();
  out.onmessage = (data) => term.write(data);
  if (run) launched.set(cwd, run);
  selectTab(tab);
  await invoke("term_open", { tab: tab.id, cwd, run: run ?? null, cols: term.cols, rows: term.rows, out }).catch((e) => term.write(`\r\n${e}\r\n`));
  return tab;
}

export function selectTab(tab) {
  showLog(false);
  $("#shells").hidden = false;
  current = tab;
  for (const t of tabs) t.el.hidden = t !== tab;
  renderTabs();
  if (!drawer.hidden) requestAnimationFrame(() => { fitShell(); tab.term.focus(); });
}

export function closeTab(tab) {
  invoke("term_close", { tab: tab.id }).catch(() => {});
  tab.term.dispose();
  tab.el.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  if (current === tab) current = tabs.at(-1) ?? null;
  if (current) selectTab(current);
  else {
    renderTabs();
    showWhere();
  }
}

export function renderTabs() {
  if (!tabs.length) return void $("#ttabs").replaceChildren();
  const byCwd = new Map(agents.map((a) => [a.cwd, a])); // one pass, not a search per tab
  $("#ttabs").replaceChildren(
    ...tabs.map((t) => {
      const b = el("div", `dtab${t === current ? " active" : ""}`);
      const a = byCwd.get(t.cwd);
      b.innerHTML = a ? logo(agentLook(a.name).logo, 12) : icon("terminal", 16);
      b.append(el("span", "", short(t.cwd)));
      b.title = t.cwd || "Home folder";
      b.onclick = () => selectTab(t);
      const x = el("button", "", "");
      x.innerHTML = icon("x", 14);
      x.title = "Close terminal";
      x.onclick = async (e) => {
        e.stopPropagation();
        // closing a terminal ends the agent in it: ask first, since that stops the tutoring too
        if (a && !(await confirmDialog([`Stop ${agentLook(a.name).label}?`, "Closing this terminal ends the tutor running in it.", "Close"]))) return;
        closeTab(t);
      };
      b.append(x);
      return b;
    }),
  );
  for (const t of tabs) if (byCwd.has(t.cwd)) t.hint.hidden = true;
}

function fitShell() {
  if (!current || drawer.hidden) return;
  current.fit.fit();
  invoke("term_resize", { tab: current.id, cols: current.term.cols, rows: current.term.rows }).catch(() => {});
}

export function openTerminal() {
  setDrawer(true);
  if (tabs.length) showWhere(); // a new terminal for another agent
}

// ---------- the Log tab: what happened, one line per fact (agents, messages, tool calls, errors) ----------

const logLines = $("#log-lines");
const MAX_LINES = 1500; // keeps memory flat however long the app runs

function logLine(text) {
  const atEnd = logLines.scrollHeight - logLines.scrollTop - logLines.clientHeight < 40;
  const line = el("div", /error|gave up|dropped|stopped waiting|disconnected/.test(text) ? "bad" : /received|connected|started/.test(text) ? "good" : "", text);
  logLines.append(line);
  if (logLines.childElementCount > MAX_LINES) logLines.firstElementChild.remove();
  if (atEnd) logLines.scrollTop = logLines.scrollHeight;
}

function showLog(on) {
  $("#logpane").hidden = !on;
  $("#shells").hidden = on;
  $("#logtab").classList.toggle("active", on);
  if (!on) return;
  $("#where").hidden = true;
  for (const t of tabs) t.el.hidden = true;
  current = null;
  renderTabs();
  logLines.scrollTop = logLines.scrollHeight;
}

export function listenToLog() {
  const ch = new Channel();
  ch.onmessage = logLine;
  invoke("log_listen", { onLine: ch })
    .then(([path, lines]) => {
      $("#log-path").textContent = path;
      for (const l of lines.slice(-MAX_LINES)) logLine(l);
    })
    .catch(() => {});
}

$("#logtab").onclick = () => showLog(true);
$("#log-copy").onclick = () => navigator.clipboard.writeText([...logLines.children].map((l) => l.textContent).join("\n"));
$("#term-btn").onclick = () => setDrawer(drawer.hidden);
$("#tnew").onclick = () => { starting = null; showWhere(); };
$("#drawer-close").onclick = () => setDrawer(false);
addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setDrawer(drawer.hidden);
  }
});

// ---------- resizable panes ----------

/** Drag `grip` to resize: `apply` gets the pointer event, `done` saves the result. */
function dragResize(grip, apply, done) {
  grip.onpointerdown = (e) => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const up = () => {
      removeEventListener("pointermove", apply);
      removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      done();
    };
    addEventListener("pointermove", apply);
    addEventListener("pointerup", up);
  };
}
const rootVar = (name, value) => document.documentElement.style.setProperty(name, value);
const saveVar = (key, name) => () => store.set(key, getComputedStyle(document.documentElement).getPropertyValue(name));
dragResize($("#drawer-grip"), (m) => {
  rootVar("--drawer-h", `${Math.min(innerHeight - 160, Math.max(140, innerHeight - m.clientY))}px`);
  fitShell();
}, saveVar("learn.drawerH", "--drawer-h"));
dragResize($("#chat-grip"), (m) => {
  const box = $("#lesson").getBoundingClientRect();
  rootVar("--chat-w", `${Math.round(Math.min(box.width - 360, Math.max(320, box.right - m.clientX)))}px`);
}, saveVar("learn.chatW", "--chat-w"));
dragResize($("#side-grip"), (m) => {
  rootVar("--side-w", `${Math.round(Math.min(480, Math.max(200, m.clientX)))}px`);
}, saveVar("learn.sideW", "--side-w"));
for (const [k, name] of [["learn.drawerH", "--drawer-h"], ["learn.chatW", "--chat-w"], ["learn.sideW", "--side-w"]]) {
  const saved = store.get(k, null);
  if (saved) rootVar(name, saved);
}
