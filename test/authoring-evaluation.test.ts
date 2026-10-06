import { expect, it } from "vitest";
import {
  AUTHORING_CRITERIA,
  contentEvaluationPrompt,
  parseContentJudgments,
  type AuthoredContent,
} from "../src/authoring-evaluation.ts";
const content: AuthoredContent = {
  objective: "Apply cost",
  mode: "lesson",
  html: "<p>Predict cost on new data.</p>",
  rubric: "Accept equivalent valid methods.",
  plan: "Objective: cost",
};
const judgments = () =>
  Object.keys(AUTHORING_CRITERIA).map((criterion) => ({
    criterion,
    verdict: "pass",
    quote: "Predict cost on new data.",
    reason: "A concrete upcoming task.",
  }));
it("requires every semantic criterion and a supplied excerpt", () => {
  expect(parseContentJudgments(JSON.stringify(judgments()), content)).toHaveLength(7);
  const invented = judgments();
  invented[0].quote = "An invented question";
  expect(() => parseContentJudgments(JSON.stringify(invented), content)).toThrow(
    "quotes no supplied source",
  );
  expect(() => parseContentJudgments(JSON.stringify(judgments().slice(1)), content)).toThrow(
    "every criterion",
  );
  const duplicate = judgments();
  duplicate[1] = duplicate[0];
  expect(() => parseContentJudgments(JSON.stringify(duplicate), content)).toThrow(
    "unique criterion",
  );
});
it("asks for concrete judgments instead of treating plan labels as question quality", () => {
  const prompt = contentEvaluationPrompt(content);
  expect(prompt).toContain("Mapping names alone cannot prove quality");
  expect(prompt).toContain("not human learning evidence");
  expect(prompt).toContain("Prior-topic retrieval");
  expect(prompt).toContain("Solve at least two allowed alternatives");
  expect(prompt).toContain("Do not claim to have checked rendered diagrams");
});
