// The start screen: what to learn, how to start (the gear), and material to teach from.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { $, el, store, toast } from "./dom.js";
import { icon } from "./icons.js";
import { app, folderPath, materialsFor } from "./state.js";
import { GEARS, gearNote } from "./phases.js";
import { confirmDialog } from "./dialogs.js";
import { refresh, renderSidebar, unfold } from "./sidebar.js";
import { leave, openSource, renderSources, show, showLesson } from "./lesson.js";
import { send } from "./composer.js";
import { tutorReady } from "./who.js";

let pending = []; // material picked on the start screen, saved when the lesson starts
let gear = store.get("learn.gear", "probe");
const OPENERS = [
  "What do you want to learn?", "What are we learning today?", "What's next on your list?", "Where should we begin?",
  "What do you want to understand?", "What's been on your mind?", "Pick something to master.", "What are you curious about?",
];
let opener = OPENERS[0];

function chip(name, words, onRemove) {
  const c = el("span", "chip");
  c.innerHTML = icon("doc", 18);
  c.append(el("span", "", name), el("small", "", `${Math.round(words / 1000) || "<1"}k`));
  const x = el("button");
  x.type = "button";
  x.innerHTML = icon("x", 16);
  x.setAttribute("aria-label", `Remove ${name}`);
  x.onclick = onRemove;
  c.append(x);
  return c;
}

export function renderStart() {
  const path = folderPath(app.target);
  const subject = app.target != null;
  $("#crumb").textContent = subject ? (path.length > 1 ? `${path.slice(0, -1).join(" / ")} · New lesson` : "New lesson") : "";
  $("#start-title").textContent = subject ? path.at(-1) : opener;
  $("#start-input").setAttribute("aria-label", subject ? "What should this lesson cover?" : "What do you want to learn?");
  $("#materials").replaceChildren(...pending.map((p, i) => chip(p.name, p.words, () => {
    pending.splice(i, 1);
    invoke("forget_source", { token: p.token }).catch(() => {});
    renderStart();
  })));
  $("#gears").replaceChildren(
    ...Object.entries(GEARS).map(([id, g]) => {
      const b = el("button", "gear");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(id === gear));
      b.append(el("b", "", g.label), el("span", "", g.about));
      b.onclick = () => { gear = id; store.set("learn.gear", id); renderStart(); };
      return b;
    }),
  );
  $("#library").hidden = !subject;
  if (!subject) return;
  $("#library-list").replaceChildren(
    ...materialsFor(app.target).map((s) => {
      const r = el("div", "mat");
      r.innerHTML = icon("doc", 18);
      const name = el("button", "name", s.name);
      name.type = "button";
      name.onclick = () => openSource(s);
      const x = el("button", "icon");
      x.type = "button";
      x.innerHTML = icon("x", 16);
      x.title = `Remove ${s.name}`;
      x.onclick = async () => {
        if (!(await confirmDialog([`Remove “${s.name}”?`, "The tutor won't teach from it anymore.", "Remove"]))) return;
        await invoke("delete_source", { id: s.id });
        await refresh();
        renderStart();
      };
      r.append(name, el("small", "", `${s.words.toLocaleString()} words`), x);
      return r;
    }),
  );
}

/** The start screen for a new lesson in `folder` (null: a new subject). */
export function startNew(folder) {
  leave();
  if (folder == null) opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  app.lesson = null;
  app.target = folder;
  for (const p of pending) invoke("forget_source", { token: p.token }).catch(() => {});
  pending = [];
  $("#start-input").value = "";
  show("start");
  renderStart();
  renderSidebar();
  $("#start-input").focus();
}

/** Adds picked or dropped material (read by Rust, which hands back a token for each) to `folder`, or holds it
 *  for the subject about to be made. */
async function addMaterial(files, folder) {
  if (folder == null) pending.push(...files);
  else {
    let done = 0;
    for (const f of files) {
      toast(`Adding ${f.name}${files.length > 1 ? ` (${++done} of ${files.length})` : ""}…`, 0);
      try {
        await invoke("add_source", { folder, lesson: null, token: f.token });
      } catch (e) {
        toast(`Couldn't add ${f.name}: ${e}`);
        done = -1;
      }
    }
    if (done >= 0) toast(files.length ? `Added ${files.length > 1 ? `${files.length} files` : files[0].name}` : "", 2500);
    await refresh();
  }
  if (!$("#start").hidden) renderStart();
  if (app.lesson) renderSources();
}

/** Reads each path in Rust; one that can't be read is reported and skipped, not the whole drop. */
async function readAll(paths) {
  const files = [];
  for (const [i, path] of paths.entries()) {
    if (paths.length > 1) toast(`Reading ${i + 1} of ${paths.length}…`, 0);
    try {
      files.push(await invoke("read_source", { path }));
    } catch (e) {
      toast(`Couldn't read ${path.split(/[\\/]/).pop()}: ${e}`);
      return files;
    }
  }
  toast("");
  return files;
}

export async function attach({ folder } = {}) {
  try {
    await addMaterial(await invoke("pick_source"), folder ?? null);
  } catch (e) {
    toast(e);
  }
}

$("#add-material").onclick = () => attach({ folder: app.target });
$("#attach").onclick = () => attach();
$("#plus").onclick = () => attach({ folder: app.lesson?.folder });

// files dropped anywhere on the window become material for whatever subject is open
try {
  getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    $("#dropping").hidden = payload.type !== "over" && payload.type !== "enter";
    if (payload.type !== "drop") return;
    $("#dropping").hidden = true;
    const folder = app.lesson ? app.lesson.folder : !$("#start").hidden ? app.target : !$("#doc").hidden ? app.doc?.folder ?? null : null;
    await addMaterial(await readAll(payload.paths), folder);
  });
} catch { /* outside the app window (tests) */ }

let starting = false; // a second Enter while the first is still making the lesson would make two
$("#start-form").onsubmit = async (e) => {
  e.preventDefault();
  if (starting) return;
  starting = true;
  try {
    await start();
  } catch (e) {
    toast(e);
  } finally {
    starting = false;
  }
};

async function start() {
  const text = $("#start-input").value.trim();
  if (!text && !materialsFor(app.target).length && !pending.length) return $("#start-input").focus();
  if (!(await tutorReady())) return; // an API provider that isn't set up yet: its settings opened instead
  const g = GEARS[gear] ?? GEARS.probe;
  const words = text || "Teach me this material.";
  const title = text.split("\n")[0].slice(0, 200) || pending[0]?.name.replace(/\.\w+$/, "") || "New lesson";
  // a lesson always lives in a subject: from the home screen, the subject is made first
  let folder = app.target;
  if (folder == null) {
    folder = await invoke("create_folder", { parent: null, name: title });
    const held = pending;
    pending = [];
    for (const p of held) await invoke("add_source", { folder, lesson: null, token: p.token }).catch((e) => toast(`Couldn't add ${p.name}: ${e}`));
  }
  unfold(folder);
  const id = await invoke("create_lesson", { folder, title });
  await refresh();
  leave();
  app.target = folder;
  app.lesson = { id, title, folder, state: "", sections: 0, phase: g.phase, last: null, toolResults: {} };
  showLesson();
  renderSidebar();
  send(`${words}${gearNote(g)}`, words); // the tutor gets the gear; the chat shows what the learner wrote
}
