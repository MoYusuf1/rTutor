// The chat pane: messages, short notes, and the "Thinking…" block that shows what the tutor is doing.
import { $, el } from "./dom.js";
import { md, drawDiagrams } from "./markdown.js";

export const log = () => $("#log");

let into = null; // a fragment replayed history is built into, out of the page

// The chat sticks to its bottom: while the learner is at (or near) the end, anything that changes the chat's
// height (a message, a card, the Thinking block growing, a diagram rendering) keeps the end in view. Scrolling
// up to read releases it; scrolling back down, or sending a message, sticks it again.
let stuck = true;
let pinnedAt = -1; // where the app last put it: a scroll event reporting that is the app's own, not the learner's
const pin = () => {
  if (!stuck) return;
  log().scrollTop = log().scrollHeight;
  pinnedAt = log().scrollTop;
};
log().addEventListener("scroll", () => {
  const l = log();
  // scroll events arrive a frame late: the one for a pin can land after more was appended, and would look like
  // the learner scrolling up. Only a position the app didn't set can release the chat.
  if (l.scrollTop === pinnedAt) return;
  stuck = l.scrollHeight - l.scrollTop - l.clientHeight < 60;
}, { passive: true });
let pinQueued = false; // many changes in one frame (a streaming reply) pin once
new MutationObserver(() => {
  if (pinQueued) return;
  pinQueued = true;
  requestAnimationFrame(() => { pinQueued = false; pin(); });
}).observe(log(), { childList: true, subtree: true, characterData: true });
log().addEventListener("toggle", () => requestAnimationFrame(pin), true); // a Thinking block opening or folding
/** Back to the newest message (sending, or opening a lesson). */
export function toBottom() {
  stuck = true;
  pin();
}

/** Runs `fn` with everything it adds to the chat going into `frag` instead, without animation. */
export function renderInto(frag, fn) {
  into = frag;
  try {
    fn();
  } finally {
    into = null;
  }
}

/** Keeps a scroller pinned to the bottom while it already was near it. */
export function follow(node) {
  const s = node.closest("#log, #canvas") ?? node;
  if (s.scrollHeight - s.scrollTop - s.clientHeight < 200) s.scrollTop = s.scrollHeight;
}

/** Adds to the chat. Anything the tutor shows ends the current "Thinking…" block, which folds above it. */
export function chatNode(node) {
  if (into) return into.appendChild(node);
  if (work) thinking(false);
  log().append(node);
  return node; // the chat stays at its end on its own (see `stuck`)
}

export function say(text, who = "bot") {
  if (who === "user" && !into) stuck = true; // sending a message always brings the chat to its end
  chatNode(el("div", `msg ${who}${into ? "" : " appear"}`)).append(md(text));
}

export const note = (text) => chatNode(el("div", "meta", text));

/** A note from outside the tutor's turn (the timer): it goes above an open "Thinking…" block instead of ending it. */
export function aside(text) {
  if (!work || into) return note(text);
  log().insertBefore(el("div", "meta", text), work.node);
}

/** A node whose markdown re-renders at most once per frame while text streams in. */
export function liveMarkdown(parent) {
  const box = el("div");
  parent === log() ? chatNode(box) : parent.append(box);
  let src = "";
  let queued = false;
  let done = false; // once final, a frame still queued from streaming must not overwrite it
  let last = 0;
  return {
    box,
    set(text) {
      src = text;
      if (queued || done) return;
      queued = true;
      // each render parses the whole text so far, so a long reply renders less often: every frame while short,
      // then about every length/16 ms (a 4,000-character reply every 250 ms). The stream stays O(n), not O(n²).
      const wait = Math.max(0, Math.min(src.length / 16, 400) - (performance.now() - last));
      setTimeout(() => requestAnimationFrame(() => {
        queued = false;
        if (done) return;
        last = performance.now();
        box.replaceChildren(md(src, false));
        follow(box);
      }), wait);
    },
    finish(text = src) {
      done = true;
      box.replaceChildren(md(text));
      drawDiagrams(box);
    },
  };
}

// ---------- the "Thinking…" block ----------
// While the tutor works, a collapsible block shows what it is doing: its reasoning (API models that share it)
// and each step (searching the material, writing on the canvas). Afterwards it folds into "Thought for 12s".

const MUSINGS = [
  "Thinking", "Pondering", "Turning pages", "Connecting the dots", "Sharpening a question", "Finding a good example",
  "Sketching it out", "Mulling it over", "Choosing the next step", "Looking it up", "Drawing a picture", "Weighing the options",
  "Untangling it", "Lining up the ideas", "Finding the right angle", "Checking the material", "Building it up",
];
const musing = () => MUSINGS[Math.floor(Math.random() * MUSINGS.length)];

// what the block says before the tutor has the message (starting, not picked up yet); null once it works
let status = () => null;
let changed = () => {};
/** `status`: a line to show instead of a musing while nothing is working yet. `changed`: called on every start or stop. */
export function onWork(hooks) {
  ({ status = status, changed = changed } = hooks);
}

class Work {
  constructor(node, resumed) {
    this.node = node;
    this.body = node.querySelector(".work-body");
    this.label = node.querySelector("summary span:last-child");
    this.steps = node.querySelectorAll(".step").length;
    this.started = resumed ? Number(node.dataset.started) : Date.now();
    this.musing = musing();
    const dots = el("span", "dots");
    dots.append(el("i"), el("i"), el("i"));
    node.querySelector("summary").prepend(dots);
    node.classList.remove("done");
    node.open = true; // open while it works, folded once it's done
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** A new block, or the last one again when nothing was shown since it folded. */
  static open() {
    const last = log().lastElementChild;
    if (last?.classList.contains("work") && last.classList.contains("done")) return new Work(last, true);
    const node = el("details", "work");
    const summary = el("summary");
    summary.append(el("span", "", ""));
    node.append(summary, el("div", "work-body"));
    node.dataset.started = Date.now();
    log().append(node);
    return new Work(node, false);
  }

  tick() {
    const waiting = status();
    if (waiting) this.started = Date.now(); // waiting for a tutor isn't thinking: the clock starts once it has the message
    const secs = Math.round((Date.now() - this.started) / 1000);
    if (waiting) return void (this.label.textContent = waiting);
    this.label.textContent = `${this.musing}… ${secs >= 3 ? `${secs}s` : ""}`.trim();
    if (secs && secs % 8 === 0) this.musing = musing();
  }

  step(text) {
    this.steps++;
    this.body.append(el("div", "step", text));
    follow(this.body);
  }

  close() {
    clearInterval(this.timer);
    if (!this.steps && !this.body.textContent.trim()) return this.node.remove();
    this.node.classList.add("done");
    this.node.open = false;
    this.node.querySelector(".dots").remove();
    this.node.dataset.started = this.started;
    const secs = Math.max(1, Math.round((Date.now() - this.started) / 1000));
    this.label.textContent = `Thought for ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}`;
  }
}

let work = null;

export function thinking(on) {
  if (on && !work) work = Work.open();
  else if (!on && work) {
    work.close();
    work = null;
  }
  changed();
}

/** One line in the live "Thinking…" block. */
export const step = (text) => work?.step(text);
/** Where streamed reasoning goes, while the block is open. */
export const workBody = () => work?.body;
/** The status line may have changed (an agent connected or picked the message up). */
export const refreshWork = () => work?.tick();
