/**
 * markdown.ts — markdown → HTML, plus the HTML escaping used by the page builders.
 *
 * Answers and grade feedback are rendered here, at write time, and the HTML is
 * stored alongside the markdown. That keeps the browser runtime dependency-free.
 */

import { marked } from "marked";

/** Render markdown to HTML. Synchronous — `marked` async mode is not used. */
export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

/** Escape text for interpolation into an HTML text node or double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for embedding inside a <script> block.
 *
 * Reason: a `</script>` sequence anywhere in the JSON (a lesson title, a learner's
 * question) would close the tag early. Escaping `<` handles that and `-->` in one go.
 */
export function toScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
