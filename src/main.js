import { invoke, Channel } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import mermaidUrl from "@mermaid-js/tiny/dist/mermaid.tiny.js?url";
import "./style.css";

marked.use({ breaks: true });
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* UI prefs only */ } },
};

// ---------- icons ----------

const PATHS = {
  sidebar: "M4 5h16v14H4zM9.5 5v14",
  folder: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  bookmark: "M7 4h10v16l-5-3.5L7 20z",
  file: "M7 3h7l4 4v14H7zM14 3v4h4",
  filePlus: "M7 3h7l4 4v14H7zM14 3v4h4M12.5 11v6M9.5 14h6",
  folderPlus: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5zM12 11v5M9.5 13.5h5",
  doc: "M6 3h12v18H6zM9 8h6M9 12h6M9 16h3",
  chev: "M9 6l6 6-6 6",
  clip: "M19.5 11.5l-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l8.2-8.2a3 3 0 0 1 4.3 4.3l-8.2 8.2a1.5 1.5 0 0 1-2.1-2.1l7.5-7.5",
  x: "M6 6l12 12M18 6L6 18",
  send: "M12 19V5M5.5 11.5L12 5l6.5 6.5",
  spark: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z",
  terminal: "M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4",
};
const icon = (name, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
for (const e of document.querySelectorAll("[data-icon]")) e.innerHTML = icon(e.dataset.icon, e.classList.contains("send") ? 18 : 16);

// ---------- markdown → sanitized HTML, with LaTeX, callouts and (when final) mermaid ----------

const tex = (t, displayMode) => katex.renderToString(t, { displayMode, throwOnError: false });

function md(src, final = true) {
  const code = [];
  const math = [];
  // hide code so a $ inside it isn't math; render math before markdown so marked can't mangle it
  src = String(src)
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, (c) => `KXC${code.push(c) - 1}KXC`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => `KXM${math.push(tex(t, true)) - 1}KXM`)
    .replace(/\$([^\s$](?:[^$\n]*[^\s$])?)\$/g, (_, t) => `KXM${math.push(tex(t, false)) - 1}KXM`)
    .replace(/KXC(\d+)KXC/g, (_, i) => code[i]);
  const node = el("div", "md");
  node.innerHTML = DOMPurify.sanitize(marked.parse(src).replace(/KXM(\d+)KXM/g, (_, i) => math[i]));

  for (const bq of node.querySelectorAll("blockquote")) {
    const p = bq.firstElementChild;
    const m = p?.tagName === "P" && p.innerHTML.match(/^\[!(\w+)\]\s*/);
    if (!m) continue;
    const rest = p.innerHTML.slice(m[0].length);
    const cut = rest.search(/<br\s*\/?>|\n/);
    const title = el("div", "callout-title");
    title.innerHTML = cut < 0 ? rest : rest.slice(0, cut); // already sanitized above
    if (!title.textContent.trim()) title.textContent = m[1];
    p.innerHTML = cut < 0 ? "" : rest.slice(cut).replace(/^(<br\s*\/?>|\n)\s*/, "");
    if (!p.textContent.trim()) p.remove();
    const body = el("div", "callout-body");
    body.append(...bq.childNodes);
    const box = el("div", `callout callout-${m[1].toLowerCase()}`);
    box.append(title, body);
    bq.replaceWith(box);
  }
  if (final) {
    for (const c of node.querySelectorAll("code.language-mermaid")) c.parentElement.replaceWith(el("div", "mermaid", c.textContent));
  }
  return node;
}

let mermaidLib;
async function drawDiagrams(node) {
  const nodes = node.querySelectorAll(".mermaid");
  if (!nodes.length) return;
  if (!mermaidLib) {
    // the tiny build (no heavy layout engines) is a classic script that sets globalThis.mermaid; load it on first diagram
    await new Promise((resolve, reject) => {
      const script = Object.assign(document.createElement("script"), { src: mermaidUrl, onload: resolve, onerror: reject });
      document.head.append(script);
    });
    mermaidLib = globalThis.mermaid;
  }
  {
    // read the palette on every draw so diagrams follow a light/dark switch
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    mermaidLib.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        background: v("--bg"), primaryColor: v("--surface"), primaryTextColor: v("--text"), primaryBorderColor: v("--accent"),
        secondaryColor: v("--sidebar"), tertiaryColor: v("--bg"), lineColor: v("--muted"), textColor: v("--text"),
        fontFamily: "Inter Variable, sans-serif", fontSize: "14px",
      },
    });
  }
  await mermaidLib.run({ nodes }).catch(() => {}); // a broken diagram shows mermaid's own error
}

/** A node whose markdown re-renders at most once per frame while text streams in. */
function liveMarkdown(parent) {
  const box = el("div");
  parent.append(box);
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
        follow(parent);
      });
    },
    finish(text = src) {
      done = true;
      box.replaceChildren(md(text));
      drawDiagrams(box);
    },
  };
}

/** The value of a string field inside JSON that is still streaming in, e.g. {"markdown": "## Ti */
function partialField(json, key) {
  const m = json.match(new RegExp(`"${key}"\\s*:\\s*"`));
  if (!m) return "";
  let out = "";
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === '"') break;
    if (c !== "\\") { out += c; continue; }
    const n = json[++i];
    if (n === undefined) break;
    if (n === "u") {
      if (i + 4 >= json.length) break;
      out += String.fromCharCode(parseInt(json.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[n] ?? n;
  }
  return out;
}

function follow(node) {
  const s = node.closest("#log, #canvas") ?? node;
  if (s.scrollHeight - s.scrollTop - s.clientHeight < 200) s.scrollTop = s.scrollHeight;
}
const log = () => $("#log");
function chatNode(node) {
  log().append(node);
  log().scrollTop = log().scrollHeight;
  return node;
}
function say(text, who = "bot") {
  chatNode(el("div", `msg ${who}`)).append(md(text));
}
const note = (text) => chatNode(el("div", "meta", text));

// ---------- data ----------

let data = { folders: [], lessons: [], sources: [] };
let lesson = null; // { id, title, folder, last } — `last` is the latest assistant content (Rust keeps the history)
let busy = false;
let target = null; // folder new items go into
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
  renderTree();
  renderMarks();
}

// ---------- sidebar: files ----------

function row(kind, item, depth) {
  const r = el("div", "row");
  r.dataset.kind = kind;
  r.dataset.id = item.id;
  const iconName = kind === "folder" ? "folder" : kind === "source" ? "doc" : "file";
  r.innerHTML = (kind === "folder" ? `<span class="chev">${icon("chev", 12)}</span>` : "") + icon(iconName, 15);
  r.append(el("span", "label", item.name ?? item.title));
  if (kind === "source") r.append(el("span", "side", `${Math.round(item.words / 1000) || "<1"}k`));
  if (kind === "lesson" && item.id === lesson?.id) r.classList.add("active");
  if (kind === "folder" && item.id === target) r.classList.add("active");
  r.draggable = kind !== "source";
  return r;
}

function renderTree() {
  const build = (parent) => {
    const frag = document.createDocumentFragment();
    for (const f of data.folders.filter((x) => x.parent === parent)) {
      const wrap = el("div", `folder${opened.has(f.id) ? " open" : ""}`);
      const kids = el("div", "children");
      kids.append(build(f.id));
      wrap.append(row("folder", f), kids);
      frag.append(wrap);
    }
    if (parent != null) for (const s of data.sources.filter((x) => x.folder === parent)) frag.append(row("source", s));
    for (const l of data.lessons.filter((x) => x.folder === parent)) frag.append(row("lesson", l));
    return frag;
  };
  $("#tree").replaceChildren(build(null));
}

function renderMarks() {
  const marks = data.lessons.filter((l) => l.bookmarked);
  $("#marks").replaceChildren(...marks.map((l) => row("lesson", l)));
}

const item = (r) => {
  const id = Number(r.dataset.id);
  return { kind: r.dataset.kind, id, it: (r.dataset.kind === "folder" ? data.folders : r.dataset.kind === "source" ? data.sources : data.lessons).find((x) => x.id === id) };
};

$("#sidebar").addEventListener("click", (e) => {
  const r = e.target.closest(".row");
  if (!r || busy || r.querySelector("input")) return;
  const { kind, id, it } = item(r);
  if (kind === "folder") {
    opened.has(id) ? opened.delete(id) : opened.add(id);
    store.set("learn.open", [...opened]);
    target = id;
    renderTree();
  } else if (kind === "lesson") openLesson(id);
  else openSource(it);
});
$("#sidebar").addEventListener("dblclick", (e) => {
  const r = e.target.closest(".row");
  if (r && r.dataset.kind !== "source") rename(r);
});
$("#tree").addEventListener("click", (e) => {
  if (e.target === $("#tree")) { target = null; renderTree(); } // click empty space: back to the top level
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
  target = id;
  await refresh();
  rename($(`#tree .row[data-kind="folder"][data-id="${id}"]`));
}

// drag a lesson or folder onto a folder (or empty space) to move it
let dragged = null;
$("#tree").addEventListener("dragstart", (e) => { dragged = item(e.target.closest(".row")); });
$("#tree").addEventListener("dragover", (e) => {
  const r = e.target.closest(".row");
  if (!dragged || (r && r.dataset.kind !== "folder")) return;
  e.preventDefault();
  for (const x of document.querySelectorAll(".row.drop")) x.classList.remove("drop");
  r?.classList.add("drop");
});
$("#tree").addEventListener("drop", async (e) => {
  e.preventDefault();
  const r = e.target.closest(".row");
  const folder = r ? Number(r.dataset.id) : null;
  if (dragged && !(dragged.kind === "folder" && dragged.id === folder)) {
    await invoke("move_item", { kind: dragged.kind, id: dragged.id, folder }).catch(() => {}); // refused if it would nest a folder in itself
    if (folder != null) opened.add(folder);
    if (dragged.kind === "lesson" && lesson?.id === dragged.id) lesson.folder = folder;
  }
  dragged = null;
  refresh();
});
$("#tree").addEventListener("dragend", () => { dragged = null; renderTree(); });

// ---------- context menu ----------

function menu(x, y, entries) {
  const m = $("#menu");
  m.replaceChildren(
    ...entries.map((e) => {
      if (e === "-") return el("hr");
      const b = el("button", e.danger ? "danger" : "", e.label);
      b.onclick = async () => {
        if (e.danger && !b.dataset.armed) {
          b.dataset.armed = "1";
          b.textContent = "Click again to delete";
          return;
        }
        m.hidden = true;
        await e.run();
      };
      return b;
    }),
  );
  m.hidden = false;
  m.style.left = `${Math.min(x, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - m.offsetHeight - 8)}px`;
}
addEventListener("click", (e) => { if (!e.target.closest("#menu")) $("#menu").hidden = true; });
addEventListener("keydown", (e) => { if (e.key === "Escape") $("#menu").hidden = true; });

$("#sidebar").addEventListener("contextmenu", (e) => {
  if (busy || !e.target.closest("#files, #bookmarks")) return;
  e.preventDefault();
  const r = e.target.closest(".row");
  if (!r) return menu(e.clientX, e.clientY, [
    { label: "New lesson", run: () => startNew(null) },
    { label: "New folder", run: () => newFolder(null) },
  ]);
  const { kind, id, it } = item(r);
  if (kind === "folder") {
    menu(e.clientX, e.clientY, [
      { label: "New lesson", run: () => startNew(id) },
      { label: "New folder", run: () => newFolder(id) },
      { label: "Add material", run: () => attach({ folder: id }) },
      "-",
      { label: "Rename", run: () => rename(r) },
      { label: "Delete folder", danger: true, run: async () => {
        await invoke("delete_folder", { id });
        if (lesson && !data.lessons.some((l) => l.id === lesson.id && l.folder !== id)) startNew(null);
        refresh();
      } },
    ]);
  } else if (kind === "lesson") {
    menu(e.clientX, e.clientY, [
      { label: it.bookmarked ? "Remove bookmark" : "Bookmark", run: async () => { await invoke("bookmark_lesson", { id, on: !it.bookmarked }); refresh(); } },
      { label: "Rename", run: () => rename(r) },
      { label: "Export as Markdown", run: () => invoke("export_lesson", { id }) },
      "-",
      { label: "Delete lesson", danger: true, run: async () => {
        await invoke("delete_lesson", { id });
        if (lesson?.id === id) startNew(target);
        refresh();
      } },
    ]);
  } else {
    menu(e.clientX, e.clientY, [{ label: "Remove material", danger: true, run: async () => { await invoke("delete_source", { id }); refresh(); } }]);
  }
});

// ---------- sidebar: tabs, search, collapse ----------

for (const t of document.querySelectorAll(".tab")) {
  t.onclick = () => {
    for (const x of document.querySelectorAll(".tab")) x.classList.toggle("active", x === t);
    for (const p of ["files", "search", "bookmarks"]) $(`#${p}`).hidden = p !== t.dataset.tab;
    for (const b of document.querySelectorAll(".files-only")) b.hidden = t.dataset.tab !== "files";
    if (t.dataset.tab === "search") $("#search-input").focus();
  };
}

let searchTimer;
$("#search-input").oninput = () => {
  clearTimeout(searchTimer);
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
        d.onclick = () => !busy && openLesson(h.id);
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
  c.innerHTML = icon("doc", 13);
  c.append(el("span", "", name), el("small", "", `${Math.round(words / 1000) || "<1"}k`));
  if (onRemove) {
    const x = el("button");
    x.type = "button";
    x.innerHTML = icon("x", 12);
    x.setAttribute("aria-label", `Remove ${name}`);
    x.onclick = onRemove;
    c.append(x);
  }
  return c;
}

let pending = []; // material picked on the start screen, saved when the lesson starts

function renderStart() {
  const path = folderPath(target);
  $("#crumb").textContent = path.length ? path.join(" / ") : "";
  $("#materials").replaceChildren(
    ...materialsFor(target).map((s) => chip(s.name, s.words)),
    ...pending.map((p, i) => chip(p.name, p.words, () => { pending.splice(i, 1); renderStart(); })),
  );
}

function startNew(folder) {
  lesson = null;
  target = folder;
  pending = [];
  $("#start-input").value = "";
  show("start");
  renderStart();
  renderTree();
  $("#start-input").focus();
}

async function attach({ folder } = {}) {
  try {
    const picked = await invoke("pick_source");
    if (!picked) return;
    if (folder != null) {
      await invoke("add_source", { folder, lesson: null, name: picked.name, text: picked.text });
      opened.add(folder);
      await refresh();
    } else {
      pending.push(picked);
    }
    if (!$("#start").hidden) renderStart();
  } catch (e) {
    alert(e);
  }
}
$("#attach").onclick = () => attach();

async function openSource(s) {
  const { name, body } = await invoke("get_source", { id: s.id });
  lesson = null;
  show("doc");
  $("#doc-title").textContent = name;
  $("#doc-words").textContent = `${s.words.toLocaleString()} words`;
  if (/\.md$/i.test(name)) $("#doc-body").replaceChildren(md(body));
  else $("#doc-body").replaceChildren(el("pre", "plain", body));
  $("#doc").scrollTop = 0;
}

const leadHeading = (markdown = "") => markdown.match(/^#{1,2}\s+(.+)$/m)?.[1].replace(/[*_`$]/g, "").trim().slice(0, 80);

function showNotes(markdown) {
  $("#notes").hidden = !markdown;
  if (markdown) $("#notes-body").replaceChildren(md(markdown));
}

function showLesson() {
  show("lesson");
  $("#title").textContent = lesson.title;
  $("#canvas-body").replaceChildren();
  $("#canvas-body").classList.remove("titled");
  log().replaceChildren();
  showNotes(lesson.state);
  $("#lesson-materials").replaceChildren(...materialsFor(lesson.folder, lesson.id).map((s) => chip(s.name, s.words)));
}

async function openLesson(id) {
  const l = await invoke("get_lesson", { id });
  lesson = { id, title: l.title, folder: l.folder, state: l.state, sections: l.sections.length, toolResults: l.toolResults ?? {}, last: null };
  target = l.folder;
  showLesson();
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
        if (b.type === "tool_use" && b.name === "quiz") note(`Quiz: ${b.input?.question ?? ""}`);
      }
    }
  }
  const last = l.messages.at(-1);
  lesson.last = last?.role === "assistant" ? last.content : null;
  renderTree();
  renderMeter();
  if (pendingCalls().length) runLoop(); // closed in the middle of a quiz: ask it again
}

// ---------- streaming one turn ----------

async function streamTurn(content) {
  const typing = chatNode(el("div", "typing"));
  typing.append(el("span"), el("span"), el("span"));
  const views = new Map();
  const live = new Map(); // tool_use id → live canvas section

  const ch = new Channel();
  ch.onmessage = (e) => {
    if (e.type === "log") return agentLog(e.text); // behind-the-scenes lines go to the Agent panel only
    typing.remove();
    if (e.type === "start") {
      const b = e.block;
      const view = { buf: "" };
      if (b.type === "text") view.md = liveMarkdown(chatNode(el("div", "msg bot")));
      else if (b.type === "thinking" || b.type === "reasoning") {
        const d = chatNode(el("details", "meta"));
        d.append(el("summary", "", "Thinking"));
        view.md = liveMarkdown(d);
      } else if (b.type === "tool_use" && b.name === "write_lesson") {
        view.md = liveMarkdown($("#canvas-body"));
        view.lesson = true;
        live.set(b.id, view.md);
      } else if (b.type === "server_tool_use") view.note = note("Searching the web…");
      else if (b.type === "fallback") note(`Continued on ${b.to?.model ?? "a fallback model"}.`);
      else if (b.type === "compaction") note("Earlier turns summarized to save tokens.");
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
    typing.remove();
  }
}

// ---------- tools ----------

const pendingCalls = () => (Array.isArray(lesson?.last) ? lesson.last.filter((b) => b.type === "tool_use") : []);

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
      b.onclick = () => done(i);
      return b;
    });
    card.append(...buttons);
    if (withNote || free) {
      extra.placeholder = free ? "Your own answer" : "Why?";
      card.append(extra);
    }
    extra.onkeydown = (e) => { if (free && e.key === "Enter" && extra.value.trim()) done(-1); };
    card.scrollIntoView({ block: "nearest" });
    function done(i) {
      for (const b of buttons) b.disabled = true;
      extra.disabled = true;
      resolve({ i, buttons, text: extra.value.trim() });
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

async function addSection(markdown, live) {
  if (live) live.finish(markdown);
  else {
    const box = md(markdown);
    $("#canvas-body").append(box);
    drawDiagrams(box);
    follow(box);
  }
  await invoke("add_section", { lesson: lesson.id, markdown });
  // the first heading the tutor writes becomes the lesson title (shown once, not twice)
  if (lesson.sections++ === 0 && leadHeading(markdown)) {
    lesson.title = leadHeading(markdown);
    $("#title").textContent = lesson.title;
    $("#canvas-body").classList.add("titled");
    await invoke("rename_lesson", { id: lesson.id, title: lesson.title });
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
  await invoke("save_tool_result", { lesson: lesson.id, result });
  lesson.toolResults[call.id] = result;
  return result;
}

async function executeTool({ id, name, input = {} }) {
  const ok = (content) => ({ type: "tool_result", tool_use_id: id, content });
  const bad = (content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
  const live = turn.live.get(id); // the section already streamed onto the canvas, if any
  const fail = (msg) => { live?.box.remove(); return bad(msg); };
  if (turn.truncated) return fail("Your reply was cut off at the output limit before this call finished. Make the step shorter and call the tool again.");
  if (id in turn.invalid) return fail(JSON.stringify({ INVALID_JSON: turn.invalid[id] }));

  if (name === "write_lesson") {
    if (typeof input.markdown !== "string") return fail("write_lesson needs a markdown string.");
    await addSection(input.markdown, live);
    return ok("Added to the lesson.");
  }
  if (name === "quiz") {
    const { question, options, correct_index: c, explanation = "" } = input;
    if (typeof question !== "string" || !Array.isArray(options) || options.length < 2 || !Number.isInteger(c) || c < 0 || c >= options.length) {
      return bad("quiz needs a question, at least 2 options and a valid 0-based correct_index.");
    }
    const { i, buttons, text } = await choiceCard("quiz", question, [...options, "I don't know"], { note: true });
    const right = i === c;
    const picked = i === options.length ? "I don't know" : options[i];
    buttons[c].classList.add("right");
    if (!right) buttons[i].classList.add("wrong");
    await addSection(resultCard(question, picked, options[c], right, text, explanation));
    return ok(`The learner chose "${picked}" (${right ? "correct" : `incorrect; correct answer: "${options[c]}"`}).${text ? ` Their note: ${text}` : ""} The result card with your explanation is already in the lesson, so don't repeat it.`);
  }
  if (name === "update_state") {
    if (typeof input.markdown !== "string") return bad("update_state needs a markdown string.");
    await invoke("set_state", { lesson: lesson.id, markdown: input.markdown });
    lesson.state = input.markdown;
    showNotes(input.markdown);
    return ok("Lesson state saved.");
  }
  if (name === "ask") {
    if (typeof input.question !== "string" || !Array.isArray(input.options)) return bad("ask needs a question and options.");
    const { i, text } = await choiceCard("ask", input.question, input.options, { free: true });
    const answer = i < 0 ? text : input.options[i];
    say(answer, "user");
    return ok(`The learner answered: ${answer}`);
  }
  return bad(`Unknown tool: ${name}`);
}

// ---------- status strip: what the provider reports about each turn ----------

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

let lastProvider = null; // who answered this lesson's latest turn

async function renderMeter() {
  const p = provider();
  const s = await invoke("stats", { lesson: lesson?.id ?? null, provider: p.id }).catch(() => ({}));
  const parts = [];
  const last = s.last;
  lastProvider = last?.provider ?? null;
  parts.push(seg(last?.model || p.model || p.label, ""));
  for (const [key, label] of [["five_hour", "5h"], ["seven_day", "week"]]) {
    const w = s.limits?.unifiedWindows?.[key];
    if (!w) continue;
    const reset = new Date(w.resetsAt * 1000);
    const when = key === "five_hour" ? reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : reset.toLocaleDateString([], { weekday: "short", hour: "numeric" });
    parts.push(seg(label, `${Math.round(w.utilization * 100)}%`, w.utilization, `Subscription usage, resets ${when}`));
  }
  if (last) {
    const ctx = last.input + last.cache_read + last.cache_write;
    const win = windowOf(last.model);
    parts.push(seg("context", fmt(ctx), win ? ctx / win : null, win ? `${fmt(ctx)} of ${fmt(win)} tokens` : `${fmt(ctx)} tokens sent last turn`));
    if (ctx) parts.push(seg("cached", `${Math.round((last.cache_read / ctx) * 100)}%`, null, "Share of last turn's prompt read from cache"));
  }
  const t = s.totals;
  if (t?.turns && !p.local && t.cost != null) parts.push(seg("lesson", `$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}`, null, `${t.turns} turns, ${fmt(t.input)} in, ${fmt(t.output)} out`));
  $("#meter").replaceChildren(...parts);
}

// ---------- the tutor loop ----------

function setBusy(on) {
  busy = on;
  document.body.classList.toggle("busy", on);
  $("#input").disabled = on;
  $("#composer .send").disabled = on;
  if (!on && !$("#lesson").hidden) $("#input").focus();
}

/** `first`: the learner's message; undefined continues with pending tool calls. */
async function runLoop(first) {
  setBusy(true);
  let content = first;
  try {
    for (;;) {
      if (content === undefined) {
        const calls = pendingCalls();
        if (!calls.length) break;
        content = [];
        for (const call of calls) content.push(await runTool(call)); // all results go back in ONE message
      }
      const { reply, live } = await streamTurn(content);
      lesson.last = reply.content;
      renderMeter();
      turn = { live, invalid: reply.invalid, truncated: reply.stop_reason === "max_tokens" };
      if (reply.stop_reason === "refusal") {
        note(`The model declined to continue${reply.stop_details?.category ? ` (${reply.stop_details.category})` : ""}. Try rephrasing.`);
        break;
      }
      content = reply.stop_reason === "pause_turn" ? null : undefined; // null resumes a paused web search
    }
  } catch (e) {
    agentLog(`error  ${e}`);
    note(`Something went wrong: ${e}`);
  } finally {
    setBusy(false);
    refresh();
  }
}

// ---------- bottom panel: agent log and terminal ----------

const drawer = $("#drawer");

function setDrawer(open) {
  drawer.hidden = !open;
  document.body.classList.toggle("drawer-open", open);
  if (open && !$("#shell").hidden) openShell();
}

function showPane(name) {
  for (const b of document.querySelectorAll(".dtab")) b.classList.toggle("active", b.dataset.pane === name);
  $("#agent-log").hidden = name !== "agent";
  $("#shell").hidden = name !== "shell";
  store.set("learn.pane", name);
  if (name === "shell" && !drawer.hidden) openShell();
}

const MAX_LOG = 1500; // older lines drop off so a long session can't grow memory without bound
function agentLog(text) {
  const box = $("#agent-log");
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = el("div", /^(stderr|error)|"is_error":true|failed/i.test(text) ? "err" : text.startsWith("done") ? "done" : "");
  line.append(el("span", "t", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), text);
  box.append(line);
  while (box.childElementCount > MAX_LOG) box.firstElementChild.remove();
  if (atEnd) box.scrollTop = box.scrollHeight;
}

let shell = null; // { term, fit }: one xterm for the app's lifetime, so scrollback survives hiding the panel

async function startPty() {
  const out = new Channel();
  out.onmessage = (data) => shell.term.write(data);
  await invoke("term_open", { cols: shell.term.cols, rows: shell.term.rows, out }).catch((e) => shell.term.write(`\r\n${e}\r\n`));
}

async function openShell() {
  if (shell) {
    requestAnimationFrame(fitShell);
    return shell.term.focus();
  }
  // loaded the first time the terminal opens, not at startup
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", monospace', fontSize: 13, cursorBlink: true, scrollback: 5000,
    theme: { background: v("--sidebar"), foreground: v("--text"), cursor: v("--accent"), selectionBackground: v("--accent-soft") },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($("#shell"));
  fit.fit();
  shell = { term, fit };
  term.onData((data) =>
    invoke("term_write", { data }).catch(async () => {
      await startPty(); // the shell exited: any key starts a new one
    }),
  );
  new ResizeObserver(fitShell).observe($("#shell"));
  await startPty();
  term.focus();
}

function fitShell() {
  if (!shell || $("#shell").hidden || drawer.hidden) return;
  shell.fit.fit();
  invoke("term_resize", { cols: shell.term.cols, rows: shell.term.rows }).catch(() => {});
}

$("#term-btn").onclick = () => setDrawer(drawer.hidden);
$("#drawer-close").onclick = () => setDrawer(false);
for (const b of document.querySelectorAll(".dtab")) b.onclick = () => showPane(b.dataset.pane);
addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setDrawer(drawer.hidden);
  }
});
$("#drawer-grip").onpointerdown = (e) => {
  e.preventDefault();
  const move = (m) => {
    const h = Math.min(innerHeight - 160, Math.max(140, innerHeight - m.clientY));
    document.documentElement.style.setProperty("--drawer-h", `${h}px`);
    fitShell();
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    store.set("learn.drawerH", getComputedStyle(document.documentElement).getPropertyValue("--drawer-h"));
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
};
const savedH = store.get("learn.drawerH", null);
if (savedH) document.documentElement.style.setProperty("--drawer-h", savedH);
showPane(store.get("learn.pane", "agent"));

// ---------- model ----------

const PRESETS = {
  "claude-code": { label: "Claude Code", kind: "claude-code", model: "", local: true }, // your signed-in CLI, no key
  codex: { label: "Codex", kind: "codex", model: "", local: true },
  nvidia: { label: "NVIDIA", kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", model: "moonshotai/kimi-k3" },
  anthropic: { label: "Anthropic", kind: "anthropic", baseUrl: "", model: "claude-opus-5-5" },
  openai: { label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "" },
  openrouter: { label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  ollama: { label: "Ollama", kind: "openai", baseUrl: "http://localhost:11434/v1", model: "", keyless: true },
  custom: { label: "Custom", kind: "openai", baseUrl: "", model: "" },
};
let settings = { active: "claude-code", providers: {} };
const provider = (id = settings.active) => ({ id, ...PRESETS[id], ...settings.providers[id] });
let chosen = settings.active;

function showWho() {
  const p = provider();
  $("#who").textContent = p.local ? (p.model ? `${p.label} · ${p.model}` : p.label) : p.model || p.label;
}

async function pickProvider(id) {
  chosen = id;
  $("#p-status").textContent = "";
  const p = provider(id);
  for (const b of $("#p-list").children) b.setAttribute("aria-checked", String(b.dataset.id === id));
  $("#p-model").value = p.model;
  $("#p-base").value = p.baseUrl ?? "";
  $("#p-base-row").hidden = p.kind !== "openai";
  $("#p-key-row").hidden = !!(p.keyless || p.local);
  $("#p-key").value = "";
  $("#p-key").placeholder = !(p.keyless || p.local) && (await invoke("has_api_key", { provider: id }).catch(() => false)) ? "••••••••••••" : "";
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
  await pickProvider(settings.active);
  $("#settings").showModal();
  $("#p-model").focus();
}
$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  settings.active = chosen;
  settings.providers[chosen] = { model: $("#p-model").value.trim(), baseUrl: $("#p-base").value.trim() };
  try {
    if ($("#p-key").value.trim()) await invoke("set_api_key", { provider: chosen, key: $("#p-key").value.trim() });
    await invoke("save_settings", { settings });
  } catch (e) {
    alert(e);
  }
  showWho();
  if (lesson) renderMeter();
});
$("#p-test").onclick = async () => {
  const button = $("#p-test");
  button.disabled = true;
  $("#p-status").textContent = "Connecting… This uses a small provider request.";
  const p = { ...provider(chosen), model: $("#p-model").value.trim(), baseUrl: $("#p-base").value.trim() };
  try {
    const key = $("#p-key").value.trim();
    if (key && !p.local && !p.keyless) await invoke("set_api_key", { provider: p.id, key });
    $("#p-status").textContent = await invoke("test_provider", { provider: p });
  } catch (e) {
    $("#p-status").textContent = `Connection failed: ${e}`;
  } finally {
    button.disabled = false;
  }
};
$("#model").onclick = openModel;

async function ready() {
  const p = provider();
  if (p.local) return true; // the CLI uses its own sign-in and default model
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
  if ((!text && !material) || busy) return;
  if (!(await ready())) return openModel();
  const first = text || "Teach me this material.";
  const title = text.split("\n")[0].slice(0, 60) || pending[0]?.name.replace(/\.\w+$/, "") || "New lesson";
  const id = await invoke("create_lesson", { folder: target, title });
  for (const p of pending) await invoke("add_source", { folder: null, lesson: id, name: p.name, text: p.text });
  pending = [];
  await refresh();
  lesson = { id, title, folder: target, state: "", sections: 0, last: null };
  showLesson();
  renderMeter();
  say(first, "user");
  runLoop(first);
};
$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || busy || !lesson) return;
  if (!(await ready())) return openModel();
  $("#input").value = "";
  grow($("#input"));
  if (lastProvider && lastProvider !== settings.active) note(`Continued with ${provider().label}`); // handoff
  say(text, "user");
  runLoop(text);
};
$("#start-input").onkeydown = enterSubmits($("#start-form"));
$("#input").onkeydown = enterSubmits($("#composer"));
$("#input").oninput = () => grow($("#input"));
$("#new-lesson").onclick = () => !busy && startNew(target);
$("#new-folder").onclick = () => !busy && newFolder(target);

settings = { ...settings, ...((await invoke("get_settings")) ?? {}) };
showWho();
setCollapsed(store.get("learn.collapsed", false));
await refresh();
startNew(null);
