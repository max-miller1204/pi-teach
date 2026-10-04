import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { PRETEST_FOLLOW_UP, QUIZ_FOLLOW_UP } from "../src/prompts.ts";
import { DAY_MS } from "../src/review.ts";
import * as store from "../src/store.ts";
import { templatesDir } from "../src/paths.ts";
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
  ["MCP", { browseHint: "Call open_classroom.", checkPage: "Call open_classroom." }],
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
      questions: [
        {
          question_id: "q1",
          correct,
          points_earned: score,
          points_possible: 100,
          feedback: "Each value has one owner.",
        },
      ],
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

  it("ignores legacy confidence metadata when grading and scheduling review", async () => {
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
    expect(text).not.toContain("Wrong while");
    expect(text).not.toContain("Correct but guessed");
    // A wrong answer returns tomorrow. A correct answer moves to three days.
    expect(text).toContain("Next review: q1 tomorrow, q2 in 3 days.");
    expect(result.details).not.toHaveProperty("confidentlyWrong");
    expect(result.details).not.toHaveProperty("correctGuesses");
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

describe("scaffold_lesson", () => {
  it("creates a shell that fails loudly until a question is written", async () => {
    const result = await tool("scaffold_lesson").execute({
      classroom: "rust",
      name: "borrowing",
      title: "Borrowing",
      summary: "Lend a value without moving it.",
    });
    expect(result.details["error"]).toBeUndefined();
    const text = result.content[0].text;
    const htmlPath = result.details["path"] as string;
    expect(text).toContain(
      `Read the current quiz contract: ${path.join(templatesDir(), "quiz.html")}`,
    );
    expect(text).toContain("State one learning objective");
    expect(text).toContain("predict, retrieve, explain, practise, or diagnose");
    expect(text).toContain(path.join(path.dirname(htmlPath), "quiz", "key.json"));
    expect(text).toContain("Call lesson_health for this lesson");

    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("data-cl-content");
    expect(html).toContain("<h1>Borrowing</h1>");
    expect(html).toContain('data-type="CHOOSE-A-TYPE"');
    expect(html).not.toContain("{{");

    const health = await tool("lesson_health").execute({
      classroom: "rust",
      lesson: "002-borrowing",
    });
    expect(health.content[0].text).toContain('**Unfinished questions:** `q1` ("CHOOSE-A-TYPE")');
    expect(health.content[0].text).toContain("**No private rubric:**");

    fs.writeFileSync(
      htmlPath,
      html.replace('data-type="CHOOSE-A-TYPE"', 'data-type="numeric"'),
      "utf8",
    );
    fixture.write("rust/002-borrowing/quiz/key.json", "{}");
    const fixed = await tool("lesson_health").execute({ classroom: "rust" });
    expect(fixed.content[0].text).not.toContain("Unfinished questions");
    expect(fixed.content[0].text).not.toContain("No private rubric");
    expect(fixed.content[0].text).toContain("## Response types in recent lessons");
    expect(fixed.content[0].text).toContain("- `002-borrowing`: 1 numeric");
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
    expect(text).toContain("Their last answer (wrong): the stack");
    expect(text).toContain("Read the current quiz contract");
    expect(text).toContain("It does not have to match the original type.");
    expect(text).toContain("quiz/key.json");

    const lesson = result.details["lesson"] as string;
    expect(lesson).toMatch(/^002-review-\d{4}-\d{2}-\d{2}$/);
    expect(store.readLesson("rust", lesson)).toMatchObject({ kind: "review" });
    const html = fs.readFileSync(result.details["path"] as string, "utf8");
    expect(html).toContain('data-kind="review"');
    expect(html).toContain('data-type="CHOOSE-A-TYPE"');
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

describe("record_retrieval_check", () => {
  function missed() {
    return writeGradedAttempt({
      at: Date.now() - 1000,
      answers: [termAnswer("q1", "wrong")],
      correct: { q1: false },
    });
  }
  function record() {
    return tool("record_retrieval_check").execute({
      classroom: "rust",
      review_key: "001-ownership/check-1/q1",
      learning_record: "0001-owner.md",
      answer: "The value is dropped.",
      evidence: "A new scope example. The learner identified when the value is dropped.",
    });
  }
  it("resolves current health and schedules later review without changing the grade", async () => {
    missed();
    const grades = store.listGrades("rust", "001-ownership");
    const submissions = store.listSubmissions("rust", "001-ownership");
    fixture.write(
      "rust/learning-records/0001-owner.md",
      "# Ownership\nThe learner correctly applied the rule to a new scope.",
    );
    const result = await record();
    expect(result.details["error"]).not.toBe(true);
    expect(store.listGrades("rust", "001-ownership")).toEqual(grades);
    expect(store.listSubmissions("rust", "001-ownership")).toEqual(submissions);
    const [item] = store.reviewItems("rust");
    expect(item).toMatchObject({
      box: 1,
      attempts: 2,
      lastCorrect: true,
      lastSource: "chat",
      learningRecord: "0001-owner.md",
    });
    expect(item.dueAt).toBe(item.lastAt + 3 * DAY_MS);
    const health = await tool("lesson_health").execute({ classroom: "rust" });
    expect(health.content[0].text).toContain("Resolved quiz gaps");
    expect(health.content[0].text).toContain("0001-owner.md");
    expect(health.content[0].text).not.toContain("Missed on the last attempt");
    expect((await record()).details["error"]).toBe(true);
    expect(store.listRetrievalChecks("rust")).toHaveLength(1);
    writeGradedAttempt({
      at: item.lastAt + 1,
      answers: [termAnswer("q1", "wrong again")],
      correct: { q1: false },
    });
    expect(store.reviewItems("rust")[0].lastCorrect).toBe(false);
    const later = await tool("lesson_health").execute({ classroom: "rust" });
    expect(later.content[0].text).toContain("Quiz questions missed more than once");
    expect(later.content[0].text).not.toContain("Resolved quiz gaps");
  });
  it("refuses unlinked, missing, or superseded evidence", async () => {
    expect((await record()).details["error"]).toBe(true);
    missed();
    expect((await record()).content[0].text).toContain("No learning record");
    fixture.write(
      "rust/learning-records/0001-owner.md",
      "---\nstatus: superseded by LR-0002\n---\n# Old claim",
    );
    expect((await record()).content[0].text).toContain("active learning record");
    expect(store.listRetrievalChecks("rust")).toEqual([]);
  });
  it("does not infer correctness from an unrelated free-form learning record", async () => {
    missed();
    fixture.write(
      "rust/learning-records/0001-owner.md",
      "# Resolved\nThe learner understands ownership.",
    );
    const health = await tool("lesson_health").execute({ classroom: "rust" });
    expect(health.content[0].text).toContain("Missed on the last attempt");
    expect(store.reviewItems("rust")[0].lastCorrect).toBe(false);
  });
});

it("stores explicit partial points and gives the original review keys", async () => {
  const submission = store.createSubmission({
    classroom: "rust",
    lesson: "001-ownership",
    quizId: "check-1",
    quizTitle: "Check",
    kind: "check",
    answers: [termAnswer("q1", "incomplete")],
  });
  const result = await tool("grade_lesson_quiz").execute({
    submission_id: submission.id,
    score: 75,
    feedback_markdown: "One part is missing.",
    questions: [
      {
        question_id: "q1",
        correct: false,
        points_earned: 3,
        points_possible: 4,
        feedback: "Name when the scope ends.",
      },
    ],
  });
  expect(result.details["error"]).not.toBe(true);
  expect(result.content[0].text).toContain("001-ownership/check-1/q1");
  expect(store.listGrades("rust", "001-ownership")[0].questions[0]).toMatchObject({
    pointsEarned: 3,
    pointsPossible: 4,
  });
  expect(store.reviewItems("rust")[0]).toMatchObject({
    box: 0,
    lastCorrect: false,
    lastCredit: 0.75,
  });
  const health = await tool("lesson_health").execute({ classroom: "rust" });
  expect(health.content[0].text).toContain("Partial credit on the last attempt");
  expect(health.content[0].text).not.toContain("Missed on the last attempt");
});
