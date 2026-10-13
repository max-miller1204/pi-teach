import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import classroomExtension from "../index.ts";
import { ClassroomBridge, applyGrade } from "../src/bridge.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import {
  prepareResume,
  resumeTeacherTool,
  piResumes,
  savePiResume,
} from "../src/teacher-resume.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { makeFixture, seedClassroom, termAnswer, type Fixture } from "./helpers.ts";
import type { TeacherPlan } from "../src/teacher.ts";

let fixture: Fixture;
const location = { classroom: "rust", lesson: "001-ownership" };
const message = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
const plan = (text = "Which binding owns the buffer after a move?"): TeacherPlan => ({
  calls: [],
  message: text,
  learning_record: "",
  notes_markdown: "",
});
function graded(kind: "check" | "review" | "pretest" = "review", correct = false) {
  const submission = store.createSubmission({
    ...location,
    quizId: "check",
    quizTitle: "Review",
    kind,
    answers: [termAnswer("q1", "old binding")],
  });
  applyGrade(submission, {
    score: correct ? 100 : 0,
    feedbackMarkdown: "Check the owner.",
    questions: [{ questionId: "q1", correct, feedback: "The new binding owns it." }],
  });
  return { ...location, submission_id: submission.id };
}
beforeEach(() => {
  fixture = makeFixture();
  seedClassroom(fixture);
});
afterEach(async () => {
  await server.close();
  fixture.cleanup();
});

describe("explicit teacher handoff", () => {
  it("validates assessment identity, kind, and latest attempt before writing", () => {
    const input = graded();
    expect(() => prepareResume({ ...input, classroom: "other" })).toThrow();
    seedClassroom(fixture, { lesson: "002-other" });
    expect(() => prepareResume({ ...input, lesson: "002-other" })).toThrow("does not belong");
    expect(() => prepareResume({ ...input, lesson: "../001-ownership" })).toThrow();
    graded();
    expect(() => prepareResume(input)).toThrow("latest graded");
    const good = graded("check", true);
    expect(() => prepareResume(good)).toThrow("no missed");
    expect(() => prepareResume(graded("pretest"))).toThrow("Only a graded");
  });

  it("resolves a missed item only with a linked check after the latest feedback", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
      graded();
      fixture.write("rust/learning-records/0001-old.md", "# Prior understanding");
      vi.advanceTimersByTime(10);
      store.recordRetrievalCheck("rust", {
        key: "001-ownership/check/q1",
        learningRecord: "0001-old.md",
        answer: "The new binding",
        evidence: "Answered the prior check",
      });
      vi.advanceTimersByTime(10);
      const input = graded();
      fixture.write(
        "rust/learning-records/0002-free-form.md",
        "# The learner understands ownership",
      );
      expect(prepareResume(input).unresolvedKeys).toEqual(["001-ownership/check/q1"]);
      vi.advanceTimersByTime(10);
      store.recordRetrievalCheck("rust", {
        key: "001-ownership/check/q1",
        learningRecord: "0002-free-form.md",
        answer: "The new binding owns it",
        evidence: "Answered after the latest feedback",
      });
      expect(prepareResume(input).unresolvedKeys).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires a running server and returns an exact panel link", async () => {
    const input = graded();
    let calls = 0;
    const tool = resumeTeacherTool(() => calls++);
    await expect(tool.execute(input)).rejects.toThrow("Start the classroom server");
    expect(calls).toBe(0);
    const base = await server.start();
    const result = await tool.execute(input);
    expect(result.details.url).toBe(`${base}/c/rust/001-ownership#cl-teacher`);
    expect(calls).toBe(1);
  });

  it("keeps initiating and unrelated chat foreign, and deduplicates Pi resume and reply", () => {
    const input = graded();
    const before = store.listGrades(location.classroom, location.lesson);
    const sent: string[] = [];
    const bridge = new ClassroomBridge({ sendUserMessage: (text) => sent.push(text) });
    bridge.setIdleProbe(() => false);
    bridge.noteForeignTurn();
    bridge.resume(input);
    bridge.resume(input);
    expect(sent).toHaveLength(0);
    bridge.onAgentEnd(message("Here is unrelated terminal text."));
    expect(store.listPanelMessages(location.classroom, location.lesson)).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(input.submission_id);
    expect(() => bridge.assertCanWrite()).toThrow("only a panel message");
    bridge.onAgentEnd(message("Which binding owns the buffer after a move?"));
    expect(piResumes("rust")[0].status).toBe("done");
    bridge.resume(input);
    expect(sent).toHaveLength(1);
    bridge.chat("rust", "001-ownership", "The new binding", "reply-1");
    bridge.chat("rust", "001-ownership", "The new binding", "reply-1");
    bridge.assertCanWrite();
    bridge.onAgentEnd(message("Right."));
    bridge.noteForeignTurn();
    bridge.onAgentEnd(message("Another unrelated chat answer."));
    expect(store.listPanelMessages("rust", "001-ownership").map((m) => m.role)).toEqual([
      "teacher",
      "learner",
      "teacher",
    ]);
    expect(store.listGrades("rust", "001-ownership")).toEqual(before);
    expect(store.listRetrievalChecks("rust")).toEqual([]);
    expect(store.readLearningRecords("rust")).toEqual([]);
  });

  it.each(["interactive", "rpc"])(
    "routes %s initiating input through the registered Pi tools and hooks",
    async (source) => {
      const input = graded();
      const hooks = new Map<string, (event: any) => Promise<void>>();
      const tools = new Map<string, any>();
      const sent: string[] = [];
      classroomExtension({
        on: (name: string, handler: any) => hooks.set(name, handler),
        registerTool: (tool: any) => tools.set(tool.name, tool),
        registerCommand: () => {},
        sendUserMessage: (text: string) => sent.push(text),
      } as any);
      await server.start();
      await hooks.get("input")!({ source });
      await tools.get("resume_lesson_teacher").execute("resume-call", input);
      expect(sent).toHaveLength(0);
      await hooks.get("agent_end")!({ messages: message("Continue at the lesson link.") });
      expect(sent).toHaveLength(1);
      expect(store.listPanelMessages("rust", input.lesson)).toEqual([]);
      expect(() => tools.get("grade_lesson_quiz").execute("grade-call", {})).toThrow(
        "only a panel message",
      );
      await hooks.get("agent_end")!({ messages: message("Who owns the moved buffer?") });
      expect(store.listPanelMessages("rust", input.lesson).map((m) => m.text)).toEqual([
        "Who owns the moved buffer?",
      ]);
    },
  );

  it("reuses a pending Pi grading run or an existing historical conversation", () => {
    const input = graded();
    let runs = 0;
    const bridge = new ClassroomBridge({ sendUserMessage: () => runs++ });
    bridge.grade(store.findSubmission(input.submission_id)!);
    bridge.resume(input);
    expect(runs).toBe(1);
    bridge.onAgentEnd(message("A pending corrective question."));
    bridge.resume(input);
    expect(runs).toBe(1);
    const next = new ClassroomBridge({ sendUserMessage: () => runs++ });
    next.resume(input);
    expect(runs).toBe(1);
  });

  it("recovers Pi interruption and send failure only through explicit retry", () => {
    const input = graded();
    const bridge = new ClassroomBridge({
      sendUserMessage: () => {
        throw new Error("send rejected");
      },
    });
    expect(() => bridge.resume(input)).toThrow("send rejected");
    expect(piResumes("rust")[0].status).toBe("failed");
    let runs = 0;
    const recovered = new ClassroomBridge({ sendUserMessage: () => runs++ });
    recovered.resume(input);
    expect(runs).toBe(0);
    recovered.retry("rust", `resume:${input.submission_id}`);
    recovered.reset();
    expect(piResumes("rust")[0].status).toBe("failed");
    recovered.retry("rust", `resume:${input.submission_id}`);
    recovered.onAgentEnd(message("Question after retry."));
    expect(piResumes("rust")[0].status).toBe("done");
    expect(runs).toBe(2);
  });

  it("rejects a live foreign Pi owner and service ownership", async () => {
    const input = graded();
    const bridge = new ClassroomBridge({ sendUserMessage: () => {} });
    bridge.resume(input);
    const foreign = new ClassroomBridge({ sendUserMessage: () => {} });
    expect(() => foreign.resume(input)).toThrow("Another live Pi");
    const teacher = new TeacherService(async () => plan());
    expect(() => teacher.attach("rust", "codex")).toThrow("live Pi");
    bridge.reset();
    teacher.attach("rust", "codex");
    expect(() => foreign.resume(input)).toThrow("persistent teacher");
    expect(() => teacher.attach("rust", "claude")).toThrow("belongs to codex");
    await teacher.idle();
  });

  it("marks a dead Pi owner failed and keeps resume prompts private", async () => {
    const input = graded();
    savePiResume({
      ...prepareResume(input),
      kind: "resume",
      status: "running",
      ownerPid: 2147483647,
      ownerSession: "dead",
    });
    const bridge = new ClassroomBridge({
      sendUserMessage: () => {
        throw new Error("must not auto retry");
      },
    });
    bridge.restoreResumes();
    expect(piResumes("rust")[0].status).toBe("failed");
    const base = await server.start();
    expect((await fetch(`${base}/c/rust/.pi-teacher-resumes.json`)).status).toBe(404);
    expect((await fetch(`${base}/c/rust/001-ownership/.pi-teacher-resumes.json`)).status).toBe(404);
  });

  it.each(["codex", "claude"] as const)(
    "keeps %s identity, persists one resume, and preserves assessment bytes",
    async (backend) => {
      const input = graded();
      const assessmentDir = path.join(fixture.root, "rust/001-ownership/quiz");
      const files = fs.readdirSync(path.join(assessmentDir, "grades"));
      const original = files.map((file) =>
        fs.readFileSync(path.join(assessmentDir, "grades", file), "utf8"),
      );
      saveTeacherState("rust", {
        version: 1,
        identity: { backend, sessionId: "existing-teacher" },
        requests: [],
        messages: [],
      });
      let runs = 0;
      const teacher = new TeacherService(async (identity, prompt) => {
        runs++;
        expect(identity).toEqual({ backend, sessionId: "existing-teacher" });
        expect(prompt).toContain(input.submission_id);
        return plan();
      });
      teacher.attach("rust");
      teacher.resume(input);
      teacher.resume(input);
      await teacher.idle();
      teacher.resume(input);
      expect(runs).toBe(1);
      expect(readTeacherState("rust")?.requests[0].kind).toBe("resume");
      expect(readTeacherState("rust")?.messages.map((m) => m.role)).toEqual(["teacher"]);
      const restarted = new TeacherService(async () => {
        throw new Error("duplicate");
      });
      restarted.attach("rust");
      restarted.resume(input);
      await restarted.idle();
      expect(
        files.map((file) => fs.readFileSync(path.join(assessmentDir, "grades", file), "utf8")),
      ).toEqual(original);
      expect(store.listRetrievalChecks("rust")).toEqual([]);
    },
  );

  it("reuses service pending work and conversation", async () => {
    const input = graded();
    let release!: (p: TeacherPlan) => void;
    const teacher = new TeacherService(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    teacher.attach("rust", "codex");
    teacher.chat("rust", "001-ownership", "Please explain", "existing");
    teacher.resume(input);
    expect(readTeacherState("rust")?.requests).toHaveLength(1);
    await Promise.resolve();
    release(plan());
    await teacher.idle();
    teacher.resume(input);
    expect(readTeacherState("rust")?.requests).toHaveLength(1);
  });

  it("restores a stopped service resume as failed until explicit retry", async () => {
    const input = graded();
    const request = prepareResume(input);
    saveTeacherState("rust", {
      version: 1,
      identity: { backend: "codex", sessionId: "existing" },
      messages: [],
      requests: [
        { ...request, kind: "resume", target: input.submission_id, at: 1, status: "running" },
      ],
    });
    let runs = 0;
    const teacher = new TeacherService(async () => {
      runs++;
      return plan();
    });
    teacher.attach("rust");
    teacher.resume(input);
    await teacher.idle();
    expect(runs).toBe(0);
    expect(readTeacherState("rust")?.requests[0].status).toBe("failed");
    teacher.retry("rust", request.id);
    await teacher.idle();
    expect(runs).toBe(1);
    expect(readTeacherState("rust")?.requests[0].status).toBe("done");
  });

  it("shows historical Pi messages when the service reuses that panel", async () => {
    const input = graded();
    store.addPanelMessage("rust", {
      id: "old-question",
      lesson: input.lesson,
      role: "teacher",
      text: "Who owns the moved buffer?",
    });
    const teacher = new TeacherService(async () => {
      throw new Error("must reuse history");
    });
    teacher.attach("rust", "codex");
    teacher.resume(input);
    await teacher.idle();
    expect((teacher.publicState("rust", input.lesson) as any).messages[0].text).toBe(
      "Who owns the moved buffer?",
    );
    expect((teacher.publicState("rust", input.lesson) as any).messages[0].sourceBackend).toBe("pi");
    expect(readTeacherState("rust")?.requests).toEqual([]);
  });

  it("rejects resume evidence and grading plans, then retries without duplicating the request", async () => {
    const input = graded();
    let runs = 0;
    const teacher = new TeacherService(async () => {
      runs++;
      return runs === 1 ? { ...plan(), learning_record: "Fabricated evidence" } : plan();
    });
    teacher.attach("rust", "codex");
    teacher.resume(input);
    await teacher.idle();
    expect(readTeacherState("rust")?.requests[0].status).toBe("failed");
    expect(store.listLearningRecords("rust")).toEqual([]);
    teacher.resume(input);
    expect(runs).toBe(1);
    teacher.retry("rust", `resume:${input.submission_id}`);
    await teacher.idle();
    expect(readTeacherState("rust")?.requests).toHaveLength(1);
    expect(readTeacherState("rust")?.requests[0].status).toBe("done");
    expect(runs).toBe(2);
  });
});
