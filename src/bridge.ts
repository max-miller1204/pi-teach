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

import { randomUUID } from "node:crypto";
import { readTeacherState } from "./service-state.ts";
import {
  prepareResume,
  piResumes,
  savePiResume,
  piOwnerAlive,
  type ResumeInput,
  type PiResume,
} from "./teacher-resume.ts";
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
  kind: "quiz" | "reflect" | "chat" | "resume";
  status: "running" | "failed";
  error?: string;
  prompt: string;
  durable?: true;
}

type Origin =
  /** `turn` is null for the card's original question, or a follow-up id. */
  | { kind: "ask"; annotationId: string; turn: store.TurnId }
  | { kind: "panel"; request: PanelRequest }
  | { kind: "review"; session: ReviewSession }
  | { kind: "other" };

export class ClassroomBridge {
  private readonly pending: Origin[] = [];
  private readonly sessionId = randomUUID();
  private readonly deferredResumes = new Map<string, PiResume>();
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

  /** A resume turn can ask a question. It cannot write new assessment or evidence. */
  assertCanWrite(): void {
    const origin = this.pending[0];
    if (origin?.kind === "panel" && origin.request.kind === "resume")
      throw new Error(
        "Teacher resumption permits only a panel message. Wait for the learner's panel reply before writing evidence.",
      );
  }

  /** Queue a separate panel turn. The initiating chat keeps its foreign origin. */
  resume(input: ResumeInput): void {
    const request = prepareResume(input);
    const origin = this.pending[0];
    if (
      origin?.kind === "panel" &&
      origin.request.kind === "resume" &&
      (origin.request.id !== request.id ||
        origin.request.classroom !== request.classroom ||
        origin.request.lesson !== request.lesson)
    )
      throw new Error("A resume turn cannot start another teacher request.");
    this.requireResumeOwner(request.classroom);
    this.restoreResumes();
    if (
      [...this.panel.values()].some(
        (r) => r.classroom === request.classroom && r.lesson === request.lesson,
      )
    )
      return;
    const messages = store.listPanelMessages(request.classroom, request.lesson);
    const reply = messages.at(-1);
    if (reply?.role === "learner") {
      if (
        !reply.id.startsWith("chat:") ||
        piResumes(request.classroom).some((r) => r.id === reply.id)
      )
        throw new Error("The saved learner reply has no unfinished panel request.");
      this.startResume({
        ...request,
        id: reply.id,
        kind: "chat",
        prompt: panelReplyPrompt(request.classroom, request.lesson, reply, messages),
        status: "running",
        ownerPid: process.pid,
        ownerSession: this.sessionId,
      });
      return;
    }
    if (reply) return;
    if (piResumes(request.classroom).some((r) => r.id === request.id))
      throw new Error("The completed resume request has no saved teacher message.");
    this.startResume({
      ...request,
      kind: "resume",
      status: "running",
      ownerPid: process.pid,
      ownerSession: this.sessionId,
    });
  }

  private requireResumeOwner(classroom: string): void {
    if (readTeacherState(classroom))
      throw new Error(
        "This classroom belongs to a persistent teacher. Resume through its service.",
      );
    if (
      piResumes(classroom).some(
        (r) => r.status === "running" && r.ownerSession !== this.sessionId && piOwnerAlive(r),
      )
    )
      throw new Error("Another live Pi session owns this classroom's resume request.");
  }

  restoreResumes(): void {
    for (const classroom of store.listClassrooms())
      for (const request of piResumes(classroom.name)) {
        if (request.status === "done") continue;
        if (
          store
            .listPanelMessages(request.classroom, request.lesson)
            .some((m) => m.id === request.id && m.role === "teacher")
        ) {
          savePiResume({ ...request, status: "done" });
          continue;
        }
        if (request.status === "running" && request.ownerSession !== this.sessionId) {
          if (piOwnerAlive(request)) continue;
          request.status = "failed";
          request.error = "Pi stopped during teacher resumption. Retry this request.";
          savePiResume(request);
        }
        if (!this.panel.has(request.id))
          this.panel.set(request.id, {
            ...request,
            status: request.status as "running" | "failed",
            durable: true,
          });
      }
  }

  private startResume(request: PiResume): void {
    request.ownerPid = process.pid;
    request.ownerSession = this.sessionId;
    request.status = "running";
    delete request.error;
    savePiResume(request);
    if (this.pending.length || !this.idle()) {
      this.deferredResumes.set(request.id, request);
      this.panel.set(request.id, { ...request, status: "running", durable: true });
      this.publish(request.classroom, request.lesson);
    } else this.startPanel({ ...request, durable: true });
  }

  private persistResume(request: PanelRequest, done = false): void {
    const saved = piResumes(request.classroom).find((r) => r.id === request.id);
    if (!saved || saved.ownerSession !== this.sessionId)
      throw new Error("This Pi session does not own the resume request.");
    savePiResume({ ...saved, status: done ? "done" : request.status, error: request.error });
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
    this.restoreResumes();
    const request = this.panel.get(id);
    if (!request || request.classroom !== classroom || request.status !== "failed")
      throw new Error("This request cannot be retried.");
    if (request.durable) {
      this.requireResumeOwner(classroom);
      this.startResume(piResumes(classroom).find((r) => r.id === id)!);
    } else this.startPanel(request);
  }

  /** What the lesson page's teacher panel shows. */
  panelState(classroom: string, lesson: string): unknown {
    this.restoreResumes();
    return {
      identity: { backend: "pi" },
      requests: [...this.panel.values()]
        .filter((r) => r.classroom === classroom && r.lesson === lesson)
        .map((r) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error })),
      messages: store.listPanelMessages(classroom, lesson).map(withHtml),
    };
  }

  private startPanel(input: Omit<PanelRequest, "status" | "error">): void {
    const request: PanelRequest = { ...input, status: "running" };
    const { classroom, lesson } = request;
    this.panel.set(request.id, request);
    const origin: Origin = { kind: "panel", request };
    this.pending.push(origin);
    this.publish(request.classroom, request.lesson);
    try {
      this.send(request.prompt);
    } catch (err) {
      this.pending.splice(this.pending.indexOf(origin), 1);
      request.status = "failed";
      request.error = `Pi could not start teacher work: ${(err as Error).message}`;
      if (request.durable) this.persistResume(request);
      this.publish(classroom, lesson);
      throw err;
    }
  }

  private publish(classroom: string, lesson: string): void {
    server.pushEvent(classroom, lesson, "teacher", this.panelState(classroom, lesson));
  }

  /**
   * Called on agent_end. If this run was started by a question that is still
   * unanswered, fill it from the run's final assistant text.
   */
  onAgentEnd(messages: readonly unknown[]): void {
    try {
      this.finishOrigin(messages);
    } finally {
      if (!this.pending.length) {
        const request = this.deferredResumes.values().next().value;
        if (request) {
          this.deferredResumes.delete(request.id);
          this.startPanel({ ...request, durable: true });
        }
      }
    }
  }

  private finishOrigin(messages: readonly unknown[]): void {
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
    if (request.durable) this.persistResume(request, !this.panel.has(request.id));
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
    for (const request of this.panel.values())
      if (request.durable && request.status === "running") {
        request.status = "failed";
        request.error = "Pi stopped during teacher resumption. Retry this request.";
        this.persistResume(request);
      }
    this.deferredResumes.clear();
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
