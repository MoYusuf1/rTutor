import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./style.css";
import { $, el, store } from "./dom.js";
import { icon, logo, agentLook } from "./icons.js";
import { md, drawDiagrams, partialField } from "./markdown.js";
import { startTimer } from "./timer.js";

for (const e of document.querySelectorAll("[data-icon]")) e.innerHTML = icon(e.dataset.icon);


/** A node whose markdown re-renders at most once per frame while text streams in. */
function liveMarkdown(parent) {
  const box = el("div");
  parent === log() ? chatNode(box) : parent.append(box);
  let src = "";
  let queued = false;
  let done = false; // once final, a frame still queued from streaming must not overwrite it
  return {
    box,
    set(text) {
      src = text;
      if (queued || done) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (done) return;
        box.replaceChildren(md(src, false));
        follow(box);
      });
    },
    finish(text = src) {
      done = true;
      box.replaceChildren(md(text));
      drawDiagrams(box);
    },
  };
}

function follow(node) {
  const s = node.closest("#log, #canvas") ?? node;
  if (s.scrollHeight - s.scrollTop - s.clientHeight < 200) s.scrollTop = s.scrollHeight;
}
const log = () => $("#log");
/** Adds to the chat. Anything the tutor shows ends the current "Thinking…" block, which folds above it;
 *  a new one starts below if it keeps working. */
function chatNode(node) {
  if (work) thinking(false);
  log().append(node);
  if (restoring) log().scrollTop = log().scrollHeight;
  else requestAnimationFrame(() => log().scrollTo({ top: log().scrollHeight, behavior: "smooth" }));
  return node;
}
function say(text, who = "bot") {
  chatNode(el("div", `msg ${who}${restoring ? "" : " appear"}`)).append(md(text));
}
let restoring = false; // reopening a lesson: its history shows at once, without the arrival animation

/** New lesson content writes itself in, and the canvas glides to it so the newest part is in view. */
function reveal(box) {
  box.classList.add("appear");
  requestAnimationFrame(() => box.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
}

/** Shows the latest of a lesson: the start of its newest section, and the end of the chat. */
function showLatest() {
  const last = $("#canvas-body").lastElementChild;
  if (last) last.scrollIntoView({ block: "start" });
  else $("#canvas").scrollTop = 0;
  log().scrollTop = log().scrollHeight;
}
const note = (text) => chatNode(el("div", "meta", text));
// While the tutor works, a collapsible "Thinking…" block shows what it is doing: its reasoning (API models
// that share it) and each step (searching the material, writing on the canvas). Afterwards it folds into
// "Thought for 12s". Terminal agents show their full reasoning in their own terminal.
let work = null; // { node, body, label, started, steps, timer }

// What the "Thinking…" line says, picked fresh each time, the way Claude Code does
const MUSINGS = [
  "Thinking", "Pondering", "Turning pages", "Connecting the dots", "Sharpening a question", "Finding a good example",
  "Sketching it out", "Mulling it over", "Choosing the next step", "Looking it up", "Drawing a picture", "Weighing the options",
  "Untangling it", "Lining up the ideas", "Finding the right angle", "Checking the material", "Building it up",
];
const musing = () => MUSINGS[Math.floor(Math.random() * MUSINGS.length)];

/** The live line: a musing, how long it's been, and, for an agent that hasn't picked the message up, that. */
function workLabel() {
  if (!work) return;
  const secs = Math.round((Date.now() - work.started) / 1000);
  const a = agents.find((x) => x.id === activeAgent);
  const pending = usingAgent() && sentWaiting && a && !a.busy;
  work.label.textContent = pending
    ? `Waiting for ${agentLook(a.name).label} to pick this up… ${secs}s`
    : `${work.musing}… ${secs >= 3 ? `${secs}s` : ""}`.trim();
  if (secs && secs % 8 === 0) work.musing = musing();
}

function thinking(on) {
  // picking up right where the last block ended (nothing shown in between): continue that block
  const last = log().lastElementChild;
  if (on && !work && last?.classList.contains("work") && last.classList.contains("done")) {
    const dots = el("span", "dots");
    dots.append(el("i"), el("i"), el("i"));
    last.querySelector("summary").prepend(dots);
    last.classList.remove("done");
    last.open = true;
    work = { node: last, body: last.querySelector(".work-body"), label: last.querySelector("summary span:last-child"), started: Number(last.dataset.started), steps: last.querySelectorAll(".step").length, musing: musing() };
    work.timer = setInterval(workLabel, 1000);
    workLabel();
  } else if (on && !work) {
    const node = el("details", "work");
    const summary = el("summary");
    const dots = el("span", "dots");
    dots.append(el("i"), el("i"), el("i"));
    const label = el("span", "", "");
    summary.append(dots, label);
    const body = el("div", "work-body");
    node.append(summary, body);
    node.open = true; // open while it works, folded once it's done
    log().append(node);
    log().scrollTop = log().scrollHeight;
    node.dataset.started = Date.now();
    work = { node, body, label, started: Date.now(), steps: 0, musing: musing() };
    work.timer = setInterval(workLabel, 1000);
    workLabel();
  } else if (!on && work) {
    const w = work;
    work = null;
    clearInterval(w.timer);
    if (!w.steps && !w.body.textContent.trim()) w.node.remove();
    else {
      w.node.classList.add("done");
      w.node.open = false;
      w.node.querySelector(".dots").remove();
      const secs = Math.max(1, Math.round((Date.now() - w.started) / 1000));
      w.label.textContent = `Thought for ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}`;
    }
  }
  setWorking();
}

/** One line in the live "Thinking…" block. */
function step(text) {
  if (!work) return;
  work.steps++;
  work.body.append(el("div", "step", text));
  follow(work.body);
}

// ---------- data ----------

let data = { folders: [], lessons: [], sources: [] };
let lesson = null; // { id, title, folder, state, sections, phase, last, toolResults }
let target = null; // folder new items go into
let gen = 0; // bumps whenever the open lesson changes, so late events from the old one are dropped
const opened = new Set(store.get("learn.open", []));

const folderById = (id) => data.folders.find((f) => f.id === id);
function folderPath(id) {
  const names = [];
  for (let f = folderById(id); f; f = folderById(f.parent)) names.unshift(f.name);
  return names;
}
/** Material a lesson in `folder` (or the lesson itself) would be taught from. */
function materialsFor(folder, lessonId) {
  const chain = new Set();
  for (let f = folderById(folder); f; f = folderById(f.parent)) chain.add(f.id);
  return data.sources.filter((s) => chain.has(s.folder) || (lessonId && s.lesson === lessonId));
}

async function refresh() {
  data = await invoke("tree");
  renderSidebar();
}

// ---------- sidebar: subjects with their lessons ----------

function row(kind, item) {
  const r = el("div", `row ${kind}`);
  r.dataset.kind = kind;
  r.dataset.id = item.id;
  if (kind === "folder") r.innerHTML = `<span class="chev">${icon("chev", 16)}</span>${icon(opened.has(item.id) ? "folderOpen" : "folder", 20)}`;
  if (kind === "source") r.innerHTML = icon("doc", 18);
  r.append(el("span", "label", item.name ?? item.title));
  if (kind === "source") r.append(el("span", "side", `${Math.round(item.words / 1000) || "<1"}k`));
  if (kind === "lesson" && item.id === lesson?.id) r.classList.add("active");
  if (kind === "folder" && item.id === target && !$("#start").hidden) r.classList.add("active");
  r.draggable = kind !== "source";
  return r;
}

function renderSidebar() {
  // group once (O(n)), instead of filtering every list for every folder
  const group = (list, key) => {
    const m = new Map();
    for (const x of list) (m.get(x[key] ?? null) ?? m.set(x[key] ?? null, []).get(x[key] ?? null)).push(x);
    return m;
  };
  const folders = group(data.folders, "parent");
  const lessons = group(data.lessons, "folder");
  const build = (parent) => {
    const frag = document.createDocumentFragment();
    for (const f of folders.get(parent) ?? []) {
      const wrap = el("div", `folder${opened.has(f.id) ? " open" : ""}`);
      const kids = el("div", "children");
      kids.append(build(f.id));
      wrap.append(row("folder", f), kids);
      frag.append(wrap);
    }
    for (const l of lessons.get(parent) ?? []) frag.append(row("lesson", l));
    return frag;
  };
  $("#tree").replaceChildren(build(null));
  const pins = data.lessons.filter((l) => l.bookmarked);
  $("#pinned-sec").hidden = !pins.length;
  $("#pinned").replaceChildren(...pins.map((l) => row("lesson", l)));
}

const item = (r) => {
  const id = Number(r.dataset.id);
  return { kind: r.dataset.kind, id, it: (r.dataset.kind === "folder" ? data.folders : r.dataset.kind === "source" ? data.sources : data.lessons).find((x) => x.id === id) };
};

$("#side-scroll").addEventListener("click", (e) => {
  const r = e.target.closest(".row");
  if (!r || r.querySelector("input")) return;
  const { kind, id, it } = item(r);
  if (kind === "folder") {
    // the chevron only folds; the name opens the subject (and unfolds it)
    const fold = e.target.closest(".chev") || (target === id && !$("#start").hidden);
    if (fold && opened.has(id)) opened.delete(id);
    else opened.add(id);
    store.set("learn.open", [...opened]);
    if (!e.target.closest(".chev")) startNew(id);
    else renderSidebar();
  } else if (kind === "lesson") openLesson(id);
  else openSource(it);
});
$("#side-scroll").addEventListener("dblclick", (e) => {
  const r = e.target.closest(".row");
  if (r && r.dataset.kind !== "source") rename(r);
});

function rename(r) {
  const { kind, id, it } = item(r);
  const label = r.querySelector(".label");
  const input = el("input");
  input.value = it.name ?? it.title;
  label.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== (it.name ?? it.title)) {
      await invoke(kind === "folder" ? "rename_folder" : "rename_lesson", kind === "folder" ? { id, name: value } : { id, title: value });
      if (kind === "lesson" && lesson?.id === id) $("#title").textContent = lesson.title = value;
    }
    refresh();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
}

async function newFolder(parent) {
  const id = await invoke("create_folder", { parent, name: "Untitled" });
  if (parent != null) opened.add(parent);
  await refresh();
  rename($(`#tree .row[data-kind="folder"][data-id="${id}"]`));
}

// drag a lesson or folder onto a folder, or onto Recents to take it out of its folder
let dragged = null;
const side = $("#side-scroll");
side.addEventListener("dragstart", (e) => { dragged = item(e.target.closest(".row")); });
side.addEventListener("dragover", (e) => {
  const r = e.target.closest(".row");
  // lessons go into a subject; a folder can also go back to the top level
  if (!dragged || (r ? r.dataset.kind !== "folder" : dragged.kind !== "folder")) return;
  e.preventDefault();
  for (const x of document.querySelectorAll(".drop")) x.classList.remove("drop");
  r?.classList.add("drop");
});
side.addEventListener("drop", async (e) => {
  e.preventDefault();
  const r = e.target.closest(".row");
  const folder = r ? Number(r.dataset.id) : dragged?.kind === "folder" ? null : undefined;
  if (dragged && folder !== undefined && !(dragged.kind === "folder" && dragged.id === folder)) {
    await invoke("move_item", { kind: dragged.kind, id: dragged.id, folder }).catch(() => {}); // refused if it would nest a folder in itself
    if (folder != null) opened.add(folder);
    if (dragged.kind === "lesson" && lesson?.id === dragged.id) lesson.folder = folder;
  }
  dragged = null;
  refresh();
});
side.addEventListener("dragend", () => { dragged = null; renderSidebar(); });

// ---------- confirm dialog ----------

/** Asks before something can't be undone. Resolves true on the red button. */
function confirmDialog([title, text, action]) {
  const d = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = action;
  d.returnValue = "";
  d.showModal();
  $("#confirm-ok").focus();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

// ---------- context menu ----------

function menu(x, y, entries) {
  const m = $("#menu");
  m.replaceChildren(
    ...entries.map((e) => {
      if (e === "-") return el("hr");
      const b = el("button", e.danger ? "danger" : "", e.label);
      b.onclick = async () => {
        m.hidden = true;
        if (e.danger && !(await confirmDialog(e.confirm ?? [`${e.label}?`, "This can't be undone.", e.label]))) return;
        await e.run();
      };
      return b;
    }),
  );
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
}
addEventListener("click", (e) => {
  if (!e.target.closest("#menu")) $("#menu").hidden = true;
  if (!e.composedPath().some((n) => n.id === "pop" || n.id === "model")) $("#pop").hidden = true;
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#menu").hidden = $("#pop").hidden = true;
    toggleSources(false);
  }
});

side.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const r = e.target.closest(".row");
  if (!r) return menu(e.clientX, e.clientY, [{ label: "New subject", run: () => startNew(null) }]);
  const { kind, id, it } = item(r);
  if (kind === "folder") {
    menu(e.clientX, e.clientY, [
      { label: "New lesson", run: () => startNew(id) },
      { label: "Add material", run: () => attach({ folder: id }) },
      { label: "New folder inside", run: () => newFolder(id) },
      "-",
      { label: "Rename", run: () => rename(r) },
      { label: "Delete subject", danger: true, confirm: [`Delete “${it.name}”?`, "Its lessons and material go too. This can't be undone.", "Delete subject"], run: async () => {
        await invoke("delete_folder", { id });
        if (lesson && !data.lessons.some((l) => l.id === lesson.id && l.folder !== id)) startNew(null);
        refresh();
      } },
    ]);
  } else if (kind === "lesson") {
    menu(e.clientX, e.clientY, [
      { label: it.bookmarked ? "Unpin" : "Pin", run: async () => { await invoke("bookmark_lesson", { id, on: !it.bookmarked }); refresh(); } },
      { label: "Rename", run: () => rename(r) },
      { label: "Export as Markdown", run: () => invoke("export_lesson", { id }) },
      "-",
      { label: "Delete lesson", danger: true, confirm: [`Delete “${it.title}”?`, "The lesson, its chat and notes go for good.", "Delete lesson"], run: async () => {
        await invoke("delete_lesson", { id });
        if (lesson?.id === id) startNew(target);
        refresh();
      } },
    ]);
  } else {
    menu(e.clientX, e.clientY, [{ label: "Remove material", danger: true, confirm: [`Remove “${it.name}”?`, "The tutor won't teach from it anymore.", "Remove"], run: async () => { await invoke("delete_source", { id }); refresh(); } }]);
  }
});

// ---------- sidebar: search, collapse ----------

function setSearch(on) {
  $("#search-input").hidden = !on;
  $("#search-btn").hidden = on;
  $("#results").hidden = !on || !$("#search-input").value;
  $("#sections").hidden = !$("#results").hidden;
  if (on) $("#search-input").focus();
  else $("#search-input").value = "";
}
$("#search-btn").onclick = () => setSearch(true);
$("#search-input").onblur = () => { if (!$("#search-input").value) setSearch(false); };
$("#search-input").onkeydown = (e) => { if (e.key === "Escape") setSearch(false); };

let searchTimer;
$("#search-input").oninput = () => {
  clearTimeout(searchTimer);
  setSearch(true);
  searchTimer = setTimeout(async () => {
    const hits = await invoke("search", { query: $("#search-input").value });
    $("#results").replaceChildren(
      ...hits.map((h) => {
        const d = el("div", "hit");
        d.append(el("div", "", h.title));
        if (h.snippet) {
          const s = el("div", "snip");
          s.textContent = h.snippet;
          s.innerHTML = s.innerHTML.replaceAll("\u0001", "<mark>").replaceAll("\u0002", "</mark>"); // escaped text, then marks
          d.append(s);
        }
        d.onclick = () => openLesson(h.id);
        return d;
      }),
    );
  }, 120);
};

const setCollapsed = (on) => {
  document.body.classList.toggle("collapsed", on);
  store.set("learn.collapsed", on);
};
$("#collapse").onclick = () => setCollapsed(true);
$("#expand").onclick = () => setCollapsed(false);

// ---------- views ----------

function show(view) {
  for (const v of ["start", "lesson", "doc"]) $(`#${v}`).hidden = v !== view;
}

function chip(name, words, onRemove) {
  const c = el("span", `chip${onRemove ? "" : " inherited"}`);
  c.innerHTML = icon("doc", 18);
  c.append(el("span", "", name), el("small", "", `${Math.round(words / 1000) || "<1"}k`));
  if (onRemove) {
    const x = el("button");
    x.type = "button";
    x.innerHTML = icon("x", 16);
    x.setAttribute("aria-label", `Remove ${name}`);
    x.onclick = onRemove;
    c.append(x);
  }
  return c;
}

let pending = []; // material picked on the start screen, saved when the lesson starts

const GEARS = {
  scratch: { label: "Start from scratch", about: "New to this? Learn it from the foundations up.", phase: "plan",
    tell: "I'm new to this. Don't test what I know beyond one question about my goal: plan, then teach from the foundations." },
  probe: { label: "Find what I know", about: "A few questions first, so the lessons start at your level.", phase: "probe",
    tell: "Start by finding out what I already know." },
  test: { label: "Test me", about: "Already familiar? Find the gaps, then fill them.", phase: "review",
    tell: "I'm already familiar with this. Test me to find my gaps, then teach what I miss." },
};
let gear = store.get("learn.gear", "probe");
const OPENERS = [
  "What do you want to learn?", "What are we learning today?", "What's next on your list?", "Where should we begin?",
  "What do you want to understand?", "What's been on your mind?", "Pick something to master.", "What are you curious about?",
];
let opener = OPENERS[0];

function renderStart() {
  const path = folderPath(target);
  const subject = target != null;
  $("#crumb").textContent = subject ? (path.length > 1 ? `${path.slice(0, -1).join(" / ")} · New lesson` : "New lesson") : "";
  $("#start-title").textContent = subject ? path.at(-1) : opener;
  $("#start-input").setAttribute("aria-label", subject ? "What should this lesson cover?" : "What do you want to learn?");
  $("#materials").replaceChildren(...pending.map((p, i) => chip(p.name, p.words, () => { pending.splice(i, 1); renderStart(); })));
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
  if (subject) {
    $("#library-list").replaceChildren(
      ...materialsFor(target).map((s) => {
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
}
$("#add-material").onclick = () => attach({ folder: target });

/** Leaving the open lesson: anything still waiting on the learner there is let go. */
function leave() {
  gen++;
  openCard?.abandon();
  thinking(false);
}

function startNew(folder) {
  leave();
  if (folder == null) opener = OPENERS[Math.floor(Math.random() * OPENERS.length)];
  lesson = null;
  target = folder;
  pending = [];
  $("#start-input").value = "";
  show("start");
  renderStart();
  renderSidebar();
  $("#start-input").focus();
}
$("#new-subject").onclick = () => startNew(null);

/** Adds picked or dropped material to `folder`, or holds it for the subject about to be made. */
async function addMaterial(files, folder) {
  for (const f of files) {
    if (folder == null) pending.push(f);
    else await invoke("add_source", { folder, lesson: null, name: f.name, text: f.text }).catch((e) => alert(e));
  }
  if (folder != null) await refresh();
  if (!$("#start").hidden) renderStart();
  if (lesson) renderSources();
}

async function attach({ folder } = {}) {
  try {
    await addMaterial(await invoke("pick_source"), folder ?? null);
  } catch (e) {
    alert(e);
  }
}

// files dropped anywhere on the window become material for whatever subject is open
try {
  getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    $("#dropping").hidden = payload.type !== "over" && payload.type !== "enter";
    if (payload.type !== "drop") return;
    $("#dropping").hidden = true;
    const folder = lesson ? lesson.folder : !$("#start").hidden ? target : null;
    try {
      const files = [];
      for (const path of payload.paths) files.push(await invoke("read_source", { path }));
      await addMaterial(files, folder);
    } catch (e) {
      alert(e);
    }
  });
} catch { /* outside the app window (tests) */ }
$("#attach").onclick = () => attach();

async function openSource(s) {
  const { name, body } = await invoke("get_source", { id: s.id });
  leave();
  lesson = null;
  show("doc");
  renderSidebar();
  $("#doc-title").textContent = name;
  $("#doc-words").textContent = `${s.words.toLocaleString()} words`;
  if (/\.md$/i.test(name)) $("#doc-body").replaceChildren(md(body));
  else $("#doc-body").replaceChildren(el("pre", "plain", body));
  $("#doc").scrollTop = 0;
}

const leadHeading = (markdown = "") => markdown.match(/^#{1,2}\s+(.+)$/m)?.[1].replace(/[*_`$]/g, "").trim().slice(0, 200);

function showNotes(markdown) {
  $("#notes").hidden = !markdown;
  if (markdown) $("#notes-body").replaceChildren(md(markdown));
}

/** The Sources panel (top right of a lesson): everything the tutor teaches this lesson from. */
function renderSources() {
  const list = materialsFor(lesson.folder, lesson.id);
  const words = list.reduce((n, s) => n + s.words, 0);
  $("#sources-count").textContent = list.length || "";
  const head = el("header");
  head.append(el("h3", "", "Sources"), el("span", "sub", list.length ? `${list.length} in this subject · ${fmt(words)} words` : "None yet"));
  $("#sources-pop").replaceChildren(
    head,
    ...(list.length ? [] : [el("p", "empty", "Use + in the chat, or drop files anywhere, to add a textbook, slides, notes or a transcript.")]),
    ...list.map((s) => {
      const r = el("div", "src");
      const kind = (s.name.match(/\.(\w+)$/)?.[1] ?? "txt").toUpperCase();
      const badge = el("span", `kind kind-${kind.toLowerCase()}`, kind.slice(0, 4));
      const text = el("button", "src-text");
      text.type = "button";
      text.title = "Open";
      text.append(el("span", "name", s.name.replace(/\.\w+$/, "")), el("small", "", `${s.words.toLocaleString()} words`));
      text.onclick = () => { toggleSources(false); openSource(s); };
      const x = el("button", "icon remove");
      x.type = "button";
      x.innerHTML = icon("trash", 16);
      x.title = "Remove";
      x.onclick = async () => {
        if (!(await confirmDialog([`Remove “${s.name}”?`, "The tutor won't teach from it anymore.", "Remove"]))) return;
        await invoke("delete_source", { id: s.id });
        await refresh();
        renderSources();
      };
      r.append(badge, text, x);
      return r;
    }),
  );
}
function toggleSources(open = $("#sources-pop").hidden) {
  $("#sources-pop").hidden = !open;
  $("#sources-btn").setAttribute("aria-expanded", String(open));
}
$("#sources-btn").onclick = () => toggleSources();
$("#plus").onclick = () => attach({ folder: lesson?.folder });

function showLesson() {
  show("lesson");
  $("#title").textContent = lesson.title;
  $("#canvas-body").replaceChildren();
  $("#canvas-body").classList.remove("titled");
  log().replaceChildren();
  showNotes(lesson.state);
  renderSources();
  renderSuggest();
}

async function openLesson(id) {
  leave();
  const mine = gen;
  const l = await invoke("get_lesson", { id });
  if (mine !== gen) return; // the learner clicked something else meanwhile
  lesson = { id, title: l.title, folder: l.folder, state: l.state, sections: l.sections.length, toolResults: l.toolResults ?? {}, phase: null, last: null };
  target = l.folder;
  showLesson();
  restoring = true;
  for (const m of l.sections) {
    const node = md(m);
    $("#canvas-body").append(node);
    drawDiagrams(node);
  }
  $("#canvas-body").classList.toggle("titled", leadHeading(l.sections[0]) === lesson.title);
  for (const m of l.messages) {
    if (typeof m.content === "string") say(m.content, m.role === "user" ? "user" : "bot");
    else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) say(b.text);
        if (b.type === "tool_use" && b.name === "say" && b.input?.text) say(b.input.text);
        if (b.type === "tool_use" && b.name === "quiz") note(`Quiz: ${b.input?.question ?? ""}`);
        if (b.type === "tool_use" && b.name === "phase") lesson.phase = b.input?.phase;
      }
    }
  }
  restoring = false;
  // open on the newest part, not the top (diagrams and fonts settle a moment later, so look again)
  showLatest();
  setTimeout(() => mine === gen && showLatest(), 400);
  // no phase reported yet: the gear the lesson was started in
  const opener = l.messages[0]?.content;
  lesson.phase ??= typeof opener === "string" ? Object.values(GEARS).find((g) => opener.endsWith(g.tell))?.phase ?? null : null;
  const last = l.messages.at(-1);
  lesson.last = last?.role === "assistant" ? last.content : null;
  renderSidebar();
  renderSuggest();
  ensureAgent();
  showWho();
  if (lesson.id === agentLesson && agentThinking()) thinking(true);
  if (!usingAgent() && pendingCalls().length) runLoop(); // closed in the middle of a quiz: ask it again
}

// ---------- streaming one API turn ----------

async function streamTurn(content) {
  const mine = gen;
  thinking(true);
  const views = new Map();
  const live = new Map(); // tool_use id → live canvas section

  const ch = new Channel();
  ch.onmessage = (e) => {
    if (mine !== gen) return;
    if (e.type === "start") {
      const b = e.block;
      const view = { buf: "" };
      if (b.type === "text") view.md = liveMarkdown(log()), view.md.box.className = "msg bot";
      else if ((b.type === "thinking" || b.type === "reasoning") && work) view.md = liveMarkdown(work.body);
      else if (b.type === "tool_use" && b.name === "write_lesson") {
        view.md = liveMarkdown($("#canvas-body"));
        view.lesson = true;
        live.set(b.id, view.md);
      } else if (b.type === "server_tool_use") view.note = note("Searching the web…");
      else if (b.type === "fallback") note(`Continued on ${b.to?.model ?? "a fallback model"}.`);
      else if (b.type === "compaction") note("Earlier turns summarized to save tokens.");
      if (b.type === "text" || view.lesson) thinking(false);
      views.set(e.index, view);
    } else if (e.type === "delta") {
      const v = views.get(e.index);
      if (!v) return;
      v.buf += e.text;
      if (v.lesson) v.md.set(partialField(v.buf, "markdown"));
      else if (v.md) v.md.set(v.buf);
    } else if (e.type === "stop") {
      const v = views.get(e.index);
      if (v?.note) v.note.textContent = `Searched the web: ${partialField(v.buf, "query")}`;
      else if (v?.md && !v.lesson) v.md.finish();
    }
  };

  try {
    const reply = await invoke("send", { provider: provider(), lesson: lesson.id, content, onEvent: ch });
    const kept = new Set(reply.content.filter((b) => b.type === "tool_use").map((b) => b.id));
    for (const [id, view] of live) if (!kept.has(id)) view.box.remove(); // e.g. dropped by a fallback
    return { reply, live };
  } finally {
    if (mine === gen) thinking(false);
  }
}

/** What the "Thinking…" block says about a tool call, if anything. */
function describe(name, input = {}) {
  const src = (id) => data.sources.find((x) => x.id === Number(id))?.name ?? `material ${id}`;
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

// ---------- tools ----------

const pendingCalls = () => (Array.isArray(lesson?.last) ? lesson.last.filter((b) => b.type === "tool_use") : []);

let openCard = null; // the quiz or question waiting on the learner; the composer can answer it in words

function choiceCard(kind, question, options, { note: withNote = false, free = false } = {}) {
  return new Promise((resolve) => {
    const card = chatNode(el("div", `card ${kind}`));
    const q = el("div", "q");
    q.append(md(question));
    card.append(q);
    const extra = el("input");
    extra.setAttribute("aria-label", free ? "Your own answer" : "Why? (optional)");
    const buttons = options.map((o, i) => {
      const b = el("button", "opt");
      b.type = "button";
      b.append(el("span", "k", String.fromCharCode(65 + i)), md(o));
      b.onclick = () => done({ i });
      return b;
    });
    card.append(...buttons);
    if (withNote || free) {
      extra.placeholder = !options.length ? "Type your answer" : free ? "Your own answer" : "Why? (optional)";
      card.append(extra);
    }
    const row = el("div", "answer-row");
    if (!options.length) {
      // a short answer: the box is the whole card, with a button to hand it in
      const check = el("button", "primary", "Check");
      check.type = "button";
      check.onclick = () => extra.value.trim() && done({ i: -1 });
      row.append(extra, check);
      card.append(row);
      requestAnimationFrame(() => extra.focus());
    }
    extra.onkeydown = (e) => { if (free && e.key === "Enter" && extra.value.trim()) done({ i: -1 }); };
    card.scrollIntoView({ block: "nearest" });
    const self = {
      // the chat box is for talking, not answering: a message sent there sets this question aside
      interrupt: (said) => done({ i: -1, interrupted: said }),
      abandon: () => done({ abandoned: true }),
    };
    openCard = self;
    thinking(false);
    function done(r) {
      if (openCard !== self) return;
      openCard = null;
      for (const b of buttons) b.disabled = true;
      const text = extra.value.trim();
      // an answered card settles: the typing box and Check go, what was given stays as plain text
      card.classList.add("answered");
      if (r.i !== undefined && r.i >= 0) buttons[r.i].classList.add("picked");
      const given = r.interrupted ? "" : !options.length ? text : r.i >= 0 && text ? `Your note: ${text}` : "";
      row.remove();
      extra.remove();
      if (given && !r.abandoned) card.append(el("div", "given", given));
      if (r.abandoned || r.interrupted) card.append(el("div", "given muted", r.interrupted ? "Skipped" : "Left unanswered"));
      resolve({ ...r, buttons, text: r.interrupted ?? text });
    }
  });
}

const quoted = (s) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");
function resultCard(question, picked, correct, right, why, explanation) {
  const lines = [`[!${right ? "success" : "failure"}] ${question.replace(/\s*\n\s*/g, " ")}`];
  lines.push(right ? `**Answer:** ${picked}` : `**Your answer:** ${picked}\n**Correct answer:** ${correct}`);
  if (why) lines.push(`**Your note:** ${why}`);
  if (explanation) lines.push("", explanation);
  return quoted(lines.join("\n"));
}

/** Adds a section to lesson `target` (default: the open one), on screen only if it is open. */
async function addSection(markdown, live, to = lesson) {
  const shown = to === lesson;
  if (live) live.finish(markdown);
  else if (shown) {
    const box = md(markdown);
    $("#canvas-body").append(box);
    drawDiagrams(box);
    reveal(box);
  }
  await invoke("add_section", { lesson: to.id, markdown });
  // the first heading the tutor writes becomes the lesson title (shown once, not twice)
  if (to.sections++ === 0 && leadHeading(markdown)) {
    to.title = leadHeading(markdown);
    if (shown) {
      $("#title").textContent = to.title;
      $("#canvas-body").classList.add("titled");
    }
    await invoke("rename_lesson", { id: to.id, title: to.title });
    refresh();
  }
}

let turn = { live: new Map(), invalid: {}, truncated: false };

async function runTool(call) {
  lesson.toolResults ??= {};
  if (lesson.toolResults[call.id]) {
    turn.live.get(call.id)?.box.remove();
    return lesson.toolResults[call.id];
  }
  const result = await executeTool(call);
  if (result.abandoned) return result;
  await invoke("save_tool_result", { lesson: lesson.id, result });
  lesson.toolResults[call.id] = result;
  return result;
}

const LEFT = "The learner left this lesson before answering. Wait for their next message.";

/** Runs one tool call for lesson `to` (default: the open one) and returns its tool_result. */
async function executeTool({ id, name, input = {} }, t = turn, to = lesson) {
  const ok = (content) => ({ type: "tool_result", tool_use_id: id, content });
  const bad = (content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
  const live = t.live.get(id); // the section already streamed onto the canvas, if any
  const fail = (msg) => { live?.box.remove(); return bad(msg); };
  const here = to === lesson;
  const said = here && describe(name, input);
  if (said) step(said);
  if (t.truncated) return fail("Your reply was cut off at the output limit before this call finished. Make the step shorter and call the tool again.");
  if (id in t.invalid) return fail(JSON.stringify({ INVALID_JSON: t.invalid[id] }));

  if (name === "write_lesson") {
    if (typeof input.markdown !== "string") return fail("write_lesson needs a markdown string.");
    await addSection(input.markdown, live, to);
    return ok("Added to the lesson.");
  }
  if (name === "update_state") {
    if (typeof input.markdown !== "string") return bad("update_state needs a markdown string.");
    await invoke("set_state", { lesson: to.id, markdown: input.markdown });
    to.state = input.markdown;
    if (here) showNotes(input.markdown);
    return ok("Lesson state saved.");
  }
  if (name === "phase") {
    if (!["probe", "plan", "teach", "review"].includes(input.phase)) return bad("phase is one of probe, plan, teach, review.");
    to.phase = input.phase;
    if (here) renderSuggest();
    return ok(`Phase: ${input.phase}.`);
  }
  if (name === "search_material") {
    if (typeof input.query !== "string") return bad("search_material needs a query.");
    return ok(await invoke("material_search", { lesson: to.id, query: input.query }));
  }
  if (name === "read_material") {
    try {
      return ok(await invoke("material_read", { lesson: to.id, material: Number(input.material), part: Number(input.part) }));
    } catch (e) {
      return bad(String(e));
    }
  }
  if (name === "subject_notes") {
    if (typeof input.markdown !== "string") return bad("subject_notes needs a markdown string.");
    await invoke("set_subject_notes", { lesson: to.id, markdown: input.markdown });
    return ok("Subject notes saved. Every lesson in this subject will start from them.");
  }
  if (name === "say") {
    if (typeof input.text !== "string") return bad("say needs text.");
    if (here) say(input.text);
    return ok("Shown in the chat.");
  }
  if (["quiz", "ask", "true_false", "short_answer"].includes(name)) {
    if (!here) return { ...bad(LEFT), abandoned: true };
  }
  // a message typed in the chat box while a question was open: the learner set the question aside
  const aside = (r) => {
    say(r.text, "user");
    return ok(`The learner skipped this question and wrote in the chat instead: "${r.text}". Respond to that first; it may change what you do next. Don't repeat the skipped question unless it still fits.`);
  };
  if (name === "true_false") {
    const { statement, answer, explanation = "" } = input;
    if (typeof statement !== "string" || typeof answer !== "boolean") return bad("true_false needs a statement and a boolean answer.");
    const r = await choiceCard("quiz", statement, ["True", "False", "I don't know"], { note: true });
    if (r.abandoned) return { ...bad(LEFT), abandoned: true };
    if (r.interrupted) return aside(r);
    if (r.i < 0) {
      say(r.text, "user");
      return ok(`The learner didn't pick True or False. They wrote: ${r.text}`);
    }
    const c = answer ? 0 : 1;
    const picked = ["True", "False", "I don't know"][r.i];
    const right = r.i === c;
    r.buttons[c].classList.add("right");
    if (!right) r.buttons[r.i].classList.add("wrong");
    await addSection(resultCard(statement, picked, answer ? "True" : "False", right, r.text, explanation));
    return ok(`The learner said "${picked}" (${right ? "correct" : `incorrect; the statement is ${answer ? "true" : "false"}`}).${r.text ? ` Their note: ${r.text}` : ""} The result card with your explanation is already in the lesson.`);
  }
  if (name === "short_answer") {
    const { question, answer, explanation = "" } = input;
    if (typeof question !== "string" || typeof answer !== "string") return bad("short_answer needs a question and a model answer.");
    const r = await choiceCard("quiz short", question, [], { free: true });
    if (r.abandoned) return { ...bad(LEFT), abandoned: true };
    if (r.interrupted) return aside(r);
    const lines = [`[!question] ${question.replace(/\s*\n\s*/g, " ")}`, `**Your answer:** ${r.text}`, `**A good answer:** ${answer}`];
    if (explanation) lines.push("", explanation);
    await addSection(quoted(lines.join("\n")));
    return ok(`The learner answered: "${r.text}". Your model answer: "${answer}". Judge it yourself (equivalent wording and small spelling slips count as right) and tell them in one line; the comparison and your explanation are already on the canvas.`);
  }
  if (name === "quiz") {
    const { question, options, correct_index: c, explanation = "" } = input;
    if (typeof question !== "string" || !Array.isArray(options) || options.length < 2 || !Number.isInteger(c) || c < 0 || c >= options.length) {
      return bad("quiz needs a question, at least 2 options and a valid 0-based correct_index.");
    }
    const r = await choiceCard("quiz", question, [...options, "I don't know"], { note: true });
    if (r.abandoned) return { ...bad(LEFT), abandoned: true };
    if (r.interrupted) return aside(r);
    if (r.i < 0) {
      say(r.text, "user");
      return ok(`The learner didn't pick an option. They wrote: ${r.text}`);
    }
    const right = r.i === c;
    const picked = r.i === options.length ? "I don't know" : options[r.i];
    r.buttons[c].classList.add("right");
    if (!right) r.buttons[r.i].classList.add("wrong");
    await addSection(resultCard(question, picked, options[c], right, r.text, explanation));
    return ok(`The learner chose "${picked}" (${right ? "correct" : `incorrect; correct answer: "${options[c]}"`}).${r.text ? ` Their note: ${r.text}` : ""} The result card with your explanation is already in the lesson, so don't repeat it.`);
  }
  if (name === "ask") {
    if (typeof input.question !== "string" || !Array.isArray(input.options)) return bad("ask needs a question and options.");
    const r = await choiceCard("ask", input.question, input.options, { free: true });
    if (r.abandoned) return { ...bad(LEFT), abandoned: true };
    if (r.interrupted) return aside(r);
    const answer = r.i < 0 ? r.text : input.options[r.i];
    say(answer, "user");
    return ok(`The learner answered: ${answer}`);
  }
  return bad(`Unknown tool: ${name}`);
}

// ---------- the lesson's phase, and shortcuts that fit it ----------

const PHASES = { probe: "Probing", plan: "Planning", teach: "Teaching", review: "Reviewing" };
const SUGGEST = {
  none: [["Find what I know", "Start by finding out what I already know."], ["Teach me from scratch", GEARS.scratch.tell], ["Test me", GEARS.test.tell]],
  probe: [["Start teaching", "That's enough questions about what I know. Make the plan and start teaching."], ["Test me instead", "Skip ahead and test me on this."]],
  plan: [["Looks good, start", "The plan looks good. Start teaching."], ["Change the plan", "I'd like to change the plan."]],
  teach: [["Another angle", "Explain that from a different angle."], ["Quiz me", "Quiz me on what we just covered."], ["Test me on everything", "Test me on everything so far."], ["Check what I know", "Pause teaching and check what I already know about what's next."]],
  review: [["Back to teaching", "Let's go back to teaching the next part."], ["Explain my misses", "Explain the ones I got wrong."]],
};

function renderSuggest() {
  const phase = lesson?.phase;
  // which gear the lesson is in, then the sensible next moves
  const now = el("span", "now");
  now.title = "The lesson's current gear";
  if (PHASES[phase]) now.innerHTML = `<span class="gear-icon">${icon(phase, 15)}</span>`;
  now.append(el("b", "", PHASES[phase] ?? ""));

  $("#suggest").replaceChildren(
    ...(PHASES[phase] ? [now] : []),
    ...(SUGGEST[phase] ?? SUGGEST.none).map(([label, text]) => {
      const b = el("button", "", label);
      b.type = "button";
      b.onclick = () => send(text);
      return b;
    }),
  );
}

// ---------- status: what an API provider reports about each turn ----------

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
// context window by model family; unknown models just show the size
const windowOf = (m = "") => (/haiku/.test(m) ? 2e5 : /^claude-(opus|sonnet|fable|mythos)-[45]/.test(m) ? 1e6 : 0);

function seg(label, value, frac, title) {
  const s = el("span", "seg");
  s.title = title ?? "";
  s.append(label);
  if (frac != null) {
    const b = el("span", `bar${frac > 0.9 ? " full" : frac > 0.7 ? " warn" : ""}`);
    const i = el("i");
    i.style.width = `${Math.min(100, Math.round(frac * 100))}%`;
    b.append(i);
    s.append(b);
  }
  if (value) s.append(el("b", "", value));
  return s;
}

async function meter() {
  const s = await invoke("stats", { lesson: lesson?.id ?? null }).catch(() => ({}));
  const parts = [];
  const last = s.last;
  if (last) {
    const ctx = last.input + last.cache_read + last.cache_write;
    const win = windowOf(last.model);
    parts.push(seg("context", fmt(ctx), win ? ctx / win : null, win ? `${fmt(ctx)} of ${fmt(win)} tokens` : `${fmt(ctx)} tokens sent last turn`));
    if (ctx) parts.push(seg("cached", `${Math.round((last.cache_read / ctx) * 100)}%`, null, "Share of last turn's prompt read from cache"));
  }
  const t = s.totals;
  if (t?.turns && t.cost != null) parts.push(seg("lesson", `$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}`, null, `${t.turns} turns, ${fmt(t.input)} in, ${fmt(t.output)} out`));
  const box = el("div", "meter");
  box.append(...parts);
  return box;
}

// ---------- the API tutor loop ----------

let apiBusy = null; // the lesson an API turn is running for

/** `first`: the learner's message; undefined continues with pending tool calls. */
async function runLoop(first) {
  const mine = gen;
  const me = lesson;
  apiBusy = me.id;
  let content = first;
  try {
    for (;;) {
      if (content === undefined) {
        const calls = pendingCalls();
        if (!calls.length) break;
        content = [];
        for (const call of calls) {
          const r = await runTool(call);
          if (r.abandoned || mine !== gen) return; // asked again when the lesson is reopened
          content.push(r); // all results go back in ONE message
        }
      }
      const { reply, live } = await streamTurn(content);
      me.last = reply.content;
      if (mine !== gen) return; // saved by Rust; picked up when the lesson is reopened
      turn = { live, invalid: reply.invalid, truncated: reply.stop_reason === "max_tokens" };
      if (reply.stop_reason === "refusal") {
        note(`The model declined to continue${reply.stop_details?.category ? ` (${reply.stop_details.category})` : ""}. Try rephrasing.`);
        break;
      }
      content = reply.stop_reason === "pause_turn" ? null : undefined; // null resumes a paused web search
    }
  } catch (e) {
    if (mine === gen && e !== "Stopped.") note(`Something went wrong: ${e}`);
  } finally {
    if (apiBusy === me.id) apiBusy = null;
    setWorking();
    refresh();
  }
}

// ---------- terminal agents: they pull the learner's messages and call the lesson tools ----------

let agents = []; // [{ id, name, cwd, cmd, busy }]
let activeAgent = null;
let agentLesson = null; // the lesson the agent is working on
let sentWaiting = false;
let lastSent = ""; // a message was sent and the agent hasn't picked it up yet

const usingAgent = () => settings.active === "agent";

/** A subject's folder (~/rtutor/<subject>): where its agent runs. */
function subjectDir(folder) {
  let f = folderById(folder);
  while (f?.parent != null) f = folderById(f.parent);
  return f?.dir ?? "";
}
const within = (cwd = "", dir = "") => !!dir && (cwd === dir || cwd.startsWith(`${dir}/`) || cwd.startsWith(`${dir}\\`));
/** The agent teaching lesson `l`: the one in its subject's folder, else the active one (if its own isn't starting). */
function agentFor(l = lesson) {
  const dir = l ? subjectDir(l.folder) : "";
  return agents.find((a) => within(a.cwd, dir)) ?? (startingDirs.has(dir) ? undefined : agents.find((a) => a.id === activeAgent));
}
const startingDirs = new Set(); // subject folders whose agent rTutor is starting

/** Opening or messaging a lesson: start its subject's agent there if it has none (with the agent picked to start automatically). */
async function ensureAgent(l = lesson) {
  const dir = l && subjectDir(l.folder);
  const kind = settings.main?.kind;
  if (!dir || !kind || !usingAgent() || agents.some((a) => within(a.cwd, dir)) || startingDirs.has(dir) || tabs.some((t) => t.cwd === dir)) return;
  startingDirs.add(dir);
  const tab = await newTab(dir, quickStarts()[kind][2]);
  invoke("log_note", { line: `starting ${quickStarts()[kind][0]} for ${short(dir)}` }).catch(() => {});
  // it starts out of sight; if it isn't listening soon it's probably asking something, so show its terminal
  setTimeout(() => {
    startingDirs.delete(dir);
    if (agents.some((a) => within(a.cwd, dir) && (a.waiting || a.busy))) return;
    invoke("log_note", { line: `the agent for ${short(dir)} isn't listening after 25s; showing its terminal` }).catch(() => {});
    setDrawer(true, { where: false });
    selectTab(tab);
  }, 25000);
}
const agentThinking = () => sentWaiting || !!agentFor()?.busy;

const agentEvents = new Channel();
agentEvents.onmessage = async (e) => {
  if (e.type === "agents") {
    const before = new Set(agents.map((a) => a.id));
    agents = e.agents;
    activeAgent = e.active;
    for (const a of agents) for (const d of startingDirs) if (within(a.cwd, d)) startingDirs.delete(d);
    if (agentFor()?.busy) sentWaiting = false;
    if (lesson?.id === agentLesson) thinking(!openCard && agentThinking());
    setWorking();
    for (const a of agents) if (!before.has(a.id)) connected(a);
    showWho();
    if (!$("#pop").hidden) renderPop();
    if (!$("#start").hidden) renderStart();
  } else if (e.type === "call") {
    const to = lesson?.id === e.lesson ? lesson : { id: e.lesson, sections: 1, state: "" };
    agentLesson = e.lesson;
    if (lesson?.id === e.lesson && !openCard && !["say", "quiz", "ask"].includes(e.name)) thinking(true); // its steps show as they happen
    let result;
    try {
      result = await executeTool({ id: `agent-${e.id}`, name: e.name, input: e.input ?? {} }, { live: new Map(), invalid: {}, truncated: false }, to);
    } catch (err) {
      result = { content: String(err), is_error: true };
    }
    await invoke("agent_result", { id: e.id, result: { content: result.content, is_error: !!result.is_error } });
    if (lesson?.id === e.lesson) thinking(!openCard && agentThinking());
  }
};

/** A new agent came up: offer to start it automatically from now on. */
function connected(a) {
  const look = agentLook(a.name);
  const cmd = launched.get(a.cwd) || a.cmd;
  const main = settings.main;
  const kind = kindOf(cmd);
  if (!kind || main?.kind === kind || settings.asked?.includes(kind)) return;
  const box = $("#offer");
  box.replaceChildren(el("p", "", `${look.label} is live. Start it automatically for each subject you open?`));
  const row = el("div", "offer-row");
  const yes = el("button", "primary", "Start it automatically");
  const no = el("button", "", "Not now");
  yes.onclick = () => {
    settings.main = { name: a.name, kind };
    saveSettings();
    box.hidden = true;
  };
  no.onclick = () => {
    settings.asked = [...(settings.asked ?? []), kind];
    saveSettings();
    box.hidden = true;
  };
  row.append(yes, no);
  box.append(row);
  box.hidden = false;
}

// ---------- the send button: a stop button while the tutor works ----------

const working = () =>
  !!lesson && !openCard && (apiBusy === lesson.id || (usingAgent() && agentLesson === lesson.id && agentThinking()));

function setWorking() {
  const on = working();
  const b = $("#composer .send");
  b.classList.toggle("stop", on);
  b.innerHTML = on ? '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>' : icon("send", 20);
  b.setAttribute("aria-label", on ? "Stop" : "Send");
  b.title = on ? "Stop" : "";
}

/** The agent's own terminal tab, when it runs in one of rTutor's. */
const agentTab = (a = agentFor()) => a && tabs.find((t) => t.cwd === a.cwd);
const NUDGE = "Call the rTutor next tool now and keep tutoring through rTutor's tools.";

async function stop() {
  if (!lesson) return;
  if (apiBusy === lesson.id) await invoke("stop_turn", { lesson: lesson.id }).catch(() => {});
  if (usingAgent()) {
    sentWaiting = false;
    await invoke("agent_stop", { id: agentFor()?.id ?? null }).catch(() => {});
    // interrupt it right away (Esc stops Claude Code and Codex mid-thought), then send it back to listening
    const tab = agentTab();
    if (tab) {
      await invoke("term_write", { tab: tab.id, data: "\x1b" }).catch(() => {});
      setTimeout(() => invoke("term_write", { tab: tab.id, data: `${NUDGE}\r` }).catch(() => {}), 700);
    }
  }
  thinking(false);
  note("Stopped.");
}

/** The learner's message (or a shortcut) goes to whoever is teaching. */
async function send(text) {
  if (!lesson) return;
  if (openCard) {
    openCard.interrupt(text); // the question's tool call returns with this message; no separate send
    return;
  }
  if (usingAgent()) {
    if (sentWaiting && lastSent === text) return; // already waiting to be picked up
    lastSent = text;
    say(text, "user");
    sentWaiting = true;
    agentLesson = lesson.id;
    await ensureAgent();
    // no tutor for this subject and none to start: the message waits; the agent menu is where to start one
    if (!agentFor() && !startingDirs.has(subjectDir(lesson.folder))) {
      $("#pop").hidden = false;
      renderPop();
    } else thinking(true);
    await invoke("agent_send", { lesson: lesson.id, text, own: startingDirs.has(subjectDir(lesson.folder)) }).catch((e) => { sentWaiting = false; thinking(false); note(String(e)); });
    // an agent that isn't waiting in `next` won't see the message until it is reminded
    setTimeout(() => {
      const a = agentFor();
      if (!sentWaiting || !a || a.waiting || a.busy) return;
      const tab = agentTab(a);
      // it may be asking something in its terminal (trust this folder? allow a tool?): show it
      if (tab) {
        step(`${agentLook(a.name).label} isn't listening yet; its terminal is open below`);
        setDrawer(true, { where: false });
        selectTab(tab);
      } else note(`${agentLook(a.name).label} isn't listening. In its terminal, tell it: ${NUDGE}`);
      invoke("log_note", { line: `agent hadn't picked up the message after 3s; ${tab ? "reminded it in its terminal" : "its terminal isn't rTutor's"}` }).catch(() => {});
    }, 3000);
    return;
  }
  if (apiBusy === lesson.id) return note("One moment, the tutor is still answering.");
  if (!(await ready())) return openModel();
  say(text, "user");
  runLoop(text);
}

// ---------- bottom panel: terminals ----------

const drawer = $("#drawer");
const tabs = []; // { id, cwd, cmd, term, fit, el, button }
let current = null;
let nextTab = 1;
const launched = new Map(); // folder → the agent command rTutor typed there
let mcpBin = "";
let home = "";

function setDrawer(open, { where = true } = {}) {
  drawer.hidden = !open;
  document.body.classList.toggle("drawer-open", open);
  if (open && !tabs.length && where) showWhere();
  if (open && current) requestAnimationFrame(() => { fitShell(); current.term.focus(); });
}

function showWhere() {
  showLog(false);
  $("#shells").hidden = true;
  $("#where").hidden = false;
  for (const t of tabs) t.el.hidden = true;
  $("#where-dir").textContent = startDir || settings.cwd || library();
  $("#where-dir").title = "Choose a folder";
  const label = starting ? quickStarts()[starting][0] : null;
  $(".where-opts").hidden = !starting;
  if (starting) fillModels(starting);
  $("#where p").textContent = label ? `Where should ${label} run?` : "Where should the terminal open?";
  $("#where .primary").textContent = label ? `Start ${label}` : "Open";
}
$("#where-dir").onclick = async () => {
  const dir = await invoke("pick_folder").catch(() => null);
  if (dir) {
    if (!starting) settings.cwd = dir;
    startDir = dir;
    $("#where-dir").textContent = dir;
    saveSettings();
  }
};
$("#where").onsubmit = (e) => {
  e.preventDefault();
  const run = starting ? quickStarts()[starting][2] : undefined;
  const dir = $("#where-dir").textContent || library();
  starting = startDir = null;
  newTab(dir, run);
};

/** ~/rtutor: every subject's material is a folder of Markdown files in here, so an agent started here can read it all. */
const library = () => (home ? `${home}${home.includes("\\") ? "\\" : "/"}rtutor` : "");
const short = (dir = "") => dir.split(/[\\/]/).filter(Boolean).pop() || "~";

/** Commands that start each agent wired to rTutor, so a click is all it takes. */
function quickStarts() {
  const bin = mcpBin.replace(/'/g, "");
  // model and effort as picked when starting it; blank means the agent's own default
  const pick = (kind) => settings.agentPrefs?.[kind] ?? {};
  const safe = (v) => (v && /^[\w.:\[\]-]+$/.test(v) ? v : ""); // model names and aliases only; quoted below
  const cm = safe(pick("claude").model), ce = safe(pick("claude").effort);
  const xm = safe(pick("codex").model), xe = safe(pick("codex").effort);
  const json = JSON.stringify({ mcpServers: { rtutor: { command: bin, args: ["--mcp"] } } });
  const go = "'Call the rTutor next tool now and tutor through it.'";
  return {
    // the prompt goes first: --mcp-config and --allowedTools take every word after them
    claude: ["Claude Code", "claude", `env MCP_TOOL_TIMEOUT=1800000 claude ${go}${cm ? ` --model '${cm}'` : ""}${ce ? ` --effort ${ce}` : ""} --mcp-config '${json}' --allowedTools mcp__rtutor`],
    codex: ["Codex", "openai", `codex${xm ? ` -m '${xm}'` : ""}${xe ? ` -c model_reasoning_effort=${xe}` : ""} -c 'mcp_servers.rtutor.command="${bin}"' -c 'mcp_servers.rtutor.args=["--mcp"]' -c mcp_servers.rtutor.tool_timeout_sec=1800 -c 'mcp_servers.rtutor.default_tools_approval_mode="approve"' ${go}`],
  };
}
let installed = []; // coding agents found on this computer

/** Restarts an agent in its own terminal with the model and effort just picked. Its lesson memory is the
 *  lesson state and notes, so it picks up where it left off. */
async function restartAgent(a, kind) {
  const tab = agentTab(a);
  if (!tab) return;
  const dir = tab.cwd;
  invoke("log_note", { line: `restarting ${agentLook(a.name).label} in ${short(dir)} with ${JSON.stringify(settings.agentPrefs?.[kind] ?? {})}` }).catch(() => {});
  startingDirs.add(dir);
  closeTab(tab);
  await newTab(dir, quickStarts()[kind][2]);
  if (lesson) note(`Switching ${agentLook(a.name).label}'s model. It picks up from its notes.`);
}

/** One click: a terminal in the library folder with the agent already starting in it. */
let starting = null; // the agent the "where" form will start, if one was picked
let startDir = null; // where it starts: the open subject's folder
const modelInfo = {}; // kind → what the agent offers (its models and their effort levels), read once

/** The model and effort pickers for `kind`, filled from the agent itself. Effort levels follow the model. */
async function fillModels(kind, model = $("#where-model"), effortSel = $("#where-effort"), changed = () => {}) {
  modelInfo[kind] ??= await invoke("agent_models", { kind }).catch(() => ({ models: [] }));
  const info = modelInfo[kind];
  const prefs = (settings.agentPrefs ??= {})[kind] ??= {};
  const opt = (value, text) => Object.assign(el("option", "", text), { value });
  const current = info.models.find((m) => m.id === info.current);
  // the agent's own models, one typed in earlier, and "Other…" for any name the agent accepts (new models included)
  const custom = prefs.model && !info.models.some((m) => m.id === prefs.model) ? [opt(prefs.model, prefs.model)] : [];
  model.replaceChildren(opt("", current ? `Default (${current.name})` : "Default"), ...info.models.map((m) => opt(m.id, m.name)), ...custom, opt("__other", "Other…"));
  model.value = prefs.model ?? "";
  const levels = () => {
    const m = info.models.find((x) => x.id === (model.value || info.current)) ?? info.models[0];
    const list = m?.levels?.length ? m.levels : info.levels ?? [];
    const fallback = model.value ? m?.default : info.effort || m?.default;
    const effort = effortSel;
    effort.replaceChildren(opt("", fallback ? `Default (${fallback})` : "Default"), ...list.map((l) => opt(l, l)));
    effort.value = list.includes(prefs.effort) ? prefs.effort : "";
    prefs.effort = effort.value;
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

function startAgent(kind) {
  $("#pop").hidden = true;
  starting = kind;
  startDir = subjectDir(lesson ? lesson.folder : target) || null;
  setDrawer(true, { where: false });
  showWhere();
}

/** Which built-in start a command line is, so a saved start always uses rTutor's current command. */
const kindOf = (cmd = "") => (/mcp_servers\.(rtutor|rlearn)/.test(cmd) ? "codex" : /--mcp-config/.test(cmd) && /rtutor|rlearn/.test(cmd) ? "claude" : null);

async function newTab(cwd, run) {
  $("#where").hidden = true;
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, cols: 100, rows: 24,
    theme: { background: v("--sidebar"), foreground: v("--text"), cursor: v("--accent"), selectionBackground: v("--accent-soft") },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const box = el("div", "shell");
  const hint = el("div", "hint");
  hint.append(el("span", "", "Run your coding agent here"));
  for (const [label, logoName, cmd] of Object.values(quickStarts())) {
    const b = el("button");
    b.type = "button";
    b.innerHTML = logo(logoName, 18);
    b.append(label);
    b.onclick = () => {
      launched.set(cwd, cmd);
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
  const tab = { id: nextTab++, cwd, term, fit, el: box, hint };
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

function selectTab(tab) {
  showLog(false);
  $("#shells").hidden = false;
  current = tab;
  for (const t of tabs) t.el.hidden = t !== tab;
  renderTabs();
  if (!drawer.hidden) requestAnimationFrame(() => { fitShell(); tab.term.focus(); });
}

function closeTab(tab) {
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

function renderTabs() {
  $("#ttabs").replaceChildren(
    ...tabs.map((t) => {
      const b = el("div", `dtab${t === current ? " active" : ""}`);
      const a = agents.find((x) => x.cwd === t.cwd);
      b.innerHTML = a ? logo(agentLook(a.name).logo, 12) : icon("terminal", 16);
      b.append(el("span", "", short(t.cwd)));
      b.title = t.cwd || "Home folder";
      b.onclick = () => selectTab(t);
      const x = el("button", "", "");
      x.innerHTML = icon("x", 14);
      x.title = "Close terminal";
      x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
      b.append(x);
      return b;
    }),
  );
  for (const t of tabs) t.hint.hidden = agents.some((a) => a.cwd === t.cwd);
}

function fitShell() {
  if (!current || drawer.hidden) return;
  current.fit.fit();
  invoke("term_resize", { tab: current.id, cols: current.term.cols, rows: current.term.rows }).catch(() => {});
}

function openTerminal() {
  setDrawer(true);
  if (tabs.length) showWhere(); // a new terminal for another agent
}

// ---------- the Log tab: what happened, one line per fact (agents, messages, tool calls, errors) ----------

const logLines = $("#log-lines");
function logLine(text) {
  const atEnd = logLines.scrollHeight - logLines.scrollTop - logLines.clientHeight < 40;
  const line = el("div", /error|gave up|dropped|stopped waiting|disconnected/.test(text) ? "bad" : /received|connected|started/.test(text) ? "good" : "", text);
  logLines.append(line);
  while (logLines.childElementCount > 1500) logLines.firstElementChild.remove(); // keeps memory flat
  if (atEnd) logLines.scrollTop = logLines.scrollHeight;
}
function showLog(on) {
  $("#logpane").hidden = !on;
  $("#shells").hidden = on;
  $("#logtab").classList.toggle("active", on);
  if (on) {
    $("#where").hidden = true;
    for (const t of tabs) t.el.hidden = true;
    current = null;
    renderTabs();
    logLines.scrollTop = logLines.scrollHeight;
  }
}
$("#logtab").onclick = () => showLog(true);
$("#log-copy").onclick = () => navigator.clipboard.writeText([...logLines.children].map((l) => l.textContent).join("\n"));
{
  const ch = new Channel();
  ch.onmessage = logLine;
  invoke("log_listen", { onLine: ch })
    .then(([path, lines]) => {
      $("#log-path").textContent = path;
      lines.forEach(logLine);
    })
    .catch(() => {});
}

$("#term-btn").onclick = () => setDrawer(drawer.hidden);
$("#tnew").onclick = () => { starting = null; showWhere(); };
$("#drawer-close").onclick = () => setDrawer(false);
addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setDrawer(drawer.hidden);
  }
});

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
dragResize($("#drawer-grip"), (m) => {
  rootVar("--drawer-h", `${Math.min(innerHeight - 160, Math.max(140, innerHeight - m.clientY))}px`);
  fitShell();
}, () => store.set("learn.drawerH", getComputedStyle(document.documentElement).getPropertyValue("--drawer-h")));
dragResize($("#chat-grip"), (m) => {
  const box = $("#lesson").getBoundingClientRect();
  rootVar("--chat-w", `${Math.round(Math.min(box.width - 360, Math.max(320, box.right - m.clientX)))}px`);
}, () => store.set("learn.chatW", getComputedStyle(document.documentElement).getPropertyValue("--chat-w")));
dragResize($("#side-grip"), (m) => {
  rootVar("--side-w", `${Math.round(Math.min(480, Math.max(200, m.clientX)))}px`);
}, () => store.set("learn.sideW", getComputedStyle(document.documentElement).getPropertyValue("--side-w")));
for (const [k, name] of [["learn.drawerH", "--drawer-h"], ["learn.chatW", "--chat-w"], ["learn.sideW", "--side-w"]]) {
  const saved = store.get(k, null);
  if (saved) rootVar(name, saved);
}

// ---------- who teaches: terminal agents or an API provider ----------

const PRESETS = {
  nvidia: { label: "NVIDIA", kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", model: "moonshotai/kimi-k3", logo: "nvidia" },
  anthropic: { label: "Anthropic", kind: "anthropic", baseUrl: "", model: "claude-opus-5-5", logo: "anthropic" },
  openai: { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "", logo: "openai" },
  openrouter: { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "", logo: "openrouter" },
  ollama: { label: "Ollama", kind: "openai", baseUrl: "http://localhost:11434/v1", model: "", keyless: true },
  custom: { label: "Custom", kind: "openai", baseUrl: "", model: "" },
};
let settings = { active: "agent", api: "nvidia", providers: {} };
const provider = (id = settings.api) => ({ id, ...PRESETS[id], ...settings.providers[id] });
let chosen = settings.api;

const saveSettings = () => invoke("save_settings", { settings }).catch(() => {});

function showWho() {
  let name, sub, mark;
  if (usingAgent()) {
    const a = agentFor();
    const look = agentLook(a?.name);
    name = a ? look.label : startingDirs.size ? "Starting…" : "No agent";
    sub = a ? short(a.cwd) : "";
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
  if (tabs.length) renderTabs();
}

/** Who teaches: one row per running agent, one for the API provider, and a way to start another agent. */
async function renderPop() {
  const pop = $("#pop");
  const option = (mark, title, tip, on, run) => {
    const b = el("button", `opt-row${on ? " on" : ""}`);
    b.innerHTML = logo(mark, 22);
    b.append(el("span", "name", title));
    b.title = tip;
    b.onclick = run;
    return b;
  };
  const parts = [];
  for (const a of agents) {
    const look = agentLook(a.name);
    const b = option(look.logo, `${look.label} · ${short(a.cwd)}`, a.cwd || "Home folder", usingAgent() && a.id === agentFor()?.id, () => {
      settings.active = "agent";
      saveSettings();
      invoke("agent_use", { id: a.id });
      showWho();
      renderPop();
    });
    if (settings.main?.kind && quickStarts()[settings.main.kind]?.[1] === look.logo) {
      const auto = el("span", "auto", "Auto");
      auto.title = "Starts by itself for each subject you open. Click to stop that.";
      auto.onclick = (e) => { e.stopPropagation(); settings.main = null; saveSettings(); renderPop(); };
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
  // the current subject's agent: switch its model or effort here; it restarts in its terminal with them
  const current = agentFor();
  const kind = current && { claude: "claude", openai: "codex" }[agentLook(current.name).logo];
  if (kind && agentTab(current)) {
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
    parts.push(box);
  }
  parts.push(el("hr"));
  const p = provider();
  const api = option(p.logo, p.label, p.model || "Not set up", !usingAgent(), async () => {
    if (!(await ready())) return openModel();
    settings.active = "api";
    saveSettings();
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
  if (!usingAgent() && lesson) parts.push(await meter());
  pop.replaceChildren(...parts);
}

$("#model").onclick = () => {
  const pop = $("#pop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderPop();
};

async function pickProvider(id) {
  chosen = id;
  $("#p-status").textContent = "";
  const p = provider(id);
  for (const b of $("#p-list").children) b.setAttribute("aria-checked", String(b.dataset.id === id));
  $("#p-model").value = p.model;
  $("#p-base").value = p.baseUrl ?? "";
  $("#p-base-row").hidden = p.kind !== "openai";
  $("#p-key-row").hidden = !!p.keyless;
  $("#p-key").value = "";
  $("#p-key").placeholder = !p.keyless && (await invoke("has_api_key", { provider: id }).catch(() => false)) ? "••••••••••••" : "";
}

$("#p-list").append(
  ...Object.entries(PRESETS).map(([id, p]) => {
    const b = el("button", "", p.label);
    b.type = "button";
    b.dataset.id = id;
    b.setAttribute("role", "radio");
    b.onclick = () => pickProvider(id);
    return b;
  }),
);

async function openModel() {
  $("#pop").hidden = true;
  await pickProvider(settings.api);
  $("#settings").showModal();
  $("#p-model").focus();
}
$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  settings.api = chosen;
  settings.active = "api";
  settings.providers[chosen] = { model: $("#p-model").value.trim(), baseUrl: $("#p-base").value.trim() };
  try {
    if ($("#p-key").value.trim()) await invoke("set_api_key", { provider: chosen, key: $("#p-key").value.trim() });
    await invoke("save_settings", { settings });
  } catch (e) {
    alert(e);
  }
  showWho();
});
$("#p-test").onclick = async () => {
  const button = $("#p-test");
  button.disabled = true;
  $("#p-status").textContent = "Connecting… This uses a small provider request.";
  const p = { ...provider(chosen), model: $("#p-model").value.trim(), baseUrl: $("#p-base").value.trim() };
  try {
    const key = $("#p-key").value.trim();
    if (key && !p.keyless) await invoke("set_api_key", { provider: p.id, key });
    $("#p-status").textContent = await invoke("test_provider", { provider: p });
  } catch (e) {
    $("#p-status").textContent = `Connection failed: ${e}`;
  } finally {
    button.disabled = false;
  }
};

async function ready() {
  const p = provider();
  if (!p.model) return false;
  return p.keyless || (await invoke("has_api_key", { provider: p.id }).catch(() => false));
}

// ---------- wiring ----------

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

$("#start-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#start-input").value.trim();
  const material = materialsFor(target).length + pending.length > 0;
  if (!text && !material) return $("#start-input").focus();
  if (usingAgent() ? !agents.length : !(await ready())) {
    if (!usingAgent()) return openModel();
    // no tutor yet: start the lesson anyway; the message waits and goes out once one connects
  }
  const g = GEARS[gear] ?? GEARS.probe;
  const first = `${text || "Teach me this material."}\n\n${g.tell}`;
  const title = text.split("\n")[0].slice(0, 200) || pending[0]?.name.replace(/\.\w+$/, "") || "New lesson";
  // a lesson always lives in a subject: from the home screen, the subject is made first
  let folder = target;
  if (folder == null) {
    folder = await invoke("create_folder", { parent: null, name: title });
    for (const p of pending) await invoke("add_source", { folder, lesson: null, name: p.name, text: p.text });
    pending = [];
  }
  opened.add(folder);
  store.set("learn.open", [...opened]);
  const id = await invoke("create_lesson", { folder, title });
  await refresh();
  leave();
  target = folder;
  lesson = { id, title, folder, state: "", sections: 0, phase: g.phase, last: null, toolResults: {} };
  showLesson();
  renderSidebar();
  send(first);
};
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  if (working() && !$("#input").value.trim()) return stop();
  const text = $("#input").value.trim();
  if (!text || !lesson) return;
  $("#input").value = "";
  grow($("#input"));
  send(text);
};
$("#start-input").onkeydown = enterSubmits($("#start-form"));
$("#input").onkeydown = enterSubmits($("#composer"));
$("#input").oninput = () => grow($("#input"));


settings = { ...settings, ...((await invoke("get_settings")) ?? {}) };
if (!["agent", "api"].includes(settings.active)) settings.active = "agent"; // older settings named a provider here
if (!PRESETS[settings.api]) settings.api = "nvidia";
await invoke("agent_listen", { onEvent: agentEvents }).catch(() => {});
// the timer reads its lengths from the settings just loaded
startTimer({
  get: () => settings.pomo,
  set: (pomo) => { settings.pomo = pomo; saveSettings(); },
  note: (text) => lesson && note(text),
  opened: () => toggleSources(false),
});
({ bin: mcpBin, home } = await invoke("mcp_command").catch(() => ({ bin: "rtutor", home: "" })));
installed = await invoke("installed_agents").catch(() => []);
showWho();
setCollapsed(store.get("learn.collapsed", false));
await refresh();
startNew(null);
// the main agent starts with the app, out of sight until the learner opens the terminal
// agents start per subject, when a lesson in it opens (ensureAgent); older settings named one command
if (settings.main && !settings.main.kind) settings.main.kind = kindOf(settings.main.cmd);
