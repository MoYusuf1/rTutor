// The lesson canvas: the lesson itself, one section per write_lesson, plus the tutor's notes.
import { invoke } from "@tauri-apps/api/core";
import { $ } from "./dom.js";
import { md, drawDiagrams } from "./markdown.js";
import { app, leadHeading } from "./state.js";
import { newestFirst } from "./lazy.js";
import { refresh } from "./sidebar.js";

const body = () => $("#canvas-body");
let stopLazy = () => {};

/** A lesson's sections, newest in view; older ones render as the learner scrolls up to them. */
export function showSections(sections, title) {
  stopLazy();
  body().replaceChildren();
  body().classList.toggle("titled", !!sections.length && leadHeading(sections[0]) === title);
  stopLazy = newestFirst({
    box: body(),
    scroller: $("#canvas"),
    items: sections,
    batch: 20,
    render: (m, frag) => frag.append(md(m)),
    placed: (nodes) => nodes.forEach(drawDiagrams),
  });
}

/** New lesson content writes itself in, and the canvas glides to it so the newest part is in view. */
export function reveal(box) {
  box.classList.add("appear");
  requestAnimationFrame(() => box.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
}

/** Shows the latest of a lesson: the start of its newest section, and the end of the chat. */
export function showLatest() {
  const last = body().lastElementChild;
  if (last) last.scrollIntoView({ block: "start" });
  else $("#canvas").scrollTop = 0;
  $("#log").scrollTop = $("#log").scrollHeight;
}

export function showNotes(markdown) {
  $("#notes").hidden = !markdown;
  if (markdown) $("#notes-body").replaceChildren(md(markdown));
}

/** Adds a section to lesson `to` (default: the open one), on screen only if it is open. `live`: the section
 *  already streamed onto the canvas, if any. */
export async function addSection(markdown, live, to = app.lesson) {
  const shown = to === app.lesson;
  if (live) live.finish(markdown);
  else if (shown) {
    const box = md(markdown);
    body().append(box);
    drawDiagrams(box);
    reveal(box);
  }
  await invoke("add_section", { lesson: to.id, markdown });
  // the first heading the tutor writes becomes the lesson title (shown once, not twice)
  if (to.sections++ === 0 && leadHeading(markdown)) {
    to.title = leadHeading(markdown);
    if (shown) {
      $("#title").textContent = to.title;
      body().classList.add("titled");
    }
    await invoke("rename_lesson", { id: to.id, title: to.title });
    refresh();
  }
}
