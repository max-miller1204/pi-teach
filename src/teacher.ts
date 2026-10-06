/** Dedicated teachers return a plan. Only the classroom service applies it. */
import { spawn } from "node:child_process";
import { JsonObjectStream } from "./json-object-stream.ts";
import { TeacherDeadline } from "./teacher-deadline.ts";

export type Backend = "codex" | "claude";
export interface TeacherIdentity {
  backend: Backend;
  sessionId?: string;
}
export interface TeacherPlan {
  calls: Array<{ name: string; arguments_json: string }>;
  message: string;
  learning_record: string;
  notes_markdown: string;
}
export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            enum: ["answer_lesson_question", "grade_lesson_quiz", "record_retrieval_check"],
          },
          arguments_json: { type: "string" },
        },
        required: ["name", "arguments_json"],
      },
    },
    message: { type: "string" },
    learning_record: { type: "string" },
    notes_markdown: { type: "string" },
  },
  required: ["calls", "message", "learning_record", "notes_markdown"],
};
export type RunTeacher = (
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  saveIdentity: (sessionId: string) => void,
  signal?: AbortSignal,
) => Promise<TeacherPlan>;

export function parsePlan(value: unknown): TeacherPlan {
  if (!value || typeof value !== "object") throw new Error("Teacher returned no plan.");
  const p = value as TeacherPlan;
  if (
    !Array.isArray(p.calls) ||
    typeof p.message !== "string" ||
    typeof p.learning_record !== "string" ||
    typeof p.notes_markdown !== "string" ||
    p.calls.some((c) => !c || typeof c.name !== "string" || typeof c.arguments_json !== "string")
  ) {
    throw new Error("Teacher returned an invalid plan.");
  }
  return p;
}

export const runTeacher: RunTeacher = async (identity, prompt, cwd, saveIdentity, signal) => {
  return identity.backend === "codex"
    ? runCodex(identity, prompt, cwd, saveIdentity, signal)
    : runClaude(identity, prompt, cwd, saveIdentity, signal);
};

async function runClaude(
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  save: (id: string) => void,
  signal?: AbortSignal,
): Promise<TeacherPlan> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(PLAN_SCHEMA),
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--permission-mode",
    "dontAsk",
  ];
  if (identity.sessionId) args.push("--resume", identity.sessionId);
  const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], signal });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.stdin.on("error", (err) => {
    child.kill();
  });
  child.stdin.end(prompt);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Claude teacher timed out after 180 seconds."));
    }, 180_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`Claude teacher exited with ${code}: ${stderr}`);
        const result = JSON.parse(stdout);
        if (result.session_id) save(result.session_id);
        if (result.is_error)
          throw new Error(
            `Claude teacher failed: ${result.result ?? JSON.stringify(result.errors)}`,
          );
        resolve(parsePlan(result.structured_output));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function runCodex(
  identity: TeacherIdentity,
  prompt: string,
  cwd: string,
  save: (id: string) => void,
  signal?: AbortSignal,
): Promise<TeacherPlan> {
  const child = spawn("codex", ["app-server", "--stdio"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    signal,
  });
  let seq = 0,
    stderr = "",
    finalText = "";
  let threadId: string | undefined, turnId: string | undefined, failure: Error | undefined;
  const pending = new Map<
    number,
    { method: string; resolve: (v: any) => void; reject: (err: Error) => void }
  >();
  let completedResolve: () => void, completedReject: (err: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    completedResolve = resolve;
    completedReject = reject;
  });
  // Attach immediately. A process failure can precede turn/start.
  void completed.catch(() => {});
  function fail(err: Error) {
    failure ??= err;
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
    completedReject(err);
  }
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", (code) => fail(new Error(`Codex teacher exited with ${code}: ${stderr}`)));
  const deadline = new TeacherDeadline((err) => {
    fail(err);
    child.kill("SIGKILL");
  });
  const objects = new JsonObjectStream();
  child.stdout.setEncoding("utf8");
  function receive(value: unknown) {
    if (!value || typeof value !== "object" || !("id" in value || "method" in value))
      throw new Error("Invalid Codex RPC message.");
    const m = value as any;
    if (m.id !== undefined && !m.method) {
      const waiter = pending.get(m.id);
      pending.delete(m.id);
      if (waiter?.method === "thread/start" || waiter?.method === "thread/resume")
        threadId = m.result?.thread?.id;
      if (waiter?.method === "turn/start") turnId = m.result?.turn?.id;
      if (m.error) waiter?.reject(new Error(m.error.message));
      else waiter?.resolve(m.result);
    } else if (m.id !== undefined) {
      child.stdin.write(
        JSON.stringify({
          id: m.id,
          error: { code: -32601, message: "Dedicated teacher cannot use interactive tools." },
        }) + "\n",
      );
    } else if (m.params?.threadId === threadId && threadId !== undefined) {
      if (m.method === "turn/started" && m.params.turn.id === turnId) {
        deadline.enter(`running turn ${turnId} in thread ${threadId}`);
      } else if (m.params.turnId === turnId && turnId !== undefined) {
        if (
          /^item\/(agentMessage\/delta|reasoning\/(textDelta|summaryTextDelta))$/.test(m.method) &&
          typeof m.params.delta === "string" &&
          m.params.delta.length > 0
        )
          deadline.progress(m.method);
        if (m.method === "item/completed" && m.params.item.type === "reasoning")
          deadline.progress("completed reasoning item");
        if (m.method === "item/completed" && m.params.item.type === "agentMessage") {
          deadline.progress("received agent message");
          if (m.params.item.phase !== "commentary") finalText = m.params.item.text;
        }
      }
      if (m.method !== "turn/completed" || m.params.turn.id !== turnId) return;
      if (m.params.turn.status !== "completed")
        completedReject(
          new Error(`Codex turn ${m.params.turn.status}: ${JSON.stringify(m.params.turn.error)}`),
        );
      else completedResolve();
    }
  }
  child.stdout.on("data", (chunk: string) => {
    if (failure) return;
    try {
      objects.push(chunk, receive);
    } catch (err) {
      fail(new Error(`Invalid Codex stdout: ${(err as Error).message}`, { cause: err }));
    }
  });
  child.stdout.on("end", () => {
    try {
      objects.finish();
    } catch (err) {
      fail(err as Error);
    }
  });
  function request(method: string, params: unknown): Promise<any> {
    if (failure) return Promise.reject(failure);
    deadline.enter(`waiting for ${method}`);
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", { clientInfo: { name: "pi_teach_teacher", version: "0.6.0" } });
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const config = {
      cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { mcp_servers: {}, features: { shell_tool: false } },
    };
    const result = identity.sessionId
      ? await request("thread/resume", { ...config, threadId: identity.sessionId })
      : await request("thread/start", config);
    save(result.thread.id);
    await request("turn/start", {
      threadId: result.thread.id,
      input: [{ type: "text", text: prompt }],
      outputSchema: PLAN_SCHEMA,
    });
    deadline.enter(`running turn ${turnId} in thread ${threadId}`);
    await completed;
    if (failure) throw failure;
    let value: unknown;
    try {
      value = JSON.parse(finalText);
    } catch (err) {
      throw new Error(`Invalid Codex teacher plan JSON: ${(err as Error).message}`, { cause: err });
    }
    return parsePlan(value);
  } finally {
    deadline.stop();
    child.stdin.end();
    child.kill();
  }
}
