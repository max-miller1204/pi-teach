import * as paths from "../src/paths.ts";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { resolveClassroom } from "../src/commands.ts";
import {
  askPrompt,
  followUpPrompt,
  gradePrompt,
  missionStub,
  notesStub,
  PRETEST_FOLLOW_UP,
  QUIZ_FOLLOW_UP,
  reflectPrompt,
  reviewStatusText,
  teachingPrompt,
} from "../src/prompts.ts";
import { DAY_MS } from "../src/review.ts";
import type { Annotation, FollowUp, QuizGrade, QuizSubmission, Reflection } from "../src/store.ts";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  fixture.cleanup();
});

describe("teachingPrompt", () => {
  it("carries the whole methodology, so nothing has to be in the system prompt", () => {
    const prompt = teachingPrompt("Rust ownership", null);
    expect(prompt).toContain("Rust ownership");
    expect(prompt).toContain("scaffold_classroom");
    expect(prompt).toContain("scaffold_lesson");
    expect(prompt).toContain("answer_lesson_question");
    expect(prompt).toContain("grade_lesson_quiz");
    expect(prompt).toContain("zone of proximal development");
    expect(prompt).toContain("~/.pi/agent/classrooms/");
    expect(prompt).toContain(QUIZ_FOLLOW_UP);
    expect(prompt).toContain(PRETEST_FOLLOW_UP);
    expect(prompt).toContain('mode: "quiz"');
    expect(prompt).toContain("Assessment quality");
    expect(prompt).toContain("data-cl-after-pretest");
    expect(prompt).toContain(`${paths.templatesDir()}/quiz.html`);
    expect(prompt).toContain("Read the current quiz contract");
    expect(prompt).toContain("Designing a lesson");
  });

  it("points at an existing classroom when continuing one", () => {
    const prompt = teachingPrompt("Rust", "rust");
    expect(prompt).toContain("`rust`");
    expect(prompt).toContain("MISSION.md");
  });

  it("asks the model to work out where they left off when no topic is given", () => {
    expect(teachingPrompt("", null)).toContain("where they left off");
  });

  it("references the format guides by path rather than inlining them", () => {
    const prompt = teachingPrompt("Rust", null);
    expect(prompt).toContain("MISSION-FORMAT.md");
    expect(prompt).toContain("LEARNING-RECORD-FORMAT.md");
    expect(prompt).toContain("NOTES-FORMAT.md");
    // The guides themselves stay out of the prompt — they are read on demand.
    expect(prompt).not.toContain("One mission per workspace.");
  });
});

describe("followUpPrompt", () => {
  const card: Annotation = {
    id: "a1",
    classroom: "rust",
    lesson: "001-ownership",
    status: "answered",
    question: "Why only one owner?",
    selection: "one owner",
    anchor: { exact: "one owner", prefix: "", suffix: "", occurrence: 0 },
    answerMarkdown: "Because two owners could double-free.",
    answerHtml: "<p>Because two owners could double-free.</p>",
    createdAt: 1,
    answeredAt: 2,
    followUps: [],
  };

  const followUp = (id: string, question: string, answer: string | null): FollowUp => ({
    id,
    status: answer ? "answered" : "pending",
    question,
    answerMarkdown: answer,
    answerHtml: answer ? `<p>${answer}</p>` : null,
    askedAt: 3,
    answeredAt: answer ? 4 : null,
  });

  it("replays the thread so a bare “why?” is answerable", () => {
    const pending = followUp("f1", "Why does that matter?", null);
    const prompt = followUpPrompt({ ...card, followUps: [pending] }, pending, "push");

    expect(prompt).toContain("one owner"); // the passage
    expect(prompt).toContain("Why only one owner?"); // turn one
    expect(prompt).toContain("double-free"); // the answer it already gave
    expect(prompt).toContain("Why does that matter?"); // the new question
    expect(prompt).toContain("answer_lesson_question");
    expect(prompt).toContain(card.id);
  });

  it("includes earlier follow-ups but stops at the one being asked", () => {
    const earlier = followUp("f1", "What about borrows?", "Many readers, one writer.");
    const asking = followUp("f2", "And across threads?", null);
    const later = followUp("f3", "Asked after this one", null);

    const prompt = followUpPrompt({ ...card, followUps: [earlier, asking, later] }, asking, "push");

    expect(prompt).toContain("What about borrows?");
    expect(prompt).toContain("Many readers, one writer.");
    expect(prompt).toContain("And across threads?");
    expect(prompt).not.toContain("Asked after this one");
  });
});

describe("delivery parity", () => {
  const card: Annotation = {
    id: "a1",
    classroom: "rust",
    lesson: "001-ownership",
    status: "answered",
    question: "Why only one owner?",
    selection: "one owner",
    anchor: { exact: "one owner", prefix: "", suffix: "", occurrence: 0 },
    answerMarkdown: "To prevent double-free.",
    answerHtml: "<p>To prevent double-free.</p>",
    createdAt: 1,
    answeredAt: 2,
  };
  const followUp: FollowUp = {
    id: "f1",
    question: "What about borrowing?",
    status: "pending",
    answerMarkdown: null,
    answerHtml: null,
    askedAt: 3,
    answeredAt: null,
  };
  const submission: QuizSubmission = {
    id: "s1",
    classroom: card.classroom,
    lesson: card.lesson,
    quizId: "check-1",
    quizTitle: "Ownership",
    answers: [{ questionId: "q1", prompt: "Who owns a value?", value: "Everyone" }],
    submittedAt: 4,
  };
  const reflection: Reflection = {
    id: "r1",
    classroom: card.classroom,
    lesson: card.lesson,
    reflectId: "explain-1",
    prompt: "Explain ownership.",
    text: "Each value has one owner.",
    savedAt: 5,
  };
  const normalize = (prompt: string) =>
    prompt.replace(
      /This notification was delivered automatically; nothing was polled\.|It arrived as the result of your `wait_for_learner` call\./,
      "(delivery)",
    );

  it.each([
    ["question", (delivery: "push" | "wait") => askPrompt(card, delivery)],
    ["follow-up", (delivery: "push" | "wait") => followUpPrompt(card, followUp, delivery)],
    ["quiz", (delivery: "push" | "wait") => gradePrompt(submission, delivery)],
    [
      "reflection",
      (delivery: "push" | "wait") =>
        reflectPrompt(reflection, delivery).replace(
          /Then (continue what you were doing|call `wait_for_learner` again)\./,
          "(next)",
        ),
    ],
  ] as const)("changes only the arrival note for a %s", (_name, prompt) => {
    expect(normalize(prompt("wait"))).toBe(normalize(prompt("push")));
  });

  it.each(["push", "wait"] as const)("includes chat retrieval in %s grading", (delivery) => {
    const prompt = gradePrompt(submission, delivery);
    expect(prompt).toContain(QUIZ_FOLLOW_UP);
    expect(prompt).toContain('submission_id: "s1"');
    expect(prompt).toContain("End your turn");
    expect(prompt).toContain("Do not create or start the next lesson");
  });
});

describe("missionStub", () => {
  it("is a prompt to interview, not a filled-in mission", () => {
    const stub = missionStub("Rust");
    expect(stub).toContain("# Mission: Rust");
    expect(stub).toContain("## Why");
    expect(stub).toContain("Interview the learner");
  });
});

describe("notesStub", () => {
  it("starts NOTES.md as an index that points detail at notes/", () => {
    const stub = notesStub();
    expect(stub).toContain("## Index");
    expect(stub).toContain("`notes/<slug>.md`");
    expect(stub).toContain("NOTES-FORMAT.md");
  });
});

describe("resolveClassroom", () => {
  it("matches an existing classroom by directory name, slug, or title", () => {
    seedClassroom(fixture, { classroom: "rust-ownership", title: "Rust Ownership" });

    expect(resolveClassroom("rust-ownership")).toBe("rust-ownership");
    expect(resolveClassroom("Rust Ownership")).toBe("rust-ownership");
    expect(resolveClassroom("rust ownership")).toBe("rust-ownership");
  });

  it("returns null for a topic with no classroom yet", () => {
    seedClassroom(fixture, { classroom: "rust" });
    expect(resolveClassroom("yoga")).toBeNull();
  });

  it("continues the only classroom when /teach is given no topic", () => {
    seedClassroom(fixture, { classroom: "rust" });
    expect(resolveClassroom("")).toBe("rust");
  });

  it("stays out of it when there are several classrooms and no topic", () => {
    seedClassroom(fixture, { classroom: "rust" });
    seedClassroom(fixture, { classroom: "yoga" });
    expect(resolveClassroom("")).toBeNull();
  });
});

describe("gradePrompt", () => {
  const base: QuizSubmission = {
    id: "s1",
    classroom: "rust",
    lesson: "001-ownership",
    quizId: "check-1",
    quizTitle: "Ownership",
    kind: "check",
    attempt: 1,
    answers: [
      {
        questionId: "q1",
        type: "cloze",
        prompt: "Fill in the blank.",
        passage: "A value has one [[b1]].",
        parts: [{ id: "b1", value: "owner" }],
        confidence: "sure",
      },
    ],
    submittedAt: 4,
  };

  it("shows typed answers and ignores saved confidence metadata", () => {
    const prompt = gradePrompt(base, "push");
    expect(prompt).toContain("[q1] (cloze) Fill in the blank.");
    expect(prompt).toContain("A value has one [b1: «owner»].");
    expect(prompt).not.toContain("Their confidence");
    expect(prompt).not.toContain("misconception");
  });

  it("keeps the graded quiz locked and checks missed ideas in chat", () => {
    const prompt = gradePrompt(base, "push");
    expect(prompt).toContain("Keep the graded browser quiz locked.");
    expect(prompt).toContain("Do not ask for an immediate retake.");
    expect(prompt).toContain("Use a different example.");
    expect(prompt).toContain("Review the idea later through spaced review.");
    expect(prompt).toContain("Check their reply");
  });

  it("tells the teacher a pretest is diagnostic, with no retrieval check", () => {
    const prompt = gradePrompt({ ...base, kind: "pretest" }, "push");
    expect(prompt).toContain("**pretest**");
    expect(prompt).toContain(PRETEST_FOLLOW_UP);
    expect(prompt).not.toContain(QUIZ_FOLLOW_UP);
  });

  it("names the attempt and the previous score on a retake", () => {
    const previous = { score: 40 } as QuizGrade;
    const prompt = gradePrompt({ ...base, attempt: 2 }, "push", previous);
    expect(prompt).toContain("Attempt 2 at this quiz. The previous attempt scored 40%.");
  });

  it("still reads submissions written before question types existed", () => {
    const prompt = gradePrompt(
      {
        ...base,
        kind: undefined,
        answers: [
          { questionId: "q1", value: "a", label: "First", prompt: "Pick all." },
          { questionId: "q1", value: "c", label: "Third", prompt: "Pick all." },
        ],
      },
      "push",
    );
    expect(prompt).toContain("1. [q1] Pick all.");
    expect(prompt).toContain("Their answer: First; Third");
    expect(prompt).not.toContain("2. [q1]");
  });
});

describe("reviewStatusText", () => {
  const now = Date.UTC(2026, 0, 10);

  it("asks for a review before new material when questions are due", () => {
    const text = reviewStatusText(
      { total: 5, due: 2, dueSoon: 1, mastered: 1, nextDueAt: now + DAY_MS },
      now,
    );
    expect(text).toContain("2 are due for review now");
    expect(text).toContain("scaffold_review");
  });

  it("says when the next review is due when none are due now", () => {
    const text = reviewStatusText(
      { total: 5, due: 0, dueSoon: 1, mastered: 1, nextDueAt: now + DAY_MS },
      now,
    );
    expect(text).toContain("The next one is due tomorrow.");
    expect(text).not.toContain("scaffold_review");
  });

  it("goes into the teaching brief for an existing classroom", () => {
    seedClassroom(fixture);
    const prompt = teachingPrompt("", "rust", "## Spaced review\n\nSomething due.");
    expect(prompt).toContain("Something due.");
    expect(prompt).toContain("lesson_health");
  });
});

it("fails loudly when the required teaching method is missing", () => {
  const spy = vi.spyOn(paths, "docsDir").mockReturnValue(fixture.root);
  try {
    expect(() => teachingPrompt("rust", null)).toThrow(/TEACHING.md/);
  } finally {
    spy.mockRestore();
  }
});
