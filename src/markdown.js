// Markdown to sanitized HTML, with LaTeX, callouts and (when final) mermaid diagrams.
import { marked } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import mermaidUrl from "@mermaid-js/tiny/dist/mermaid.tiny.js?url";
import { el } from "./dom.js";

marked.use({ breaks: true });

const tex = (t, displayMode) => katex.renderToString(t, { displayMode, throwOnError: false });

export function md(src, final = true) {
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
export async function drawDiagrams(node) {
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
        fontFamily: "Geist Variable, sans-serif", fontSize: "14px",
      },
    });
  }
  await mermaidLib.run({ nodes }).catch(() => {}); // a broken diagram shows mermaid's own error
}

/** The value of a string field inside JSON that is still streaming in, e.g. {"markdown": "## Ti */
export function partialField(json, key) {
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
