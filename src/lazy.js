// Long lists (a lesson's canvas, its chat) render their newest items first and older ones only when scrolled
// up to, so opening a long lesson costs O(batch) instead of O(history), and unread parts never reach the DOM.
import { el } from "./dom.js";

/** Renders `items` into `box` newest-last, `batch` at a time from the end. `render(item, frag)` appends an item's
 *  nodes to `frag`; `placed(frag nodes)` runs once they are in the page. `older()`, when given, fetches the items
 *  before these (resolving to [] when there are none), so a history can arrive a page at a time. Returns a stop. */
export function newestFirst({ box, scroller, items, render, placed = () => {}, batch = 30, older = null }) {
  let end = items.length; // items[0..end) are not rendered yet
  let stopped = false;
  const chunk = () => {
    const frag = document.createDocumentFragment();
    const from = Math.max(0, end - batch);
    for (let i = from; i < end; i++) render(items[i], frag);
    end = from;
    return [frag, [...frag.children]];
  };
  const [first, nodes] = chunk();
  box.prepend(first);
  placed(nodes);
  if (!end && !older) return () => {};
  // Near the top (within MARGIN px) the next batch renders. A plain scroll check, not an IntersectionObserver: an
  // observer only reports changes, so a missed one (or a marker still in range after a short batch) stalled loading
  // for good. Each scroll event costs one comparison.
  const MARGIN = 800;
  let busy = false;
  const more = el("div", "more");
  box.prepend(more);
  const stop = () => {
    stopped = true;
    scroller.removeEventListener("scroll", load);
    more.remove();
  };
  async function load() {
    if (busy || stopped || scroller.scrollTop > MARGIN) return;
    busy = true;
    try {
      if (!end) {
        const page = older ? await older() : [];
        if (stopped) return;
        if (!page.length) return stop();
        items = page;
        end = page.length;
      }
      const before = scroller.scrollHeight;
      const atEnd = before - scroller.scrollTop - scroller.clientHeight < 4;
      const [frag, added] = chunk();
      more.after(frag);
      // what's on screen stays where it was; a scroller at its end stays at its end (older pages can arrive while
      // something new is appended below)
      if (atEnd) scroller.scrollTop = scroller.scrollHeight;
      else scroller.scrollTop += scroller.scrollHeight - before;
      placed(added);
      if (!end && !older) return stop();
    } finally {
      busy = false;
    }
    load(); // still near the top (a short batch, a tall window): keep going
  }
  scroller.addEventListener("scroll", load, { passive: true });
  requestAnimationFrame(() => load()); // once the view has settled where it opens
  return stop;
}
