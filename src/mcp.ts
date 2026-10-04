/**
 * mcp.ts: the classroom as an MCP server, for Claude Code and Codex.
 *
 * Pi runs this package in-process and wakes the agent with `sendUserMessage`. An MCP
 * server cannot wake its client, so the agent listens instead: `wait_for_learner`
 * blocks until the learner asks a question or hands in a quiz, then returns the same
 * self-contained prompt that Pi would push. The prompt names the tool that answers it,
 * so the rest of the flow (`answer_lesson_question`, `grade_lesson_quiz`) is shared.
 *
 * The server is still session-scoped: the client spawns one MCP process per session,
 * and the HTTP server lives and dies with it.
 *
 * `McpSession.handle` is a pure JSON-RPC dispatcher, so the tests drive it without a
 * child process. `mcp-stdio.ts` wires it to stdin and stdout.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { classroomListText, classroomReviewText, resolveClassroom } from "./commands.ts";
import { shouldAutoOpen } from "./config.ts";
import { openUrl } from "./open-browser.ts";
import { packageRoot } from "./paths.ts";
import {
  askPrompt,
  followUpPrompt,
  gradePrompt,
  reflectPrompt,
  teachingPrompt,
} from "./prompts.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";
import { classroomTools, isFailure, type ClassroomTool, type ToolResult } from "./tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SERVER_NAME = "pi-teach";
const SERVER_VERSION = (
  JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** Newest first. A client asking for one of these gets it echoed back. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 60;

/**
 * Appended to the teaching brief. It replaces what Pi does for free: there is no
 * `/classroom` command here, and nothing pushes the learner's questions to the agent.
 */
export const HOST_BRIEF = `## Classroom tools in this session

This session has no \`/classroom\` command, and it cannot push the learner's questions to you. Use these tools instead:

- \`open_classroom\` starts the classroom server and opens the browser. Call it before you give the learner a URL. Lesson URLs work only while this session runs. Always use the URL from this call. Reopening a classroom restores pending page requests from disk.
- \`wait_for_learner\` blocks until the learner asks about a passage, asks a follow-up, submits a quiz, or saves a self-explanation. It returns the full request and names the tool that answers it.

After you give the learner a lesson, call \`wait_for_learner\`. Answer page questions with \`answer_lesson_question\`. Grade quizzes with \`grade_lesson_quiz\` and follow the shared quiz follow-up rule. A teacher's retrieval question belongs in chat, not in a passage card. While you need a chat reply, end your turn. Do not call \`wait_for_learner\`: it receives browser requests, not chat replies. Resume listening when the chat check is complete and the learner returns to the page. Do not start another lesson without the learner's agreement. Use waits of at most 60 seconds. If a wait times out, tell the learner that listening has paused and end your turn. Resume listening when they ask to continue. Do not run a repeated wait loop. Tell the learner that browser events cannot wake an idle MCP agent. Stop when the learner says they are done. Tell the learner that they can press Esc to stop the wait and talk to you in the terminal.`;

// ── Learner inbox ─────────────────────────────────────────────────────────────

interface Waiter {
  resolve(prompts: string[] | null): void;
  timer: NodeJS.Timeout;
}

/**
 * Prompts from the browser, held until the agent asks for them.
 *
 * A prompt that arrives while nobody waits stays queued, so a question asked while the
 * agent is busy is returned by the next `wait_for_learner` call. The oldest waiter gets
 * everything queued; a cancelled waiter gets nothing, so a cancel never loses a prompt.
 */
export class LearnerInbox {
  private readonly queue: Array<{ prompt: string; key?: string; pending?: () => boolean }> = [];
  private readonly seen = new Set<string>();
  private readonly waiters = new Map<string | number, Waiter>();

  get size(): number {
    return this.queue.length;
  }

  push(prompt: string, key?: string, pending?: () => boolean): void {
    if (key && this.seen.has(key)) return;
    if (pending && !pending()) return;
    if (key) this.seen.add(key);
    this.queue.push({ prompt, key, pending });
    const oldest = this.waiters.entries().next();
    if (oldest.done) return;
    const [waitKey, waiter] = oldest.value;
    const prompts = this.take();
    this.waiters.delete(waitKey);
    clearTimeout(waiter.timer);
    waiter.resolve(prompts);
  }

  /**
   * Resolve with every queued prompt, as soon as there is one. Resolve with `[]` when
   * `timeoutMs` passes first, and with `null` when `cancel(key)` is called.
   */
  wait(key: string | number, timeoutMs: number): Promise<string[] | null> {
    const queued = this.take();
    if (queued.length > 0) return Promise.resolve(queued);
    if (this.waiters.has(key)) throw new Error(`Already waiting for request ${key}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve([]);
      }, timeoutMs);
      this.waiters.set(key, { resolve, timer });
    });
  }

  private take(): string[] {
    const pending = this.queue.filter((entry) => !entry.pending || entry.pending());
    this.queue.length = 0;
    return pending.map((entry) => entry.prompt);
  }

  cancel(key: string | number): void {
    const waiter = this.waiters.get(key);
    if (!waiter) return;
    this.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }

  /** Release every waiter with nothing, for shutdown. */
  reset(): void {
    for (const key of [...this.waiters.keys()]) this.cancel(key);
    this.queue.length = 0;
    this.seen.clear();
  }
}

function queueQuestion(inbox: LearnerInbox, annotation: store.Annotation): void {
  if (annotation.status === "pending") {
    inbox.push(
      askPrompt(annotation, "wait"),
      `ask:${annotation.id}`,
      () => store.findAnnotation(annotation.id)?.status === "pending",
    );
  }
  for (const followUp of annotation.followUps ?? []) {
    if (followUp.status !== "pending") continue;
    inbox.push(
      followUpPrompt(annotation, followUp, "wait"),
      `follow-up:${followUp.id}`,
      () =>
        store
          .findAnnotation(annotation.id)
          ?.followUps?.some((f) => f.id === followUp.id && f.status === "pending") === true,
    );
  }
}

function queueSubmission(inbox: LearnerInbox, submission: store.QuizSubmission): void {
  inbox.push(
    gradePrompt(submission, "wait", store.previousGrade(submission)),
    `quiz:${submission.id}`,
    () =>
      !store
        .listGrades(submission.classroom, submission.lesson)
        .some((g) => g.submissionId === submission.id),
  );
}

/** Restore pending requests without repeating requests delivered in this session. */
export function recoverLearnerRequests(inbox: LearnerInbox, classrooms: string[]): void {
  for (const classroom of classrooms) {
    for (const lesson of store.listLessons(classroom)) {
      for (const annotation of store.listAnnotations(classroom, lesson.name))
        queueQuestion(inbox, annotation);
      for (const submission of store.listSubmissions(classroom, lesson.name))
        queueSubmission(inbox, submission);
    }
  }
}

/** Route browser events into the session inbox. */
export function connectInbox(inbox: LearnerInbox): void {
  server.setHooks({
    delivery: "wait",
    onAsk: (annotation) => queueQuestion(inbox, annotation),
    onFollowUp: (annotation) => queueQuestion(inbox, annotation),
    onQuizSubmit: (submission) => queueSubmission(inbox, submission),
    onReflect: (reflection) => inbox.push(reflectPrompt(reflection, "wait")),
  });
}

// ── MCP-only tools ────────────────────────────────────────────────────────────

const MCP_HOST = {
  browseHint: "Call open_classroom to start the server, then give the learner the URL.",
  checkPage:
    "Call lesson_health for this lesson: it reports unfinished question types and a missing rubric. Call open_classroom before you share the URL. Open the lesson URL with a browser tool if you have one. If you have none, ask the learner to tell you about any contract error on the page.",
};

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: { error: true } };
}

function sessionTools(opened: (classroom: string | null) => void): ClassroomTool[] {
  return [
    {
      name: "begin_teaching",
      label: "Begin Teaching",
      description:
        "Start or continue teaching the user a topic, one short lesson at a time. " +
        "Returns the teaching method and the learner's classroom, if they have one. " +
        "Call this before you scaffold a classroom or write a lesson.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The topic or classroom name the user gave. Omit it to continue where they left off.",
          },
        },
        required: [],
      },
      async execute(params: { topic?: string }) {
        const topic = (params.topic ?? "").trim();
        const classroom = resolveClassroom(topic);
        const review = classroom ? classroomReviewText(classroom) : null;
        return ok(`${teachingPrompt(topic, classroom, review)}\n\n${HOST_BRIEF}`, { classroom });
      },
    },
    {
      name: "open_classroom",
      label: "Open Classroom",
      description:
        "Start the classroom server if it is not running, open it in the browser, and return its URL. " +
        "Give a classroom name to open that classroom; omit it for the list of every classroom.",
      parameters: {
        type: "object",
        properties: {
          classroom: { type: "string", description: "Classroom directory name, or its title." },
        },
        required: [],
      },
      async execute(params: { classroom?: string }) {
        const requested = params.classroom?.trim() || null;
        const target = requested ? resolveClassroom(requested) : null;
        if (requested && !target) {
          return fail(`No such classroom: ${requested}. Call list_classrooms.`);
        }
        const baseUrl = await server.start();
        opened(target);
        const url = target ? server.urlFor(target)! : baseUrl;
        if (shouldAutoOpen()) openUrl(url);
        return ok(`📚 ${url}`, { url });
      },
    },
    {
      name: "list_classrooms",
      label: "List Classrooms",
      description: "List every classroom and its lessons, with quiz scores and pending grading.",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return ok(classroomListText("Call begin_teaching with a topic to start one."));
      },
    },
  ];
}

const WAIT_TOOL = {
  name: "wait_for_learner",
  title: "Wait For Learner",
  description:
    "Wait for the learner to ask about a lesson passage, ask a follow-up, submit a quiz, or save a self-explanation. " +
    "Blocks until one arrives, then returns every waiting request in full, including the tool that answers it. " +
    "Call it while the learner works on the page. Do not call it while you need a chat reply to a retrieval question. Requires open_classroom first.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: {
        type: "number",
        description: `How long to wait before returning with nothing. Default ${DEFAULT_WAIT_SECONDS}, maximum ${MAX_WAIT_SECONDS}.`,
      },
    },
    required: [],
  },
};

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export class McpSession {
  private readonly tools: Map<string, ClassroomTool>;
  private readonly inbox: LearnerInbox;
  private readonly classrooms = new Set<string>();

  constructor(inbox: LearnerInbox) {
    this.inbox = inbox;
    this.tools = new Map(
      [
        ...classroomTools(MCP_HOST),
        ...sessionTools((classroom) => {
          for (const name of classroom ? [classroom] : store.listClassrooms().map((c) => c.name))
            this.classrooms.add(name);
          recoverLearnerRequests(inbox, [...this.classrooms]);
        }),
      ].map((tool) => [tool.name, tool]),
    );
  }

  /** Handle one message. Resolve with the response, or `null` when none is due. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (message.method === undefined) return null; // a response to us; we send no requests
    if (message.id === undefined || message.id === null) {
      if (message.method === "notifications/cancelled") {
        this.inbox.cancel(message.params?.requestId);
      }
      return null;
    }

    const id = message.id;
    switch (message.method) {
      case "initialize":
        return result(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(message.params?.protocolVersion)
            ? message.params.protocolVersion
            : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          // No `instructions`: they would cost every session, even one that never teaches.
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: this.listTools() });
      case "tools/call":
        return this.callTool(id, message.params?.name, message.params?.arguments ?? {});
      default:
        return error(id, -32601, `Method not found: ${message.method}`);
    }
  }

  private listTools(): unknown[] {
    return [
      ...[...this.tools.values()].map((tool) => ({
        name: tool.name,
        title: tool.label,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
      WAIT_TOOL,
    ];
  }

  private async callTool(
    id: string | number,
    name: unknown,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse | null> {
    if (name === WAIT_TOOL.name) return this.waitForLearner(id, args);

    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    if (!tool) return error(id, -32602, `Unknown tool: ${String(name)}`);

    const required = (tool.parameters["required"] as string[] | undefined) ?? [];
    const missing = required.filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return result(id, toolResult(fail(`Missing required argument: ${missing.join(", ")}`)));
    }

    try {
      return result(id, toolResult(await tool.execute(args)));
    } catch (err) {
      return result(id, toolResult(fail(err instanceof Error ? err.message : String(err))));
    }
  }

  private async waitForLearner(
    id: string | number,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse | null> {
    if (!server.isRunning()) {
      return result(
        id,
        toolResult(
          fail(
            "The classroom server is not running, so the learner cannot ask anything. Call open_classroom first.",
          ),
        ),
      );
    }

    let seconds: number;
    try {
      seconds = waitSeconds(args["timeout_seconds"]);
      recoverLearnerRequests(this.inbox, [...this.classrooms]);
    } catch (err) {
      return result(id, toolResult(fail((err as Error).message)));
    }
    const prompts = await this.inbox.wait(id, seconds * 1000);
    if (prompts === null) return null; // cancelled: the client expects no response

    if (prompts.length === 0) {
      return result(
        id,
        toolResult(
          ok(
            `Nothing from the learner in ${seconds} seconds. Listening has paused. Tell the learner and end your turn. Call wait_for_learner when they ask to continue.`,
          ),
        ),
      );
    }

    const header =
      prompts.length === 1
        ? ""
        : `${prompts.length} requests arrived. Handle each one. Follow the quiz follow-up rule before listening again. If you ask a retrieval question in chat, end your turn and wait for a chat reply.\n\n`;
    return result(id, toolResult(ok(header + prompts.join("\n\n---\n\n"))));
  }
}

/** Reject waits outside the supported range. */
export function waitSeconds(requested: unknown): number {
  if (requested === undefined) return DEFAULT_WAIT_SECONDS;
  if (
    typeof requested !== "number" ||
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_WAIT_SECONDS
  ) {
    throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_WAIT_SECONDS}.`);
  }
  return requested;
}

function toolResult(value: ToolResult): { content: ToolResult["content"]; isError: boolean } {
  return { content: value.content, isError: isFailure(value) };
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
