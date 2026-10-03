#!/usr/bin/env node
/**
 * launch.mjs: the entry point Claude Code and Codex run for the classroom MCP server.
 *
 * Pi loads this package with its own TypeScript loader and installs its dependencies.
 * Claude Code and Codex copy the repository and run this file, so it does two things
 * first:
 *
 *   1. Checks that Node can run TypeScript directly (Node 22.18 or later).
 *   2. Installs the runtime dependencies on the first run, from the lockfile.
 *
 * Every failure stops the server with a message on stderr. stdout is the MCP transport,
 * so nothing here may write to it.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.features.typescript) {
  throw new Error(
    `pi-teach needs Node 22.18 or later to run TypeScript without a build step. Found Node ${process.versions.node}.`,
  );
}

function hasRuntimeDependencies() {
  try {
    import.meta.resolve("marked");
    return true;
  } catch {
    return false;
  }
}

if (!hasRuntimeDependencies()) {
  console.error("[classroom] Installing runtime dependencies in", root);
  const install = spawnSync(
    "npm",
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: root,
      stdio: ["ignore", 2, 2],
      shell: process.platform === "win32",
    },
  );
  if (install.error) throw install.error;
  if (install.status !== 0) {
    throw new Error(`npm ci failed in ${root} with exit code ${install.status}.`);
  }
}

await import("../src/mcp-stdio.ts");
