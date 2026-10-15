// The focus timer (pomodoro), like Pomofocus: focus, short break and long break tabs, a clock whose minutes
// are typed over in place, and rounds before the long break. Lengths are saved with the app's settings; the
// running clock is kept per window so a restart doesn't lose a session.
import { $, el, store } from "./dom.js";
import { icon } from "./icons.js";

// what the timer needs from the app: its saved lengths, a way to save them, a chat note, and "the panel opened"
let app = { get: () => ({}), set: () => {}, note: () => {}, opened: () => {} };

const POMO_DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, autoBreak: true, autoFocus: false };
const POMO_LABEL = { focus: "Pomodoro", short: "Short break", long: "Long break" };
const pomoSet = () => ({ ...POMO_DEFAULTS, ...(app.get() ?? {}) }); // lengths and switches, saved with the app's settings
// the running clock lives in the window, so a restart doesn't lose a session in progress
let pomo = store.get("learn.pomo2", { mode: "focus", ends: 0, left: null, count: 1 });

const savePomo = () => store.set("learn.pomo2", pomo);
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const pomoLength = (mode = pomo.mode) => pomoSet()[mode] * 60;
const pomoLeft = () => Math.max(0, pomo.ends ? (pomo.ends - Date.now()) / 1000 : pomo.left ?? pomoLength());

function chime() {
  try {
    const a = new AudioContext();
    for (const [i, f] of [660, 880].entries()) {
      const o = a.createOscillator();
      const g = a.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, a.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.15, a.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + i * 0.18 + 0.5);
      o.connect(g).connect(a.destination);
      o.start(a.currentTime + i * 0.18);
      o.stop(a.currentTime + i * 0.18 + 0.55);
    }
  } catch { /* no audio: the label still changes */ }
}

function pomoTo(mode, run = false) {
  pomo = { ...pomo, mode, left: null, ends: run ? Date.now() + pomoLength(mode) * 1000 : 0 };
  savePomo();
  renderPomo(true);
}
function pomoToggle() {
  if (pomo.ends) pomo = { ...pomo, left: pomoLeft(), ends: 0 }; // pause
  else pomo = { ...pomo, ends: Date.now() + pomoLeft() * 1000, left: null }; // start or resume
  savePomo();
  renderPomo(true);
}

let ticking = 0;

/** The button by Sources, and the panel when it's open. `full` redraws the panel too (not just its clock).
 *  It ticks only while a session runs: an idle or paused timer costs nothing. */
export function renderPomo(full = false) {
  clearTimeout(ticking);
  if (pomo.ends) ticking = setTimeout(renderPomo, 1000 - (Date.now() % 1000) + 5); // on the second, as the clock shows
  const left = pomoLeft();
  const running = pomo.ends > 0;
  const started = running || pomo.left != null;
  if (running && left <= 0) {
    // a session ends: a chime, a note, and on to the next one
    chime();
    const set = pomoSet();
    if (pomo.mode === "focus") {
      const next = pomo.count % set.every === 0 ? "long" : "short";
      pomo.count++;
      app.note(next === "long" ? `${set.every} focus sessions done. Take ${set.long} minutes.` : `Focus session done. Take ${set.short}.`);
      pomoTo(next, set.autoBreak);
    } else {
      app.note("Break's over. Time to focus.");
      pomoTo("focus", set.autoFocus);
    }
    return;
  }
  const b = $("#pomo");
  $("#pomo-time").textContent = started ? clock(left) : "Focus";
  b.className = `pomo ${pomo.mode}${running ? " running" : started ? " paused" : ""}`;
  b.style.setProperty("--p", started ? 1 - left / pomoLength() : 0);
  const pop = $("#pomo-pop");
  if (pop.hidden) return;
  if (!full && pop.contains(document.activeElement)) return; // don't redraw under someone typing
  if (!full && running && pop.querySelector(".big")) {
    pop.querySelector(".big").textContent = clock(left);
    return;
  }
  if (!full) return;
  const set = pomoSet();
  const tabs = el("div", "pomo-tabs");
  for (const [mode, label] of Object.entries(POMO_LABEL)) {
    const t = el("button", mode === pomo.mode ? "on" : "", label);
    t.type = "button";
    t.onclick = () => pomoTo(mode);
    tabs.append(t);
  }
  const go = el("button", "primary go", running ? "Pause" : started ? "Resume" : "Start");
  go.type = "button";
  go.onclick = pomoToggle;
  const reset = el("button", "icon");
  reset.type = "button";
  reset.title = "Restart this session";
  reset.innerHTML = icon("reset", 18);
  reset.onclick = () => pomoTo(pomo.mode);
  const controls = el("div", "pomo-controls");
  controls.append(go, reset);
  const save = (patch) => {
    app.set({ ...set, ...patch });
  };
  /** A number that edits in place: it looks like plain text until you type over it. Enter or leaving saves. */
  const editable = (value, min, max, onSave, title, pad = 0) => {
    const shown = String(value).padStart(pad, "0");
    const n = el("span", "num-edit", shown);
    n.contentEditable = "true";
    n.spellcheck = false;
    n.inputMode = "numeric";
    n.title = title;
    // the first digit typed replaces the number (engines disagree on whether a click selects it)
    let fresh = false;
    n.onfocus = () => { fresh = true; };
    n.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        if (e.key === "Escape") n.textContent = shown;
        n.blur();
      } else if (e.key.length === 1) {
        e.preventDefault(); // digits only, typed by hand so every engine behaves the same
        if (!/\d/.test(e.key) || (!fresh && n.textContent.length >= 3)) return;
        n.textContent = fresh ? e.key : n.textContent + e.key;
        fresh = false;
        getSelection().selectAllChildren(n);
        getSelection().collapseToEnd();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        n.textContent = fresh ? "" : n.textContent.slice(0, -1);
        fresh = false;
      }
    };
    n.onblur = () => {
      const v = Math.round(Number(n.textContent.trim()));
      if (v >= min && v <= max && v !== value) onSave(v);
      else n.textContent = shown;
    };
    return n;
  };
  // the clock: while it isn't running, its minutes are the setting for this tab
  const big = el("div", "big");
  if (running || left !== pomoLength()) big.textContent = clock(left);
  else {
    big.append(editable(set[pomo.mode], 1, 180, (v) => {
      save({ [pomo.mode]: v });
      pomo = { ...pomo, left: null, ends: 0 };
      savePomo();
      renderPomo(true);
    }, "Type the minutes", 2), ":00");
  }
  // rounds: which one this is, out of how many before the long break; − and + change how many
  const round = el("div", "pomo-round");
  const step = (d) => {
    const b = el("button", "step", d < 0 ? "−" : "+");
    b.type = "button";
    b.title = d < 0 ? "One round fewer" : "One more round";
    b.disabled = d < 0 ? set.every <= 1 : set.every >= 12;
    b.onclick = () => { save({ every: set.every + d }); renderPomo(true); };
    return b;
  };
  round.append(step(-1), el("span", "", `Round ${((pomo.count - 1) % set.every) + 1} of ${set.every}`), step(1));
  pop.replaceChildren(tabs, big, controls, round);
}

$("#pomo").onclick = (e) => {
  e.stopPropagation();
  $("#pomo-pop").hidden = !$("#pomo-pop").hidden;
  app.opened();
  renderPomo(true);
};
$("#pomo").oncontextmenu = (e) => { e.preventDefault(); pomoTo(pomo.mode); };
// the path is taken when the click happens: a panel that redraws itself under the click still counts as inside
const clickedIn = (e, ...ids) => e.composedPath().some((n) => ids.includes(n.id));
addEventListener("click", (e) => { if (!clickedIn(e, "pomo-pop", "pomo")) $("#pomo-pop").hidden = true; });

/** Starts the clock once the app's settings are loaded. */
export function startTimer(hooks) {
  app = hooks;
  renderPomo();
}
