import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import * as store from "../src/store.ts";
import { DAY_MS } from "../src/review.ts";
import {
  makeFixture,
  lessonHtml,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe("discovery", () => {
  it("finds classrooms and their lessons", () => {
    seedClassroom(fixture);

    const classrooms = store.listClassrooms();
    expect(classrooms).toHaveLength(1);
    expect(classrooms[0]).toMatchObject({
      name: "rust",
      title: "Rust",
      emoji: "🦀",
      lessonCount: 1,
    });

    const lessons = store.listLessons("rust");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({ name: "001-ownership", title: "Ownership", order: 1 });
  });

  it("treats a directory holding a lesson document as a lesson, with or without lesson.json", () => {
    fixture.write("rust/007-borrowing/lesson.html", lessonHtml("Borrowing"));

    const lessons = store.listLessons("rust");
    expect(lessons).toHaveLength(1);
    // Falls back to the document's <title>.
    expect(lessons[0].title).toBe("Borrowing");
    expect(lessons[0].order).toBe(7);
  });

  it("accepts a literal lesson-001.html", () => {
    fixture.write("rust/001-intro/lesson-001.html", lessonHtml("Intro"));
    expect(store.listLessons("rust")[0].htmlPath).toMatch(/lesson-001\.html$/);
  });

  it("prefers lesson.html when several documents are present", () => {
    fixture.write("rust/001-intro/lesson-001.html", lessonHtml("Old"));
    fixture.write("rust/001-intro/lesson.html", lessonHtml("Current"));
    expect(store.listLessons("rust")[0].title).toBe("Current");
  });

  it("ignores the classroom's own reserved directories", () => {
    seedClassroom(fixture);
    fixture.write("rust/reference/cheatsheet.html", "<html><body>ref</body></html>");
    fixture.write("rust/assets/diagram.html", "<html><body>asset</body></html>");
    fixture.write("rust/learning-records/0001-owns.md", "# Owns");

    expect(store.listLessons("rust").map((l) => l.name)).toEqual(["001-ownership"]);
    expect(store.listReferenceDocs("rust")).toEqual(["cheatsheet.html"]);
    expect(store.listLearningRecords("rust")).toEqual(["0001-owns.md"]);
  });

  it("ignores directories with no lesson document at all", () => {
    seedClassroom(fixture);
    fs.mkdirSync(path.join(fixture.root, "rust", "scratch"), { recursive: true });
    expect(store.listLessons("rust").map((l) => l.name)).toEqual(["001-ownership"]);
  });

  it("orders numbered lessons first, then unnumbered by creation", () => {
    fixture.write("rust/003-third/lesson.html", lessonHtml("Third"));
    fixture.write("rust/001-first/lesson.html", lessonHtml("First"));
    fixture.write("rust/appendix/lesson.html", lessonHtml("Appendix"));
    fixture.write(
      "rust/appendix/lesson.json",
      JSON.stringify({ title: "Appendix", summary: "", createdAt: 9 }),
    );

    expect(store.listLessons("rust").map((l) => l.name)).toEqual([
      "001-first",
      "003-third",
      "appendix",
    ]);
  });

  it("returns nothing for slugs that are not valid directory names", () => {
    seedClassroom(fixture);
    expect(store.readClassroom("../rust")).toBeNull();
    expect(store.listLessons("..")).toEqual([]);
    expect(store.readLesson("rust", "../..")).toBeNull();
  });

  it("survives an empty classrooms root", () => {
    expect(store.listClassrooms()).toEqual([]);
  });
});

describe("annotations", () => {
  const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };

  it("creates, finds, updates, and deletes", () => {
    const { classroom, lesson } = seedClassroom(fixture);

    const created = store.createAnnotation({
      classroom,
      lesson,
      question: "Why only one?",
      selection: "one owner",
      anchor,
    });
    expect(created.status).toBe("pending");
    expect(store.findAnnotation(created.id)).toMatchObject({ id: created.id, status: "pending" });

    const updated = store.updateAnnotation(created.id, {
      status: "answered",
      answerMarkdown: "Because aliasing.",
      answerHtml: "<p>Because aliasing.</p>",
      answeredAt: 123,
    });
    expect(updated).toMatchObject({ status: "answered", answerMarkdown: "Because aliasing." });
    expect(store.listAnnotations(classroom, lesson)).toHaveLength(1);

    expect(store.deleteAnnotation(classroom, lesson, created.id)).toBe(true);
    expect(store.listAnnotations(classroom, lesson)).toEqual([]);
    expect(store.deleteAnnotation(classroom, lesson, created.id)).toBe(false);
  });

  it("returns null for an unknown id instead of throwing", () => {
    seedClassroom(fixture);
    expect(store.findAnnotation("nope")).toBeNull();
    expect(store.updateAnnotation("nope", { status: "answered" })).toBeNull();
  });

  it("counts annotations on the lesson it belongs to", () => {
    const { classroom, lesson } = seedClassroom(fixture);
    store.createAnnotation({ classroom, lesson, question: "q", selection: "s", anchor });
    expect(store.readLesson(classroom, lesson)!.annotationCount).toBe(1);
  });
});

describe("follow-ups", () => {
  const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };

  /** An annotation whose first question already has an answer. */
  function answeredCard(): store.Annotation {
    const { classroom, lesson } = seedClassroom(fixture);
    const created = store.createAnnotation({
      classroom,
      lesson,
      question: "Why only one?",
      selection: "one owner",
      anchor,
    });
    return store.updateAnnotation(created.id, {
      status: "answered",
      answerMarkdown: "Because aliasing.",
      answerHtml: "<p>Because aliasing.</p>",
      answeredAt: 1,
    })!;
  }

  it("appends pending turns to the card, in order", () => {
    const card = answeredCard();

    const first = store.addFollowUp(card.id, "What about borrows?")!;
    const second = store.addFollowUp(card.id, "And threads?")!;

    expect(first.followUp.status).toBe("pending");
    const stored = store.findAnnotation(card.id)!;
    expect(stored.followUps!.map((f) => f.question)).toEqual([
      "What about borrows?",
      "And threads?",
    ]);
    expect(second.annotation.followUps).toHaveLength(2);
  });

  it("answers one turn without touching the others", () => {
    const card = answeredCard();
    const first = store.addFollowUp(card.id, "What about borrows?")!.followUp;
    store.addFollowUp(card.id, "And threads?");

    store.updateFollowUp(card.id, first.id, {
      status: "answered",
      answerMarkdown: "Many readers, one writer.",
      answeredAt: 2,
    });

    const stored = store.findAnnotation(card.id)!;
    expect(stored.answerMarkdown).toBe("Because aliasing.");
    expect(stored.followUps![0]).toMatchObject({ status: "answered" });
    expect(stored.followUps![1].status).toBe("pending");
  });

  it("routes an incoming answer to the oldest turn still waiting", () => {
    const card = answeredCard();
    expect(store.answerTarget(store.findAnnotation(card.id)!)).toBeNull();

    const first = store.addFollowUp(card.id, "First follow-up")!.followUp;
    const second = store.addFollowUp(card.id, "Second follow-up")!.followUp;
    expect(store.answerTarget(store.findAnnotation(card.id)!)).toBe(first.id);

    store.updateFollowUp(card.id, first.id, { status: "answered", answerMarkdown: "a" });
    expect(store.answerTarget(store.findAnnotation(card.id)!)).toBe(second.id);

    // Nothing pending: a late answer revises the most recent turn rather than the first.
    store.updateFollowUp(card.id, second.id, { status: "answered", answerMarkdown: "b" });
    expect(store.answerTarget(store.findAnnotation(card.id)!)).toBe(second.id);
  });

  it("reports whether a specific turn is still pending", () => {
    const card = answeredCard();
    const followUp = store.addFollowUp(card.id, "Pending?")!.followUp;
    const stored = store.findAnnotation(card.id)!;

    expect(store.isTurnPending(stored, null)).toBe(false);
    expect(store.isTurnPending(stored, followUp.id)).toBe(true);
    expect(store.isTurnPending(stored, "nope")).toBe(false);
  });

  it("returns null for unknown cards and unknown turns", () => {
    const card = answeredCard();
    expect(store.addFollowUp("nope", "q")).toBeNull();
    expect(store.updateFollowUp(card.id, "nope", { status: "answered" })).toBeNull();
  });

  it("treats a card written before follow-ups existed as a single-turn thread", () => {
    const { classroom, lesson } = seedClassroom(fixture);
    // A legacy annotations.json: no followUps key at all.
    fixture.write(
      `${classroom}/${lesson}/annotations.json`,
      JSON.stringify([
        {
          id: "legacy",
          classroom,
          lesson,
          status: "answered",
          question: "Old question",
          selection: "one owner",
          anchor,
          answerMarkdown: "Old answer",
          answerHtml: "<p>Old answer</p>",
          createdAt: 1,
          answeredAt: 2,
        },
      ]),
    );

    const legacy = store.findAnnotation("legacy")!;
    expect(legacy.followUps).toBeUndefined();
    expect(store.answerTarget(legacy)).toBeNull();

    const added = store.addFollowUp("legacy", "Still works?")!;
    expect(added.annotation.followUps).toHaveLength(1);
  });
});

describe("quiz submissions and grades", () => {
  function submit(classroom: string, lesson: string) {
    return store.createSubmission({
      classroom,
      lesson,
      quizId: "check-1",
      quizTitle: "Check on learning",
      kind: "check",
      answers: [{ questionId: "q1", value: "a", label: "First answer" }],
    });
  }

  it("writes submissions into the lesson directory and finds them by id", () => {
    const { classroom, lesson } = seedClassroom(fixture);
    const submission = submit(classroom, lesson);

    const dir = path.join(fixture.root, classroom, lesson, "quiz", "submissions");
    expect(fs.readdirSync(dir)).toHaveLength(1);
    expect(store.findSubmission(submission.id)).toMatchObject({
      id: submission.id,
      quizId: "check-1",
    });
  });

  it("reports an ungraded submission, then the score once graded", () => {
    const { classroom, lesson } = seedClassroom(fixture);
    const submission = submit(classroom, lesson);

    expect(store.readLesson(classroom, lesson)).toMatchObject({
      hasUngradedSubmission: true,
      latestScore: null,
    });

    store.writeGrade({
      submissionId: submission.id,
      classroom,
      lesson,
      quizId: submission.quizId,
      score: 75,
      feedbackMarkdown: "Close.",
      feedbackHtml: "<p>Close.</p>",
      questions: [{ questionId: "q1", correct: false, feedback: "Not quite." }],
      gradedAt: Date.now(),
    });

    expect(store.readLesson(classroom, lesson)).toMatchObject({
      hasUngradedSubmission: false,
      latestScore: 75,
    });

    const [state] = store.latestQuizStates(classroom, lesson);
    expect(state.submission.id).toBe(submission.id);
    expect(state.grade!.score).toBe(75);
  });

  it("pairs the latest submission with its own grade, not an older one", () => {
    const { classroom, lesson } = seedClassroom(fixture);
    const first = submit(classroom, lesson);
    store.writeGrade({
      submissionId: first.id,
      classroom,
      lesson,
      quizId: first.quizId,
      score: 40,
      feedbackMarkdown: "",
      feedbackHtml: "",
      questions: [],
      gradedAt: Date.now(),
    });

    submit(classroom, lesson);
    const [state] = store.latestQuizStates(classroom, lesson);
    expect(state.submission.id).not.toBe(first.id);
    expect(state.grade).toBeNull();
    expect(state.attempts).toBe(2);
    expect(state.submission.attempt).toBe(2);
  });
});

describe("titleFromSlug", () => {
  it("drops the ordering prefix and title-cases the rest", () => {
    expect(store.titleFromSlug("003-closures-capture-by-value")).toBe("Closures Capture By Value");
  });
});

describe("review items", () => {
  const T0 = Date.UTC(2026, 0, 1);

  it("schedules graded questions and leaves pretests out", () => {
    seedClassroom(fixture);
    writeGradedAttempt({
      at: T0,
      kind: "pretest",
      quizId: "pretest",
      answers: [termAnswer("p1", "no idea")],
      correct: { p1: false },
    });
    writeGradedAttempt({
      at: T0 + DAY_MS,
      answers: [termAnswer("q1", "owner", { confidence: "guess" })],
      correct: { q1: true },
    });

    const saved = store.listSubmissions("rust", "001-ownership");
    const items = store.reviewItems("rust");
    expect(items.map((item) => item.key)).toEqual(["001-ownership/check-1/q1"]);
    expect(items[0]).toMatchObject({ box: 0, dueAt: T0 + 2 * DAY_MS + 1, lastAnswer: "owner" });
    expect(store.listSubmissions("rust", "001-ownership")).toEqual(saved);
    expect(saved.find((submission) => submission.quizId === "check-1")!.answers[0].confidence).toBe(
      "guess",
    );
  });

  it("counts a review question as another attempt at the item it names", () => {
    seedClassroom(fixture);
    seedClassroom(fixture, { lesson: "002-review" });
    writeGradedAttempt({ at: T0, answers: [termAnswer("q1", "owner")], correct: { q1: true } });
    writeGradedAttempt({
      at: T0 + 3 * DAY_MS,
      lesson: "002-review",
      quizId: "review",
      kind: "review",
      answers: [termAnswer("r1", "borrow", { reviewOf: "001-ownership/check-1/q1" })],
      correct: { r1: false },
    });

    const [item] = store.reviewItems("rust");
    expect(item).toMatchObject({
      key: "001-ownership/check-1/q1",
      attempts: 2,
      box: 0,
      prompt: "Prompt for q1",
    });
  });

  it("never lets a pretest set the lesson score", () => {
    seedClassroom(fixture);
    writeGradedAttempt({ at: T0, answers: [termAnswer("q1", "x")], correct: { q1: true } });
    const grade = store.listGrades("rust", "001-ownership")[0];
    store.writeGrade({ ...grade, score: 90 });
    writeGradedAttempt({
      at: T0 + 1,
      kind: "pretest",
      quizId: "pretest",
      answers: [termAnswer("p1", "x")],
      correct: { p1: false },
    });
    expect(store.readLesson("rust", "001-ownership")!.latestScore).toBe(90);
  });
});

describe("quiz states", () => {
  it("keeps the latest attempt at each quiz separately", () => {
    seedClassroom(fixture);
    const T0 = Date.UTC(2026, 0, 1);
    writeGradedAttempt({
      at: T0,
      quizId: "pretest",
      kind: "pretest",
      answers: [termAnswer("p1", "x")],
      correct: { p1: false },
    });
    writeGradedAttempt({ at: T0 + 1, answers: [termAnswer("q1", "a")], correct: { q1: false } });
    const second = writeGradedAttempt({
      at: T0 + 2,
      answers: [termAnswer("q1", "b")],
      correct: { q1: true },
    });

    const states = store.latestQuizStates("rust", "001-ownership");
    expect(states.map((s) => [s.quizId, s.attempts])).toEqual([
      ["pretest", 1],
      ["check-1", 2],
    ]);
    expect(states[1].submission.id).toBe(second.id);
    expect(store.previousGrade(second)!.questions[0].correct).toBe(false);
  });

  it("uses the newest revision of a grade everywhere and keeps the older file", () => {
    seedClassroom(fixture);
    const T0 = Date.UTC(2026, 0, 1);
    const first = writeGradedAttempt({
      at: T0,
      answers: [termAnswer("q1", "a")],
      correct: { q1: false },
    });
    const original = store.listGrades("rust", "001-ownership")[0];
    store.writeGrade({
      ...original,
      score: 100,
      questions: [{ questionId: "q1", correct: true, feedback: "Revised." }],
      gradedAt: original.gradedAt + 10,
    });

    expect(store.listGrades("rust", "001-ownership")).toHaveLength(2);
    expect(store.latestGrades("rust", "001-ownership").map((g) => g.score)).toEqual([100]);
    expect(store.readLesson("rust", "001-ownership")!.latestScore).toBe(100);
    const [state] = store.latestQuizStates("rust", "001-ownership");
    expect(state.grade!.score).toBe(100);
    expect(state.attempts).toBe(1);

    const [item] = store.reviewItems("rust");
    expect(item).toMatchObject({ attempts: 1, lastCorrect: true, lastFeedback: "Revised." });
    expect(item.dueAt).toBe(original.gradedAt + DAY_MS);
    expect(item.progress).toBe("context-unknown");

    const second = writeGradedAttempt({
      at: T0 + 100,
      answers: [termAnswer("q1", "b")],
      correct: { q1: true },
    });
    expect(second.id).not.toBe(first.id);
    expect(store.previousGrade(second)!.score).toBe(100);
  });
});

describe("reflections", () => {
  it("keeps every save and returns the latest of each", () => {
    seedClassroom(fixture);
    const input = { classroom: "rust", lesson: "001-ownership", prompt: "Explain." };
    store.createReflection({ ...input, reflectId: "a", text: "first" });
    store.createReflection({ ...input, reflectId: "b", text: "other" });
    store.createReflection({ ...input, reflectId: "a", text: "second" });

    expect(store.listReflections("rust", "001-ownership")).toHaveLength(3);
    expect(
      store.latestReflections("rust", "001-ownership").map((r) => [r.reflectId, r.text]),
    ).toEqual([
      ["a", "second"],
      ["b", "other"],
    ]);
  });
});

describe("readGlossary", () => {
  it("parses GLOSSARY.md, and gives no terms when there is none", () => {
    seedClassroom(fixture);
    expect(store.readGlossary("rust")).toEqual({ terms: [], errors: [] });
    fixture.write("rust/GLOSSARY.md", "**Owner**:\nThe variable a value belongs to.\n");
    expect(store.readGlossary("rust").terms.map((t) => t.term)).toEqual(["Owner"]);
  });
});

describe("corrupt state", () => {
  it("reports invalid JSON instead of treating annotations as absent", () => {
    seedClassroom(fixture);
    fixture.write("rust/001-ownership/annotations.json", "{");
    expect(() => store.listAnnotations("rust", "001-ownership")).toThrow(/annotations.json/);
  });
});

it("distinguishes absent optional state from corrupt state files", () => {
  seedClassroom(fixture);
  expect(store.listAnnotations("rust", "001-ownership")).toEqual([]);
  expect(store.listReflections("rust", "001-ownership")).toEqual([]);
  for (const source of ["null", "{}", "true", "[invalid]"]) {
    fixture.write("rust/001-ownership/annotations.json", source);
    expect(() => store.listAnnotations("rust", "001-ownership")).toThrow(/annotations.json/);
  }
});

it("reports a corrupt grade instead of dropping it from history", () => {
  seedClassroom(fixture);
  fixture.write("rust/001-ownership/quiz/grades/corrupt.json", "{");
  expect(() => store.listGrades("rust", "001-ownership")).toThrow(/corrupt.json/);
});
