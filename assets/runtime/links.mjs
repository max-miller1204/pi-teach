/**
 * links.mjs — which links open in a new tab.
 *
 * Sources (citations, papers, videos) open in a new tab so the reader never loses
 * their place in a lesson. Navigation inside the classroom stays in the current tab.
 *
 * `opensInNewTab` is DOM-free so the test suite exercises the same rule the browser
 * runs; `initLinks` is the thin DOM wiring around it.
 */

/**
 * True for http(s) links to another site, and for PDFs wherever they are hosted.
 *
 * @param {string} href  the link's resolved URL
 * @param {string} origin  the page's own origin
 */
export function opensInNewTab(href, origin) {
  let url;
  try {
    url = new URL(href, origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== origin || url.pathname.toLowerCase().endsWith(".pdf");
}

/**
 * Open qualifying links in a new tab when clicked.
 *
 * Decided at click time rather than by rewriting every anchor up front, so links a
 * lesson adds later (answer cards, quiz feedback) behave the same. Links that set
 * their own `target`, or carry `download`, are left alone.
 */
export function initLinks() {
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || link.hasAttribute("download") || link.hasAttribute("target")) return;
    if (!opensInNewTab(link.href, window.location.origin)) return;
    link.target = "_blank";
    link.relList.add("noopener");
  });
}
