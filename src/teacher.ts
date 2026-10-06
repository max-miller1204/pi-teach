/** Dedicated teachers return a plan. Only the classroom service applies it. */
import { spawn } from "node:child_process";
import * as readline from "node:readline";

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
  const pending = new Map<number, { resolve: (v: any) => void; reject: (err: Error) => void }>();
  let completedResolve: () => void, completedReject: (err: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    completedResolve = resolve;
    completedReject = reject;
  });
  // Attach immediately. A process failure can precede turn/start.
  void completed.catch(() => {});
  function fail(err: Error) {
    for (const waiter of pending.values()) waiter.reject(err);
    pending.clear();
    completedReject(err);
  }
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code) => fail(new Error(`Codex teacher exited with ${code}: ${stderr}`)));
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && !m.method) {
        const waiter = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) waiter?.reject(new Error(m.error.message));
        else waiter?.resolve(m.result);
      } else if (m.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            id: m.id,
            error: { code: -32601, message: "Dedicated teacher cannot use interactive tools." },
          }) + "\n",
        );
      } else if (m.method === "item/completed" && m.params.item.type === "agentMessage") {
        finalText = m.params.item.text;
      } else if (m.method === "turn/completed") {
        if (m.params.turn.status !== "completed")
          completedReject(
            new Error(`Codex turn ${m.params.turn.status}: ${JSON.stringify(m.params.turn.error)}`),
          );
        else completedResolve();
      }
    } catch (err) {
      fail(err as Error);
    }
  });
  function request(method: string, params: unknown): Promise<any> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  const timer = setTimeout(() => {
    fail(new Error("Codex teacher timed out after 180 seconds."));
    child.kill("SIGKILL");
  }, 180_000);
  try {
    await request("initialize", { clientInfo: { name: "pi_teach_teacher", version: "0.5.1" } });
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
    await completed;
    return parsePlan(JSON.parse(finalText));
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
