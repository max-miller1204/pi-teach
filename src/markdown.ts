/**
 * markdown.ts — markdown → HTML, plus the HTML escaping used by the page builders.
 *
 * Answers and grade feedback are rendered here, at write time, and the HTML is
 * stored alongside the markdown. That keeps the browser runtime dependency-free.
 *
 * Math is rendered here too, as MathML, with the Temml build the browser uses for
 * lesson math. Inline math is $...$ or \(...\). Display math is $$...$$ or \[...\].
 */

import { Marked } from "marked";
import type { TokenizerAndRendererExtension, Tokens } from "marked";
import temml from "../assets/runtime/vendor/temml/temml.mjs";

/** Inline formulas, tried in order. `$` needs no space inside it and no digit after it. */
const INLINE_MATH: { pattern: RegExp; display: boolean }[] = [
  { pattern: /^\$\$([\s\S]+?)\$\$/, display: true },
  { pattern: /^\\\[([\s\S]+?)\\\]/, display: true },
  { pattern: /^\\\(([\s\S]+?)\\\)/, display: false },
  { pattern: /^\$(?![\s$])((?:\\[\s\S]|[^\\$])+?)(?<!\s)\$(?!\d)/, display: false },
];

/** A display formula that is a block of its own: its delimiters start and end lines. */
const BLOCK_MATH = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/;

interface MathToken extends Tokens.Generic {
  tex: string;
  display: boolean;
}

const blockMath: TokenizerAndRendererExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
  tokenizer(src) {
    const match = BLOCK_MATH.exec(src);
    if (!match) return undefined;
    return { type: "blockMath", raw: match[0], tex: match[1] ?? match[2], display: true };
  },
  renderer: (token) => renderTex(token as MathToken),
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "inlineMath",
  level: "inline",
  start(src) {
    const index = src.search(/\$|\\[([]/);
    return index === -1 ? undefined : index;
  },
  tokenizer(src) {
    for (const { pattern, display } of INLINE_MATH) {
      const match = pattern.exec(src);
      if (match) return { type: "inlineMath", raw: match[0], tex: match[1], display };
    }
    return undefined;
  },
  renderer: (token) => renderTex(token as MathToken),
};

const markdown = new Marked({ gfm: true, breaks: false, extensions: [blockMath, inlineMath] });

/**
 * One formula as MathML. TeX that does not parse shows its error and its source in
 * place, so the reader sees that the formula is broken.
 */
function renderTex({ tex, display }: MathToken): string {
  const className = display ? "cl-math cl-math-display" : "cl-math";
  try {
    const mathml = temml.renderToString(tex, { displayMode: display, throwOnError: true });
    return `<span class="${className}">${mathml}</span>`;
  } catch (error) {
    if (!(error instanceof temml.ParseError) || !(error instanceof Error)) throw error;
    return (
      `<span class="${className}"><span class="cl-contract-error" role="note">` +
      `<span class="cl-contract-error-title">Math did not render</span>` +
      `<span>${escapeHtml(error.message.trim())}</span>` +
      `<code>${escapeHtml(tex)}</code></span></span>`
    );
  }
}

/** Render markdown to HTML. Synchronous — `marked` async mode is not used. */
export function renderMarkdown(md: string): string {
  return markdown.parse(md, { async: false }) as string;
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
