import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  publicReview,
  publishReview,
  reviewSessions,
  startReview,
  updateReview,
  validateReview,
} from "../src/review-session.ts";
import { DAY_MS, DEFAULT_REVIEW_SIZE } from "../src/review.ts";
import {
  makeFixture,
  reviewDocument,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";
let f: Fixture;
beforeEach(() => {
  f = makeFixture();
  seedClassroom(f);
  writeGradedAttempt({
    at: Date.now() - 2 * DAY_MS,
    answers: [termAnswer("q1", "owner")],
    correct: { q1: true },
  });
});
afterEach(() => f.cleanup());

describe("review request contracts", () => {
  it("saves the selected items once and resumes an unattempted review", () => {
    const first = startReview("rust", randomUUID(), "pi");
    expect(first.added).toBe(true);
    expect(first.session.items.map((i) => i.key)).toEqual(["001-ownership/check-1/q1"]);
    expect(fs.existsSync(path.join(f.root, "rust", first.session.lesson))).toBe(false);
    expect(startReview("rust", randomUUID(), "pi").session.id).toBe(first.session.id);
    publishReview(first.session, reviewDocument(first.session.items));
    updateReview(first.session, "done");
    expect(startReview("rust", randomUUID(), "pi").added).toBe(false);
    expect(reviewSessions("rust")).toHaveLength(1);
    expect(JSON.stringify(publicReview(first.session))).not.toContain("lastAnswer");
  });
  it("uses the same batch size as reviews started by the host", () => {
    writeGradedAttempt({
      at: Date.now() - 2 * DAY_MS,
      quizId: "many",
      answers: Array.from({ length: 12 }, (_, i) => termAnswer(`q${i + 1}`, "owner")),
      correct: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i + 1}`, true])),
    });
    expect(startReview("rust", randomUUID(), "pi").session.items).toHaveLength(DEFAULT_REVIEW_SIZE);
  });
  it("rejects empty, unfinished, unlinked, duplicate, and reordered review questions before writes", () => {
    const s = startReview("rust", randomUUID(), "pi").session;
    const document = reviewDocument(s.items);
    for (const bad of [
      { ...document, rubric_json: "{}" },
      { ...document, teaching_plan_json: "{}" },
      { ...document, lesson_html: document.lesson_html.replace("<textarea></textarea>", "") },
      {
        ...document,
        lesson_html: document.lesson_html.replace(
          "<textarea></textarea>",
          "<template><textarea></textarea></template>",
        ),
      },
      {
        ...document,
        lesson_html: document.lesson_html.replace('data-type="short"', 'data-type="CHOOSE-A-TYPE"'),
      },
      {
        ...document,
        lesson_html: document.lesson_html.replace(s.items[0].key, "001-ownership/check-1/other"),
      },
      {
        ...document,
        lesson_html: document.lesson_html.replace('data-kind="review"', 'data-kind="check"'),
      },
    ])
      expect(() => publishReview(s, bad)).toThrow();
    const multiple = {
      ...s,
      items: [s.items[0], { ...s.items[0], key: "001-ownership/check-1/q2" }],
    };
    const two = reviewDocument(multiple.items);
    expect(() =>
      validateReview(multiple, {
        ...two,
        lesson_html: two.lesson_html.replace("check-1/q2", "check-1/q1"),
      }),
    ).toThrow("selected item keys");
    expect(() => validateReview(multiple, reviewDocument([...multiple.items].reverse()))).toThrow(
      "selected item keys",
    );
    expect(fs.existsSync(path.join(f.root, "rust", s.lesson))).toBe(false);
  });
  it("keeps the original objective policy and rejects invented historical policy", () => {
    const session = startReview("rust", randomUUID(), "pi").session;
    const document = reviewDocument(session.items);
    const invented = JSON.parse(document.teaching_plan_json);
    invented.objectives.r1.retentionDays = 30;
    expect(() =>
      validateReview(session, { ...document, teaching_plan_json: JSON.stringify(invented) }),
    ).toThrow("cannot invent retention");
    const known = {
      ...session,
      items: [
        {
          ...session.items[0],
          objective: { statement: "Explain ownership.", application: true, retentionDays: 60 },
        },
      ],
    };
    const knownDocument = reviewDocument(known.items);
    const changed = JSON.parse(knownDocument.teaching_plan_json);
    changed.objectives.r1.retentionDays = 30;
    expect(() =>
      validateReview(known, { ...knownDocument, teaching_plan_json: JSON.stringify(changed) }),
    ).toThrow("changed its original objective");
    expect(() => validateReview(known, knownDocument)).not.toThrow();
  });
  it("replays publication without changing private files and rejects conflicting writes or symlinks", () => {
    const s = startReview("rust", randomUUID(), "pi").session,
      doc = reviewDocument(s.items);
    publishReview(s, doc);
    publishReview(s, doc);
    expect(() => publishReview(s, { ...doc, rubric_json: doc.rubric_json + " " })).toThrow(
      "conflicts",
    );
    const file = path.join(f.root, "rust", s.lesson, "quiz/key.json");
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.root, "rust/001-ownership/lesson.html"), file);
    expect(() => publishReview(s, doc)).toThrow("symlink");
  });
});
