// The confirm dialog and the context menu.
import { $, el } from "./dom.js";

/** Asks before something can't be undone. Resolves true on the red button. */
export function confirmDialog([title, text, action]) {
  const d = $("#confirm");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = action;
  d.returnValue = "";
  d.showModal();
  $("#confirm-ok").focus();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

/** A context menu at (x, y). Entries: { label, run, danger, confirm } or "-" for a divider. */
export function menu(x, y, entries) {
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
