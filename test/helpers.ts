/**
 * Shared fixture helpers: build a throwaway classrooms root on disk and point the
 * extension at it, so store/server tests exercise the real filesystem layout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { _overrideClassroomsDir, submissionsDir } from "../src/paths.ts";
import * as store from "../src/store.ts";
import { _overrideConfigPath } from "../src/config.ts";

export interface Fixture {
  root: string;
  /** Write a file beneath the classrooms root, creating parent directories. */
  write(relativePath: string, contents: string): string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-classroom-test-"));
  _overrideClassroomsDir(root);
  _overrideConfigPath(path.join(root, "test-config.json"));

  return {
    root,
    write(relativePath, contents) {
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, "utf8");
      return file;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A minimal, valid lesson document. */
export function lessonHtml(title: string, body = "<p>Some lesson prose to highlight.</p>"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main data-cl-content>${body}</main></body></html>`;
}

/**
 * Seed a classroom with one lesson.
 *
 * Returns the slugs so tests can address it without restating the layout.
 */
export function seedClassroom(
  fixture: Fixture,
  options: {
    classroom?: string;
    lesson?: string;
    title?: string;
    mission?: string;
  } = {},
): { classroom: string; lesson: string } {
  const classroom = options.classroom ?? "rust";
  const lesson = options.lesson ?? "001-ownership";

  fixture.write(
    `${classroom}/classroom.json`,
    JSON.stringify({ title: options.title ?? "Rust", emoji: "🦀", createdAt: 1 }),
  );
  fixture.write(
    `${classroom}/MISSION.md`,
    options.mission ??
      "# Mission: Rust\n\n## Why\n\nShip a CLI to my team by October.\n\n## Success looks like\n\n- Ships\n",
  );
  fixture.write(`${classroom}/${lesson}/lesson.html`, lessonHtml("Ownership"));
  fixture.write(
    `${classroom}/${lesson}/lesson.json`,
    JSON.stringify({ title: "Ownership", summary: "One owner at a time.", createdAt: 2 }),
  );

  return { classroom, lesson };
}

/**
 * Write a graded quiz attempt straight to disk, at a chosen time.
 *
 * Review schedules are measured in days, so the tests place attempts in the past
 * instead of waiting.
 */
export function writeGradedAttempt(options: {
  classroom?: string;
  lesson?: string;
  quizId?: string;
  kind?: store.QuizKind;
  at: number;
  answers: store.QuizAnswer[];
  correct: Record<string, boolean>;
}): store.QuizSubmission {
  const classroom = options.classroom ?? "rust";
  const lesson = options.lesson ?? "001-ownership";
  const submission: store.QuizSubmission = {
    id: randomUUID(),
    classroom,
    lesson,
    quizId: options.quizId ?? "check-1",
    quizTitle: "Check on learning",
    kind: options.kind ?? "check",
    attempt: 1,
    answers: options.answers,
    submittedAt: options.at,
  };
  const file = path.join(submissionsDir(classroom, lesson), `${options.at}-${submission.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(submission), "utf8");
  store.writeGrade({
    submissionId: submission.id,
    classroom,
    lesson,
    quizId: submission.quizId,
    score: 0,
    feedbackMarkdown: "",
    feedbackHtml: "",
    questions: Object.entries(options.correct).map(([questionId, correct]) => ({
      questionId,
      correct,
      feedback: correct ? "Right." : "Not quite.",
    })),
    gradedAt: options.at + 1,
  });
  return submission;
}

/** A `term` answer, the simplest typed answer. */
export function termAnswer(
  questionId: string,
  value: string,
  extra: Partial<store.QuizAnswer> = {},
): store.QuizAnswer {
  return { questionId, type: "term", prompt: `Prompt for ${questionId}`, value, ...extra };
}

/** A complete review document for browser and recovery fixtures. */
export function reviewDocument(
  items: import("../src/review.ts").ReviewItem[],
): import("../src/review-session.ts").ReviewDocument {
  const objectives: Record<string, unknown> = {};
  const questions: Record<string, unknown> = {};
  const rubric: Record<string, unknown> = {};
  const body = items
    .map((item, i) => {
      const id = `r${i + 1}`;
      objectives[id] = item.objective ?? { statement: "Explain ownership.", application: false };
      questions[id] = { objective: id, task: "retrieval", support: "independent" };
      rubric[id] = {
        expected: "The new owner releases it.",
        points: 1,
        full: "Name the new owner.",
        partial: "Zero points if the owner is wrong.",
      };
      return `<li class="cl-q" data-question-id="${id}" data-type="short" data-review-of="${item.key}"><p class="cl-q-prompt">A String moves to a second binding. Who releases it?</p><textarea></textarea></li>`;
    })
    .join("\n");
  return {
    lesson_html: lessonHtml(
      "Ownership review",
      `<h1>Ownership review</h1><form class="cl-quiz" data-quiz-id="review" data-kind="review" data-evidence="report"><ol class="cl-questions">${body}</ol></form>`,
    ),
    rubric_json: JSON.stringify({ review: rubric }),
    teaching_plan_json: JSON.stringify({
      version: 1,
      objectives,
      quizzes: { review: { purpose: "assessment", questions } },
    }),
  };
}

/** A historical graded review with no panel conversation. Use only scratch roots. */
export function seedHistoricalReview(root: string): {
  classroom: string;
  lesson: string;
  submission_id: string;
} {
  const classroom = "rust",
    lesson = "999-historical-review";
  const dir = path.join(root, classroom, lesson);
  fs.mkdirSync(path.join(dir, "quiz"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "lesson.html"),
    lessonHtml(
      "Historical ownership review",
      `<p>Ownership controls cleanup. A move transfers ownership to a new binding.</p><form class="cl-quiz" data-quiz-id="review" data-kind="review"><ol class="cl-questions">${["Name the language used in this lesson.", "Name the owner before a move.", "What happens to a value when its owner leaves scope?"].map((prompt, i) => `<li class="cl-q" data-question-id="q${i + 1}" data-type="term" data-review-of="001-ownership/check-1/q${i + 1}"><p class="cl-q-prompt">${prompt}</p><input type="text"></li>`).join("")}</ol></form>`,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "quiz/key.json"),
    JSON.stringify({
      review: {
        q1: { pointsPossible: 1, criteria: "Rust." },
        q2: { pointsPossible: 1, criteria: "The original binding." },
        q3: { pointsPossible: 1, criteria: "The value is dropped." },
      },
    }),
  );
  const input = { classroom, lesson };
  const submission = store.createSubmission({
    ...input,
    quizId: "review",
    quizTitle: "Historical ownership review",
    kind: "review",
    answers: [
      termAnswer("q1", "Rust", { reviewOf: "001-ownership/check-1/q1" }),
      termAnswer("q2", "original binding", { reviewOf: "001-ownership/check-1/q2" }),
      termAnswer("q3", "It lives forever", { reviewOf: "001-ownership/check-1/q3" }),
    ],
  });
  store.writeGrade({
    submissionId: submission.id,
    ...input,
    quizId: "review",
    score: 67,
    feedbackMarkdown: "Two correct. The missed idea is cleanup when the owner leaves scope.",
    feedbackHtml: "<p>Two correct. Check cleanup.</p>",
    questions: [1, 2, 3].map((i) => ({
      questionId: `q${i}`,
      correct: i !== 3,
      feedback: i === 3 ? "The value is dropped when its owner leaves scope." : "Correct.",
    })),
    gradedAt: Date.now(),
  });
  return { ...input, submission_id: submission.id };
}
