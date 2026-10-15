// Long lists (a lesson's canvas, its chat) render their newest items first and older ones only when scrolled
// up to, so opening a long lesson costs O(batch) instead of O(history), and unread parts never reach the DOM.
import { el } from "./dom.js";

/** Renders `items` into `box` newest-last, `batch` at a time from the end. `render(item, frag)` appends an item's
 *  nodes to `frag`; `placed(frag nodes)` runs once they are in the page. `older()`, when given, fetches the items
 *  before these (resolving to [] when there are none), so a history can arrive a page at a time. Returns a stop. */
export function newestFirst({ box, scroller, items, render, placed = () => {}, batch = 30, older = null }) {
  let end = items.length; // items[0..end) are not rendered yet
  let more = null;
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
  const io = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting || stopped) return;
    if (!end && older) {
      io.unobserve(more); // one fetch at a time
      const page = await older();
      if (stopped) return;
      if (!page.length) return stop();
      items = page;
      end = page.length;
      io.observe(more);
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
    if (!end && !older) stop();
  }, { root: scroller, rootMargin: "800px 0px 0px 0px" });
  const stop = () => {
    stopped = true;
    io.disconnect();
    more?.remove();
  };
  if (!end && !older) return stop;
  more = el("div", "more");
  box.prepend(more);
  io.observe(more);
  return stop;
}
