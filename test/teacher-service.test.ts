import { DAY_MS } from "../src/review.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeFixture,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import * as store from "../src/store.ts";
import * as server from "../src/server.ts";
import { applyGrade } from "../src/bridge.ts";
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
  it("limits model operations to the active request across a persistent session", async () => {
    const s = submission();
    const seen: string[][] = [];
    const teacher = new TeacherService(
      async (_identity, prompt, _cwd, _save, _signal, contract) => {
        seen.push(contract.operations);
        const marker = "Tool definitions:\n";
        const definitions = JSON.parse(prompt.split(marker)[1].split("\n\nRequest ")[0]);
        expect(definitions.map((tool: { name: string }) => tool.name)).toEqual(contract.operations);
        if (seen.length === 1) {
          expect(contract.required).toBe(true);
          return plan([grade(s.id)]);
        }
        expect(contract.required).not.toBe(true);
        expect(definitions[0].parameters.required).not.toContain("learning_record");
        expect(definitions[0].parameters.properties).not.toHaveProperty("learning_record");
        return plan([]);
      },
    );
    teacher.attach("rust", "codex");
    await teacher.idle();
    teacher.chat("rust", location.lesson, "I need another example.", randomUUID());
    await teacher.idle();
    expect(seen).toEqual([["grade_lesson_quiz"], ["record_retrieval_check"]]);
    expect(readTeacherState("rust")!.requests.every((request) => request.status === "done")).toBe(
      true,
    );
    await teacher.stop();
  });
  it("identifies teaching behind a pretest before and after grading without leaking it", async () => {
    f.write(
      "rust/001-ownership/lesson.html",
      '<form class="cl-quiz" data-quiz-id="pretest-1" data-kind="pretest"><li class="cl-q" data-question-id="q1" data-type="term"></li></form><template data-cl-after-pretest="pretest-1"><p>Hidden teaching sentinel.</p></template>',
    );
    const s = store.createSubmission({
      ...location,
      quizId: "pretest-1",
      quizTitle: "Pretest",
      kind: "pretest",
      answers: [termAnswer("q1", "forever")],
    });
    let runs = 0;
    const teacher = new TeacherService(async (_identity, prompt) => {
      const marker = "Private context:\n";
      const context = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
      expect(context.lessonStage.gatedPretests).toEqual(["pretest-1"]);
      expect(prompt).toContain("Do not claim that teaching is missing");
      if (runs++ === 0) {
        expect(context.lessonStage.pendingPretests).toEqual(["pretest-1"]);
        expect(context.lesson).not.toContain("Hidden teaching sentinel.");
        return plan([grade(s.id)], "Continue to the teaching released after grading.");
      }
      expect(context.lessonStage.pendingPretests).toEqual([]);
      expect(context.lesson).toContain("Hidden teaching sentinel.");
      return plan([]);
    });
    teacher.attach("rust", "codex");
    await teacher.idle();
    teacher.chat("rust", location.lesson, "The teaching is visible now.", randomUUID());
    await teacher.idle();
    expect(runs).toBe(2);
    expect(readTeacherState("rust")!.requests.every((request) => request.status === "done")).toBe(
      true,
    );
  });
  it("supplies indexed topic notes in a fresh teacher session", async () => {
    f.write(
      "rust/NOTES.md",
      "# Notes\n\n## Index\n\n- [Current checkpoint](notes/current-checkpoint.md)\n",
    );
    f.write(
      "rust/notes/current-checkpoint.md",
      "Use course convention e = prediction minus observation. Check the unresolved sign gap.",
    );
    f.write("rust/notes/unrelated.md", "Unindexed private note sentinel.");
    const teacher = new TeacherService(async (_id, prompt) => {
      expect(prompt).toContain("prediction minus observation");
      expect(prompt).toContain("unresolved sign gap");
      expect(prompt).not.toContain("Unindexed private note sentinel");
      expect(prompt).not.toContain("wait_for_learner");
      return plan([]);
    });
    teacher.attach("rust", "codex");
    teacher.chat("rust", location.lesson, "Continue this check", randomUUID());
    await teacher.idle();
    expect(readTeacherState("rust")?.requests[0].status).toBe("done");
  });
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
  f.write("rust/NOTES.md", "# Notes\n\n## Preferences\n\nKeep examples short.\n\n## Index\n");
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
  expect(notes).toContain("(notes/teacher-gaps.md)");
  expect(
    fs
      .readFileSync(path.join(f.root, "rust/notes/teacher-gaps.md"), "utf8")
      .match(/## Unresolved gap/g),
  ).toHaveLength(1);
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

it.each([true, false])(
  "records only quiz understanding backed by fully credited answers: %s",
  async (correct) => {
    const s = submission();
    const call = grade(s.id);
    const args = JSON.parse(call.arguments_json);
    args.score = correct ? 100 : 0;
    args.questions[0].correct = correct;
    call.arguments_json = JSON.stringify(args);
    const teacher = new TeacherService(async () => ({
      calls: [call],
      message: "Feedback.",
      notes_markdown: "",
      learning_record:
        "# Ownership\n\nEvidence: check-1/q1. The learner traced the lifetime correctly.",
    }));
    teacher.attach("rust", "codex");
    await teacher.idle();
    expect(readTeacherState("rust")?.requests[0].status).toBe(correct ? "done" : "failed");
    expect(store.listLearningRecords("rust")).toHaveLength(correct ? 1 : 0);
  },
);

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

it.each(["check-1/q10", "check-1/q1 and check-1/q10"])(
  "rejects learning evidence from an incorrect cited question: %s",
  async (evidence) => {
    const s = store.createSubmission({
      ...location,
      quizId: "check-1",
      quizTitle: "Ownership",
      kind: "check",
      answers: [termAnswer("q1", "dropped"), termAnswer("q10", "forever")],
    });
    const teacher = new TeacherService(async () => ({
      ...plan([
        {
          name: "grade_lesson_quiz",
          arguments_json: JSON.stringify({
            submission_id: s.id,
            score: 50,
            feedback_markdown: "One correct answer.",
            questions: [
              { question_id: "q1", correct: true, feedback: "Correct." },
              { question_id: "q10", correct: false, feedback: "Review the lifetime." },
            ],
          }),
        },
      ]),
      learning_record: `# Ownership\n\nEvidence: ${evidence}.`,
    }));
    teacher.attach("rust", "codex");
    await teacher.idle();
    expect(readTeacherState("rust")!.requests[0].status).toBe("failed");
    expect(store.listLearningRecords("rust")).toHaveLength(0);
    expect(store.listGrades("rust", location.lesson)).toHaveLength(0);
  },
);

it("records reflection gaps as notes without claiming mastery", async () => {
  f.write("rust/NOTES.md", "# Notes\n\n## Index\n");
  const teacher = new TeacherService(async (_id, prompt) => {
    expect(prompt).toContain("Do not write a learning record without a verified retrieval check");
    return {
      calls: [],
      message: "We will check this idea with a new example.",
      learning_record: "",
      notes_markdown: "The self-explanation confuses ownership and borrowing.",
    };
  });
  teacher.attach("rust", "codex");
  teacher.reflection(
    store.createReflection({
      ...location,
      reflectId: "explain",
      prompt: "Explain ownership.",
      text: "Borrowers own the value.",
    }),
  );
  await teacher.idle();
  expect(readTeacherState("rust")?.requests[0].status).toBe("done");
  expect(fs.readFileSync(path.join(f.root, "rust/notes/teacher-gaps.md"), "utf8")).toContain(
    "confuses ownership",
  );
  expect(store.listLearningRecords("rust")).toHaveLength(0);
});

it.each([true, false])(
  "accepts retrieval evidence only for an item reviewed on the current page: %s",
  async (reviewedHere) => {
    const s = submission();
    applyGrade(s, {
      score: 0,
      feedbackMarkdown: "Missed.",
      questions: [{ questionId: "q1", correct: false, feedback: "Review ownership." }],
    });
    f.write(
      "rust/002-review/lesson.html",
      "<html><head></head><body><main data-cl-content>Review</main></body></html>",
    );
    if (reviewedHere) {
      const review = store.createSubmission({
        classroom: "rust",
        lesson: "002-review",
        quizId: "review",
        quizTitle: "Review",
        kind: "review",
        answers: [{ ...termAnswer("r1", "wrong"), reviewOf: "001-ownership/check-1/q1" }],
      });
      applyGrade(review, {
        score: 0,
        feedbackMarkdown: "Missed again.",
        questions: [{ questionId: "r1", correct: false, feedback: "Use a new example." }],
      });
    }
    const reply = "The owner drops the value at the end of its scope.";
    const teacher = new TeacherService(async () => ({
      calls: [
        {
          name: "record_retrieval_check",
          arguments_json: JSON.stringify({
            classroom: "rust",
            review_key: "001-ownership/check-1/q1",
            answer: reply,
            evidence: "Correct lifetime in a fresh example.",
          }),
        },
      ],
      message: "Correct.",
      learning_record:
        "# Verified ownership\n\nThe learner traced the lifetime in a fresh example.",
      notes_markdown: "",
    }));
    teacher.attach("rust", "codex");
    teacher.chat("rust", "002-review", reply, randomUUID());
    await teacher.idle();
    expect(readTeacherState("rust")?.requests.find((r) => r.kind === "chat")?.status).toBe(
      reviewedHere ? "done" : "failed",
    );
    expect(store.listRetrievalChecks("rust")).toHaveLength(reviewedHere ? 1 : 0);
    expect(store.listGrades("rust", location.lesson)[0].score).toBe(0);
  },
);

it("rejects retrieval placeholders before grading and regenerates only on explicit retry", async () => {
  const s = submission();
  let runs = 0;
  const teacher = new TeacherService(async () => {
    runs++;
    return plan(
      runs === 1
        ? [grade(s.id), { name: "record_retrieval_check", arguments_json: "{}" }]
        : [grade(s.id)],
    );
  });
  teacher.attach("rust", "claude");
  await teacher.idle();
  const rejected = readTeacherState("rust")!.requests[0];
  expect(rejected.status).toBe("failed");
  expect(rejected.error).toContain("Retrieval evidence requires a learner reply");
  expect(rejected.applied ?? 0).toBe(0);
  expect(store.listGrades(location.classroom, location.lesson)).toHaveLength(0);
  expect(store.listRetrievalChecks("rust")).toHaveLength(0);
  expect(store.readLearningRecords("rust")).toEqual([]);
  expect(readTeacherState("rust")!.messages).toHaveLength(0);
  expect(runs).toBe(1);
  teacher.retry("rust", `quiz:${s.id}`);
  await teacher.idle();
  expect(runs).toBe(2);
  expect(readTeacherState("rust")!.requests[0].status).toBe("done");
  expect(store.listGrades(location.classroom, location.lesson)).toHaveLength(1);
  expect(store.listRetrievalChecks("rust")).toHaveLength(0);
  await teacher.stop();
});

it("requests a new plan on explicit retry after invalid panel evidence", async () => {
  writeGradedAttempt({
    at: Date.now() - 2 * DAY_MS,
    answers: [termAnswer("q1", "owner")],
    correct: { q1: false },
  });
  let runs = 0;
  const teacher = new TeacherService(async (_identity, prompt) => {
    runs++;
    if (runs === 2)
      expect(prompt).toContain("A learning record requires verified retrieval evidence.");
    expect(prompt).toContain("001-ownership/check-1/q1");
    return runs === 1 ? { ...plan([]), learning_record: "An unverified record." } : plan([]);
  });
  teacher.attach("rust", "codex");
  const id = randomUUID();
  teacher.chat("rust", "001-ownership", "The owner releases it.", id);
  await teacher.idle();
  expect(readTeacherState("rust")!.requests[0].status).toBe("failed");
  teacher.retry("rust", `chat:${id}`);
  await teacher.idle();
  expect(runs).toBe(2);
  expect(readTeacherState("rust")!.requests[0].status).toBe("done");
  await teacher.stop();
});

it("regenerates a rejected grade on explicit retry without repeating a saved grade", async () => {
  const s = submission();
  let runs = 0;
  const teacher = new TeacherService(async (_identity, prompt) => {
    runs++;
    const call = grade(s.id);
    if (runs === 1) {
      const args = JSON.parse(call.arguments_json);
      args.score = 10;
      call.arguments_json = JSON.stringify(args);
    } else expect(prompt).toContain("Score must match question points");
    return plan([call]);
  });
  teacher.attach("rust", "codex");
  await teacher.idle();
  expect(readTeacherState("rust")!.requests[0].status).toBe("failed");
  expect(store.listGrades("rust", location.lesson)).toHaveLength(0);
  teacher.attach("rust", "codex");
  await teacher.idle();
  expect(runs).toBe(1);
  teacher.retry("rust", `quiz:${s.id}`);
  await teacher.idle();
  expect(runs).toBe(2);
  expect(readTeacherState("rust")!.requests[0].status).toBe("done");
  expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
  const state = readTeacherState("rust")!;
  state.requests[0].status = "planned";
  state.requests[0].applied = 0;
  saveTeacherState("rust", state);
  const restarted = new TeacherService(async () => {
    throw new Error("Recovery must keep the saved grade.");
  });
  restarted.restore();
  await restarted.idle();
  expect(readTeacherState("rust")!.requests[0].status).toBe("done");
  expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
  await teacher.stop();
  await restarted.stop();
});

it("regenerates an older rejected score marked as a valid plan", async () => {
  const s = submission();
  const invalid = grade(s.id);
  const args = JSON.parse(invalid.arguments_json);
  args.score = 10;
  invalid.arguments_json = JSON.stringify(args);
  const first = new TeacherService(async () => plan([invalid]));
  first.attach("rust", "codex");
  await first.idle();
  const state = readTeacherState("rust")!;
  state.requests[0].planValidated = true;
  saveTeacherState("rust", state);
  let runs = 0;
  const restored = new TeacherService(async () => {
    runs++;
    return plan([grade(s.id)]);
  });
  restored.restore();
  await restored.idle();
  expect(runs).toBe(0);
  restored.retry("rust", `quiz:${s.id}`);
  await restored.idle();
  expect(runs).toBe(1);
  expect(readTeacherState("rust")!.requests[0].status).toBe("done");
  expect(store.listGrades("rust", location.lesson)).toHaveLength(1);
  await first.stop();
  await restored.stop();
});
