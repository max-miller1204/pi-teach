import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { resolveClassroom } from "../src/commands.js";
import { followUpPrompt, missionStub, notesStub, teachingPrompt } from "../src/prompts.js";
import type { Annotation, FollowUp } from "../src/store.js";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.js";

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
    const prompt = followUpPrompt({ ...card, followUps: [pending] }, pending);

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

    const prompt = followUpPrompt({ ...card, followUps: [earlier, asking, later] }, asking);

    expect(prompt).toContain("What about borrows?");
    expect(prompt).toContain("Many readers, one writer.");
    expect(prompt).toContain("And across threads?");
    expect(prompt).not.toContain("Asked after this one");
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
