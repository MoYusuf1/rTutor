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
  edit: "M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z",
  plus: "M12 5v14M5 12h14",
  doc: "M6 3h12v18H6zM9 8h6M9 12h6M9 16h3",
  chev: "M9 6l6 6-6 6",
  clip: "M19.5 11.5l-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l8.2-8.2a3 3 0 0 1 4.3 4.3l-8.2 8.2a1.5 1.5 0 0 1-2.1-2.1l7.5-7.5",
  x: "M6 6l12 12M18 6L6 18",
  send: "M12 19V5M5.5 11.5L12 5l6.5 6.5",
  spark: "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z",
  terminal: "M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
};
const icon = (name, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
for (const e of document.querySelectorAll("[data-icon]")) e.innerHTML = icon(e.dataset.icon, e.classList.contains("send") ? 18 : 16);

// Provider logos (Simple Icons, CC0). Brand colors only where the mark is a color; the rest follow the text.
const LOGOS = {
  claude: ["#D97757", "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"],
  anthropic: ["currentColor", "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"],
  openai: ["currentColor", "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"],
  nvidia: ["#76B900", "M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z"],
  openrouter: ["currentColor", "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"],
};
const logo = (name, size = 18) => {
  const l = LOGOS[name];
  return l ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${l[0]}" aria-hidden="true"><path d="${l[1]}"/></svg>` : icon(name === "terminal" ? "terminal" : "spark", size);
};
/** An MCP client's name ("claude-code", "codex-mcp-client", ...) as people say it, with its logo. */
function agentLook(name = "") {
  if (/claude/i.test(name)) return { label: "Claude Code", logo: "claude" };
  if (/codex/i.test(name)) return { label: "Codex", logo: "openai" };
  return { label: name.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Agent", logo: "terminal" };
}

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
const thinkingNode = el("div", "thinking");
thinkingNode.append(el("span", "dots"), el("span", "", "Thinking…"));
thinkingNode.firstChild.append(el("i"), el("i"), el("i"));
/** Adds to the chat, always above the "Thinking…" line. */
function chatNode(node) {
  log().insertBefore(node, thinkingNode.parentNode === log() ? thinkingNode : null);
  log().scrollTop = log().scrollHeight;
  return node;
}
function say(text, who = "bot") {
  chatNode(el("div", `msg ${who}`)).append(md(text));
}
const note = (text) => chatNode(el("div", "meta", text));
function thinking(on) {
  if (on && thinkingNode.parentNode !== log()) {
    log().append(thinkingNode);
    log().scrollTop = log().scrollHeight;
  } else if (!on) thinkingNode.remove();
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

// ---------- sidebar: folders with their lessons, recents ----------

function row(kind, item) {
  const r = el("div", `row ${kind}`);
  r.dataset.kind = kind;
  r.dataset.id = item.id;
  if (kind === "folder") r.innerHTML = `<span class="chev">${icon("chev", 12)}</span>${icon("folder", 15)}`;
  if (kind === "source") r.innerHTML = icon("doc", 14);
  r.append(el("span", "label", item.name ?? item.title));
  if (kind === "source") r.append(el("span", "side", `${Math.round(item.words / 1000) || "<1"}k`));
  if (kind === "lesson" && item.id === lesson?.id) r.classList.add("active");
  r.draggable = kind !== "source";
  return r;
}

function renderSidebar() {
  const build = (parent) => {
    const frag = document.createDocumentFragment();
    for (const f of data.folders.filter((x) => x.parent === parent)) {
      const wrap = el("div", `folder${opened.has(f.id) ? " open" : ""}`);
      const kids = el("div", "children");
      kids.append(build(f.id));
      wrap.append(row("folder", f), kids);
      frag.append(wrap);
    }
    if (parent != null) {
      for (const s of data.sources.filter((x) => x.folder === parent)) frag.append(row("source", s));
      for (const l of data.lessons.filter((x) => x.folder === parent)) frag.append(row("lesson", l));
    }
    return frag;
  };
  $("#tree").replaceChildren(build(null));
  $("#recents").replaceChildren(...data.lessons.filter((l) => l.folder == null).map((l) => row("lesson", l)));
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
    opened.has(id) ? opened.delete(id) : opened.add(id);
    store.set("learn.open", [...opened]);
    r.parentElement.classList.toggle("open", opened.has(id));
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
  const loose = e.target.closest("#recents");
  if (!dragged || (!loose && r?.dataset.kind !== "folder")) return;
  e.preventDefault();
  for (const x of document.querySelectorAll(".drop")) x.classList.remove("drop");
  (loose ? $("#recents") : r).classList.add("drop");
});
side.addEventListener("drop", async (e) => {
  e.preventDefault();
  const r = e.target.closest(".row");
  const folder = e.target.closest("#recents") ? null : r ? Number(r.dataset.id) : undefined;
  if (dragged && folder !== undefined && !(dragged.kind === "folder" && dragged.id === folder)) {
    await invoke("move_item", { kind: dragged.kind, id: dragged.id, folder }).catch(() => {}); // refused if it would nest a folder in itself
    if (folder != null) opened.add(folder);
    if (dragged.kind === "lesson" && lesson?.id === dragged.id) lesson.folder = folder;
  }
  dragged = null;
  refresh();
});
side.addEventListener("dragend", () => { dragged = null; renderSidebar(); });

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
addEventListener("click", (e) => {
  if (!e.target.closest("#menu")) $("#menu").hidden = true;
  if (!e.target.closest("#pop, #model")) $("#pop").hidden = true;
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#menu").hidden = $("#pop").hidden = true;
});

side.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const r = e.target.closest(".row");
  if (!r) return menu(e.clientX, e.clientY, [
    { label: "New lesson", run: () => startNew(null) },
    { label: "New folder", run: () => newFolder(null) },
  ]);
  const { kind, id, it } = item(r);
  if (kind === "folder") {
    menu(e.clientX, e.clientY, [
      { label: "New lesson here", run: () => startNew(id) },
      { label: "New folder inside", run: () => newFolder(id) },
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
      { label: it.bookmarked ? "Unpin" : "Pin", run: async () => { await invoke("bookmark_lesson", { id, on: !it.bookmarked }); refresh(); } },
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

/** Leaving the open lesson: anything still waiting on the learner there is let go. */
function leave() {
  gen++;
  openCard?.abandon();
  thinking(false);
}

function startNew(folder) {
  leave();
  lesson = null;
  target = folder;
  pending = [];
  $("#start-input").value = "";
  show("start");
  renderStart();
  renderSidebar();
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
  const last = l.messages.at(-1);
  lesson.last = last?.role === "assistant" ? last.content : null;
  renderSidebar();
  renderSuggest();
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
    if (e.type === "log" || mine !== gen) return;
    if (e.type === "start") {
      const b = e.block;
      const view = { buf: "" };
      if (b.type === "text") view.md = liveMarkdown(log()), view.md.box.className = "msg bot";
      else if (b.type === "thinking" || b.type === "reasoning") view.thinking = true;
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
      extra.placeholder = free ? "Your own answer" : "Why? (optional)";
      card.append(extra);
    }
    extra.onkeydown = (e) => { if (free && e.key === "Enter" && extra.value.trim()) done({ i: -1 }); };
    card.scrollIntoView({ block: "nearest" });
    const self = {
      answer: (text) => { extra.value = text; done({ i: -1, typed: true }); },
      abandon: () => done({ abandoned: true }),
    };
    openCard = self;
    $("#input").placeholder = "Or answer in your own words…";
    thinking(false);
    function done(r) {
      if (openCard !== self) return;
      openCard = null;
      $("#input").placeholder = "Ask your tutor…";
      for (const b of buttons) b.disabled = true;
      extra.disabled = true;
      resolve({ ...r, buttons, text: extra.value.trim() });
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
    follow(box);
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
  if (name === "say") {
    if (typeof input.text !== "string") return bad("say needs text.");
    if (here) say(input.text);
    return ok("Shown in the chat.");
  }
  if (name === "quiz" || name === "ask") {
    if (!here) return { ...bad(LEFT), abandoned: true };
  }
  if (name === "quiz") {
    const { question, options, correct_index: c, explanation = "" } = input;
    if (typeof question !== "string" || !Array.isArray(options) || options.length < 2 || !Number.isInteger(c) || c < 0 || c >= options.length) {
      return bad("quiz needs a question, at least 2 options and a valid 0-based correct_index.");
    }
    const r = await choiceCard("quiz", question, [...options, "I don't know"], { note: true });
    if (r.abandoned) return { ...bad(LEFT), abandoned: true };
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
    const answer = r.i < 0 ? r.text : input.options[r.i];
    say(answer, "user");
    return ok(`The learner answered: ${answer}`);
  }
  return bad(`Unknown tool: ${name}`);
}

// ---------- shortcuts for the lesson's phase ----------

const SUGGEST = {
  probe: [["Start teaching", "That's enough questions about what I know. Make the plan and start teaching."], ["Keep checking", "Keep checking what I know."], ["Test me instead", "Skip the lesson and test me on this topic."]],
  plan: [["Looks good, start", "The plan looks good. Start teaching."], ["Change the plan", "I'd like to change the plan."]],
  teach: [["Another angle", "Explain that from a different angle."], ["Quiz me", "Quiz me on what we just covered."], ["Test me on everything", "Test me on everything so far."], ["Slow down", "Slow down and take smaller steps."]],
  review: [["Back to teaching", "Let's go back to teaching the next part."], ["Harder", "Make the questions harder."], ["Explain my misses", "Explain the ones I got wrong."]],
};

function renderSuggest() {
  const box = $("#suggest");
  box.replaceChildren(
    ...(SUGGEST[lesson?.phase] ?? []).map(([label, text]) => {
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
  const p = provider();
  const s = await invoke("stats", { lesson: lesson?.id ?? null, provider: p.id }).catch(() => ({}));
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
    if (mine === gen) note(`Something went wrong: ${e}`);
  } finally {
    if (apiBusy === me.id) apiBusy = null;
    refresh();
  }
}

// ---------- terminal agents: they pull the learner's messages and call the lesson tools ----------

let agents = []; // [{ id, name, cwd, cmd, busy }]
let activeAgent = null;
let agentLesson = null; // the lesson the agent is working on
let sentWaiting = false; // a message was sent and the agent hasn't picked it up yet

const usingAgent = () => settings.active === "agent";
const agentThinking = () => sentWaiting || !!agents.find((a) => a.id === activeAgent)?.busy;

const agentEvents = new Channel();
agentEvents.onmessage = async (e) => {
  if (e.type === "agents") {
    const before = new Set(agents.map((a) => a.id));
    agents = e.agents;
    activeAgent = e.active;
    if (agents.find((a) => a.id === activeAgent)?.busy) sentWaiting = false;
    if (lesson?.id === agentLesson) thinking(!openCard && agentThinking());
    for (const a of agents) if (!before.has(a.id)) connected(a);
    showWho();
    if (!$("#pop").hidden) renderPop();
  } else if (e.type === "call") {
    const to = lesson?.id === e.lesson ? lesson : { id: e.lesson, sections: 1, state: "" };
    agentLesson = e.lesson;
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
  if (!cmd || (main && main.cmd === cmd && main.cwd === a.cwd) || settings.asked?.includes(cmd)) return;
  const box = $("#offer");
  box.replaceChildren(el("p", "", `${look.label} is live. Start it automatically whenever rlearn opens?`));
  const row = el("div", "offer-row");
  const yes = el("button", "primary", "Start it automatically");
  const no = el("button", "", "Not now");
  yes.onclick = () => {
    settings.main = { cwd: a.cwd, cmd, name: a.name };
    saveSettings();
    box.hidden = true;
  };
  no.onclick = () => {
    settings.asked = [...(settings.asked ?? []), cmd];
    saveSettings();
    box.hidden = true;
  };
  row.append(yes, no);
  box.append(row);
  box.hidden = false;
}

/** The learner's message (or a shortcut) goes to whoever is teaching. */
async function send(text) {
  if (!lesson) return;
  if (openCard) {
    openCard.answer(text);
    return;
  }
  if (usingAgent()) {
    if (!agents.length) {
      note("No agent is running. Open the terminal and start one.");
      openTerminal();
      return;
    }
    say(text, "user");
    sentWaiting = true;
    agentLesson = lesson.id;
    thinking(true);
    await invoke("agent_send", { lesson: lesson.id, text }).catch((e) => { sentWaiting = false; thinking(false); note(String(e)); });
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
const launched = new Map(); // folder → the agent command rlearn typed there
let mcpBin = "";
let home = "";

function setDrawer(open) {
  drawer.hidden = !open;
  document.body.classList.toggle("drawer-open", open);
  if (open && !tabs.length) showWhere();
  if (open && current) requestAnimationFrame(() => { fitShell(); current.term.focus(); });
}

function showWhere() {
  $("#where").hidden = false;
  for (const t of tabs) t.el.hidden = true;
  $("#where-dir").textContent = settings.cwd || home;
  $("#where-dir").title = "Choose a folder";
}
$("#where-dir").onclick = async () => {
  const dir = await invoke("pick_folder").catch(() => null);
  if (dir) {
    settings.cwd = dir;
    $("#where-dir").textContent = dir;
    saveSettings();
  }
};
$("#where").onsubmit = (e) => {
  e.preventDefault();
  newTab(settings.cwd || home);
};

const short = (dir = "") => dir.split(/[\\/]/).filter(Boolean).pop() || "~";

/** Commands that start each agent wired to rlearn, so a click is all it takes. */
function quickStarts() {
  const bin = mcpBin.replace(/'/g, "");
  const json = JSON.stringify({ mcpServers: { rlearn: { command: bin, args: ["--mcp"] } } });
  return [
    ["Claude Code", "claude", `env MCP_TOOL_TIMEOUT=1800000 claude --mcp-config '${json}' --allowedTools mcp__rlearn 'Start rlearn'`],
    ["Codex", "openai", `codex -c 'mcp_servers.rlearn.command="${bin}"' -c 'mcp_servers.rlearn.args=["--mcp"]' -c mcp_servers.rlearn.tool_timeout_sec=1800 -c 'mcp_servers.rlearn.default_tools_approval_mode="approve"' 'Start rlearn'`],
  ];
}

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
  for (const [label, logoName, cmd] of quickStarts()) {
    const b = el("button");
    b.type = "button";
    b.innerHTML = logo(logoName, 14);
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
  any.title = "Any agent that speaks MCP can power rlearn: add this server to it.";
  any.onclick = () => term.write(`\r\n\x1b[2mAdd this MCP server to your agent, then ask it to start rlearn:\x1b[0m\r\n  ${mcpBin} --mcp\r\n`);
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
      b.innerHTML = a ? logo(agentLook(a.name).logo, 12) : icon("terminal", 12);
      b.append(el("span", "", short(t.cwd)));
      b.title = t.cwd || "Home folder";
      b.onclick = () => selectTab(t);
      const x = el("button", "", "");
      x.innerHTML = icon("x", 11);
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

$("#term-btn").onclick = () => setDrawer(drawer.hidden);
$("#tnew").onclick = showWhere;
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
for (const [k, name] of [["learn.drawerH", "--drawer-h"], ["learn.chatW", "--chat-w"]]) {
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
    const a = agents.find((x) => x.id === activeAgent);
    const look = agentLook(a?.name);
    name = a ? look.label : "No agent running";
    sub = a ? short(a.cwd) : "Open the terminal to start one";
    mark = a ? look.logo : "terminal";
  } else {
    const p = provider();
    name = p.label;
    sub = p.model || "Choose a model";
    mark = p.logo;
  }
  $("#who").textContent = name;
  $("#who-sub").textContent = sub;
  $("#who-logo").innerHTML = logo(mark, 18);
  $("#model").classList.toggle("off", usingAgent() && !agents.length);
  if (tabs.length) renderTabs();
}

async function renderPop() {
  const pop = $("#pop");
  const option = (mark, title, sub, on, run) => {
    const b = el("button", `opt-row${on ? " on" : ""}`);
    b.innerHTML = logo(mark, 18);
    const text = el("span", "who");
    text.append(el("span", "", title), el("small", "", sub));
    b.append(text);
    b.onclick = run;
    return b;
  };
  const parts = [el("h4", "", "Agents")];
  for (const a of agents) {
    const look = agentLook(a.name);
    parts.push(option(look.logo, look.label, a.cwd || "Home folder", usingAgent() && a.id === activeAgent, () => {
      settings.active = "agent";
      saveSettings();
      invoke("agent_use", { id: a.id });
      showWho();
      renderPop();
    }));
  }
  const term = el("button", "act", "");
  term.innerHTML = icon("terminal", 15);
  term.append(agents.length ? "Start another agent" : "Start an agent in the terminal");
  term.onclick = () => { pop.hidden = true; openTerminal(); };
  parts.push(term);
  if (settings.main) {
    const look = agentLook(settings.main.name);
    const auto = el("p", "auto", `${look.label} starts with rlearn in ${short(settings.main.cwd)}. `);
    const off = el("button", "link", "Stop that");
    off.onclick = () => { settings.main = null; saveSettings(); renderPop(); };
    auto.append(off);
    parts.push(auto);
  }
  const p = provider();
  parts.push(el("h4", "", "API"));
  const api = option(p.logo, p.label, p.model || "Not set up", !usingAgent(), async () => {
    if (!(await ready())) return openModel();
    settings.active = "api";
    saveSettings();
    showWho();
    renderPop();
  });
  const gear = el("button", "icon", "");
  gear.innerHTML = icon("gear", 15);
  gear.title = "API provider settings";
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
  if (!text && !material) return;
  if (usingAgent() ? !agents.length : !(await ready())) return usingAgent() ? openTerminal() : openModel();
  const first = text || "Teach me this material.";
  const title = text.split("\n")[0].slice(0, 60) || pending[0]?.name.replace(/\.\w+$/, "") || "New lesson";
  const id = await invoke("create_lesson", { folder: target, title });
  for (const p of pending) await invoke("add_source", { folder: null, lesson: id, name: p.name, text: p.text });
  pending = [];
  await refresh();
  leave();
  lesson = { id, title, folder: target, state: "", sections: 0, phase: null, last: null, toolResults: {} };
  showLesson();
  renderSidebar();
  send(first);
};
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || !lesson) return;
  $("#input").value = "";
  grow($("#input"));
  send(text);
};
$("#start-input").onkeydown = enterSubmits($("#start-form"));
$("#input").onkeydown = enterSubmits($("#composer"));
$("#input").oninput = () => grow($("#input"));
$("#new-lesson").onclick = () => startNew(null);
$("#new-folder").onclick = () => newFolder(null);

settings = { ...settings, ...((await invoke("get_settings")) ?? {}) };
if (!["agent", "api"].includes(settings.active)) settings.active = "agent"; // older settings named a provider here
if (!PRESETS[settings.api]) settings.api = "nvidia";
await invoke("agent_listen", { onEvent: agentEvents }).catch(() => {});
({ bin: mcpBin, home } = await invoke("mcp_command").catch(() => ({ bin: "rlearn", home: "" })));
showWho();
setCollapsed(store.get("learn.collapsed", false));
await refresh();
startNew(null);
// the main agent starts with the app, out of sight until the learner opens the terminal
if (settings.main) newTab(settings.main.cwd, settings.main.cmd);
