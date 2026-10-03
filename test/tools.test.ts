import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { QUIZ_FOLLOW_UP } from "../src/prompts.ts";
import * as store from "../src/store.ts";
import { classroomTools, PI_HOST } from "../src/tools.ts";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
  seedClassroom(fixture);
});

afterEach(() => fixture.cleanup());

describe.each([
  ["Pi", PI_HOST],
  ["MCP", { browseHint: "Call open_classroom." }],
] as const)("%s quiz follow-up", (_name, host) => {
  async function grade(correct: boolean, score: number) {
    const submission = store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Ownership",
      answers: [{ questionId: "q1", value: "One owner" }],
    });
    const tool = classroomTools(host).find((tool) => tool.name === "grade_lesson_quiz")!;
    return tool.execute({
      submission_id: submission.id,
      score,
      feedback_markdown: "Ownership check.",
      questions: [{ question_id: "q1", correct, feedback: "Each value has one owner." }],
    });
  }

  it("requests retrieval after any wrong answer, even with a passing score", async () => {
    const result = await grade(false, 90);
    expect(result.content[0].text).toContain(QUIZ_FOLLOW_UP);
    expect(result.content[0].text).toContain("Missed questions: q1");
    expect(result.details["incorrectQuestionIds"]).toEqual(["q1"]);
  });

  it("asks for agreement after all answers are correct", async () => {
    const result = await grade(true, 100);
    expect(result.content[0].text).not.toContain(QUIZ_FOLLOW_UP);
    expect(result.content[0].text).toContain("ready to continue");
    expect(result.details["incorrectQuestionIds"]).toEqual([]);
  });

  it("does not request retrieval when grading fails", async () => {
    const tool = classroomTools(host).find((tool) => tool.name === "grade_lesson_quiz")!;
    const result = await tool.execute({
      submission_id: "missing",
      score: 0,
      feedback_markdown: "Unknown.",
      questions: [],
    });
    expect(result.details["error"]).toBe(true);
    expect(result.content[0].text).not.toContain(QUIZ_FOLLOW_UP);
  });
});
