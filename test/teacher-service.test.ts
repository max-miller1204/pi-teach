import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFixture, seedClassroom, termAnswer, type Fixture } from "./helpers.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import * as store from "../src/store.ts";
import * as server from "../src/server.ts";
import type { TeacherPlan } from "../src/teacher.ts";

let f: Fixture;
const location = { classroom: "rust", lesson: "001-ownership" };
const plan = (
  calls: TeacherPlan["calls"],
  message = "What happens with a second example?",
): TeacherPlan => ({ calls, message, learning_record: "", notes_markdown: "" });
const grade = (id: string) => ({
  name: "grade_lesson_quiz",
  arguments_json: JSON.stringify({
    submission_id: id,
    score: 0,
    feedback_markdown: "Check the owner.",
    questions: [{ question_id: "q1", correct: false, feedback: "The owner releases the value." }],
  }),
});
function submission() {
  return store.createSubmission({
    ...location,
    quizId: "check-1",
    quizTitle: "Ownership",
    kind: "check",
    answers: [termAnswer("q1", "forever")],
  });
}
beforeEach(() => {
  f = makeFixture();
  seedClassroom(f);
  f.write("rust/001-ownership/quiz/key.json", '{"q1":"dropped"}');
});
afterEach(async () => {
  await server.close();
  f.cleanup();
});
describe("persistent teacher", () => {
  it("starts work after idle and delivers service-owned SSE writes", async () => {
    let runs = 0;
    const teacher = new TeacherService(async (_identity, prompt, _cwd, save) => {
      runs++;
      save("dedicated-session");
      const id = /annotation_id: "([^"]+)"/.exec(prompt)![1];
      return plan([
        {
          name: "answer_lesson_question",
          arguments_json: JSON.stringify({
            annotation_id: id,
            answer_markdown: "One owner controls the lifetime.",
          }),
        },
      ]);
    });
    teacher.connect();
    teacher.attach("rust", "codex");
    await teacher.idle();
    expect(runs).toBe(0);
    const base = await server.start(0);
    const abort = new AbortController();
    const stream = await fetch(`${base}/api/events?classroom=rust&lesson=001-ownership`, {
      signal: abort.signal,
    });
    const reader = stream.body!.getReader();
    await reader.read();
    const response = await fetch(`${base}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...location,
        question: "Why?",
        anchor: { exact: "Some lesson prose" },
      }),
    });
    expect(response.status).toBe(201);
    const a = await response.json();
    await teacher.idle();
    expect(runs).toBe(1);
    expect(store.findAnnotation(a.id)?.status).toBe("answered");
    const frame = new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    expect(frame).toContain("event: answer");
    expect(readTeacherState("rust")?.identity.sessionId).toBe("dedicated-session");
    expect(
      (await (await fetch(`${base}/api/state?classroom=rust&lesson=001-ownership`)).json()).teacher
        .messages,
    ).toHaveLength(1);
  });
  it("uses one owner and runs requests in sequence", async () => {
    let active = 0,
      max = 0;
    const teacher = new TeacherService(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return plan([]);
    });
    teacher.attach("rust", "claude");
    expect(() => teacher.attach("rust", "codex")).toThrow("belongs to claude");
    teacher.chat("rust", location.lesson, "First", randomUUID());
    teacher.chat("rust", location.lesson, "Second", randomUUID());
    await teacher.idle();
    expect(max).toBe(1);
    expect(readTeacherState("rust")?.requests.map((r) => r.status)).toEqual(["done", "done"]);
  });
  it("recovers queued work and saved plans without duplicate grades", async () => {
    const s = submission();
    const teacher = new TeacherService(async () => plan([grade(s.id)]));
    teacher.attach("rust", "codex");
    await teacher.idle();
    expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
    const state = readTeacherState("rust")!;
    state.requests[0].status = "planned";
    state.requests[0].applied = 0;
    saveTeacherState("rust", state);
    const restarted = new TeacherService(async () => {
      throw new Error("A saved plan must not call the model again.");
    });
    restarted.restore();
    await restarted.idle();
    expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
    expect(readTeacherState("rust")?.requests[0].status).toBe("done");
    restarted.chat("rust", location.lesson, "Saved learner answer", randomUUID());
    await restarted.idle();
  });
  it("shows a specific failure and requires an explicit retry", async () => {
    let runs = 0;
    const teacher = new TeacherService(async () => {
      runs++;
      throw new Error("Claude authentication expired.");
    });
    teacher.attach("rust", "claude");
    teacher.chat("rust", location.lesson, "Hello", randomUUID());
    await teacher.idle();
    const state = readTeacherState("rust")!;
    expect(state.requests[0].error).toBe(
      `claude chat request ${state.requests[0].id} in rust/001-ownership: Claude authentication expired.`,
    );
    teacher.attach("rust", "claude");
    await teacher.idle();
    expect(runs).toBe(1);
    teacher.retry("rust", state.requests[0].id);
    await teacher.idle();
    expect(runs).toBe(2);
  });
  it("fails visibly when the private rubric is missing", async () => {
    fs.unlinkSync(path.join(f.root, "rust/001-ownership/quiz/key.json"));
    submission();
    let runs = 0;
    const teacher = new TeacherService(async () => {
      runs++;
      return plan([]);
    });
    teacher.attach("rust", "codex");
    await teacher.idle();
    expect(runs).toBe(0);
    expect(readTeacherState("rust")?.requests[0].error).toContain("Private quiz rubric is missing");
  });
  it("rejects cross-request writes", async () => {
    const s = submission();
    const other = submission();
    const teacher = new TeacherService(async () => plan([grade(other.id)]));
    teacher.attach("rust", "codex");
    await teacher.idle();
    expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
    expect(readTeacherState("rust")?.requests.find((r) => r.target === s.id)?.error).toContain(
      "does not own",
    );
  });
});

it("keeps retrieval records and linked evidence idempotent after a saved-plan restart", async () => {
  const s = submission();
  const first = new TeacherService(async () => plan([grade(s.id)]));
  first.attach("rust", "codex");
  await first.idle();
  const reply = "The String is dropped when its owner leaves scope.";
  const checked = new TeacherService(async () => ({
    calls: [
      {
        name: "record_retrieval_check",
        arguments_json: JSON.stringify({
          classroom: "rust",
          review_key: "001-ownership/check-1/q1",
          learning_record: "service-supplied.md",
          answer: reply,
          evidence: "The learner identified the end of the owner's scope in a new example.",
        }),
      },
    ],
    message: "Correct. Are you ready to continue?",
    notes_markdown: "",
    learning_record:
      "# Owner lifetime\n\nThe learner traced a String to the end of its owner's scope in a new example.",
  }));
  checked.restore();
  checked.chat("rust", location.lesson, reply, randomUUID());
  await checked.idle();
  expect(store.listRetrievalChecks("rust")).toHaveLength(1);
  const state = readTeacherState("rust")!;
  const request = state.requests.find((r) => r.kind === "chat")!;
  expect(request.status).toBe("done");
  request.status = "planned";
  request.applied = 0;
  saveTeacherState("rust", state);
  const restarted = new TeacherService(async () => {
    throw new Error("Do not repeat a saved plan.");
  });
  restarted.restore();
  await restarted.idle();
  expect(store.listRetrievalChecks("rust")).toHaveLength(1);
  expect(store.listLearningRecords("rust")).toEqual(["0001-teacher-check.md"]);
  expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
  expect(readTeacherState("rust")?.requests.find((r) => r.kind === "chat")?.status).toBe("done");
});

it("leaves queued work saved when stopped and recovers it on restart", async () => {
  let release!: () => void;
  const active = new TeacherService(async (_id, _prompt, _cwd, _save, signal) => {
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      signal?.addEventListener("abort", () =>
        reject(new Error("Teacher stopped by service control.")),
      );
    });
    return plan([]);
  });
  active.attach("rust", "codex");
  active.chat("rust", location.lesson, "First", randomUUID());
  active.chat("rust", location.lesson, "Second", randomUUID());
  await new Promise((r) => setTimeout(r, 0));
  await active.stop();
  expect(readTeacherState("rust")?.requests.map((r) => r.status)).toEqual(["failed", "queued"]);
  const restarted = new TeacherService(async () => plan([]));
  restarted.restore();
  await restarted.idle();
  expect(readTeacherState("rust")?.requests.map((r) => r.status)).toEqual(["failed", "done"]);
  release();
});

it("records a skipped retrieval gap once without claiming learning", async () => {
  f.write("rust/NOTES.md", "# Notes\n\n## Preferences\n\nKeep examples short.\n");
  const teacher = new TeacherService(async () => ({
    calls: [],
    message: "The gap remains. Review it later.",
    learning_record: "",
    notes_markdown: "## Unresolved gap\n\nThe learner skipped the owner lifetime check.",
  }));
  teacher.attach("rust", "codex");
  teacher.chat("rust", location.lesson, "Skip this check", randomUUID());
  await teacher.idle();
  const state = readTeacherState("rust")!;
  state.requests[0].status = "planned";
  saveTeacherState("rust", state);
  const restarted = new TeacherService(async () => {
    throw new Error("Do not call the model again.");
  });
  restarted.restore();
  await restarted.idle();
  const notes = fs.readFileSync(path.join(f.root, "rust/NOTES.md"), "utf8");
  expect(notes).toContain("Keep examples short.");
  expect(notes.match(/## Unresolved gap/g)).toHaveLength(1);
  expect(store.listLearningRecords("rust")).toHaveLength(0);
});

it("preserves a pretest grade and records only demonstrated prior knowledge", async () => {
  const s = store.createSubmission({
    ...location,
    quizId: "prior",
    quizTitle: "Prior knowledge",
    kind: "pretest",
    answers: [termAnswer("q1", "dropped")],
  });
  const correct = grade(s.id);
  const args = JSON.parse(correct.arguments_json);
  args.score = 100;
  args.questions[0].correct = true;
  correct.arguments_json = JSON.stringify(args);
  const teacher = new TeacherService(async () => ({
    calls: [correct],
    message: "You already know the lifetime rule. The lesson can focus on moves.",
    learning_record:
      "# Prior knowledge\n\nThe learner correctly named the lifetime rule in a pretest.",
    notes_markdown: "",
  }));
  teacher.attach("rust", "claude");
  await teacher.idle();
  expect(readTeacherState("rust")?.requests[0].status).toBe("done");
  expect(store.listGrades("rust", location.lesson)[0].score).toBe(100);
  expect(store.listLearningRecords("rust")).toHaveLength(1);
  expect(store.reviewItems("rust")).toHaveLength(0);
});

it("refuses teacher work from a changed rubric before generating a plan", async () => {
  const original = fs.readFileSync(path.join(f.root, "rust/001-ownership/quiz/key.json"), "utf8");
  const s = submission();
  f.write("rust/001-ownership/quiz/key.json", '{"q1":"forever"}');
  let runs = 0;
  const teacher = new TeacherService(async () => {
    runs++;
    return plan([grade(s.id)]);
  });
  teacher.attach("rust", "codex");
  await teacher.idle();
  expect(runs).toBe(0);
  const request = readTeacherState("rust")!.requests[0];
  expect(request.status).toBe("failed");
  expect(request.plan).toBeUndefined();
  f.write("rust/001-ownership/quiz/key.json", original);
  teacher.retry("rust", request.id);
  await teacher.idle();
  expect(runs).toBe(1);
  expect(store.latestGrades("rust", location.lesson)[0].score).toBe(0);
});

it("requires a new plan on explicit retry when saved rubric evidence is absent", async () => {
  const s = submission();
  const teacher = new TeacherService(async () => plan([grade(s.id)]));
  teacher.attach("rust", "codex");
  await teacher.idle();
  const state = readTeacherState("rust")!;
  const request = state.requests[0];
  request.status = "planned";
  request.applied = 0;
  delete request.planRubricDigest;
  saveTeacherState("rust", state);
  let runs = 0;
  const restarted = new TeacherService(async () => {
    runs++;
    return plan([grade(s.id)]);
  });
  restarted.restore();
  await restarted.idle();
  expect(runs).toBe(0);
  expect(readTeacherState("rust")!.requests[0].status).toBe("failed");
  restarted.retry("rust", request.id);
  await restarted.idle();
  expect(runs).toBe(1);
  expect(store.latestGrades("rust", location.lesson)).toHaveLength(1);
});
