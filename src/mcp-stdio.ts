/**
 * mcp-stdio.ts: runs the classroom MCP server over stdio. Importing it starts it.
 *
 * Messages are newline-delimited JSON-RPC, as the MCP stdio transport requires.
 * stdout carries protocol messages only; diagnostics go to stderr.
 */

import * as readline from "node:readline";

import { connectInbox, LearnerInbox, McpSession, type JsonRpcMessage } from "./mcp.ts";
import * as server from "./server.ts";

const inbox = new LearnerInbox();
const session = new McpSession(inbox);
connectInbox(inbox);

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line) as JsonRpcMessage;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  session.handle(message).then(
    (response) => {
      if (response) write(response);
    },
    (err: unknown) => {
      console.error("[classroom] MCP request failed", err);
      if (message.id !== undefined && message.id !== null) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    },
  );
});

// The client closes stdin when the session ends. The server goes with it.
lines.on("close", () => {
  inbox.reset();
  void server.close().then(() => process.exit(0));
});
