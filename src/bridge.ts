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
 *
 * Runs that have no card (a grade, a self-explanation, a reply in the teacher panel)
 * post their final assistant text to the lesson's teacher panel, so the learner never
 * has to come back to the terminal for a retrieval question.
 */

import { validateGrade } from "../assets/runtime/grade.mjs";
import { findLastAssistantText } from "./assistant-text.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  askPrompt,
  followUpPrompt,
  gradePrompt,
  panelReplyPrompt,
  reflectPrompt,
  reviewPrompt,
} from "./prompts.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";

import {
  readReviewDocument,
  reviewSessions,
  requireReviewOwner,
  updateReview,
  publishReview,
  type ReviewSession,
} from "./review-session.ts";

/** Minimal shape of the pi API this module needs, so tests can pass a stub. */
export interface MessageSender {
  sendUserMessage(text: string, options?: { deliverAs?: string }): void;
}

/** A run whose final text belongs in a lesson's teacher panel. */
interface PanelRequest {
  id: string;
  classroom: string;
  lesson: string;
  kind: "quiz" | "reflect" | "chat";
  status: "running" | "failed";
  error?: string;
  prompt: string;
}

type Origin =
  /** `turn` is null for the card's original question, or a follow-up id. */
  | { kind: "ask"; annotationId: string; turn: store.TurnId }
  | { kind: "panel"; request: PanelRequest }
  | { kind: "review"; session: ReviewSession }
  | { kind: "other" };

export class ClassroomBridge {
  private readonly pending: Origin[] = [];
  /** Panel runs not yet finished, or finished with nothing to say. */
  private readonly panel = new Map<string, PanelRequest>();
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
    // so only the tool writes a grade. The run's final text is the feedback and the
    // retrieval question, and it goes to the teacher panel, never into the grade.
    this.startPanel({
      id: `quiz:${submission.id}`,
      classroom: submission.classroom,
      lesson: submission.lesson,
      kind: "quiz",
      prompt: gradePrompt(submission, "push", store.previousGrade(submission)),
    });
  }

  /** Show the agent a self-explanation the learner saved. Its reply goes to the panel. */
  reflect(reflection: store.Reflection): void {
    this.startPanel({
      id: `reflect:${reflection.id}`,
      classroom: reflection.classroom,
      lesson: reflection.lesson,
      kind: "reflect",
      prompt: reflectPrompt(reflection, "push"),
    });
  }

  /**
   * The learner replied in the teacher panel. `id` comes from the page and stays the
   * same when it resends after a network error, so a resend never wakes the agent twice.
   */
  chat(classroom: string, lesson: string, text: string, id: string): void {
    const { message, added } = store.addPanelMessage(classroom, {
      id: `chat:${id}`,
      lesson,
      role: "learner",
      text,
    });
    if (!added) return;
    this.startPanel({
      id: message.id,
      classroom,
      lesson,
      kind: "chat",
      prompt: panelReplyPrompt(
        classroom,
        lesson,
        message,
        store.listPanelMessages(classroom, lesson),
      ),
    });
  }

  /** Author a browser review in the live Pi session. */
  review(session: ReviewSession): void {
    requireReviewOwner(session, "pi");
    if (session.status !== "queued") return;
    const prompt = reviewPrompt(session, "push");
    updateReview(session, "running");
    const origin: Origin = { kind: "review", session };
    this.pending.push(origin);
    try {
      this.send(prompt);
    } catch (err) {
      this.pending.splice(this.pending.indexOf(origin), 1);
      updateReview(session, "failed", (err as Error).message);
      throw err;
    }
  }
  retryReview(session: ReviewSession): void {
    requireReviewOwner(session, "pi");
    if (session.status !== "failed") throw new Error("This review cannot be retried.");
    updateReview(session, "queued");
    this.review({ ...session, status: "queued" });
  }
  restoreReviews(): void {
    for (const classroom of store.listClassrooms())
      for (const session of reviewSessions(classroom.name))
        if (
          session.owner === "pi" &&
          (session.status === "queued" || session.status === "running")
        ) {
          try {
            process.kill(session.ownerPid, 0);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
            updateReview(
              session,
              "failed",
              "Pi stopped during review creation. Retry this review.",
            );
          }
        }
  }

  /** Send a panel run again after it ended with nothing to say. */
  retry(classroom: string, id: string): void {
    const request = this.panel.get(id);
    if (!request || request.classroom !== classroom || request.status !== "failed")
      throw new Error("This request cannot be retried.");
    this.startPanel(request);
  }

  /** What the lesson page's teacher panel shows. */
  panelState(classroom: string, lesson: string): unknown {
    return {
      identity: { backend: "pi" },
      requests: [...this.panel.values()]
        .filter((r) => r.classroom === classroom && r.lesson === lesson)
        .map((r) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error })),
      messages: store.listPanelMessages(classroom, lesson).map(withHtml),
    };
  }

  private startPanel(input: Omit<PanelRequest, "status" | "error">): void {
    const { id, classroom, lesson, kind, prompt } = input;
    const request: PanelRequest = { id, classroom, lesson, kind, prompt, status: "running" };
    this.panel.set(request.id, request);
    this.pending.push({ kind: "panel", request });
    this.publish(request.classroom, request.lesson);
    this.send(request.prompt);
  }

  private publish(classroom: string, lesson: string): void {
    server.pushEvent(classroom, lesson, "teacher", this.panelState(classroom, lesson));
  }

  /**
   * Called on agent_end. If this run was started by a question that is still
   * unanswered, fill it from the run's final assistant text.
   */
  onAgentEnd(messages: readonly unknown[]): void {
    const origin = this.pending.shift();
    if (origin?.kind === "review") {
      try {
        publishReview(origin.session, readReviewDocument(origin.session));
        updateReview(origin.session, "done");
      } catch (err) {
        updateReview(
          origin.session,
          "failed",
          `Pi review creation failed: ${(err as Error).message}`,
        );
      }
      return;
    }
    if (origin?.kind === "panel") return this.finishPanel(origin.request, messages);
    if (!origin || origin.kind !== "ask") return;

    const annotation = store.findAnnotation(origin.annotationId);
    if (!annotation || !store.isTurnPending(annotation, origin.turn)) return;

    const text = findLastAssistantText(messages);
    if (text) applyTurnAnswer(origin.annotationId, origin.turn, text);
    else markFailed(origin.annotationId, origin.turn);
  }

  /** Post a panel run's final text to the lesson's teacher panel. */
  private finishPanel(request: PanelRequest, messages: readonly unknown[]): void {
    const text = findLastAssistantText(messages);
    if (request.kind === "quiz" && !graded(request)) {
      request.status = "failed";
      request.error = "Your teacher finished without grading this quiz.";
    } else if (text) {
      store.addPanelMessage(request.classroom, {
        id: request.id,
        lesson: request.lesson,
        role: "teacher",
        text,
      });
      this.panel.delete(request.id);
    } else if (request.kind === "quiz" && graded(request)) {
      // The grade and its feedback are on the quiz. A retry would grade it again.
      this.panel.delete(request.id);
    } else {
      request.status = "failed";
      request.error = "Your teacher finished without a reply.";
    }
    this.publish(request.classroom, request.lesson);
  }

  /** Drop queued origins — used when the session shuts down. */
  reset(): void {
    for (const origin of this.pending)
      if (origin.kind === "review")
        updateReview(
          origin.session,
          "failed",
          "Pi stopped during review creation. Retry this review.",
        );
    this.pending.length = 0;
    this.panel.clear();
  }
}

function graded(request: PanelRequest): boolean {
  const submissionId = request.id.slice("quiz:".length);
  return store
    .listGrades(request.classroom, request.lesson)
    .some((g) => g.submissionId === submissionId);
}

/** A panel message with its markdown rendered, for a teacher message. */
export function withHtml<T extends { role: string; text: string }>(
  message: T,
): T & { html?: string } {
  return message.role === "teacher" ? { ...message, html: renderMarkdown(message.text) } : message;
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
  server.pushEvent(submission.classroom, submission.lesson, "grade", {
    submission: store.publicSubmission(submission),
    grade,
  });
  return grade;
}
