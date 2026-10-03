/**
 * The lesson health report: where a lesson did not land.
 */

import { describe, expect, it } from "vitest";

import { healthReport, lessonHealthLines, type LessonHealthInput } from "../src/health.ts";
import type { Annotation, QuizGrade, QuizSubmission } from "../src/store.ts";

function annotation(selection: string, followUps: number): Annotation {
  return {
    id: selection,
    classroom: "rust",
    lesson: "001-ownership",
    status: "answered",
    question: "Why?",
    selection,
    anchor: { exact: selection, prefix: "", suffix: "", occurrence: 0 },
    answerMarkdown: "Because.",
    answerHtml: "<p>Because.</p>",
    createdAt: 1,
    answeredAt: 2,
    followUps: Array.from({ length: followUps }, (_, i) => ({
      id: `${selection}-${i}`,
      status: "answered" as const,
      question: "And?",
      answerMarkdown: "So.",
      answerHtml: "<p>So.</p>",
      askedAt: 3,
      answeredAt: 4,
    })),
  };
}

function attempt(
  id: string,
  correct: Record<string, boolean>,
  confidence?: "sure",
): { submission: QuizSubmission; grade: QuizGrade } {
  return {
    submission: {
      id,
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check",
      kind: "check",
      answers: Object.keys(correct).map((questionId) => ({
        questionId,
        type: "term" as const,
        prompt: `What is ${questionId}?`,
        value: "x",
        confidence,
      })),
      submittedAt: Number(id),
    },
    grade: {
      submissionId: id,
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      score: 0,
      feedbackMarkdown: "",
      feedbackHtml: "",
      questions: Object.entries(correct).map(([questionId, ok]) => ({
        questionId,
        correct: ok,
        feedback: "",
      })),
      gradedAt: Number(id) + 1,
    },
  };
}

function input(overrides: Partial<LessonHealthInput>): LessonHealthInput {
  return {
    lesson: "001-ownership",
    title: "Ownership",
    annotations: [],
    submissions: [],
    grades: [],
    reflections: [],
    avoided: [],
    ...overrides,
  };
}

describe("lessonHealthLines", () => {
  it("says nothing about a lesson that landed", () => {
    expect(lessonHealthLines(input({ annotations: [annotation("one owner", 1)] }))).toEqual([]);
  });

  it("names the passages with long threads, longest first", () => {
    const lines = lessonHealthLines(
      input({ annotations: [annotation("one owner", 2), annotation("dropped", 4)] }),
    );
    expect(lines.join("\n")).toMatch(/"dropped": 5 turns\n.*"one owner": 3 turns/);
  });

  it("separates repeated misses, confident misses, and a single last miss", () => {
    const attempts = [
      attempt("1", { q1: false, q2: true, q3: true }),
      attempt("2", { q1: false, q2: false, q3: true }, "sure"),
    ];
    const text = lessonHealthLines(
      input({
        submissions: attempts.map((a) => a.submission),
        grades: attempts.map((a) => a.grade),
      }),
    ).join("\n");
    expect(text).toContain('`check-1/q1` "What is q1?": missed 2 of 2');
    expect(text).toMatch(/Wrong while "Sure".*\n.*check-1\/q1.*\n.*check-1\/q2/);
    expect(text).toContain("Missed on the last attempt:** `check-1/q2`");
    expect(text).not.toContain("q3");
  });

  it("reports avoided words and the latest self-explanation", () => {
    const text = lessonHealthLines(
      input({
        avoided: [{ term: "Hypertrophy", avoided: "Bulking", count: 2 }],
        reflections: [
          {
            id: "r",
            classroom: "rust",
            lesson: "001-ownership",
            reflectId: "explain-1",
            prompt: "Explain.",
            text: "A value has one owner.",
            savedAt: 1,
          },
        ],
      }),
    ).join("\n");
    expect(text).toContain('"Bulking" (2×). Use "Hypertrophy".');
    expect(text).toContain("> A value has one owner.");
  });
});

describe("healthReport", () => {
  it("leads with glossary errors and summarises quiet lessons", () => {
    const report = healthReport(
      "rust",
      [input({ annotations: [annotation("dropped", 3)] }), input({ lesson: "002-borrowing" })],
      ['Line 3: "Empty" has no definition.'],
    );
    expect(report).toContain("## GLOSSARY.md errors");
    expect(report).toContain("## Ownership (`001-ownership`)");
    expect(report).toContain("1 other lesson: nothing needs attention.");
  });

  it("says plainly when nothing needs attention", () => {
    expect(healthReport("rust", [input({})], [])).toContain("Nothing needs attention.");
  });
});
