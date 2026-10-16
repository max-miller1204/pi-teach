/** Run one request at a time for each classroom. Persist plans before writes. */
import { prepareResume, piResumes, piOwnerAlive, type ResumeInput } from "./teacher-resume.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { applyTurnAnswer, withHtml } from "./bridge.ts";
import { classroomDir, lessonDir, safeStaticFile } from "./paths.ts";
import { stageLesson } from "./pretest.ts";
import { validateGrade } from "../assets/runtime/grade.mjs";
import { answerGradingTool, GRADE_ANSWERS, scoredAnswers } from "./teacher-grading.ts";
import {
  askPrompt,
  followUpPrompt,
  gradePrompt,
  reflectPrompt,
  dedicatedTeacherPrompt,
  reviewPrompt,
} from "./prompts.ts";
import * as store from "./store.ts";
import * as server from "./server.ts";
import { classroomTools, isFailure, PI_HOST } from "./tools.ts";
import {
  readTeacherState,
  saveTeacherState,
  type TeacherRequest,
  type TeacherState,
} from "./service-state.ts";
import {
  runTeacher,
  type Backend,
  type RunTeacher,
  type PlanContract,
  type TeacherPlan,
  parsePlan,
} from "./teacher.ts";

import {
  reviewSessions,
  requireReviewOwner,
  updateReview,
  publishReview,
  validateReview,
  type ReviewDocument,
  type ReviewSession,
} from "./review-session.ts";

export class TeacherService {
  private readonly states = new Map<string, TeacherState>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly run: RunTeacher;
  private stopping = false;
  private readonly controllers = new Set<AbortController>();
  constructor(run: RunTeacher = runTeacher) {
    this.run = run;
  }

  attach(classroom: string, backend?: Backend): void {
    if (!store.readClassroom(classroom)) throw new Error(`No such classroom: ${classroom}`);
    if (piResumes(classroom).some((r) => r.status === "running" && piOwnerAlive(r)))
      throw new Error("A live Pi session owns this classroom's resume request.");
    let state = this.states.get(classroom) ?? readTeacherState(classroom);
    if (!state) {
      if (!backend)
        throw new Error("Select teacher_backend codex or claude. The initiating host is unknown.");
      state = { version: 1, identity: { backend }, requests: [], messages: [] };
    } else if (backend && backend !== state.identity.backend) {
      throw new Error(
        `Classroom ${classroom} belongs to ${state.identity.backend}. It cannot attach to ${backend}.`,
      );
    }
    if (!this.states.has(classroom)) {
      for (const r of state.requests)
        if (r.status === "running") {
          r.status = "failed";
          r.error = "Service stopped during teacher work. Retry this request.";
          if (r.kind === "review") updateReview(this.reviewSession(r), "failed", r.error);
        }
      this.states.set(classroom, state);
    }
    saveTeacherState(classroom, state);
    this.recover(classroom);
    this.wake(classroom);
  }
  restore(): void {
    for (const c of store.listClassrooms()) if (readTeacherState(c.name)) this.attach(c.name);
  }
  connect(): void {
    server.setHooks({
      delivery: "service",
      reviewOwner: "service",
      onAsk: (a) => this.question(a),
      onFollowUp: (a, f) => this.followUp(a, f),
      onQuizSubmit: (s) => this.submission(s),
      onReflect: (r) => this.reflection(r),
      teacherState: (classroom, lesson) => this.publicState(classroom, lesson),
      onTeacherChat: (classroom, lesson, text, id) => this.chat(classroom, lesson, text, id),
      onTeacherRetry: (classroom, id) => this.retry(classroom, id),
      onReview: (session) => this.review(session),
      onReviewRetry: (session) => {
        if (
          this.states.get(session.classroom)?.requests.some((r) => r.id === `review:${session.id}`)
        )
          this.retry(session.classroom, `review:${session.id}`);
        else {
          updateReview(session, "queued");
          this.review({ ...session, status: "queued" });
        }
      },
      canAccept: (classroom) => {
        if (!this.states.has(classroom))
          throw new Error("No teacher owns this classroom. Call open_classroom first.");
      },
    });
  }
  private enqueue(r: Omit<TeacherRequest, "status" | "at">): void {
    const state = this.states.get(r.classroom);
    if (!state) throw new Error(`No teacher owns classroom ${r.classroom}.`);
    if (state.requests.some((x) => x.id === r.id)) return;
    state.requests.push({ ...r, status: "queued", at: Date.now() });
    saveTeacherState(r.classroom, state);
    this.publish(r.classroom, r.lesson);
    this.wake(r.classroom);
  }
  question(a: store.Annotation): void {
    this.enqueue({
      id: `ask:${a.id}`,
      classroom: a.classroom,
      lesson: a.lesson,
      kind: "ask",
      target: a.id,
      prompt: askPrompt(a, "service"),
    });
  }
  followUp(a: store.Annotation, f: store.FollowUp): void {
    this.enqueue({
      id: `follow-up:${f.id}`,
      classroom: a.classroom,
      lesson: a.lesson,
      kind: "follow-up",
      target: a.id,
      turn: f.id,
      prompt: followUpPrompt(a, f, "service"),
    });
  }
  submission(s: store.QuizSubmission): void {
    this.enqueue({
      id: `quiz:${s.id}`,
      classroom: s.classroom,
      lesson: s.lesson,
      kind: "quiz",
      target: s.id,
      prompt: gradePrompt(s, "service", store.previousGrade(s)),
    });
  }
  reflection(r: store.Reflection): void {
    this.enqueue({
      id: `reflect:${r.id}`,
      classroom: r.classroom,
      lesson: r.lesson,
      kind: "reflect",
      target: r.id,
      prompt: reflectPrompt(r, "service"),
    });
  }
  private reviewSession(request: TeacherRequest): ReviewSession {
    const session = reviewSessions(request.classroom).find((s) => s.id === request.target);
    if (!session || session.lesson !== request.lesson)
      throw new Error("The review request no longer exists.");
    requireReviewOwner(session, "service");
    return session;
  }
  review(session: ReviewSession): void {
    requireReviewOwner(session, "service");
    if (this.states.get(session.classroom)?.requests.some((r) => r.id === `review:${session.id}`))
      return;
    this.enqueue({
      id: `review:${session.id}`,
      classroom: session.classroom,
      lesson: session.lesson,
      kind: "review",
      target: session.id,
      prompt: reviewPrompt(session, "service"),
    });
    if (session.status === "failed") {
      const state = this.states.get(session.classroom)!;
      const request = state.requests.find((r) => r.id === `review:${session.id}`)!;
      request.status = "failed";
      request.error = session.error;
      saveTeacherState(session.classroom, state);
    }
  }
  private recover(classroom: string): void {
    for (const session of reviewSessions(classroom)) {
      if (session.owner !== "service" || session.status === "done") continue;
      this.review(session);
    }
    for (const l of store.listLessons(classroom)) {
      for (const a of store.listAnnotations(classroom, l.name)) {
        if (a.status === "pending") this.question(a);
        for (const f of a.followUps ?? []) if (f.status === "pending") this.followUp(a, f);
      }
      for (const s of store.listSubmissions(classroom, l.name))
        if (!store.listGrades(classroom, l.name).some((g) => g.submissionId === s.id))
          this.submission(s);
      for (const r of store.listReflections(classroom, l.name)) this.reflection(r);
    }
  }
  chat(classroom: string, lesson: string, text: string, id: string): void {
    const state = this.states.get(classroom);
    if (!state) throw new Error("No classroom teacher. Call open_classroom first.");
    const key = `chat:${id}`;
    if (!state.messages.some((m) => m.id === key)) {
      state.messages.push({
        id: key,
        lesson,
        role: "learner",
        text,
        at: this.nextMessageAt(classroom, lesson, state),
      });
      saveTeacherState(classroom, state);
    }
    this.enqueue({
      id: key,
      classroom,
      lesson,
      kind: "chat",
      target: id,
      prompt: `The learner replied in the teacher panel:\n${text}`,
    });
  }
  resume(input: ResumeInput): void {
    const request = prepareResume(input);
    const state = this.states.get(request.classroom);
    if (!state) throw new Error("No classroom teacher. Call open_classroom first.");
    if (piResumes(request.classroom).some((r) => r.status === "running" && piOwnerAlive(r)))
      throw new Error("A live Pi session owns this classroom's resume request.");
    if (state.requests.some((r) => r.lesson === request.lesson && r.status !== "done")) return;
    const reply = this.messages(request.classroom, request.lesson, state).at(-1);
    if (reply?.role === "learner") {
      if (!reply.id.startsWith("chat:") || state.requests.some((r) => r.id === reply.id))
        throw new Error("The saved learner reply has no unfinished panel request.");
      // Preserve the actual reply when it comes from historical Pi storage.
      const existing = state.messages.find((m) => m.id === reply.id && m.role === "learner");
      if (existing && (existing.lesson !== request.lesson || existing.text !== reply.text))
        throw new Error("The saved reply ID belongs to a different panel message.");
      if (!existing) {
        state.messages.push(reply);
        saveTeacherState(request.classroom, state);
      }
      this.enqueue({
        id: reply.id,
        classroom: request.classroom,
        lesson: request.lesson,
        kind: "chat",
        target: reply.id.slice("chat:".length),
        prompt: `The learner replied in the teacher panel:\n${reply.text}`,
      });
      return;
    }
    if (reply) return;
    if (state.requests.some((r) => r.id === request.id))
      throw new Error("The completed resume request has no saved teacher message.");
    this.enqueue({ ...request, kind: "resume", target: input.submission_id });
  }
  retry(classroom: string, id: string): void {
    const state = this.states.get(classroom),
      r = state?.requests.find((r) => r.id === id);
    if (!state || !r || r.status !== "failed") throw new Error("This request cannot be retried.");
    if (r.kind === "quiz" && r.plan && !(r.applied ?? 0)) {
      const submission = store.findSubmission(r.target);
      if (submission?.rubricDigest && r.planRubricDigest !== submission.rubricDigest) {
        delete r.plan;
        delete r.planRubricDigest;
      }
      if (r.plan && submission) {
        try {
          const call = r.plan.calls.find(
            (call) => call.name === (r.planVersion === 2 ? GRADE_ANSWERS : "grade_lesson_quiz"),
          );
          if (!call) throw new Error("The saved plan has no grade call.");
          const supplied = JSON.parse(call.arguments_json);
          const args = r.planVersion === 2 ? scoredAnswers(supplied) : supplied;
          validateGrade(
            args.score,
            args.questions.map(
              (q: {
                question_id: string;
                correct: boolean;
                points_earned?: number;
                points_possible?: number;
              }) => ({
                questionId: q.question_id,
                correct: q.correct,
                pointsEarned: q.points_earned,
                pointsPossible: q.points_possible,
              }),
            ),
            [...new Set(submission.answers.map((answer) => answer.questionId))],
          );
        } catch {
          delete r.plan;
        }
      }
    }
    if (r.kind === "review" && r.plan) {
      try {
        validateReview(this.reviewSession(r), this.reviewDocument(r.plan));
      } catch {
        delete r.plan;
      }
    }
    if (r.kind !== "review" && r.plan && r.planValidated !== true && !(r.applied ?? 0))
      delete r.plan;
    if (!r.plan && r.error)
      r.prompt += `\n\nPrevious teacher plan error: ${r.error}\nCorrect it in the new plan.`;
    r.status = r.plan ? "planned" : "queued";
    if (r.kind === "review") updateReview(this.reviewSession(r), "queued");
    delete r.error;
    saveTeacherState(classroom, state);
    this.publish(classroom, r.lesson);
    this.wake(classroom);
  }
  /** Include saved Pi conversation when a classroom moves to a persistent host. */
  private messages(
    classroom: string,
    lesson: string,
    state: TeacherState,
  ): (store.PanelMessage & { sourceBackend?: "pi" })[] {
    const current = state.messages.filter((m) => m.lesson === lesson);
    const history = store
      .listPanelMessages(classroom, lesson)
      .filter((m) => !current.some((existing) => existing.id === m.id && existing.role === m.role))
      .map((m) => ({ ...m, sourceBackend: "pi" as const }));
    return [...history, ...current].sort((a, b) => a.at - b.at);
  }
  /** Keep replies after saved messages if the clock has moved back. */
  private nextMessageAt(classroom: string, lesson: string, state: TeacherState): number {
    const previous = this.messages(classroom, lesson, state).at(-1);
    return previous ? Math.max(Date.now(), previous.at + 1) : Date.now();
  }
  publicState(classroom: string, lesson: string): unknown {
    const state = this.states.get(classroom);
    if (!state) return null;
    return {
      identity: state.identity,
      requests: state.requests
        .filter((r) => r.lesson === lesson)
        .map((r) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error })),
      messages: this.messages(classroom, lesson, state).map(withHtml),
    };
  }
  private publish(classroom: string, lesson: string): void {
    server.pushEvent(classroom, lesson, "teacher", this.publicState(classroom, lesson));
  }
  private wake(classroom: string): void {
    if (this.stopping || this.active.has(classroom)) return;
    // Defer execution until the request is fully saved and its HTTP response can finish.
    const work = Promise.resolve()
      .then(() => this.drain(classroom))
      .finally(() => {
        this.active.delete(classroom);
      });
    this.active.set(classroom, work);
  }
  async idle(): Promise<void> {
    await Promise.all(this.active.values());
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    await this.idle();
  }
  private contract(r: TeacherRequest): PlanContract {
    switch (r.kind) {
      case "quiz":
        return { operations: [GRADE_ANSWERS], required: true, messageRequired: true };
      case "ask":
      case "follow-up":
        return { operations: ["answer_lesson_question"], required: true };
      case "review":
        return { operations: ["publish_review"], required: true, messageRequired: true };
      case "chat":
        return {
          operations: ["record_retrieval_check"],
          messageRequired: true,
          notesAllowed: true,
        };
      case "reflect":
        return { operations: [], messageRequired: true, notesAllowed: true };
      case "resume":
        return { operations: [], messageRequired: true };
    }
  }
  private prompt(r: TeacherRequest, state: TeacherState): string {
    if (r.kind === "review") return r.prompt;
    const lesson = store.readLesson(r.classroom, r.lesson);
    if (!lesson) throw new Error("The request lesson no longer exists.");
    const rubric = path.join(lessonDir(r.classroom, r.lesson), "quiz", "key.json");
    if (r.kind === "quiz" && !fs.existsSync(rubric))
      throw new Error("Private quiz rubric is missing. Write quiz/key.json before grading.");
    const privateRubric = fs.existsSync(rubric) ? fs.readFileSync(rubric, "utf8") : null;
    if (r.kind === "quiz") {
      const submission = store.findSubmission(r.target);
      if (!submission) throw new Error("The submitted quiz no longer exists.");
      const digest = createHash("sha256").update(privateRubric!).digest("hex");
      if (submission.rubricDigest && digest !== submission.rubricDigest)
        throw new Error(
          "The private rubric changed after submission. Restore it before teacher work.",
        );
      r.planRubricDigest = digest;
    }
    const classroomDocs = store.listClassroomDocs(r.classroom).map((file) => ({
      file,
      text: fs.readFileSync(path.join(classroomDir(r.classroom), file), "utf8"),
    }));
    const index = classroomDocs.find((doc) => doc.file === "NOTES.md");
    const links = [
      ...new Set(
        [...(index?.text ?? "").matchAll(/\[[^\]]*\]\((notes\/[a-z0-9.-]+\.md)(?:#[^)]*)?\)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    const topicNotes = links.map((file) => {
      const target = safeStaticFile(classroomDir(r.classroom), file);
      if (!target) throw new Error(`Indexed teacher note is missing or unsafe: ${file}.`);
      return { file, text: fs.readFileSync(target, "utf8") };
    });
    const staged = stageLesson(
      fs.readFileSync(lesson.htmlPath, "utf8"),
      new Set(
        store
          .latestQuizStates(r.classroom, r.lesson)
          .filter((s) => s.submission.kind === "pretest" && s.grade)
          .map((s) => s.quizId),
      ),
    );
    const context = {
      lesson: staged.html,
      lessonStage: {
        gatedPretests: staged.gatedPretests,
        pendingPretests: staged.pendingPretests,
      },
      privateRubric,
      teachingPlan: r.kind === "quiz" ? store.findSubmission(r.target)?.teachingPlan : undefined,
      records: store.readLearningRecords(r.classroom),
      messages: this.messages(r.classroom, r.lesson, state),
      grades: store.latestGrades(r.classroom, r.lesson),
      reviewItems: store.lessonReviewItems(r.classroom, r.lesson),
      classroomDocs,
      topicNotes,
    };
    const contract = this.contract(r);
    const defs = classroomTools(PI_HOST)
      .map((tool) => (tool.name === "grade_lesson_quiz" ? answerGradingTool(tool) : tool))
      .filter((t) => contract.operations.includes(t.name));
    return dedicatedTeacherPrompt(
      r.id,
      `Current request kind: ${r.kind}. ${contract.required ? "Return exactly one call from the tool definitions." : contract.operations.length ? "Return only retrieval calls supported by this learner reply. Otherwise return calls=[]." : "Return calls=[]."}\n\n${r.prompt}`,
      context,
      defs.map((t) => {
        const parameters = structuredClone(t.parameters);
        if (t.name === "record_retrieval_check") {
          delete (parameters.properties as Record<string, unknown>).learning_record;
          parameters.required = (parameters.required as string[]).filter(
            (key) => key !== "learning_record",
          );
        }
        return { name: t.name, description: t.description, parameters };
      }),
    );
  }
  private async drain(classroom: string): Promise<void> {
    const state = this.states.get(classroom)!;
    while (!this.stopping) {
      const r = state.requests.find((r) => r.status === "queued" || r.status === "planned");
      if (!r) return;
      r.startedAt = Date.now();
      delete r.finishedAt;
      try {
        if (!r.plan) {
          r.status = "running";
          if (r.kind === "review") updateReview(this.reviewSession(r), "running");
          saveTeacherState(classroom, state);
          this.publish(classroom, r.lesson);
          const controller = new AbortController();
          this.controllers.add(controller);
          let plan;
          try {
            plan = await this.run(
              state.identity,
              this.prompt(r, state),
              classroomDir(classroom),
              (id) => {
                state.identity.sessionId = id;
                saveTeacherState(classroom, state);
              },
              controller.signal,
              this.contract(r),
              (value) => {
                r.modelOutput = value;
                saveTeacherState(classroom, state);
              },
            );
          } finally {
            this.controllers.delete(controller);
          }
          r.plan = parsePlan(plan);
          r.planVersion = 2;
          r.planValidated = false;
          r.status = "planned";
          saveTeacherState(classroom, state);
        }
        await this.apply(r, state);
        r.finishedAt = Date.now();
        r.status = "done";
        if (r.kind === "review") updateReview(this.reviewSession(r), "done");
        console.log(
          `[teacher] ${state.identity.backend} ${classroom}/${r.lesson} ${r.id} done in ${r.finishedAt - r.startedAt}ms.`,
        );
        saveTeacherState(classroom, state);
        this.publish(classroom, r.lesson);
      } catch (err) {
        r.status = "failed";
        r.finishedAt = Date.now();
        r.error = `${state.identity.backend} ${r.kind} request ${r.id} in ${classroom}/${r.lesson}: ${err instanceof Error ? err.message : String(err)}`;
        if (r.kind === "review") updateReview(this.reviewSession(r), "failed", r.error);
        console.error(`[teacher] ${r.error}`);
        saveTeacherState(classroom, state);
        this.publish(classroom, r.lesson);
      }
    }
  }
  private reviewDocument(plan: TeacherPlan): ReviewDocument {
    if (
      plan.calls.length !== 1 ||
      plan.calls[0].name !== "publish_review" ||
      plan.learning_record.trim() ||
      plan.notes_markdown.trim()
    )
      throw new Error(
        "Review authoring requires exactly one publish_review call and no evidence writes.",
      );
    const document = JSON.parse(plan.calls[0].arguments_json);
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      typeof document.lesson_html !== "string" ||
      typeof document.rubric_json !== "string" ||
      typeof document.teaching_plan_json !== "string"
    )
      throw new Error("Invalid review document arguments.");
    return document;
  }
  private async apply(r: TeacherRequest, state: TeacherState): Promise<void> {
    const plan = r.plan!;
    if (r.kind === "review") {
      const session = this.reviewSession(r),
        document = this.reviewDocument(plan);
      validateReview(session, document);
      r.planValidated = true;
      saveTeacherState(r.classroom, state);
      publishReview(session, document);
      return;
    }
    if (
      r.kind === "resume" &&
      (plan.calls.length || plan.learning_record.trim() || plan.notes_markdown.trim())
    )
      throw new Error(
        "Teacher resumption permits only a panel message. It cannot write assessment or learning evidence.",
      );
    const required =
      r.kind === "quiz"
        ? r.planVersion === 2
          ? GRADE_ANSWERS
          : "grade_lesson_quiz"
        : r.kind === "ask" || r.kind === "follow-up"
          ? "answer_lesson_question"
          : null;
    if (required && plan.calls.filter((c) => c.name === required).length !== 1)
      throw new Error(`Teacher must return one ${required} call.`);
    if (r.kind !== "ask" && r.kind !== "follow-up" && !plan.message.trim())
      throw new Error("Teacher message is empty.");
    // Validate ownership for every call before any write.
    const parsed = plan.calls.map((c) => {
      const args = JSON.parse(c.arguments_json);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Invalid teacher arguments.");
      if (
        c.name === "answer_lesson_question" &&
        (required !== c.name || args.annotation_id !== r.target)
      )
        throw new Error("Teacher tried to answer a request it does not own.");
      if (
        (c.name === "grade_lesson_quiz" || c.name === GRADE_ANSWERS) &&
        (required !== c.name || args.submission_id !== r.target)
      )
        throw new Error("Teacher tried to grade a request it does not own.");
      if (
        c.name === "record_retrieval_check" &&
        (r.kind !== "chat" || args.classroom !== r.classroom || !plan.learning_record.trim())
      )
        throw new Error("Retrieval evidence requires a learner reply and a learning record.");
      if (c.name === "record_retrieval_check") {
        const learner = state.messages.find((m) => m.id === r.id && m.role === "learner");
        const grades = new Set(
          store.latestGrades(r.classroom, r.lesson).map((g) => g.submissionId),
        );
        const reviewedHere = store
          .listSubmissions(r.classroom, r.lesson)
          .some(
            (s) =>
              s.kind === "review" &&
              grades.has(s.id) &&
              s.answers.some((a) => a.reviewOf === args.review_key),
          );
        if (
          typeof args.evidence !== "string" ||
          !args.evidence.trim() ||
          args.answer !== learner?.text ||
          !store
            .reviewItems(r.classroom)
            .some(
              (item) => item.key === args.review_key && (item.lesson === r.lesson || reviewedHere),
            )
        )
          throw new Error(
            "Retrieval check must use the actual learner reply and this lesson's review item.",
          );
      }
      const publicTools = classroomTools(PI_HOST);
      const tool =
        c.name === GRADE_ANSWERS
          ? answerGradingTool(publicTools.find((t) => t.name === "grade_lesson_quiz")!)
          : publicTools.find((t) => t.name === c.name);
      if (
        !tool ||
        ![
          "answer_lesson_question",
          "grade_lesson_quiz",
          GRADE_ANSWERS,
          "record_retrieval_check",
        ].includes(c.name)
      )
        throw new Error(`Teacher operation is not allowed: ${c.name}`);
      for (const key of tool.parameters.required as string[])
        if (
          args[key] === undefined &&
          !(c.name === "record_retrieval_check" && key === "learning_record")
        )
          throw new Error(`Teacher omitted ${key}.`);
      return { name: c.name, args, tool };
    });
    const pretest = r.kind === "quiz" && store.findSubmission(r.target)?.kind === "pretest";
    const quiz = r.kind === "quiz" ? store.findSubmission(r.target) : null;
    if (quiz?.rubricDigest && r.planRubricDigest !== quiz.rubricDigest)
      throw new Error(
        "The saved grading plan has no matching rubric. Retry to request a new plan.",
      );
    const quizPrefix = quiz?.quizId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const citedQuestions = quiz
      ? [
          ...plan.learning_record.matchAll(
            new RegExp(`(?<![A-Za-z0-9_.-])${quizPrefix}/([A-Za-z0-9_.-]+)`, "g"),
          ),
        ]
          .map((match) => match[1])
          .map((id) =>
            quiz.answers.some((a) => a.questionId === id) ? id : id.replace(/\.+$/, ""),
          )
      : [];
    const quizRecord =
      !pretest &&
      quiz &&
      plan.learning_record.trim() &&
      parsed.some(
        (call) =>
          (call.name === "grade_lesson_quiz" || call.name === GRADE_ANSWERS) &&
          Array.isArray(call.args.questions) &&
          citedQuestions.length > 0 &&
          citedQuestions.every(
            (id) =>
              quiz.answers.some((a) => a.questionId === id) &&
              call.args.questions.some(
                (q: { correct?: boolean; question_id?: string }) =>
                  q.correct === true && q.question_id === id,
              ),
          ),
      );
    if (
      plan.learning_record.trim() &&
      !pretest &&
      !quizRecord &&
      !parsed.some((c) => c.name === "record_retrieval_check")
    )
      throw new Error("A learning record requires verified retrieval evidence.");
    if (plan.notes_markdown.trim() && r.kind !== "chat" && r.kind !== "reflect")
      throw new Error("Gap notes require a learner reply or self-explanation.");
    r.planValidated = true;
    saveTeacherState(r.classroom, state);
    if (plan.learning_record.trim() && !r.recordFile) {
      const numbers = store
        .listLearningRecords(r.classroom)
        .map((file) => Number(/^(\d+)-/.exec(file)?.[1] ?? 0));
      r.recordFile = `${String(Math.max(0, ...numbers) + 1).padStart(4, "0")}-teacher-check.md`;
      saveTeacherState(r.classroom, state);
    }
    const recordFile = r.recordFile!;
    for (let i = r.applied ?? 0; i < parsed.length; i++) {
      const { name, args, tool } = parsed[i];
      if (name === "answer_lesson_question") {
        const a = store.findAnnotation(r.target);
        const turn = r.turn ?? null;
        if (a && store.isTurnPending(a, turn)) {
          if (typeof args.answer_markdown !== "string" || !args.answer_markdown.trim())
            throw new Error("Teacher answer is empty.");
          applyTurnAnswer(r.target, turn, args.answer_markdown);
        }
      } else if (name === "grade_lesson_quiz" || name === GRADE_ANSWERS) {
        if (!store.listGrades(r.classroom, r.lesson).some((g) => g.submissionId === r.target)) {
          const result = await tool.execute(args);
          if (isFailure(result)) {
            r.planValidated = false;
            throw new Error(result.content[0].text);
          }
        }
      } else {
        const dir = path.join(classroomDir(r.classroom), "learning-records");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, recordFile);
        if (fs.existsSync(file)) {
          if (fs.readFileSync(file, "utf8") !== plan.learning_record)
            throw new Error("Learning record path belongs to another record.");
        } else fs.writeFileSync(file, plan.learning_record, { flag: "wx" });
        args.learning_record = recordFile;
        const previous = store
          .listRetrievalChecks(r.classroom)
          .find((check) => check.key === args.review_key && check.learningRecord === recordFile);
        if (!previous) {
          const result = await tool.execute(args);
          if (isFailure(result)) throw new Error(result.content[0].text);
        }
      }
      r.applied = i + 1;
      saveTeacherState(r.classroom, state);
    }
    if ((pretest || quizRecord) && plan.learning_record.trim()) {
      const priorGrade = store
        .latestGrades(r.classroom, r.lesson)
        .find((grade) => grade.submissionId === r.target);
      if (
        !priorGrade ||
        (pretest
          ? !priorGrade.questions.some((q) => q.correct)
          : !citedQuestions.every((id) =>
              priorGrade.questions.some((q) => q.correct && q.questionId === id),
            ))
      )
        throw new Error("A quiz learning record requires fully credited evidence.");
      const file = path.join(classroomDir(r.classroom), "learning-records", recordFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        if (fs.readFileSync(file, "utf8") !== plan.learning_record)
          throw new Error("Learning record path belongs to another record.");
      } else fs.writeFileSync(file, plan.learning_record, { flag: "wx" });
    }
    if (plan.notes_markdown.trim()) {
      const index = path.join(classroomDir(r.classroom), "NOTES.md");
      const indexText = fs.readFileSync(index, "utf8");
      if (!/^## Index\s*$/m.test(indexText))
        throw new Error("NOTES.md needs an Index section before saving teacher notes.");
      const file = path.join(classroomDir(r.classroom), "notes", "teacher-gaps.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, "# Teacher gaps\n", { flag: "wx" });
      const previous = fs.readFileSync(file, "utf8");
      const marker = `<!-- teacher-request:${r.id} -->`;
      if (!previous.includes(marker)) {
        fs.writeFileSync(
          `${file}.teacher.tmp`,
          `${previous}\n\n${marker}\n${plan.notes_markdown}\n`,
        );
        fs.renameSync(`${file}.teacher.tmp`, file);
      }
      if (!indexText.includes("(notes/teacher-gaps.md)")) {
        fs.writeFileSync(
          `${index}.teacher.tmp`,
          indexText.replace(
            /^## Index\s*$/m,
            "## Index\n\n- [Teacher gaps](notes/teacher-gaps.md): Review unresolved checks and self-explanations.",
          ),
        );
        fs.renameSync(`${index}.teacher.tmp`, index);
      }
    }
    if (plan.message.trim() && !state.messages.some((m) => m.id === r.id && m.role === "teacher"))
      state.messages.push({
        id: r.id,
        lesson: r.lesson,
        role: "teacher",
        text: plan.message,
        at: this.nextMessageAt(r.classroom, r.lesson, state),
      });
  }
}
