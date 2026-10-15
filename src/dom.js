// The few DOM helpers everything uses, and per-window preferences in localStorage.
/** The lesson's title on the page and in the window title (the taskbar and window switcher show it). */
export function setTitle(title) {
  document.querySelector("#title").textContent = title;
  document.title = title ? `${title} · rTutor` : "rTutor";
}

export const $ = (s) => document.querySelector(s);
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
export const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* UI prefs only */ } },
};
