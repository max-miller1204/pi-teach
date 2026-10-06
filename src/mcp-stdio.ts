/** An MCP connection attaches to the persistent service. stdin does not own HTTP. */
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { control, ensureService, serviceStatus } from "./service-client.ts";
import { McpSession, LearnerInbox, type JsonRpcMessage } from "./mcp.ts";
import { serviceToolDefinitions } from "./service-tools.ts";
import type { Backend } from "./teacher.ts";

const local = new McpSession(new LearnerInbox(), {
  tools: serviceToolDefinitions.map((tool) => ({
    ...tool,
    async execute() {
      throw new Error("Service tools require a service connection.");
    },
  })),
  async open() {
    throw new Error("Opening a classroom requires a service connection.");
  },
});
const client = randomUUID();
let backend: Backend | undefined;
let connected = false;
let start: Promise<unknown> | undefined;
function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
async function attach(): Promise<void> {
  start ??= ensureService().catch((err) => {
    start = undefined;
    throw err;
  });
  try {
    await start;
    connected = true;
  } finally {
    start = undefined;
  }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  void (async () => {
    if (message.method === "initialize") {
      const configured = process.env.PI_CLASSROOM_TEACHER;
      if (configured !== undefined && configured !== "codex" && configured !== "claude")
        throw new Error("PI_CLASSROOM_TEACHER must be codex or claude.");
      const name = String(message.params?.clientInfo?.name ?? "").toLowerCase();
      backend =
        (configured as Backend | undefined) ??
        (name.includes("codex") ? "codex" : name.includes("claude") ? "claude" : undefined);
    }
    if (message.method !== "tools/call") {
      const response = await local.handle(message);
      if (response) write(response);
      return;
    }
    // Status and stop must not start a stopped service.
    if (
      message.method === "tools/call" &&
      message.params?.name === "classroom_service" &&
      ["status", "stop"].includes(message.params?.arguments?.action)
    ) {
      const status = await serviceStatus();
      if (!status.running) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(status) }], isError: false },
        });
        return;
      }
    }
    await attach();
    const response = await control("/rpc", { client, backend, message });
    if (response) write(response);
  })().catch((err) => {
    console.error("[classroom] MCP request failed", err);
    if (message.id !== undefined && message.id !== null)
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: err.message } });
  });
});
lines.on("close", () => {
  void (async () => {
    if (start) await start;
    if (connected) await control("/disconnect", { client });
  })()
    .catch((err) => console.error("[classroom] detach failed", err))
    .finally(() => process.exit(0));
});
