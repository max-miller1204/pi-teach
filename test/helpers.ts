/**
 * Shared fixture helpers: build a throwaway classrooms root on disk and point the
 * extension at it, so store/server tests exercise the real filesystem layout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _overrideClassroomsDir } from "../src/paths.js";

export interface Fixture {
  root: string;
  /** Write a file beneath the classrooms root, creating parent directories. */
  write(relativePath: string, contents: string): string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-classroom-test-"));
  _overrideClassroomsDir(root);

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
