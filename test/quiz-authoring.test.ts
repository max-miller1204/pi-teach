import { expect, it } from "vitest";
import {
  authoredQuestions,
  authoredQuizzes,
  authoredQuestionTypes,
  quizDiversityLines,
  typeCounts,
  unfinishedQuestionLines,
} from "../src/quiz-authoring.ts";
it.each(['"', "'"])(
  "reads quoted comparison characters and review identity with %s quotes",
  (quote) => {
    const html = `<form data-title=${quote}Predict x > 0${quote} class=${quote}cl-quiz${quote} data-quiz-id=${quote}review${quote} data-kind=${quote}review${quote}><li title=${quote}x < 1${quote} class=${quote}cl-q${quote} data-question-id=${quote}q1${quote} data-type=${quote}short${quote} data-review-of=${quote}001-original/check/q1${quote}></li></form>`;
    expect(authoredQuizzes(html)).toEqual([
      {
        id: "review",
        kind: "review",
        questions: [{ id: "q1", type: "short", reviewOf: "001-original/check/q1" }],
      },
    ]);
  },
);
it("reads authored types without counting examples in comments or scripts", () => {
  expect(
    authoredQuestionTypes(
      `<li class='cl-q' data-type="numeric"></li><li data-type='short' class="item cl-q"></li><!-- <li class="cl-q" data-type="short"> --><script>"<li class='cl-q' data-type='short'>"</script>`,
    ),
  ).toEqual(["numeric", "short"]);
});
it("reports repeated short answers without requiring unsuitable types", () => {
  expect(quizDiversityLines(["short", "short", "short"]).join()).toContain("authoring diagnostic");
  expect(quizDiversityLines(["short", "numeric", "short"])).toEqual([]);
  expect(quizDiversityLines(["short"])).toEqual([]);
});
it("reports questions with a missing or unknown type, such as the scaffold placeholder", () => {
  const questions = authoredQuestions(
    `<li class="cl-q" data-question-id="q1" data-type="CHOOSE-A-TYPE"></li><li class="cl-q" data-question-id="q2"></li><li class="cl-q" data-question-id="q3" data-type="term"></li>`,
  );
  expect(questions).toEqual([
    { id: "q1", type: "CHOOSE-A-TYPE" },
    { id: "q2", type: null },
    { id: "q3", type: "term" },
  ]);
  expect(unfinishedQuestionLines(questions)).toEqual([
    '- **Unfinished questions:** `q1` ("CHOOSE-A-TYPE"), `q2` (no data-type). The page refuses this quiz. Choose a type from quiz.html and write the question.',
  ]);
  expect(unfinishedQuestionLines(questions.slice(2))).toEqual([]);
});
it("counts types, most used first", () => {
  expect(typeCounts(["short", "numeric", "numeric", "locate"])).toBe(
    "2 numeric, 1 short, 1 locate",
  );
});
