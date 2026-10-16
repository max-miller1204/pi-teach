import { expect, it } from "vitest";
import { scoredAnswers } from "../src/teacher-grading.ts";
import { validateGrade } from "../assets/runtime/grade.mjs";

const answers = () => ({
  submission_id: "weighted",
  feedback_markdown: "Review the averaging step.",
  questions: [
    [4, 4],
    [2, 4],
    [2, 2],
    [2, 2],
    [2, 2],
    [2, 2],
  ].map(([earned, possible], i) => ({
    question_id: `q${i}`,
    correct: earned === possible,
    points_earned: earned,
    points_possible: possible,
    feedback: "Feedback.",
  })),
});

it("calculates the weighted total without changing the model's point allocations", () => {
  const args = answers();
  const before = structuredClone(args);
  expect(scoredAnswers(args)).toEqual({ ...before, score: 87.5 });
  expect(args).toEqual(before);
});

it.each([92, 87.5, undefined])("rejects a supplied score instead of replacing it: %s", (score) => {
  const supplied = { ...answers(), score };
  expect(() => scoredAnswers(supplied)).toThrow("must omit score");
});

it("keeps correctness and point bounds mandatory", () => {
  const args = answers();
  args.questions[1].correct = true;
  expect(() => scoredAnswers(args)).toThrow("correct must mean full credit");
  args.questions[1].correct = false;
  args.questions[1].points_earned = 5;
  expect(() => scoredAnswers(args)).toThrow("Invalid points");
});

it("keeps the public validator's rejection of the old inconsistent score", () => {
  const questions = answers().questions.map((q) => ({
    questionId: q.question_id,
    correct: q.correct,
    pointsEarned: q.points_earned,
    pointsPossible: q.points_possible,
  }));
  expect(() =>
    validateGrade(
      92,
      questions,
      questions.map((q) => q.questionId),
    ),
  ).toThrow("Score must match question points: 87.50%");
});
