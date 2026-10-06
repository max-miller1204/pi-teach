import { expect, it } from "vitest";
import { parseTeachingPlan } from "../src/teaching-plan.ts";

const html = `<form class="cl-quiz" data-quiz-id="pre" data-kind="pretest">
<li class="cl-q" data-question-id="p" data-type="short"></li></form>
<template data-cl-after-pretest="pre"><section id="teach-cost">Explain cost.</section>
<form class="cl-quiz" data-quiz-id="check"><li class="cl-q" data-question-id="q" data-type="numeric"></li></form></template>`;
const plan = () => ({
  version: 1,
  objectives: { cost: { statement: "Calculate cost", application: true } },
  quizzes: {
    pre: {
      purpose: "prequestion",
      questions: {
        p: {
          objective: "cost",
          task: "prediction",
          support: "independent",
          teaching: "teach-cost",
        },
      },
    },
    check: {
      purpose: "assessment",
      questions: {
        q: { objective: "cost", task: "transfer", support: "independent" },
      },
    },
  },
});
it("maps upcoming prequestions to objectives, gated teaching, and assessment", () => {
  expect(parseTeachingPlan(JSON.stringify(plan()), html)).toEqual(plan());
});
it("rejects prerequisite retrieval as a substitute for upcoming prequestions", () => {
  const p = plan();
  p.quizzes.pre.purpose = "prerequisite";
  expect(() => parseTeachingPlan(JSON.stringify(p), html)).toThrow("upcoming lesson");
});
it.each(["missing", "visible", "duplicate", "other-gate"])(
  "rejects %s teaching targets",
  (kind) => {
    const source =
      kind === "missing"
        ? html.replace('id="teach-cost"', 'id="other"')
        : kind === "visible"
          ? '<p id="teach-cost">leak</p>' + html
          : kind === "duplicate"
            ? html.replace("Explain cost.", '<p id="teach-cost">Duplicate</p>')
            : html.replace('id="teach-cost"', 'id="other"') +
              '<form class="cl-quiz" data-quiz-id="pre2" data-kind="pretest"></form><template data-cl-after-pretest="pre2"><p id="teach-cost">Other</p></template>';
    expect(() => parseTeachingPlan(JSON.stringify(plan()), source)).toThrow("inside its gate");
  },
);
it("rejects missing objective coverage without claiming semantic quality", () => {
  const p = plan();
  p.quizzes.check.purpose = "prior-retrieval";
  expect(() => parseTeachingPlan(JSON.stringify(p), html)).toThrow("post-teaching assessment");
});
it("rejects unsupported plan versions and unknown question mappings", () => {
  expect(() => parseTeachingPlan(JSON.stringify({ ...plan(), version: 2 }), html)).toThrow(
    "version 1",
  );
  const p = plan();
  Object.assign(p.quizzes.check.questions, { extra: p.quizzes.check.questions.q });
  expect(() => parseTeachingPlan(JSON.stringify(p), html)).toThrow("unknown question");
});
