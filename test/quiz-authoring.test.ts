import { expect, it } from "vitest";
import {
  authoredQuestions,
  authoredQuestionTypes,
  quizDiversityLines,
  typeCounts,
  unfinishedQuestionLines,
} from "../src/quiz-authoring.ts";
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
