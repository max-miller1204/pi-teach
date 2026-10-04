/**
 * The MCP server for Claude Code and Codex: JSON-RPC dispatch, the learner inbox, and
 * the full round trip from a browser question to `wait_for_learner` and back.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  connectInbox,
  DEFAULT_WAIT_SECONDS,
  HOST_BRIEF,
  LearnerInbox,
  MAX_WAIT_SECONDS,
  McpSession,
  waitSeconds,
  type JsonRpcResponse,
} from "../src/mcp.ts";
import { gradePrompt, QUIZ_FOLLOW_UP } from "../src/prompts.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";

let fixture: Fixture;
let inbox: LearnerInbox;
let session: McpSession;
let nextId = 1;

beforeEach(() => {
  process.env["PI_CLASSROOM_AUTO_OPEN"] = "0";
  fixture = makeFixture();
  seedClassroom(fixture);
  inbox = new LearnerInbox();
  session = new McpSession(inbox);
  connectInbox(inbox);
});

afterEach(async () => {
  inbox.reset();
  await server.close();
  fixture.cleanup();
});

function request(method: string, params?: unknown): Promise<JsonRpcResponse | null> {
  return session.handle({ jsonrpc: "2.0", id: nextId++, method, params });
}

interface CallResult {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const response = await request("tools/call", { name, arguments: args });
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result as CallResult;
}

const text = (result: CallResult) => result.content.map((c) => c.text).join("\n");

const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };

async function askFromBrowser(question: string): Promise<store.Annotation> {
  const res = await fetch(`${server.getBaseUrl()}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      classroom: "rust",
      lesson: "001-ownership",
      question,
      selection: "one owner",
      anchor,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as store.Annotation;
}

describe("protocol", () => {
  it("echoes a supported protocol version and declares tools", async () => {
    const response = await request("initialize", { protocolVersion: "2025-06-18" });
    const result = (response as { result: Record<string, any> }).result;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["capabilities"]).toEqual({ tools: {} });
    expect(result["serverInfo"].name).toBe("pi-teach");
    expect(result["instructions"]).toBeUndefined();
  });

  it("answers an unknown protocol version with its newest one", async () => {
    const response = await request("initialize", { protocolVersion: "1999-01-01" });
    expect((response as { result: Record<string, any> }).result["protocolVersion"]).toBe(
      "2025-11-25",
    );
  });

  it("lists the shared tools and the session tools", async () => {
    const response = await request("tools/list");
    const tools = (response as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "answer_lesson_question",
      "begin_teaching",
      "grade_lesson_quiz",
      "lesson_health",
      "list_classrooms",
      "open_classroom",
      "record_retrieval_check",
      "scaffold_classroom",
      "scaffold_lesson",
      "scaffold_review",
      "wait_for_learner",
    ]);
  });

  it("does not answer notifications", async () => {
    expect(await session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(
      null,
    );
  });

  it("rejects unknown methods and tools", async () => {
    expect(await request("resources/list")).toMatchObject({ error: { code: -32601 } });
    expect(await request("tools/call", { name: "nope", arguments: {} })).toMatchObject({
      error: { code: -32602 },
    });
  });

  it("reports a missing required argument as a tool error", async () => {
    const result = await call("answer_lesson_question", { annotation_id: "x" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("answer_markdown");
  });
});

describe("session tools", () => {
  it("begin_teaching returns the method, the classroom, and how to listen", async () => {
    const result = await call("begin_teaching", { topic: "rust" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("Their classroom is `rust`");
    expect(text(result)).toContain(HOST_BRIEF);
    expect(text(result)).toContain(QUIZ_FOLLOW_UP);
    expect(HOST_BRIEF).toContain("Do not call `wait_for_learner`");
  });

  it("open_classroom starts the server and returns the classroom URL", async () => {
    const result = await call("open_classroom", { classroom: "Rust" });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain(`${server.getBaseUrl()}/c/rust`);
  });

  it("open_classroom fails loudly for an unknown classroom", async () => {
    const result = await call("open_classroom", { classroom: "haskell" });
    expect(result.isError).toBe(true);
    expect(server.isRunning()).toBe(false);
  });

  it("scaffold results point at open_classroom, not a Pi command", async () => {
    const result = await call("scaffold_classroom", { name: "Go" });
    expect(text(result)).toContain("open_classroom");
    expect(text(result)).not.toContain("/classroom");
  });

  it("list_classrooms lists lessons", async () => {
    expect(text(await call("list_classrooms"))).toContain("Ownership");
  });
});

describe("wait_for_learner", () => {
  it("fails loudly while the server is not running", async () => {
    const result = await call("wait_for_learner", { timeout_seconds: 1 });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("open_classroom");
  });

  it("returns a browser question, and the answer reaches the card", async () => {
    await call("open_classroom");
    const waiting = call("wait_for_learner");
    const annotation = await askFromBrowser("Why only one owner?");

    const prompt = text(await waiting);
    expect(prompt).toContain("Why only one owner?");
    expect(prompt).toContain(annotation.id);
    expect(prompt).toContain("wait_for_learner");
    expect(prompt).not.toContain("nothing was polled");

    const answered = await call("answer_lesson_question", {
      annotation_id: annotation.id,
      answer_markdown: "Because aliasing.",
    });
    expect(answered.isError).toBe(false);
    expect(store.findAnnotation(annotation.id)!.status).toBe("answered");
  });

  it("returns the shared quiz rule and preserves wrong-answer feedback", async () => {
    await call("open_classroom");
    const response = await fetch(`${server.getBaseUrl()}/api/quiz/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: "rust",
        lesson: "001-ownership",
        quizId: "check-1",
        quizTitle: "Ownership",
        kind: "check",
        answers: [
          { questionId: "q1", type: "term", prompt: "Who owns a value?", value: "Everyone" },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const submission = (await response.json()) as store.QuizSubmission;
    const prompt = text(await call("wait_for_learner"));
    expect(prompt).toBe(gradePrompt(submission, "wait"));

    const graded = await call("grade_lesson_quiz", {
      submission_id: submission.id,
      score: 0,
      feedback_markdown: "Review ownership.",
      questions: [{ question_id: "q1", correct: false, feedback: "Each value has one owner." }],
    });
    expect(graded.isError).toBe(false);
    expect(text(graded)).toContain(QUIZ_FOLLOW_UP);
    expect(text(graded)).toContain("Missed questions: q1");
    const state = await fetch(
      `${server.getBaseUrl()}/api/state?classroom=rust&lesson=001-ownership`,
    );
    expect(await state.json()).toMatchObject({
      quizzes: [
        {
          quizId: "check-1",
          grade: {
            score: 0,
            questions: [{ questionId: "q1", correct: false }],
          },
        },
      ],
    });
  });

  it("keeps questions asked while nobody waits, and returns them together", async () => {
    await call("open_classroom");
    await askFromBrowser("First?");
    await askFromBrowser("Second?");

    const prompt = text(await call("wait_for_learner"));
    expect(prompt).toContain("2 requests arrived");
    expect(prompt).toContain("First?");
    expect(prompt).toContain("Second?");
    expect(inbox.size).toBe(0);
  });

  it("recovers an ungraded submission after an MCP restart", async () => {
    const submission = store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check",
      kind: "check",
      answers: [{ questionId: "q1", type: "term", value: "owner" }],
    });
    await call("open_classroom", { classroom: "rust" });
    expect(text(await call("wait_for_learner", { timeout_seconds: 1 }))).toContain(submission.id);
  });

  it("recovers pending card turns once and ignores requests already answered", async () => {
    await call("open_classroom", { classroom: "rust" });
    const card = await askFromBrowser("Before restart?");
    inbox.reset();
    await call("open_classroom", { classroom: "rust" });
    await call("open_classroom", { classroom: "rust" });
    expect(inbox.size).toBe(1);
    const received = text(await call("wait_for_learner"));
    expect(received).toContain(card.id);
    expect(received).not.toContain("2 requests");
    await call("answer_lesson_question", { annotation_id: card.id, answer_markdown: "One owner." });
    const followUp = store.addFollowUp(card.id, "And borrows?")!.followUp;
    await call("open_classroom", { classroom: "rust" });
    expect(text(await call("wait_for_learner"))).toContain(followUp.question);
    await call("answer_lesson_question", {
      annotation_id: card.id,
      answer_markdown: "Many readers.",
    });
    inbox.reset();
    await call("open_classroom", { classroom: "rust" });
    expect(inbox.size).toBe(0);
  });

  it("does not deliver a queued submission that has already been graded", async () => {
    const submission = store.createSubmission({
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check",
      kind: "check",
      answers: [{ questionId: "q1", type: "term", value: "owner" }],
    });
    await call("open_classroom", { classroom: "rust" });
    await call("grade_lesson_quiz", {
      submission_id: submission.id,
      score: 100,
      feedback_markdown: "Yes.",
      questions: [{ question_id: "q1", correct: true, feedback: "Right." }],
    });
    const result = text(await call("wait_for_learner", { timeout_seconds: 1 }));
    expect(result).not.toContain(submission.id);
    expect(result).toContain("Nothing from the learner");
    inbox.reset();
    await call("open_classroom", { classroom: "rust" });
    expect(inbox.size).toBe(0);
  });

  it("restricts recovered requests to the classroom that was opened", async () => {
    seedClassroom(fixture, { classroom: "other" });
    store.createSubmission({
      classroom: "other",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check",
      kind: "check",
      answers: [{ questionId: "q1", value: "x" }],
    });
    await call("open_classroom", { classroom: "rust" });
    expect(inbox.size).toBe(0);
  });

  it("returns nothing when the wait times out", async () => {
    await call("open_classroom");
    const result = await call("wait_for_learner", { timeout_seconds: 1 });
    expect(result.isError).toBe(false);
    expect(text(result)).toContain("Nothing from the learner");
  });

  it("sends no response for a cancelled wait, and keeps later questions", async () => {
    await call("open_classroom");
    const id = nextId++;
    const waiting = session.handle({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "wait_for_learner", arguments: {} },
    });
    await session.handle({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id },
    });
    expect(await waiting).toBe(null);

    await askFromBrowser("After the cancel?");
    expect(inbox.size).toBe(1);
  });
});

describe("waitSeconds", () => {
  it("defaults and rejects invalid or long waits", () => {
    expect(waitSeconds(undefined)).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds(MAX_WAIT_SECONDS)).toBe(MAX_WAIT_SECONDS);
    for (const value of [2.4, 0, 1e9, null, "60"])
      expect(() => waitSeconds(value)).toThrow(/timeout_seconds/);
  });
});
