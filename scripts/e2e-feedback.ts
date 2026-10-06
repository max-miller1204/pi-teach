/** Evaluate rubric fidelity with alternate, partial, uncertain, assisted, and old answers. */
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFixture, seedClassroom } from "../test/helpers.ts";
import { dedicatedTeacherPrompt, gradePrompt } from "../src/prompts.ts";
import { classroomTools, PI_HOST, isFailure } from "../src/tools.ts";
import { runTeacher } from "../src/teacher.ts";
import * as store from "../src/store.ts";
import { parseHarness } from "./harness.ts";

const backend = parseHarness(
  process.argv[2],
  "Usage: node scripts/e2e-feedback.ts <claude|codex> [artifacts]",
);
const artifacts = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const fixture = makeFixture();
seedClassroom(fixture);
const questions = [
  {
    id: "alternate",
    prompt:
      "Two threads each read x, add one locally, then write x. Initially x=0. Give a legal schedule that ends at x=1. Thread names and independent read order may vary.",
    answer: "B reads 0; A reads 0; B writes 1; A writes 1.",
    expected: "Both reads happen before either write. Either thread can read or write first.",
    points: 4,
    earned: 4,
    partial:
      "2 points for a legal order of each thread; 2 for final value 1 with both reads before writes.",
  },
  {
    id: "partial",
    prompt:
      "Residuals are 2 and -1. Calculate mean squared error. Show the sum and the averaging step.",
    answer: "The squared errors sum to 5. Therefore the mean squared error is 5.",
    expected: "Sum 5; divide by 2; mean 2.5.",
    points: 4,
    earned: 2,
    partial: "2 points for sum 5; 2 points for dividing by 2 to get 2.5.",
  },
  {
    id: "uncertain",
    prompt: "Residuals are 2 and -1. Calculate mean squared error.",
    answer: "(4+1)/2=2.5.",
    expected: "2.5",
    points: 2,
    earned: 2,
    confidence: "unsure" as const,
    partial: "1 point for correct sum 5 without the mean; otherwise 0.",
  },
  {
    id: "sure",
    prompt: "Residuals are 2 and -1. Calculate mean squared error.",
    answer: "(4+1)/2=2.5.",
    expected: "2.5",
    points: 2,
    earned: 2,
    confidence: "sure" as const,
    partial: "1 point for correct sum 5 without the mean; otherwise 0.",
  },
  {
    id: "assisted",
    prompt: "Residuals are 2 and -1. Calculate mean squared error.",
    answer: "(4+1)/2=2.5.",
    expected: "2.5",
    points: 2,
    earned: 2,
    assistance: "hint" as const,
    partial: "1 point for correct sum 5 without the mean; otherwise 0.",
  },
  {
    id: "historical",
    prompt: "Residuals are 2 and -1. Calculate mean squared error.",
    answer: "(4+1)/2=2.5.",
    expected: "2.5",
    points: 2,
    earned: 2,
    partial: "1 point for correct sum 5 without the mean; otherwise 0.",
  },
];
const html = `<form class="cl-quiz" data-quiz-id="check">${questions.map((q) => `<li class="cl-q" data-question-id="${q.id}" data-type="short"><p class="cl-q-prompt">${q.prompt}</p><textarea></textarea></li>`).join("")}</form>`;
const rubric = {
  check: Object.fromEntries(
    questions.map((q) => [
      q.id,
      {
        expected: q.expected,
        points: q.points,
        full: `Award ${q.points} for an equivalent correct solution. ${q.expected}`,
        partial: q.partial,
      },
    ]),
  ),
};
fixture.write("rust/001-ownership/lesson.html", html);
fixture.write(
  "rust/001-ownership/lesson.json",
  JSON.stringify({ title: "Feedback evaluation", assessmentContract: 1 }),
);
fixture.write("rust/001-ownership/quiz/key.json", JSON.stringify(rubric));
try {
  const submission = store.createSubmission({
    classroom: "rust",
    lesson: "001-ownership",
    quizId: "check",
    quizTitle: "Feedback evaluation",
    kind: "check",
    answers: questions.map((q) => ({
      questionId: q.id,
      type: "short",
      prompt: q.prompt,
      value: q.answer,
      ...(q.confidence ? { confidence: q.confidence } : {}),
      ...(q.assistance ? { assistance: q.assistance } : {}),
    })),
  });
  const definitions = classroomTools(PI_HOST).filter((t) => t.name === "grade_lesson_quiz");
  const plan = await runTeacher(
    { backend },
    dedicatedTeacherPrompt(
      "feedback-evaluation",
      gradePrompt(submission, "service"),
      { lesson: html, privateRubric: rubric, submission },
      definitions,
    ),
    fixture.root,
    () => {},
  );
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, `${backend}-feedback-plan.json`),
      JSON.stringify(plan, null, 2),
    );
  if (plan.calls.length !== 1 || plan.calls[0].name !== "grade_lesson_quiz")
    throw new Error("Feedback evaluation needs one grade call.");
  const args = JSON.parse(plan.calls[0].arguments_json);
  for (const q of questions) {
    const verdict = args.questions.find((g: { question_id: string }) => g.question_id === q.id);
    if (!verdict || verdict.points_earned !== q.earned || verdict.points_possible !== q.points)
      throw new Error(
        `Rubric disagreement for ${q.id}: ${JSON.stringify(verdict)}. Expected ${q.earned}/${q.points}.`,
      );
    if (!verdict.feedback.trim()) throw new Error(`Missing feedback for ${q.id}.`);
  }
  const uncertainFeedback = args.questions.find(
    (g: { question_id: string }) => g.question_id === "uncertain",
  ).feedback;
  if (!/2\.5|mean|averag|squar|divid/i.test(uncertainFeedback))
    throw new Error("Uncertain correct answer needs explanatory reinforcement.");
  const result = await definitions[0].execute(args);
  if (isFailure(result)) throw new Error(result.content[0].text);
  if (store.reviewItems("rust").some((i) => i.progress === "retained-evidence"))
    throw new Error("Immediate or old answers cannot prove retained knowledge.");
  const report = {
    backend,
    kind: "agent-adherence",
    humanLearningEvidence: false,
    expectedScore: 87.5,
    actualScore: result.details.score,
    cases: questions.map((q) => ({ id: q.id, expected: `${q.earned}/${q.points}` })),
    uncertainFeedback,
  };
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, `${backend}-feedback-report.json`),
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
} finally {
  fixture.cleanup();
}
