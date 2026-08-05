/**
 * anchor.mjs — text-quote anchoring for highlight-and-ask.
 *
 * A highlight has to survive a page reload, and ideally survive the teacher editing
 * the lesson around it. Storing DOM offsets does neither. Instead we store a W3C-style
 * text-quote selector — the exact text plus a little context either side — and re-find
 * it in the document's plain text on load.
 *
 * Plain `.mjs` with a hand-written `.d.mts` sidecar: it is loaded directly by the
 * browser (no build step in this repo) *and* imported by the vitest suite.
 */

/** Characters of context captured on each side of the selection. */
export const CONTEXT_LENGTH = 48;

/**
 * Build a selector for `text.slice(start, end)`.
 *
 * `occurrence` is the index of this exact string among all its occurrences in the
 * document, and is what disambiguates a phrase that appears several times when the
 * surrounding context has also changed.
 *
 * @param {string} text Full plain text of the content root.
 * @param {number} start
 * @param {number} end
 * @returns {import("./anchor.d.mts").TextQuoteSelector}
 */
export function createSelector(text, start, end) {
  const exact = text.slice(start, end);
  return {
    exact,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_LENGTH)),
    occurrence: countOccurrences(text.slice(0, start), exact),
  };
}

/** How many times `needle` appears in `haystack` (non-overlapping). */
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** All non-overlapping start offsets of `needle` in `haystack`. */
function allIndexesOf(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return out;
}

/**
 * Score a candidate by how much of its stored context still matches.
 *
 * Suffix and prefix are weighted equally; a candidate whose neighbourhood is intact
 * beats one that merely repeats the phrase elsewhere in the document.
 */
function contextScore(text, candidateStart, selector) {
  const exactEnd = candidateStart + selector.exact.length;
  const beforeActual = text.slice(
    Math.max(0, candidateStart - selector.prefix.length),
    candidateStart,
  );
  const afterActual = text.slice(exactEnd, exactEnd + selector.suffix.length);
  return (
    commonSuffixLength(beforeActual, selector.prefix) +
    commonPrefixLength(afterActual, selector.suffix)
  );
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Locate a selector in `text`.
 *
 * Returns null when the quoted text is no longer present — the caller renders that
 * annotation as orphaned rather than dropping the learner's question on the floor.
 *
 * @param {string} text
 * @param {import("./anchor.d.mts").TextQuoteSelector} selector
 * @returns {{ start: number, end: number, exact: boolean } | null}
 */
export function findSelector(text, selector) {
  if (!selector || typeof selector.exact !== "string" || selector.exact.length === 0) return null;

  const candidates = allIndexesOf(text, selector.exact);
  if (candidates.length === 0) return null;

  const prefix = selector.prefix ?? "";
  const suffix = selector.suffix ?? "";
  const occurrence = Number.isInteger(selector.occurrence) ? selector.occurrence : 0;
  const contextLength = prefix.length + suffix.length;

  // No context to discriminate with: trust the recorded occurrence index.
  if (contextLength === 0) {
    const start = candidates[Math.min(occurrence, candidates.length - 1)];
    return { start, end: start + selector.exact.length, exact: false };
  }

  let best = candidates[0];
  let bestScore = -1;
  for (let i = 0; i < candidates.length; i++) {
    const score = contextScore(text, candidates[i], { ...selector, prefix, suffix });
    // Ties break toward the recorded occurrence index: same-context repeats (list
    // items, table cells) are common, and the original position is the best guess.
    if (score > bestScore || (score === bestScore && i === occurrence)) {
      best = candidates[i];
      bestScore = score;
    }
  }

  // `exact` means the whole stored neighbourhood is still intact — the caller uses it
  // to tell a confident re-anchor from a salvaged one.
  return {
    start: best,
    end: best + selector.exact.length,
    exact: bestScore >= contextLength,
  };
}

/**
 * Normalize a selection for storage: collapse runs of whitespace and trim.
 *
 * The DOM inserts whitespace that never appears in the source (indentation between
 * tags), so anchoring against raw text is unstable across reformatting.
 *
 * @param {string} value
 */
export function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}
