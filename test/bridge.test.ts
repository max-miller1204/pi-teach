import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ClassroomBridge, applyAnswer, applyGrade, applyTurnAnswer } from "../src/bridge.ts";
import * as store from "../src/store.ts";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let sent: Array<{ text: string; options?: { deliverAs?: string } }>;
let bridge: ClassroomBridge;

const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };

function ask(question = "Why only one?"): store.Annotation {
  return store.createAnnotation({
    classroom: "rust",
    lesson: "001-ownership",
    question,
    selection: "one owner",
    anchor,
  });
}

/** An asked-and-answered card, ready for a follow-up. */
function answeredCard(question = "Why only one?", answer = "Because aliasing."): store.Annotation {
  const annotation = ask(question);
  applyAnswer(annotation.id, answer);
  return store.findAnnotation(annotation.id)!;
}

function assistantRun(text: string): unknown[] {
  return [
    { role: "user", content: "…" },
    { role: "assistant", content: [{ type: "text", text }] },
  ];
}

beforeEach(() => {
  fixture = makeFixture();
  seedClassroom(fixture);
  sent = [];
  bridge = new ClassroomBridge({
    sendUserMessage: (text, options) => sent.push({ text, options }),
  });
});

afterEach(() => {
  fixture.cleanup();
});

describe("waking the agent", () => {
  it("sends a self-contained question prompt naming the tool that answers it", () => {
    const annotation = ask();
    bridge.ask(annotation);

    expect(sent).toHaveLength(1);
    const { text } = sent[0];
    expect(text).toContain(annotation.id);
    expect(text).toContain("answer_lesson_question");
    expect(text).toContain("Why only one?");
    expect(text).toContain("one owner");
    expect(text).toContain("rust");
  });

  it("interrupts nothing when the agent is mid-turn", () => {
    bridge.setIdleProbe(() => false);
    bridge.ask(ask());
    expect(sent[0].options).toEqual({ deliverAs: "followUp" });

    bridge.setIdleProbe(() => true);
    bridge.ask(ask());
    expect(sent[1].options).toBeUndefined();
  });

  it("sends the whole thread when a follow-up arrives, so it can be answered in context", () => {
    const card = answeredCard("Why only one?", "Because two owners could double-free.");
    const followUp = store.addFollowUp(card.id, "What about borrows?")!;

    bridge.followUp(followUp.annotation, followUp.followUp);

    const { text } = sent[0];
    expect(text).toContain(card.id);
    expect(text).toContain("answer_lesson_question");
    expect(text).toContain("Why only one?"); // the earlier turn
    expect(text).toContain("double-free"); // and the answer it already gave
    expect(text).toContain("What about borrows?"); // the new question
  });

  it("shows the teacher a saved self-explanation and records a foreign origin", () => {
    const reflection = store.createReflection({
      classroom: "rust",
      lesson: "001-ownership",
      reflectId: "explain-1",
      prompt: "Explain ownership.",
      text: "Each value has exactly one owner.",
    });
    bridge.reflect(reflection);
    expect(sent[0].text).toContain("Each value has exactly one owner.");
    expect(sent[0].text).toContain("Do not grade it");
    // The reflection run is not an ask, so its final text never fills a card.
    const card = ask();
    bridge.onAgentEnd(assistantRun("Noted."));
    expect(store.findAnnotation(card.id)!.status).toBe("pending");
  });

  it("sends the learner's answers inline when asking for a grade", () => {
    const submission = store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check on learning",
      kind: "check",
      answers: [
        { questionId: "q1", value: "a", label: "Borrow checker", prompt: "What rejects it?" },
      ],
    });

    bridge.grade(submission);
    const { text } = sent[0];
    expect(text).toContain(submission.id);
    expect(text).toContain("grade_lesson_quiz");
    expect(text).toContain("What rejects it?");
    expect(text).toContain("Borrow checker");
  });
});

describe("agent_end fallback", () => {
  it("fills a card the model answered in prose instead of via the tool", () => {
    const annotation = ask();
    bridge.ask(annotation);

    bridge.onAgentEnd(assistantRun("Because two owners could free the same value twice."));

    const stored = store.findAnnotation(annotation.id)!;
    expect(stored.status).toBe("answered");
    expect(stored.answerMarkdown).toContain("free the same value twice");
    expect(stored.answerHtml).toContain("<p>");
  });

  it("leaves an answer the tool already wrote alone", () => {
    const annotation = ask();
    bridge.ask(annotation);
    applyAnswer(annotation.id, "The real answer.");

    bridge.onAgentEnd(assistantRun("Done — I've answered that in the card."));

    expect(store.findAnnotation(annotation.id)!.answerMarkdown).toBe("The real answer.");
  });

  it("marks the card failed rather than spinning forever when a run says nothing", () => {
    const annotation = ask();
    bridge.ask(annotation);

    bridge.onAgentEnd([{ role: "user", content: "…" }]);

    expect(store.findAnnotation(annotation.id)!.status).toBe("failed");
  });

  it("attributes each run to the question that started it, not the previous one", () => {
    const first = ask("First question");
    const second = ask("Second question");

    bridge.ask(first);
    bridge.ask(second);

    bridge.onAgentEnd(assistantRun("Answer to the first."));
    bridge.onAgentEnd(assistantRun("Answer to the second."));

    expect(store.findAnnotation(first.id)!.answerMarkdown).toBe("Answer to the first.");
    expect(store.findAnnotation(second.id)!.answerMarkdown).toBe("Answer to the second.");
  });

  it("does not attribute a typed turn's reply to a pending question", () => {
    const annotation = ask();
    bridge.noteForeignTurn(); // the user typed something first
    bridge.ask(annotation);

    bridge.onAgentEnd(assistantRun("Reply to whatever the user typed."));
    expect(store.findAnnotation(annotation.id)!.status).toBe("pending");

    bridge.onAgentEnd(assistantRun("Reply to the highlighted question."));
    expect(store.findAnnotation(annotation.id)!.answerMarkdown).toBe(
      "Reply to the highlighted question.",
    );
  });

  it("fills a follow-up from prose without disturbing the answer above it", () => {
    const card = answeredCard("Why only one?", "Because two owners could double-free.");
    const followUp = store.addFollowUp(card.id, "What about borrows?")!;
    bridge.followUp(followUp.annotation, followUp.followUp);

    bridge.onAgentEnd(assistantRun("Borrows are temporary and non-owning."));

    const stored = store.findAnnotation(card.id)!;
    expect(stored.answerMarkdown).toBe("Because two owners could double-free.");
    expect(stored.followUps![0]).toMatchObject({ status: "answered" });
    expect(stored.followUps![0].answerMarkdown).toContain("non-owning");
    expect(stored.followUps![0].answerHtml).toContain("<p>");
  });

  it("marks only the follow-up failed when a follow-up run says nothing", () => {
    const card = answeredCard();
    const followUp = store.addFollowUp(card.id, "And?")!;
    bridge.followUp(followUp.annotation, followUp.followUp);

    bridge.onAgentEnd([{ role: "user", content: "…" }]);

    const stored = store.findAnnotation(card.id)!;
    expect(stored.status).toBe("answered");
    expect(stored.followUps![0].status).toBe("failed");
  });

  it("leaves a follow-up the tool already answered alone", () => {
    const card = answeredCard();
    const followUp = store.addFollowUp(card.id, "And?")!;
    bridge.followUp(followUp.annotation, followUp.followUp);
    applyAnswer(card.id, "The real follow-up answer."); // routed to the pending turn

    bridge.onAgentEnd(assistantRun("Done — answered in the card."));

    expect(store.findAnnotation(card.id)!.followUps![0].answerMarkdown).toBe(
      "The real follow-up answer.",
    );
  });

  it("never invents a grade from prose — grading only happens through the tool", () => {
    const submission = store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check",
      kind: "check",
      answers: [{ questionId: "q1", value: "a" }],
    });

    bridge.grade(submission);
    bridge.onAgentEnd(assistantRun("Looks like about 80% to me."));

    expect(store.listGrades("rust", "001-ownership")).toEqual([]);
  });

  it("ignores an agent_end with no queued origin at all", () => {
    expect(() => bridge.onAgentEnd(assistantRun("Unrelated turn."))).not.toThrow();
  });
});

describe("applyAnswer routing", () => {
  it("answers the pending follow-up rather than overwriting the original answer", () => {
    const card = answeredCard("Why only one?", "Because aliasing.");
    store.addFollowUp(card.id, "What about borrows?");

    applyAnswer(card.id, "Many readers, one writer.");

    const stored = store.findAnnotation(card.id)!;
    expect(stored.answerMarkdown).toBe("Because aliasing.");
    expect(stored.followUps![0].answerMarkdown).toBe("Many readers, one writer.");
  });

  it("can be pointed at one specific turn", () => {
    const card = answeredCard();
    const first = store.addFollowUp(card.id, "First")!.followUp;
    const second = store.addFollowUp(card.id, "Second")!.followUp;

    applyTurnAnswer(card.id, second.id, "Answer to the second.");

    const stored = store.findAnnotation(card.id)!;
    expect(stored.followUps![0].status).toBe("pending");
    expect(stored.followUps![0].id).toBe(first.id);
    expect(stored.followUps![1].answerMarkdown).toBe("Answer to the second.");
  });

  it("returns null for a card that no longer exists", () => {
    expect(applyAnswer("nope", "orphaned")).toBeNull();
  });
});

describe("applyGrade", () => {
  it("clamps the score and renders every piece of feedback to HTML", () => {
    const submission = store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check",
      kind: "check",
      answers: [{ questionId: "q1", value: "a" }],
    });

    const grade = applyGrade(submission, {
      score: 140,
      feedbackMarkdown: "Solid **work**.",
      questions: [{ questionId: "q1", correct: true, feedback: "Exactly `right`." }],
    });

    expect(grade.score).toBe(100);
    expect(grade.feedbackHtml).toContain("<strong>work</strong>");
    expect(grade.questions[0].feedbackHtml).toContain("<code>right</code>");
    expect(store.listGrades("rust", "001-ownership")).toHaveLength(1);
  });
});
