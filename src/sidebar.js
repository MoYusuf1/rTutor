// The sidebar: subjects with their lessons, pinned lessons, search, renaming, drag and drop, and the context menu.
import { invoke } from "@tauri-apps/api/core";
import { $, el, store, setTitle } from "./dom.js";
import { icon } from "./icons.js";
import { app, setTree, subjectDir } from "./state.js";
import { subjectGone, subjectMoved } from "./agents.js";
import { menu } from "./dialogs.js";
import { openLesson, openSource } from "./lesson.js";
import { attach, startNew } from "./start.js";

const opened = new Set(store.get("learn.open", [])); // subjects unfolded in the tree
export const unfold = (id) => {
  opened.add(id);
  store.set("learn.open", [...opened]);
};

export async function refresh() {
  setTree(await invoke("tree"));
  renderSidebar();
}

// a rename in progress: its input survives the sidebar re-rendering under it
let renaming = null; // { kind, id, input }
let rebuilding = false;

function row(kind, item) {
  const r = el("div", `row ${kind}`);
  r.dataset.kind = kind;
  r.dataset.id = item.id;
  if (kind === "folder") r.innerHTML = `<span class="chev">${icon("chev", 16)}</span>${icon(opened.has(item.id) ? "folderOpen" : "folder", 20)}`;
  if (kind === "source") r.innerHTML = icon("doc", 18);
  r.append(renaming?.kind === kind && renaming.id === item.id ? renaming.input : el("span", "label", item.name ?? item.title));
  if (kind === "source") r.append(el("span", "side", `${Math.round(item.words / 1000) || "<1"}k`));
  if (kind === "lesson" && item.id === app.lesson?.id) r.classList.add("active");
  if (kind === "folder" && item.id === app.target && !$("#start").hidden) r.classList.add("active");
  r.draggable = kind !== "source";
  return r;
}

/** Groups `list` by `key` in one pass, so building the tree is O(n) rather than a filter per folder. */
function group(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = x[key] ?? null;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function renderSidebar() {
  const folders = group(app.data.folders, "parent");
  const lessons = group(app.data.lessons, "folder");
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
  rebuilding = true;
  $("#tree").replaceChildren(build(null));
  const pins = app.data.lessons.filter((l) => l.bookmarked);
  $("#pinned-sec").hidden = !pins.length;
  $("#pinned").replaceChildren(...pins.map((l) => row("lesson", l)));
  rebuilding = false;
  renaming?.input.focus();
}

const item = (r) => {
  const id = Number(r.dataset.id);
  const kind = r.dataset.kind;
  return { kind, id, it: (kind === "folder" ? app.data.folders : kind === "source" ? app.data.sources : app.data.lessons).find((x) => x.id === id) };
};

const side = $("#side-scroll");
side.addEventListener("click", (e) => {
  const r = e.target.closest(".row");
  if (!r || r.querySelector("input")) return;
  // the second click of a double click renames, whatever the first one opened
  if (e.detail >= 2 && r.dataset.kind !== "source") return rename(r);
  const { kind, id, it } = item(r);
  if (kind === "folder") {
    // the chevron only folds; the name opens the subject (and unfolds it)
    const fold = e.target.closest(".chev") || (app.target === id && !$("#start").hidden);
    if (fold && opened.has(id)) opened.delete(id);
    else opened.add(id);
    store.set("learn.open", [...opened]);
    if (!e.target.closest(".chev")) startNew(id);
    else renderSidebar();
  } else if (kind === "lesson") openLesson(id);
  else openSource(it);
});

function rename(r) {
  const { kind, id, it } = item(r);
  const input = el("input");
  input.value = it.name ?? it.title;
  renaming = { kind, id, input };
  r.querySelector(".label").replaceWith(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    if (renaming?.input !== input) return;
    renaming = null;
    const value = input.value.trim();
    if (save && value && value !== (it.name ?? it.title)) {
      const before = kind === "folder" ? subjectDir(id) : "";
      await invoke(kind === "folder" ? "rename_folder" : "rename_lesson", kind === "folder" ? { id, name: value } : { id, title: value });
      if (before) {
        await refresh();
        if (subjectDir(id) !== before) subjectMoved(before, subjectDir(id)); // its folder moved, and its agent with it
      }
      if (kind === "lesson" && app.lesson?.id === id) setTitle((app.lesson.title = value));
    }
    refresh();
  };
  input.onkeydown = (e) => {
    e.stopPropagation(); // Enter here renames; it must not reach a form behind it
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
  input.onblur = () => rebuilding || finish(true);
}

async function newFolder(parent) {
  const id = await invoke("create_folder", { parent, name: "Untitled" });
  if (parent != null) opened.add(parent);
  await refresh();
  rename($(`#tree .row[data-kind="folder"][data-id="${id}"]`));
}

// drag a lesson or folder onto a folder, or onto the empty space to take a folder out of its parent
let dragged = null;
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
    if (dragged.kind === "lesson" && app.lesson?.id === dragged.id) app.lesson.folder = folder;
  }
  dragged = null;
  refresh();
});
side.addEventListener("dragend", () => { dragged = null; renderSidebar(); });

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
        const dir = subjectDir(id);
        await invoke("delete_folder", { id });
        if (dir) subjectGone(dir);
        if (app.lesson && !app.data.lessons.some((l) => l.id === app.lesson.id && l.folder !== id)) startNew(null);
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
        if (app.lesson?.id === id) startNew(app.target);
        refresh();
      } },
    ]);
  } else {
    menu(e.clientX, e.clientY, [{ label: "Remove material", danger: true, confirm: [`Remove “${it.name}”?`, "The tutor won't teach from it anymore.", "Remove"], run: async () => { await invoke("delete_source", { id }); refresh(); } }]);
  }
});

// ---------- search, collapse ----------

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
let searchSeq = 0; // only the newest query's answer is shown, however the replies are ordered
$("#search-input").oninput = () => {
  clearTimeout(searchTimer);
  setSearch(true);
  searchTimer = setTimeout(async () => {
    const mine = ++searchSeq;
    const hits = await invoke("search", { query: $("#search-input").value }).catch(() => []);
    if (mine !== searchSeq) return;
    if (!hits.length) return $("#results").replaceChildren(el("div", "hit none", "No matches"));
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

export const setCollapsed = (on) => {
  document.body.classList.toggle("collapsed", on);
  store.set("learn.collapsed", on);
};
$("#collapse").onclick = () => setCollapsed(true);
$("#expand").onclick = () => setCollapsed(false);
