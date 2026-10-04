/**
 * The authoring templates: the model copies them, so they are documentation and API
 * at once. These checks keep the shells minimal and the contract examples valid.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { QUESTION_TYPES } from "../assets/runtime/quiz.mjs";
import { templatesDir } from "../src/paths.ts";
import { authoredQuestions } from "../src/quiz-authoring.ts";

const read = (name: string) => fs.readFileSync(path.join(templatesDir(), name), "utf8");

describe("lesson and review shells", () => {
  it.each(["lesson.html", "review.html"])(
    "%s keeps the runtime parts and leaves one unfinished question",
    (name) => {
      const html = read(name);
      expect(html).toContain('<main class="cl-lesson-shell" data-cl-content>');
      expect(html).toContain("Read the current quiz contract: assets/templates/quiz.html");
      expect(authoredQuestions(html)).toEqual([
        { id: name === "lesson.html" ? "q1" : "r1", type: "CHOOSE-A-TYPE" },
      ]);
      for (const type of QUESTION_TYPES) expect(html).toMatch(new RegExp(`^ +${type} +\\S`, "m"));
    },
  );

  it("marks every content block in the lesson shell as optional", () => {
    const html = read("lesson.html");
    const sections = html.match(/<section>/g) ?? [];
    const optional = html.match(/Optional example:/g) ?? [];
    expect(sections.length).toBeGreaterThan(0);
    expect(optional.length).toBe(sections.length);
    expect(html).not.toContain('<form class="cl-reflect"');
  });
});

describe("quiz contract", () => {
  const html = read("quiz.html");

  it("shows a complete example of every type", () => {
    const types = authoredQuestions(html).map((q) => q.type);
    for (const type of QUESTION_TYPES) expect(types).toContain(type);
  });

  it("gives every choice and multi option a unique value", () => {
    for (const question of html.split('<li class="cl-q"').slice(1)) {
      const values = [...question.matchAll(/<input type="(?:radio|checkbox)"([^>]*)>/g)].map(
        (input) => /value="([^"]+)"/.exec(input[1])?.[1],
      );
      expect(values).not.toContain(undefined);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
