// Long lists (a lesson's canvas, its chat) render their newest items first and older ones only when scrolled
// up to, so opening a long lesson costs O(batch) instead of O(history), and unread parts never reach the DOM.
import { el } from "./dom.js";

/** Renders `items` into `box` newest-last, `batch` at a time from the end. `render(item, frag)` appends an item's
 *  nodes to `frag`; `placed(frag nodes)` runs once they are in the page. Returns a function that stops it. */
export function newestFirst({ box, scroller, items, render, placed = () => {}, batch = 30 }) {
  let end = items.length; // items[0..end) are not rendered yet
  const chunk = () => {
    const frag = document.createDocumentFragment();
    const from = Math.max(0, end - batch);
    for (let i = from; i < end; i++) render(items[i], frag);
    end = from;
    const nodes = [...frag.children];
    return [frag, nodes];
  };
  const [first, nodes] = chunk();
  box.prepend(first);
  placed(nodes);
  if (!end) return () => {};
  const more = el("div", "more");
  box.prepend(more);
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    const before = scroller.scrollHeight;
    const [frag, added] = chunk();
    more.after(frag);
    scroller.scrollTop += scroller.scrollHeight - before; // what's on screen stays where it was
    placed(added);
    if (!end) stop();
  }, { root: scroller, rootMargin: "800px 0px 0px 0px" });
  io.observe(more);
  const stop = () => {
    io.disconnect();
    more.remove();
  };
  return stop;
}
