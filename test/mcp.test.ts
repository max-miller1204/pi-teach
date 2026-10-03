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
      "list_classrooms",
      "open_classroom",
      "scaffold_classroom",
      "scaffold_lesson",
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
  it("defaults, rounds, and clamps", () => {
    expect(waitSeconds(undefined)).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds(2.4)).toBe(2);
    expect(waitSeconds(0)).toBe(1);
    expect(waitSeconds(1e9)).toBe(MAX_WAIT_SECONDS);
  });
});
