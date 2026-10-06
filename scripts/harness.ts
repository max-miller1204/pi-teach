/** Shared helpers for the scripts that drive a real Claude Code or Codex session. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type Harness = "claude" | "codex";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Claude Code prefixes plugin MCP tools with this. Codex reports the bare name. */
export const CLAUDE_PREFIX = "mcp__plugin_pi-teach_classroom__";

export function parseHarness(value: string | undefined, usage: string): Harness {
  if (value !== "claude" && value !== "codex") throw new Error(usage);
  return value;
}

/** A temporary CODEX_HOME with this checkout installed as a plugin. */
export function codexHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-e2e-codex-"));
  const realHome = process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
  fs.copyFileSync(path.join(realHome, "auth.json"), path.join(home, "auth.json"));
  for (const args of [
    ["plugin", "marketplace", "add", ROOT],
    ["plugin", "add", "pi-teach@pi-teach"],
  ]) {
    const run = spawnSync("codex", args, { env: { ...process.env, CODEX_HOME: home } });
    if (run.status !== 0) throw new Error(`codex ${args.join(" ")} failed:\n${run.stderr}`);
  }
  return home;
}

/**
 * The command that runs one non-interactive turn. `tools` are classroom tool names;
 * `extraTools` are Claude Code built-in tools to allow as well.
 */
export function harnessCommand(
  harness: Harness,
  prompt: string,
  tools: string[],
  extraTools: string[] = ["Read"],
): [string, string[]] {
  if (harness === "claude") {
    return [
      "claude",
      [
        "--plugin-dir",
        ROOT,
        "--add-dir",
        ROOT,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        [...tools.map((tool) => `${CLAUDE_PREFIX}${tool}`), ...extraTools].join(","),
      ],
    ];
  }
  // Reason: `codex exec` cannot prompt for MCP tool approval, and has no per-tool
  // allowlist. The run is confined to temporary directories and a fixed prompt.
  return [
    "codex",
    [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ],
  ];
}

/**
 * The classroom tool calls in a harness's JSON event stream, in order. Claude Code
 * emits `"name":"mcp__plugin_pi-teach_classroom__<tool>"` on each tool use; Codex emits
 * `"server":"classroom","tool":"<tool>"` on each MCP call's start and end events.
 */
export function toolCalls(harness: Harness, events: string): string[] {
  const pattern =
    harness === "claude"
      ? new RegExp(`"name":"${CLAUDE_PREFIX}([a-z_]+)"`, "g")
      : /"server":"classroom","tool":"([a-z_]+)"[^\n]*?"status":"in_progress"/g;
  return [...events.matchAll(pattern)].map((match) => match[1]!);
}

/**
 * The browser commands an agent ran: `playwright-cli` shell commands, and calls to a
 * browser MCP tool. The authoring evaluation uses this to see whether the agent
 * opened its own pages.
 */
export function browserCommands(harness: Harness, events: string): string[] {
  const browserTool = /browser|chrome|playwright|preview/i;
  const commands: string[] = [];
  for (const line of events.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (harness === "claude" && event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type !== "tool_use") continue;
        const command = typeof block.input?.command === "string" ? block.input.command : "";
        if (
          block.name === "Bash" &&
          (command.includes("playwright-cli") || command.includes("scripts/check-lesson.ts"))
        )
          commands.push(command);
        else if (browserTool.test(block.name)) commands.push(block.name);
      }
    }
    if (harness === "codex" && event.type === "item.completed") {
      const item = event.item ?? {};
      if (
        item.type === "command_execution" &&
        (String(item.command).includes("playwright-cli") ||
          String(item.command).includes("scripts/check-lesson.ts"))
      ) {
        commands.push(String(item.command));
      } else if (item.type === "mcp_tool_call" && browserTool.test(`${item.server} ${item.tool}`)) {
        commands.push(`${item.server}.${item.tool}`);
      }
    }
  }
  return commands;
}

export async function until<T>(what: string, timeoutMs: number, probe: () => T | null): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Read a JSON file that another process may still be writing. Null until it parses. */
export function readJsonWhenReady<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
