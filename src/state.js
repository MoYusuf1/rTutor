// What the whole page shares: the library (subjects, lessons, material), the open lesson and the settings.
// Everything else belongs to the module that uses it.
import { invoke } from "@tauri-apps/api/core";

export const app = {
  data: { folders: [], lessons: [], sources: [] },
  lesson: null, // the open lesson: { id, title, folder, state, sections, phase, last, toolResults }
  target: null, // the subject new lessons go into
  gen: 0, // bumps whenever the open lesson changes, so late events from the old one are dropped
  settings: { active: "agent", api: "nvidia", providers: {} },
};

let folders = new Map(); // id → folder, rebuilt with the tree so lookups are O(1)

export function setTree(tree) {
  app.data = tree;
  folders = new Map(tree.folders.map((f) => [f.id, f]));
}

export const folderById = (id) => folders.get(id);

/** Names from the subject down to `id`. */
export function folderPath(id) {
  const names = [];
  for (let f = folderById(id); f; f = folderById(f.parent)) names.unshift(f.name);
  return names;
}

/** A subject's folder on disk (~/rtutor/<subject>): where its agent runs. */
export function subjectDir(folder) {
  let f = folderById(folder);
  while (f?.parent != null) f = folderById(f.parent);
  return f?.dir ?? "";
}

/** Material a lesson in `folder` (or the lesson itself) is taught from. */
export function materialsFor(folder, lessonId) {
  const chain = new Set();
  for (let f = folderById(folder); f; f = folderById(f.parent)) chain.add(f.id);
  return app.data.sources.filter((s) => chain.has(s.folder) || (lessonId && s.lesson === lessonId));
}

export const saveSettings = () => invoke("save_settings", { settings: app.settings }).catch(() => {});

export const leadHeading = (markdown = "") => markdown.match(/^#{1,2}\s+(.+)$/m)?.[1].replace(/[*_`$]/g, "").trim().slice(0, 200);

export const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export const short = (dir = "") => dir.split(/[\\/]/).filter(Boolean).pop() || "~";
