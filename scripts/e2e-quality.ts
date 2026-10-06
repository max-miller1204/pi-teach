/** Check that semantic evaluation detects bad content despite valid mappings. */
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFixture } from "../test/helpers.ts";
import { parseTeachingPlan } from "../src/teaching-plan.ts";
import { evaluateContent } from "./authoring-evaluator.ts";
import { parseHarness } from "./harness.ts";
const backend = parseHarness(
  process.argv[2],
  "Usage: node scripts/e2e-quality.ts <claude|codex> [artifacts]",
);
const artifacts = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const fixture = makeFixture();
const objective = "Calculate mean squared error and explain how large errors affect it.";
const plan = JSON.stringify({
  version: 1,
  objectives: { cost: { statement: objective, application: true } },
  quizzes: {
    pre: {
      purpose: "prequestion",
      questions: {
        p1: {
          objective: "cost",
          task: "prediction",
          support: "independent",
          teaching: "cost-teaching",
        },
      },
    },
    check: {
      purpose: "assessment",
      questions: { q1: { objective: "cost", task: "transfer", support: "independent" } },
    },
  },
});
const html = `<h1>Mean squared error</h1><form class="cl-quiz" data-quiz-id="pre" data-kind="pretest"><li class="cl-q" data-question-id="p1" data-type="short"><p class="cl-q-prompt">What is an operating system process?</p><textarea></textarea></li></form>
<template data-cl-after-pretest="pre"><section id="cost-teaching"><p>Mean squared error is the sum of squared residuals divided by their count. With residuals 2 and -1, the mean is (4+1)/2=2.5.</p></section>
<form class="cl-quiz" data-quiz-id="check"><li class="cl-q" data-question-id="q1" data-type="term"><p class="cl-q-prompt">Copy the result from the example: with residuals 2 and -1, the mean squared error is ____.</p><input type="text"></li></form><!-- Expected answer: 2.5 --></template>`;
const rubric = JSON.stringify({
  pre: {
    p1: {
      expected: "A running program",
      points: 1,
      full: "A running program",
      partial: "0 otherwise",
    },
  },
  check: {
    q1: { expected: "2.5", points: 1, full: "Must exactly say 2.5", partial: "0 otherwise" },
  },
});
try {
  parseTeachingPlan(plan, html);
  const review = await evaluateContent(backend, fixture.root, {
    objective,
    mode: "lesson",
    html,
    rubric,
    plan,
  });
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, `${backend}-quality-report.json`),
      JSON.stringify(review, null, 2),
    );
  for (const criterion of ["prequestion", "alignment", "retrievalTransfer", "answerCues"])
    if (review.judgments.find((j) => j.criterion === criterion)?.verdict !== "fail")
      throw new Error(
        `Semantic evaluator missed bad content for ${criterion}. Mappings passed but content should fail.`,
      );
  console.log(
    JSON.stringify(
      {
        backend,
        structurallyValid: true,
        requiredFailuresDetected: true,
        judgments: review.judgments,
        humanLearningEvidence: false,
      },
      null,
      2,
    ),
  );
} finally {
  fixture.cleanup();
}
