/**
 * glossary.ts: read GLOSSARY.md into terms the lesson page can show.
 *
 * The format is fixed by docs/GLOSSARY-FORMAT.md: a `**Term**:` line, the definition
 * on the lines after it, and an optional `_Avoid_:` line of aliases. An entry that
 * breaks the format is reported as an error, never skipped in silence, so the teacher
 * can fix it.
 */

import { findTerms } from "../assets/runtime/glossary.mjs";
import { renderMarkdown } from "./markdown.ts";

export interface GlossaryTerm {
  /** The term as written, for example `RPE (Rate of Perceived Exertion)`. */
  term: string;
  /** Every form the page looks for: the term, and each side of a parenthesis. */
  forms: string[];
  definition: string;
  definitionHtml: string;
  /** Words the glossary says not to use for this term. */
  avoid: string[];
}

export interface Glossary {
  terms: GlossaryTerm[];
  errors: string[];
}

const TERM_RE = /^\*\*(.+?)\*\*:\s*(.*)$/;
const AVOID_RE = /^_Avoid_:\s*(.*)$/i;

/** `RPE (Rate of Perceived Exertion)` → the whole term, `RPE`, and the expansion. */
export function termForms(term: string): string[] {
  const forms = [term];
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(term);
  if (m) forms.push(m[1].trim(), m[2].trim());
  return [...new Set(forms.filter(Boolean))];
}

/** A line that starts with bold text but is not `**Term**:`. */
const BOLD_RE = /^\*\*([^*]+?):?\*\*/;

export function parseGlossary(markdown: string): Glossary {
  const terms: GlossaryTerm[] = [];
  const errors: string[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  let current: { term: string; definition: string[]; avoid: string[]; line: number } | null = null;
  // Reason: prose is allowed before the first entry and under a heading. Prose after a
  // closed entry is a definition split by a blank line, so it is reported.
  let afterEntry = false;
  // The lines under a malformed term line belong to it. Its error already covers them.
  let malformed = false;

  const finish = () => {
    if (!current) return;
    const definition = current.definition.join(" ").replace(/\s+/g, " ").trim();
    if (!definition) {
      errors.push(`Line ${current.line}: "${current.term}" has no definition.`);
    } else if (terms.some((t) => t.term.toLowerCase() === current!.term.toLowerCase())) {
      errors.push(`Line ${current.line}: "${current.term}" is defined twice.`);
    } else {
      terms.push({
        term: current.term,
        forms: termForms(current.term),
        definition,
        definitionHtml: renderMarkdown(definition),
        avoid: current.avoid,
      });
    }
    current = null;
    afterEntry = true;
  };

  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    const termMatch = TERM_RE.exec(line);
    if (termMatch) {
      finish();
      malformed = false;
      current = { term: termMatch[1].trim(), definition: [], avoid: [], line: i + 1 };
      if (termMatch[2].trim()) current.definition.push(termMatch[2].trim());
      continue;
    }
    const bold = BOLD_RE.exec(line);
    if (bold) {
      finish();
      malformed = true;
      const term = bold[1].trim();
      errors.push(
        `Line ${i + 1}: "${clip(line)}" is not a term entry. Write "**${term}**:" with the colon after the closing **, then the definition.`,
      );
      continue;
    }

    if (malformed) {
      if (!line || line.startsWith("#")) malformed = false;
      else continue;
    }

    const avoidMatch = AVOID_RE.exec(line);
    if (avoidMatch) {
      if (!current) {
        errors.push(
          `Line ${i + 1}: an _Avoid_ line has no term entry above it. Put it directly under a definition.`,
        );
        continue;
      }
      current.avoid = avoidMatch[1]
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      continue;
    }
    // A heading or a blank line after the definition closes the entry.
    if (line.startsWith("#")) {
      finish();
      afterEntry = false;
      continue;
    }
    if (!line) {
      if (current && current.definition.length > 0) finish();
      continue;
    }
    if (!current) {
      if (afterEntry) {
        errors.push(
          `Line ${i + 1}: "${clip(line)}" is outside every term entry. Join it to the definition above without a blank line, or put it under a heading.`,
        );
      }
      continue;
    }
    current.definition.push(line);
  }
  finish();

  return { terms, errors };
}

function clip(line: string): string {
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** A word the glossary says to avoid, found in a lesson. */
export interface AvoidedUse {
  term: string;
  avoided: string;
  count: number;
}

/**
 * Find the aliases a glossary says to avoid in a lesson's plain text.
 *
 * An alias that is also a form of some term is not reported: the glossary uses it on
 * purpose.
 */
export function avoidedUses(text: string, glossary: Glossary): AvoidedUse[] {
  const own = new Set(glossary.terms.flatMap((t) => t.forms.map((f) => f.toLowerCase())));
  const aliases: Array<{ term: string; avoided: string; forms: string[] }> = [];
  for (const term of glossary.terms) {
    for (const alias of term.avoid) {
      if (!own.has(alias.toLowerCase())) {
        aliases.push({ term: term.term, avoided: alias, forms: [alias] });
      }
    }
  }

  const counts = new Map<number, number>();
  for (const match of findTerms(text, aliases)) {
    counts.set(match.index, (counts.get(match.index) ?? 0) + 1);
  }
  return [...counts.entries()].map(([index, count]) => ({
    term: aliases[index].term,
    avoided: aliases[index].avoided,
    count,
  }));
}

/** Plain text of an HTML document: no tags, no scripts or styles, entities decoded. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
