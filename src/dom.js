// The few DOM helpers everything uses, and per-window preferences in localStorage.
/** The lesson's title on the page and in the window title (the taskbar and window switcher show it). */
export function setTitle(title) {
  document.querySelector("#title").textContent = title;
  document.title = title ? `${title} · rTutor` : "rTutor";
}

export const $ = (s) => document.querySelector(s);

/** A short notice at the bottom of the window (progress, or what went wrong), instead of a blocking alert.
 *  `ms` 0 keeps it up until the next notice; `toast("")` clears it. */
let toastTimer;
export function toast(text, ms = 5000) {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.setAttribute("role", "status");
    document.body.append(t);
  }
  t.textContent = String(text).replace(/^Error:\s*/, "");
  t.hidden = !text;
  clearTimeout(toastTimer);
  if (text && ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}
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
