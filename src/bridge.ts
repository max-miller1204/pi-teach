/**
 * bridge.ts — the wire between the browser and the agent running in this session.
 *
 * Two jobs:
 *
 *   1. Wake the agent when the browser asks something. `sendUserMessage` always
 *      starts a turn, so a message that lands mid-stream is queued as a follow-up
 *      rather than interrupting whatever the user is already doing.
 *
 *   2. Make sure a card never spins forever. The model is asked to reply by calling
 *      `answer_lesson_question`; if a run ends with the originating question still
 *      pending, the run's final assistant text is used instead. Origins are tracked
 *      in a FIFO aligned with agent_end, the same approach the slack-bridge
 *      extension uses to route replies back to the right thread.
 */

import { validateGrade } from "../assets/runtime/grade.mjs";
import { findLastAssistantText } from "./assistant-text.ts";
import { renderMarkdown } from "./markdown.ts";
import { askPrompt, followUpPrompt, gradePrompt, reflectPrompt } from "./prompts.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";

/** Minimal shape of the pi API this module needs, so tests can pass a stub. */
export interface MessageSender {
  sendUserMessage(text: string, options?: { deliverAs?: string }): void;
}

type Origin =
  /** `turn` is null for the card's original question, or a follow-up id. */
  { kind: "ask"; annotationId: string; turn: store.TurnId } | { kind: "other" };

export class ClassroomBridge {
  private readonly pending: Origin[] = [];
  private idle: () => boolean = () => true;

  private readonly pi: MessageSender;

  constructor(pi: MessageSender) {
    this.pi = pi;
  }

  /** Track whether the agent is mid-turn, so messages can be queued appropriately. */
  setIdleProbe(probe: () => boolean): void {
    this.idle = probe;
  }

  /** Record a turn that did not originate here, keeping the FIFO aligned. */
  noteForeignTurn(): void {
    this.pending.push({ kind: "other" });
  }

  private send(text: string): void {
    this.pi.sendUserMessage(text, this.idle() ? undefined : { deliverAs: "followUp" });
  }

  /** Ask the agent to answer a highlighted-text question. */
  ask(annotation: store.Annotation): void {
    this.pending.push({ kind: "ask", annotationId: annotation.id, turn: null });
    this.send(askPrompt(annotation, "push"));
  }

  /** Ask the agent to answer a follow-up asked inside an existing card. */
  followUp(annotation: store.Annotation, followUp: store.FollowUp): void {
    this.pending.push({ kind: "ask", annotationId: annotation.id, turn: followUp.id });
    this.send(followUpPrompt(annotation, followUp, "push"));
  }

  /** Ask the agent to grade a quiz submission. */
  grade(submission: store.QuizSubmission): void {
    // Grading has no fallback path — a half-graded quiz would be worse than none —
    // so the origin is recorded as foreign and only the tool writes a grade.
    this.pending.push({ kind: "other" });
    this.send(gradePrompt(submission, "push", store.previousGrade(submission)));
  }

  /** Show the agent a self-explanation the learner saved. Nothing is written back. */
  reflect(reflection: store.Reflection): void {
    this.pending.push({ kind: "other" });
    this.send(reflectPrompt(reflection, "push"));
  }

  /**
   * Called on agent_end. If this run was started by a question that is still
   * unanswered, fill it from the run's final assistant text.
   */
  onAgentEnd(messages: readonly unknown[]): void {
    const origin = this.pending.shift();
    if (!origin || origin.kind !== "ask") return;

    const annotation = store.findAnnotation(origin.annotationId);
    if (!annotation || !store.isTurnPending(annotation, origin.turn)) return;

    const text = findLastAssistantText(messages);
    if (text) applyTurnAnswer(origin.annotationId, origin.turn, text);
    else markFailed(origin.annotationId, origin.turn);
  }

  /** Drop queued origins — used when the session shuts down. */
  reset(): void {
    this.pending.length = 0;
  }
}

/**
 * Persist an answer for whichever turn of a card is waiting on one, and push the card to
 * any browser watching the lesson.
 */
export function applyAnswer(annotationId: string, answerMarkdown: string): store.Annotation | null {
  const annotation = store.findAnnotation(annotationId);
  if (!annotation) return null;
  return applyTurnAnswer(annotationId, store.answerTarget(annotation), answerMarkdown);
}

/** Persist an answer for one specific turn of a card. */
export function applyTurnAnswer(
  annotationId: string,
  turn: store.TurnId,
  answerMarkdown: string,
): store.Annotation | null {
  const patch = {
    status: "answered" as const,
    answerMarkdown,
    answerHtml: renderMarkdown(answerMarkdown),
    answeredAt: Date.now(),
  };
  const updated =
    turn === null
      ? store.updateAnnotation(annotationId, patch)
      : store.updateFollowUp(annotationId, turn, patch);
  if (updated) server.pushEvent(updated.classroom, updated.lesson, "answer", updated);
  return updated;
}

function markFailed(annotationId: string, turn: store.TurnId): void {
  const patch = { status: "failed" as const, answeredAt: Date.now() };
  const updated =
    turn === null
      ? store.updateAnnotation(annotationId, patch)
      : store.updateFollowUp(annotationId, turn, patch);
  if (updated) server.pushEvent(updated.classroom, updated.lesson, "answer", updated);
}

/** Persist a grade and push it to any browser watching the lesson. */
export function applyGrade(
  submission: store.QuizSubmission,
  input: {
    score: number;
    feedbackMarkdown: string;
    questions: store.QuizQuestionGrade[];
  },
): store.QuizGrade {
  const score = validateGrade(input.score, input.questions, [
    ...new Set(submission.answers.map((a) => a.questionId)),
  ]);
  const grade: store.QuizGrade = {
    submissionId: submission.id,
    classroom: submission.classroom,
    lesson: submission.lesson,
    quizId: submission.quizId,
    score,
    feedbackMarkdown: input.feedbackMarkdown,
    feedbackHtml: renderMarkdown(input.feedbackMarkdown),
    questions: input.questions.map((q) => ({
      questionId: q.questionId,
      correct: q.correct,
      pointsEarned: q.pointsEarned,
      pointsPossible: q.pointsPossible,
      feedback: q.feedback,
      feedbackHtml: renderMarkdown(q.feedback),
    })),
    gradedAt: Date.now(),
  };

  store.writeGrade(grade);
  server.pushEvent(submission.classroom, submission.lesson, "grade", { submission, grade });
  return grade;
}
