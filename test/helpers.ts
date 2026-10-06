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
