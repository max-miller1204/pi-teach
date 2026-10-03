/**
 * glossary.mjs: find glossary terms in plain text.
 *
 * DOM-free, like anchor.mjs. The page uses it to mark terms in a lesson, and the
 * server uses it to find words the glossary says to avoid. The tests import this file,
 * so they exercise the code the browser runs.
 */

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find every use of the given terms in `text`.
 *
 * `terms[i].forms` lists the surface forms of term `i`. Matching ignores case, needs a
 * word boundary on each side, and accepts a plural `s` or `es`. When two forms overlap,
 * the longer one wins. Returns matches in text order: `{ start, end, index }`, where
 * `index` is the term's position in `terms`.
 */
export function findTerms(text, terms) {
  const owner = new Map();
  for (const [index, term] of terms.entries()) {
    for (const form of term.forms) {
      const key = form.trim().toLowerCase().replace(/\s+/g, " ");
      if (key && !owner.has(key)) owner.set(key, index);
    }
  }
  if (owner.size === 0) return [];

  const alternatives = [...owner.keys()]
    .sort((a, b) => b.length - a.length)
    .map((form) => escapeRegExp(form).replace(/\s+/g, "\\s+"));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${alternatives.join("|")})(?:e?s)?(?![\\p{L}\\p{N}_])`,
    "giu",
  );

  const matches = [];
  for (const match of text.matchAll(pattern)) {
    const base = match[1].toLowerCase().replace(/\s+/g, " ");
    const index = owner.get(base);
    if (index === undefined) continue;
    matches.push({ start: match.index, end: match.index + match[0].length, index });
  }
  return matches;
}

/** Keep only the first match of each term. */
export function firstUses(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    if (seen.has(match.index)) return false;
    seen.add(match.index);
    return true;
  });
}
