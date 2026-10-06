import { expect, it } from "vitest";
import { parseRubric } from "../src/rubric.ts";
const html =
  '<form class="cl-quiz" data-quiz-id="check"><ol><li class="cl-q" data-question-id="q1" data-type="short"></li></ol></form>';
const valid = {
  check: {
    q1: {
      expected: "A reason",
      points: 2,
      full: "One point per causal step.",
      partial: "One point for the first step.",
    },
  },
};
it("validates each authored question against its private criteria", () => {
  expect(parseRubric(JSON.stringify(valid), html)).toEqual(valid);
});
it.each([
  "{",
  "{}",
  '{"check":{}}',
  JSON.stringify({ check: { q1: { ...valid.check.q1, points: 0 } } }),
  JSON.stringify({ check: { q1: { ...valid.check.q1, full: "" } } }),
])("rejects an incomplete rubric: %s", (text) => {
  expect(() => parseRubric(text, html)).toThrow();
});
