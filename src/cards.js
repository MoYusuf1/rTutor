// Question cards in the chat. One builder serves both a live question (waiting on the learner) and a replayed
// one (a lesson reopened), so the chat looks the same either way.
import { el } from "./dom.js";
import { md } from "./markdown.js";
import { chatNode, log, thinking } from "./chat.js";

/** What a question tool call shows: its kind, the choices, and the right one when the app grades it. */
export function questionOf(name, input = {}) {
  switch (name) {
    case "quiz": return { kind: "quiz", question: input.question, options: [...input.options, "I don't know"], note: true, correct: input.correct_index };
    case "true_false": return { kind: "quiz", question: input.statement, options: ["True", "False", "I don't know"], note: true, correct: input.answer ? 0 : 1 };
    case "short_answer": return { kind: "quiz short", question: input.question, options: [], free: true };
    case "ask": return { kind: "ask", question: input.question, options: input.options, free: true };
    default: return null;
  }
}

/** What the learner said in words after a card, shown as their chat message (live and replayed alike). */
export function echo(name, q, a) {
  if (!a || a.abandoned) return null;
  if (a.skipped) return a.text;
  if (name === "ask") return a.i < 0 ? a.text : q.options[a.i];
  return (name === "quiz" || name === "true_false") && a.i < 0 ? a.text : null;
}

function build(q) {
  const card = el("div", `card ${q.kind}`);
  const head = el("div", "q");
  head.append(md(q.question));
  card.append(head);
  const extra = el("input");
  extra.setAttribute("aria-label", q.free ? "Your own answer" : "Why? (optional)");
  const buttons = q.options.map((o, i) => {
    const b = el("button", "opt");
    b.type = "button";
    b.append(el("span", "k", String.fromCharCode(65 + i)), md(o));
    card.append(b);
    return b;
  });
  const row = el("div", "answer-row");
  if (q.note || q.free) {
    extra.placeholder = !q.options.length ? "Type your answer" : q.free ? "Your own answer" : "Why? (optional)";
    card.append(extra);
  }
  return { card, buttons, extra, row };
}

/** An answered card: choices locked, the pick and the right answer marked, what was typed kept as text.
 *  `a`: { i (picked option, -1 for typed), text, skipped, abandoned }, or undefined when it wasn't recorded. */
function settle({ card, buttons, extra, row }, q, a) {
  for (const b of buttons) b.disabled = true;
  card.classList.add("answered");
  row.remove();
  extra.remove();
  if (!a) return card.append(el("div", "given muted", "Answered"));
  const graded = q.correct != null && a.i >= 0 && !a.skipped && !a.abandoned;
  if (a.i >= 0) buttons[a.i]?.classList.add("picked");
  if (graded) {
    buttons[q.correct]?.classList.add("right");
    if (a.i !== q.correct) buttons[a.i]?.classList.add("wrong");
  }
  const given = a.skipped || a.abandoned ? "" : !q.options.length ? a.text : a.i >= 0 && a.text ? `Your note: ${a.text}` : "";
  if (given) card.append(el("div", "given", given));
  if (a.skipped || a.abandoned) card.append(el("div", "given muted", a.skipped ? "Skipped" : "Left unanswered"));
}

let open = null; // the card waiting on the learner; the composer can answer it in words
export const openQuestion = () => open;

/** Shows `q` and resolves with the learner's answer: { i, text, skipped, abandoned }. */
export function askLearner(q) {
  return new Promise((resolve) => {
    const parts = build(q);
    const { card, buttons, extra, row } = parts;
    chatNode(card);
    const self = {
      // the chat box is for talking, not answering: a message sent there sets this question aside
      interrupt: (said) => done({ i: -1, text: said, skipped: true }),
      abandon: () => done({ i: -1, text: "", abandoned: true }),
    };
    function done(a) {
      if (open !== self) return;
      open = null;
      if (!a.skipped && !a.abandoned) a.text = extra.value.trim();
      settle(parts, q, a);
      resolve(a);
    }
    buttons.forEach((b, i) => (b.onclick = () => done({ i })));
    if (!q.options.length) {
      // a short answer: the box is the whole card, with a button to hand it in
      const check = el("button", "primary", "Check");
      check.type = "button";
      check.onclick = () => extra.value.trim() && done({ i: -1 });
      row.append(extra, check);
      card.append(row);
      requestAnimationFrame(() => extra.focus());
    }
    extra.onkeydown = (e) => { if (q.free && e.key === "Enter" && extra.value.trim()) done({ i: -1 }); };
    // the question, not just its options, has to be in view: a card taller than the chat shows from its top
    requestAnimationFrame(() => card.scrollIntoView({ block: card.offsetHeight > log().clientHeight ? "start" : "end" }));
    open = self;
    thinking(false);
  });
}

/** A question from earlier in the lesson, as it was answered. */
export function replayQuestion(q, answer) {
  const parts = build(q);
  chatNode(parts.card);
  settle(parts, q, answer);
}
