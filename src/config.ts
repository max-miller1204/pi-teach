/**
 * config.ts — optional ~/.pi/agent/classroom.json settings.
 *
 *   { "port": 4098, "autoOpen": true }
 *
 * Both keys are optional: an unset/invalid port means "pick an ephemeral one".
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClassroomConfig {
  port?: number;
  autoOpen?: boolean;
}

export function configPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "classroom.json");
}

export function readConfig(): ClassroomConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ClassroomConfig) : {};
  } catch {
    return {};
  }
}

/** Resolve a configured port, or 0 (ephemeral) when unset or out of range. */
export function resolveConfiguredPort(port: unknown): number {
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  return 0;
}

/** Whether the browser should be opened automatically. Env var wins. */
export function shouldAutoOpen(config: ClassroomConfig = readConfig()): boolean {
  if (process.env["PI_CLASSROOM_AUTO_OPEN"] === "0") return false;
  return config.autoOpen !== false;
}
