// The lesson tools: what each tool call from the tutor (API model or terminal agent) does in the app.
import { invoke } from "@tauri-apps/api/core";
import { app, leadHeading } from "./state.js";
import { say, step } from "./chat.js";
import { addSection, showNotes } from "./canvas.js";
import { askLearner, echo, questionOf } from "./cards.js";
import { PHASES } from "./phases.js";
import { renderSuggest } from "./lesson.js";

/** What the "Thinking…" block says about a tool call, if anything. */
function describe(name, input) {
  const src = (id) => app.data.sources.find((x) => x.id === Number(id))?.name ?? `material ${id}`;
  switch (name) {
    case "write_lesson": return `Wrote on the canvas${leadHeading(input.markdown) ? `: ${leadHeading(input.markdown)}` : ""}`;
    case "update_state": return "Updated its notes on this lesson";
    case "subject_notes": return "Updated its notes on the subject";
    case "search_material": return `Searched the material for “${input.query ?? ""}”`;
    case "read_material": return `Read ${src(input.material)}, part ${input.part}`;
    case "phase": return PHASES[input.phase] ? `Moved on to ${PHASES[input.phase].toLowerCase()}` : null;
    default: return null;
  }
}

const quoted = (s) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");

/** The result card a graded question leaves on the canvas. */
function resultCard(question, picked, correct, right, why, explanation) {
  const lines = [`[!${right ? "success" : "failure"}] ${question.replace(/\s*\n\s*/g, " ")}`];
  lines.push(right ? `**Answer:** ${picked}` : `**Your answer:** ${picked}\n**Correct answer:** ${correct}`);
  if (why) lines.push(`**Your note:** ${why}`);
  if (explanation) lines.push("", explanation);
  return quoted(lines.join("\n"));
}

const LEFT = "The learner left this lesson before answering. Wait for their next message.";
const QUESTIONS = new Set(["quiz", "true_false", "short_answer", "ask"]);

/** Checks a question call's input; the message is what the tutor is told when it's wrong. */
function invalid(name, input) {
  switch (name) {
    case "quiz": {
      const { question, options, correct_index: c } = input;
      return typeof question !== "string" || !Array.isArray(options) || options.length < 2 || !Number.isInteger(c) || c < 0 || c >= options.length
        ? "quiz needs a question, at least 2 options and a valid 0-based correct_index." : null;
    }
    case "true_false": return typeof input.statement !== "string" || typeof input.answer !== "boolean" ? "true_false needs a statement and a boolean answer." : null;
    case "short_answer": return typeof input.question !== "string" || typeof input.answer !== "string" ? "short_answer needs a question and a model answer." : null;
    case "ask": return typeof input.question !== "string" || !Array.isArray(input.options) ? "ask needs a question and options." : null;
  }
}

/** Runs one tool call for lesson `to` (default: the open one) and returns its tool_result. A question's result also
 *  carries `answer` (what the learner did), which the app keeps to replay the chat; it isn't sent to the tutor.
 *  `t`: the turn it came in ({ live: streamed canvas sections, invalid: unparsable inputs, truncated }). */
/** A data tool an agent's call ran in Rust (no window needed): show the step, and what it changed. */
export function didTool(name, input, to) {
  const here = to === app.lesson;
  const said = here && describe(name, input);
  if (said) step(said);
  if (name === "update_state" && typeof input.markdown === "string") {
    to.state = input.markdown;
    if (here) showNotes(input.markdown);
  }
  if (name === "phase" && PHASES[input.phase]) {
    to.phase = input.phase;
    if (here) renderSuggest();
  }
}

export async function executeTool({ id, name, input = {} }, t, to = app.lesson) {
  const ok = (content) => ({ type: "tool_result", tool_use_id: id, content });
  const bad = (content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
  const live = t.live.get(id); // the section already streamed onto the canvas, if any
  const fail = (msg) => { live?.box.remove(); return bad(msg); };
  const here = to === app.lesson;
  const said = here && describe(name, input);
  if (said) step(said);
  if (t.truncated) return fail("Your reply was cut off at the output limit before this call finished. Make the step shorter and call the tool again.");
  if (id in t.invalid) return fail(JSON.stringify({ INVALID_JSON: t.invalid[id] }));

  switch (name) {
    case "write_lesson":
      if (typeof input.markdown !== "string") return fail("write_lesson needs a markdown string.");
      await addSection(input.markdown, live, to);
      return ok("Added to the lesson.");
    case "update_state":
      if (typeof input.markdown !== "string") return bad("update_state needs a markdown string.");
      await invoke("set_state", { lesson: to.id, markdown: input.markdown });
      to.state = input.markdown;
      if (here) showNotes(input.markdown);
      return ok("Lesson state saved.");
    case "phase":
      if (!PHASES[input.phase]) return bad("phase is one of probe, plan, teach, review.");
      to.phase = input.phase;
      if (here) renderSuggest();
      return ok(`Phase: ${input.phase}.`);
    case "search_material":
      if (typeof input.query !== "string") return bad("search_material needs a query.");
      return ok(await invoke("material_search", { lesson: to.id, query: input.query }));
    case "read_material":
      try {
        return ok(await invoke("material_read", { lesson: to.id, material: Number(input.material), part: Number(input.part) }));
      } catch (e) {
        return bad(String(e));
      }
    case "subject_notes":
      if (typeof input.markdown !== "string") return bad("subject_notes needs a markdown string.");
      await invoke("set_subject_notes", { lesson: to.id, markdown: input.markdown });
      return ok("Subject notes saved. Every lesson in this subject will start from them.");
    case "say":
      if (typeof input.text !== "string") return bad("say needs text.");
      if (here) say(input.text);
      return ok("Shown in the chat.");
  }
  if (!QUESTIONS.has(name)) return bad(`Unknown tool: ${name}`);
  const problem = invalid(name, input);
  if (problem) return bad(problem);
  if (!here) return { ...bad(LEFT), abandoned: true };

  const q = questionOf(name, input);
  const a = await askLearner(q);
  if (a.abandoned) return { ...bad(LEFT), abandoned: true };
  const words = echo(name, q, a);
  if (words) say(words, "user");
  const answered = (content) => ({ ...ok(content), answer: a });
  if (a.skipped) {
    return answered(`The learner skipped this question and wrote in the chat instead: "${a.text}". Respond to that first; it may change what you do next. Don't repeat the skipped question unless it still fits.`);
  }
  if (name === "ask") return answered(`The learner answered: ${words}`);
  if (name === "short_answer") {
    const lines = [`[!question] ${input.question.replace(/\s*\n\s*/g, " ")}`, `**Your answer:** ${a.text}`, `**A good answer:** ${input.answer}`];
    if (input.explanation) lines.push("", input.explanation);
    await addSection(quoted(lines.join("\n")));
    return answered(`The learner answered: "${a.text}". Your model answer: "${input.answer}". Judge it yourself (equivalent wording and small spelling slips count as right) and tell them in one line; the comparison and your explanation are already on the canvas.`);
  }
  // quiz and true_false are graded here
  if (a.i < 0) return answered(`The learner didn't pick ${name === "quiz" ? "an option" : "True or False"}. They wrote: ${a.text}`);
  const picked = q.options[a.i];
  const right = a.i === q.correct;
  const correct = q.options[q.correct];
  const question = q.question;
  await addSection(resultCard(question, picked, correct, right, a.text, input.explanation ?? ""));
  const note = a.text ? ` Their note: ${a.text}` : "";
  if (name === "true_false") {
    return answered(`The learner said "${picked}" (${right ? "correct" : `incorrect; the statement is ${input.answer ? "true" : "false"}`}).${note} The result card with your explanation is already in the lesson.`);
  }
  return answered(`The learner chose "${picked}" (${right ? "correct" : `incorrect; correct answer: "${correct}"`}).${note} The result card with your explanation is already in the lesson, so don't repeat it.`);
}

/** The block the tutor gets: a tool_result without the app's own `answer` record. */
export const forTutor = ({ answer, abandoned, ...block }) => block;
