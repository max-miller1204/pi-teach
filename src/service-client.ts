/** Private local control transport. One service owns one classrooms root. */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { classroomsRoot, packageRoot } from "./paths.ts";

export const DEFAULT_SERVICE_PORT = 43123;
export function servicePort(): number {
  const text = process.env.PI_CLASSROOM_SERVICE_PORT;
  if (text === undefined) return DEFAULT_SERVICE_PORT;
  if (!/^[0-9]+$/.test(text) || Number(text) < 1 || Number(text) > 65535)
    throw new Error("PI_CLASSROOM_SERVICE_PORT must be an integer from 1 to 65535.");
  return Number(text);
}
export function servicePaths(): { dir: string; socket: string; log: string; lock: string } {
  if (!process.getuid) throw new Error("The persistent service requires Unix local sockets.");
  const root = path.resolve(classroomsRoot());
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const dir = path.join(root, ".pi-teach-service");
  return {
    dir,
    socket: path.join(os.tmpdir(), `pi-teach-${process.getuid()}-${key}.sock`),
    log: path.join(dir, "service.log"),
    lock: path.join(dir, "owner.json"),
  };
}
export function control<T = any>(endpoint: string, value?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: servicePaths().socket,
        agent: false,
        path: endpoint,
        method: value === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode !== 200)
              throw new Error(parsed.error ?? `Control request failed: ${res.statusCode}`);
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(190_000, () => req.destroy(new Error("Classroom control request timed out.")));
    req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
export async function serviceStatus(): Promise<any> {
  try {
    return await control("/status");
  } catch (err) {
    if (!["ENOENT", "ECONNREFUSED"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    return {
      running: false,
      root: path.resolve(classroomsRoot()),
      port: servicePort(),
      log: servicePaths().log,
    };
  }
}
export async function ensureService(): Promise<any> {
  const version = (
    JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const status = await serviceStatus();
  if (status.running) {
    if (
      status.port !== servicePort() ||
      status.packageRoot !== path.resolve(packageRoot()) ||
      status.version !== version
    )
      throw new Error(
        "An existing service has a different port, package path, or version. Stop it explicitly before starting this version.",
      );
    return status;
  }
  const paths = servicePaths();
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(paths.log, "a", 0o600);
  const child = spawn(process.execPath, [path.join(packageRoot(), "src", "service-main.ts")], {
    cwd: packageRoot(),
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PI_CLASSROOMS_DIR: path.resolve(classroomsRoot()) },
  });
  fs.closeSync(log);
  child.unref();
  let spawnError: Error | undefined;
  child.on("error", (err) => {
    spawnError = err;
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const current = await serviceStatus();
    if (current.running) {
      if (
        current.port !== servicePort() ||
        current.packageRoot !== path.resolve(packageRoot()) ||
        current.version !== version
      )
        throw new Error("A different service won startup ownership. Stop it explicitly.");
      return current;
    }
    if (child.exitCode !== null && !fs.existsSync(paths.lock))
      throw new Error(`Classroom service failed to start. Read ${paths.log}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Classroom service did not start within 10 seconds. Read ${paths.log}.`);
}
