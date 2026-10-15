/** Optional settings in ~/.pi/agent/classroom.json. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClassroomConfig {
  port?: number;
  tailscale?: boolean;
  tailscalePort?: number;
}

let testConfigPath: string | undefined;
export function _overrideConfigPath(file: string | undefined): void {
  testConfigPath = file;
}

/** `PI_CLASSROOM_CONFIG` when it is set, else `~/.pi/agent/classroom.json`. */
export function configPath(): string {
  if (testConfigPath) return testConfigPath;
  return (
    process.env["PI_CLASSROOM_CONFIG"] ?? path.join(os.homedir(), ".pi", "agent", "classroom.json")
  );
}

export function readConfig(file = configPath()): ClassroomConfig {
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read classroom config ${file}`, { cause: err });
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config must be an object.");
    }
    const config = parsed as ClassroomConfig;
    resolveConfiguredPort(config.port);
    if (config.tailscale !== undefined && typeof config.tailscale !== "boolean")
      throw new Error("tailscale must be a boolean.");
    if (config.tailscalePort !== undefined) resolveConfiguredPort(config.tailscalePort);
    return config;
  } catch (err) {
    throw new Error(`Invalid classroom config ${file}: ${(err as Error).message}`, { cause: err });
  }
}

/** Use an ephemeral port only when no port is configured. */
export function resolveConfiguredPort(port: unknown): number {
  if (port === undefined) return 0;
  if (typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  throw new Error("Configured port must be an integer from 1 to 65535.");
}

/** Automatic tailnet links. `PI_CLASSROOM_TAILSCALE=0` takes priority. */
export function tailscaleLinks(config: ClassroomConfig = readConfig()): {
  enabled: boolean;
  port?: number;
} {
  return {
    enabled: process.env["PI_CLASSROOM_TAILSCALE"] !== "0" && config.tailscale !== false,
    port: config.tailscalePort,
  };
}
