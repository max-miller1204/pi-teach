/**
 * The glossary: GLOSSARY.md parsing on the server, and the term matcher the lesson
 * page runs (glossary.mjs, the same file the browser loads).
 */

import { describe, expect, it } from "vitest";

import { findTerms, firstUses } from "../assets/runtime/glossary.mjs";
import { avoidedUses, htmlText, parseGlossary, termForms } from "../src/glossary.ts";

const GLOSSARY = `# Training Glossary

Words for the strength programme.

## Terms

**Hypertrophy**:
Muscle growth driven by mechanical tension
and metabolic stress.
_Avoid_: Bulking, getting big

**RPE (Rate of Perceived Exertion)**:
A 1–10 self-rating of how hard a set felt.

**Progressive overload**: Raising the demand on a muscle over time.
_Avoid_: Pushing harder
`;

describe("parseGlossary", () => {
  it("reads every entry: term, definition, and aliases to avoid", () => {
    const { terms, errors } = parseGlossary(GLOSSARY);
    expect(errors).toEqual([]);
    expect(terms.map((t) => t.term)).toEqual([
      "Hypertrophy",
      "RPE (Rate of Perceived Exertion)",
      "Progressive overload",
    ]);
    expect(terms[0]).toMatchObject({
      definition: "Muscle growth driven by mechanical tension and metabolic stress.",
      avoid: ["Bulking", "getting big"],
    });
    expect(terms[0].definitionHtml).toContain("<p>Muscle growth");
    expect(terms[2].definition).toBe("Raising the demand on a muscle over time.");
  });

  it("matches an abbreviation and its expansion separately", () => {
    expect(termForms("RPE (Rate of Perceived Exertion)")).toEqual([
      "RPE (Rate of Perceived Exertion)",
      "RPE",
      "Rate of Perceived Exertion",
    ]);
  });

  it("reports entries that break the format instead of skipping them", () => {
    const { terms, errors } = parseGlossary("**Empty**:\n\n**Twice**:\nOne.\n\n**twice**:\nTwo.\n");
    expect(terms.map((t) => t.term)).toEqual(["Twice"]);
    expect(errors).toEqual([
      'Line 1: "Empty" has no definition.',
      'Line 6: "twice" is defined twice.',
    ]);
  });
});

describe("parseGlossary malformed entries", () => {
  it("reports a bold term with no colon instead of dropping it", () => {
    expect(parseGlossary("**Fork**\nCreates a child process.\n")).toEqual({
      terms: [],
      errors: [
        'Line 1: "**Fork**" is not a term entry. Write "**Fork**:" with the colon after the closing **, then the definition.',
      ],
    });
  });

  it("reports a colon inside the bold and other bold lines", () => {
    const { terms, errors } = parseGlossary(
      "**Fork:** Creates a child process.\n\n**Exec** - replaces the program image.\n",
    );
    expect(terms).toEqual([]);
    expect(errors).toEqual([
      'Line 1: "**Fork:** Creates a child process." is not a term entry. Write "**Fork**:" with the colon after the closing **, then the definition.',
      'Line 3: "**Exec** - replaces the program image." is not a term entry. Write "**Exec**:" with the colon after the closing **, then the definition.',
    ]);
  });

  it("reports a bold line that would join the definition above", () => {
    const { terms, errors } = parseGlossary(
      "**Fork**:\nCreates a child.\n**Exec**\nReplaces it.\n",
    );
    expect(terms.map((t) => t.definition)).toEqual(["Creates a child."]);
    expect(errors[0]).toContain('Line 3: "**Exec**" is not a term entry.');
  });

  it("reports text and avoid lines that belong to no entry", () => {
    const { terms, errors } = parseGlossary(
      "_Avoid_: Spawn\n\n**Fork**:\nCreates a child.\n\nReturns twice.\n",
    );
    expect(terms.map((t) => t.term)).toEqual(["Fork"]);
    expect(errors).toEqual([
      "Line 1: an _Avoid_ line has no term entry above it. Put it directly under a definition.",
      'Line 6: "Returns twice." is outside every term entry. Join it to the definition above without a blank line, or put it under a heading.',
    ]);
  });

  it("allows a preamble, headings, and a description under a heading", () => {
    const { terms, errors } = parseGlossary(
      "# Processes\n\nWords for this course.\n\n## Creation\n\nHow processes start.\n\n**Fork**:\nCreates a child.\n\n## Replacement\n\nHow a program changes.\n\n**Exec**:\nReplaces the program image.\n",
    );
    expect(errors).toEqual([]);
    expect(terms.map((t) => t.term)).toEqual(["Fork", "Exec"]);
  });
});

describe("findTerms", () => {
  const terms = [
    { forms: ["closure"] },
    { forms: ["borrow checker"] },
    { forms: ["borrow"] },
    { forms: ["class"] },
  ];

  it("ignores case, accepts plurals, and needs word boundaries", () => {
    const text = "Closures capture. Classes are not enclosures.";
    const found = findTerms(text, terms).map((m) => text.slice(m.start, m.end));
    expect(found).toEqual(["Closures", "Classes"]);
  });

  it("prefers the longest form, and matches across line breaks", () => {
    const text = "The borrow\n checker rejects a second borrow.";
    const matches = findTerms(text, terms);
    expect(matches.map((m) => [text.slice(m.start, m.end), m.index])).toEqual([
      ["borrow\n checker", 1],
      ["borrow", 2],
    ]);
  });

  it("keeps the first use of each term", () => {
    const text = "closure, closure, borrow, closure";
    expect(firstUses(findTerms(text, terms)).map((m) => m.index)).toEqual([0, 2]);
  });
});

describe("avoidedUses", () => {
  it("finds the words the glossary says to avoid", () => {
    const text = htmlText(
      "<p>Bulking is <b>not</b> the goal.</p><p>Stop bulking. Keep pushing harder &amp; rest.</p><script>bulking</script>",
    );
    expect(text).toBe("Bulking is not the goal. Stop bulking. Keep pushing harder & rest.");
    expect(avoidedUses(text, parseGlossary(GLOSSARY))).toEqual([
      { term: "Hypertrophy", avoided: "Bulking", count: 2 },
      { term: "Progressive overload", avoided: "Pushing harder", count: 1 },
    ]);
  });
});
