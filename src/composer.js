// The chat box and its send button, which turns into a stop button while the tutor works.
import { $ } from "./dom.js";
import { icon } from "./icons.js";
import { app } from "./state.js";
import { note, onWork, thinking } from "./chat.js";
import { openQuestion } from "./cards.js";
import { agentStatus, agentWorking, sendToAgent, stopAgent, usingAgent } from "./agents.js";
import { apiWorking, sendToApi, stopApi } from "./api.js";

export const working = () => !!app.lesson && !openQuestion() && (usingAgent() ? agentWorking() : apiWorking());

export function setWorking() {
  const on = working();
  const b = $("#composer .send");
  b.classList.toggle("stop", on);
  b.innerHTML = on ? '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>' : icon("send", 20);
  b.setAttribute("aria-label", on ? "Stop" : "Send");
  b.title = on ? "Stop" : "";
}

// the "Thinking…" block says what it waits for until the tutor has the message, and the button follows it
onWork({ status: () => (usingAgent() ? agentStatus() : null), changed: setWorking });

/** The learner's message (or a shortcut) goes to whoever is teaching. `shown`: what the chat shows, when the
 *  tutor gets more than the learner typed (the starting gear). */
export async function send(text, shown = text) {
  if (!app.lesson) return;
  const question = openQuestion();
  if (question) return question.interrupt(text); // the question's tool call returns with this message
  return usingAgent() ? sendToAgent(text, shown) : sendToApi(text, shown);
}

export async function stop() {
  if (!app.lesson) return;
  await (usingAgent() ? stopAgent() : stopApi());
  thinking(false);
  note("Stopped.");
}

const grow = (t) => {
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
};
const enterSubmits = (form) => (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
};

$("#composer").onsubmit = (e) => {
  e.preventDefault();
  if (working() && !$("#input").value.trim()) return stop();
  const text = $("#input").value.trim();
  if (!text || !app.lesson) return;
  $("#input").value = "";
  grow($("#input"));
  send(text);
};
$("#start-input").onkeydown = enterSubmits($("#start-form"));
$("#input").onkeydown = enterSubmits($("#composer"));
$("#input").oninput = () => grow($("#input"));
