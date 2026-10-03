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

import { classroomListText, resolveClassroom } from "./commands.ts";
import { shouldAutoOpen } from "./config.ts";
import { openUrl } from "./open-browser.ts";
import { packageRoot } from "./paths.ts";
import { askPrompt, followUpPrompt, gradePrompt, teachingPrompt } from "./prompts.ts";
import * as server from "./server.ts";
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

export const DEFAULT_WAIT_SECONDS = 600;
export const MAX_WAIT_SECONDS = 3000;

/**
 * Appended to the teaching brief. It replaces what Pi does for free: there is no
 * `/classroom` command here, and nothing pushes the learner's questions to the agent.
 */
export const HOST_BRIEF = `## Classroom tools in this session

This session has no \`/classroom\` command, and it cannot push the learner's questions to you. Use these tools instead:

- \`open_classroom\` starts the classroom server and opens the browser. Call it before you give the learner a URL. Lesson URLs work only while this session runs.
- \`wait_for_learner\` blocks until the learner asks about a passage, asks a follow-up, or submits a quiz. It returns the full request and names the tool that answers it.

After you give the learner a lesson, call \`wait_for_learner\`. Answer what it returns, then call it again. Keep listening while the learner works through the lesson. When a wait ends with nothing, call it again. Stop when the learner says they are done. Tell the learner that they can press Esc to stop the wait and talk to you in the terminal.`;

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
  private readonly queue: string[] = [];
  private readonly waiters = new Map<string | number, Waiter>();

  get size(): number {
    return this.queue.length;
  }

  push(prompt: string): void {
    this.queue.push(prompt);
    const oldest = this.waiters.entries().next();
    if (oldest.done) return;
    const [key, waiter] = oldest.value;
    this.waiters.delete(key);
    clearTimeout(waiter.timer);
    waiter.resolve(this.queue.splice(0));
  }

  /**
   * Resolve with every queued prompt, as soon as there is one. Resolve with `[]` when
   * `timeoutMs` passes first, and with `null` when `cancel(key)` is called.
   */
  wait(key: string | number, timeoutMs: number): Promise<string[] | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.splice(0));
    if (this.waiters.has(key)) throw new Error(`Already waiting for request ${key}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve([]);
      }, timeoutMs);
      this.waiters.set(key, { resolve, timer });
    });
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
  }
}

/** Route the server's browser events into the inbox as wake-up prompts. */
export function connectInbox(inbox: LearnerInbox): void {
  server.setHooks({
    onAsk: (annotation) => inbox.push(askPrompt(annotation, "wait")),
    onFollowUp: (annotation, followUp) => inbox.push(followUpPrompt(annotation, followUp, "wait")),
    onQuizSubmit: (submission) => inbox.push(gradePrompt(submission, "wait")),
  });
}

// ── MCP-only tools ────────────────────────────────────────────────────────────

const MCP_HOST = {
  browseHint: "Call open_classroom to start the server, then give the learner the URL.",
};

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: { error: true } };
}

function sessionTools(): ClassroomTool[] {
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
        return ok(`${teachingPrompt(topic, classroom)}\n\n${HOST_BRIEF}`, { classroom });
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
    "Wait for the learner to ask about a lesson passage, ask a follow-up, or submit a quiz. " +
    "Blocks until one arrives, then returns every waiting request in full, including the tool that answers it. " +
    "Call it after you give the learner a lesson, and again after each answer. Requires open_classroom first.",
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

  constructor(inbox: LearnerInbox) {
    this.inbox = inbox;
    this.tools = new Map(
      [...classroomTools(MCP_HOST), ...sessionTools()].map((tool) => [tool.name, tool]),
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

    const seconds = waitSeconds(args["timeout_seconds"]);
    const prompts = await this.inbox.wait(id, seconds * 1000);
    if (prompts === null) return null; // cancelled: the client expects no response

    if (prompts.length === 0) {
      return result(
        id,
        toolResult(
          ok(
            `Nothing from the learner in ${seconds} seconds. Call wait_for_learner again to keep listening, unless the learner said they are done.`,
          ),
        ),
      );
    }

    const header =
      prompts.length === 1
        ? ""
        : `${prompts.length} requests arrived. Handle each one, then call wait_for_learner again.\n\n`;
    return result(id, toolResult(ok(header + prompts.join("\n\n---\n\n"))));
  }
}

/** Clamp a requested wait to whole seconds in `[1, MAX_WAIT_SECONDS]`. */
export function waitSeconds(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(1, Math.round(requested)));
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
