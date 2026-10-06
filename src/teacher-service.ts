/** Run one request at a time for each classroom. Persist plans before writes. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { applyTurnAnswer } from "./bridge.ts";
import { classroomDir, lessonDir, safeStaticFile } from "./paths.ts";
import { stageLesson } from "./pretest.ts";
import {
  askPrompt,
  followUpPrompt,
  gradePrompt,
  reflectPrompt,
  dedicatedTeacherPrompt,
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
import { runTeacher, type Backend, type RunTeacher, parsePlan } from "./teacher.ts";

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
      onAsk: (a) => this.question(a),
      onFollowUp: (a, f) => this.followUp(a, f),
      onQuizSubmit: (s) => this.submission(s),
      onReflect: (r) => this.reflection(r),
      teacherState: (classroom, lesson) => this.publicState(classroom, lesson),
      onTeacherChat: (classroom, lesson, text, id) => this.chat(classroom, lesson, text, id),
      onTeacherRetry: (classroom, id) => this.retry(classroom, id),
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
  private recover(classroom: string): void {
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
      state.messages.push({ id: key, lesson, role: "learner", text, at: Date.now() });
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
    }
    r.status = r.plan ? "planned" : "queued";
    delete r.error;
    saveTeacherState(classroom, state);
    this.publish(classroom, r.lesson);
    this.wake(classroom);
  }
  publicState(classroom: string, lesson: string): unknown {
    const state = this.states.get(classroom);
    if (!state) return null;
    return {
      identity: state.identity,
      requests: state.requests
        .filter((r) => r.lesson === lesson)
        .map((r) => ({ id: r.id, kind: r.kind, status: r.status, error: r.error })),
      messages: state.messages.filter((m) => m.lesson === lesson),
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
  private prompt(r: TeacherRequest, state: TeacherState): string {
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
      records: store.readLearningRecords(r.classroom),
      messages: state.messages.filter((m) => m.lesson === r.lesson),
      grades: store.latestGrades(r.classroom, r.lesson),
      classroomDocs,
      topicNotes,
    };
    const defs = classroomTools(PI_HOST).filter((t) =>
      ["answer_lesson_question", "grade_lesson_quiz", "record_retrieval_check"].includes(t.name),
    );
    return dedicatedTeacherPrompt(
      r.id,
      r.prompt,
      context,
      defs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
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
            );
          } finally {
            this.controllers.delete(controller);
          }
          r.plan = parsePlan(plan);
          r.status = "planned";
          saveTeacherState(classroom, state);
        }
        await this.apply(r, state);
        r.finishedAt = Date.now();
        r.status = "done";
        console.log(
          `[teacher] ${state.identity.backend} ${classroom}/${r.lesson} ${r.id} done in ${r.finishedAt - r.startedAt}ms.`,
        );
        saveTeacherState(classroom, state);
        this.publish(classroom, r.lesson);
      } catch (err) {
        r.status = "failed";
        r.finishedAt = Date.now();
        r.error = `${state.identity.backend} ${r.kind} request ${r.id} in ${classroom}/${r.lesson}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[teacher] ${r.error}`);
        saveTeacherState(classroom, state);
        this.publish(classroom, r.lesson);
      }
    }
  }
  private async apply(r: TeacherRequest, state: TeacherState): Promise<void> {
    const plan = r.plan!;
    const required =
      r.kind === "quiz"
        ? "grade_lesson_quiz"
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
        c.name === "grade_lesson_quiz" &&
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
      const tool = classroomTools(PI_HOST).find((t) => t.name === c.name);
      if (
        !tool ||
        !["answer_lesson_question", "grade_lesson_quiz", "record_retrieval_check"].includes(c.name)
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
          call.name === "grade_lesson_quiz" &&
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
      } else if (name === "grade_lesson_quiz") {
        if (!store.listGrades(r.classroom, r.lesson).some((g) => g.submissionId === r.target)) {
          const result = await tool.execute(args);
          if (isFailure(result)) throw new Error(result.content[0].text);
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
        at: Date.now(),
      });
  }
}
