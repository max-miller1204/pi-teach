import { expect, it } from "vitest";
import { authoredQuestionTypes, quizDiversityLines } from "../src/quiz-authoring.ts";
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
