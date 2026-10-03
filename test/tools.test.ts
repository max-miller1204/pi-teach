import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";

import { CONFIDENT_WRONG, PRETEST_FOLLOW_UP, QUIZ_FOLLOW_UP } from "../src/prompts.ts";
import { DAY_MS } from "../src/review.ts";
import * as store from "../src/store.ts";
import { classroomTools, PI_HOST } from "../src/tools.ts";
import {
  makeFixture,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";

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
      kind: "check",
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

function tool(name: string) {
  return classroomTools(PI_HOST).find((t) => t.name === name)!;
}

describe("grade_lesson_quiz", () => {
  function submit(kind: store.QuizKind, answers: store.QuizAnswer[]) {
    return store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: kind === "pretest" ? "pretest" : "check-1",
      quizTitle: "Ownership",
      kind,
      answers,
    });
  }

  it("refuses a grade for a question that was not submitted", async () => {
    const submission = submit("check", [termAnswer("q1", "x")]);
    const result = await tool("grade_lesson_quiz").execute({
      submission_id: submission.id,
      score: 0,
      feedback_markdown: "No.",
      questions: [
        { question_id: "q1", correct: false, feedback: "No." },
        { question_id: "q9", correct: false, feedback: "No." },
      ],
    });
    expect(result.details["error"]).toBe(true);
    expect(result.content[0].text).toContain("q9");
  });

  it("names confident misses and correct guesses, and when each comes back", async () => {
    const submission = submit("check", [
      termAnswer("q1", "x", { confidence: "sure" }),
      termAnswer("q2", "y", { confidence: "guess" }),
    ]);
    const result = await tool("grade_lesson_quiz").execute({
      submission_id: submission.id,
      score: 50,
      feedback_markdown: "Half.",
      questions: [
        { question_id: "q1", correct: false, feedback: "No." },
        { question_id: "q2", correct: true, feedback: "Yes." },
      ],
    });
    const text = result.content[0].text;
    expect(text).toContain(`Wrong while "Sure": q1. ${CONFIDENT_WRONG}`);
    expect(text).toContain("Correct but guessed: q2.");
    // A miss comes back tomorrow; a guess stays in the first box, so also tomorrow.
    expect(text).toContain("Next review: q1 tomorrow, q2 tomorrow.");
    expect(result.details["confidentlyWrong"]).toEqual(["q1"]);
  });

  it("treats a pretest as diagnostic", async () => {
    const submission = submit("pretest", [termAnswer("p1", "x")]);
    const result = await tool("grade_lesson_quiz").execute({
      submission_id: submission.id,
      score: 0,
      feedback_markdown: "Expected.",
      questions: [{ question_id: "p1", correct: false, feedback: "Not yet taught." }],
    });
    expect(result.content[0].text).toContain(PRETEST_FOLLOW_UP);
    expect(result.content[0].text).not.toContain(QUIZ_FOLLOW_UP);
    expect(result.content[0].text).not.toContain("Next review");
  });
});

describe("scaffold_review", () => {
  it("fails loudly when nothing is due", async () => {
    const empty = await tool("scaffold_review").execute({ classroom: "rust" });
    expect(empty.details["error"]).toBe(true);
    expect(empty.content[0].text).toContain("no question has been graded yet");

    writeGradedAttempt({ at: Date.now(), answers: [termAnswer("q1", "x")], correct: { q1: true } });
    const notYet = await tool("scaffold_review").execute({ classroom: "rust" });
    expect(notYet.content[0].text).toContain("The next question is due in 3 days.");
  });

  it("creates a review lesson and lists the due questions with their keys", async () => {
    writeGradedAttempt({
      at: Date.now() - 5 * DAY_MS,
      answers: [termAnswer("q1", "the stack", { confidence: "sure" })],
      correct: { q1: false },
    });
    const result = await tool("scaffold_review").execute({ classroom: "rust" });
    expect(result.details["error"]).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('data-review-of="001-ownership/check-1/q1"');
    expect(text).toContain("Their last answer (wrong, sure): the stack");

    const lesson = result.details["lesson"] as string;
    expect(lesson).toMatch(/^002-review-\d{4}-\d{2}-\d{2}$/);
    expect(store.readLesson("rust", lesson)).toMatchObject({ kind: "review" });
    expect(fs.readFileSync(result.details["path"] as string, "utf8")).toContain(
      'data-kind="review"',
    );
  });

  it("refuses a limit out of range", async () => {
    const result = await tool("scaffold_review").execute({ classroom: "rust", limit: 0 });
    expect(result.details["error"]).toBe(true);
  });
});

describe("lesson_health", () => {
  it("reads review history from other lessons for a selected original lesson", async () => {
    writeGradedAttempt({ at: 1, answers: [termAnswer("q1", "x")], correct: { q1: true } });
    for (const [at, lesson] of [
      [2, "002-review"],
      [3, "003-review"],
    ] as const) {
      seedClassroom(fixture, { lesson });
      writeGradedAttempt({
        at,
        lesson,
        quizId: "review",
        kind: "review",
        answers: [termAnswer("r1", "x", { reviewOf: "001-ownership/check-1/q1" })],
        correct: { r1: false },
      });
    }
    const result = await tool("lesson_health").execute({
      classroom: "rust",
      lesson: "001-ownership",
    });
    expect(result.content[0].text).toContain("missed 2 of 3");
    expect(result.content[0].text).not.toContain("002-review");
    expect(result.details["lessons"]).toEqual(["001-ownership"]);
  });

  it("reports avoided glossary words and glossary errors", async () => {
    fixture.write(
      "rust/GLOSSARY.md",
      "**Owner**:\nThe variable a value belongs to.\n_Avoid_: lesson prose\n\n**Empty**:\n",
    );
    const result = await tool("lesson_health").execute({ classroom: "rust" });
    const text = result.content[0].text;
    expect(text).toContain("## GLOSSARY.md errors");
    expect(text).toContain('"lesson prose" (1×). Use "Owner".');
  });

  it("fails loudly for an unknown lesson", async () => {
    const result = await tool("lesson_health").execute({ classroom: "rust", lesson: "999-nope" });
    expect(result.details["error"]).toBe(true);
  });
});
