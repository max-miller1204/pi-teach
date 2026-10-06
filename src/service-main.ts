/** Detached service entry point. stdout is a diagnostic log, not MCP transport. */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { LearnerInbox, McpSession, type JsonRpcMessage } from "./mcp.ts";
import { classroomsRoot, packageRoot } from "./paths.ts";
import { servicePaths, servicePort } from "./service-client.ts";
import { PhoneAccess } from "./phone-access.ts";
import { TeacherService } from "./teacher-service.ts";
import { readTeacherState } from "./service-state.ts";
import type { Backend } from "./teacher.ts";
import { serviceToolDefinitions } from "./service-tools.ts";
import type { ClassroomTool, ToolResult } from "./tools.ts";
import * as store from "./store.ts";
import * as server from "./server.ts";

const version = (
  JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8")) as {
    version: string;
  }
).version;
const paths = servicePaths(),
  port = servicePort();
fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
function claim(): void {
  try {
    const fd = fs.openSync(paths.lock, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, packageRoot: packageRoot(), port }));
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const owner = JSON.parse(fs.readFileSync(paths.lock, "utf8"));
    try {
      process.kill(owner.pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      fs.unlinkSync(paths.lock);
      claim();
      return;
    }
    throw new Error(`Classroom service is already owned by process ${owner.pid}.`);
  }
}
claim();
const teacher = new TeacherService(),
  phone = new PhoneAccess();
const clients = new Map<string, { session: McpSession; inbox: LearnerInbox }>();
let closing = false;
function status(): unknown {
  return {
    running: true,
    stopping: closing,
    pid: process.pid,
    root: path.resolve(classroomsRoot()),
    packageRoot: path.resolve(packageRoot()),
    version,
    port,
    url: server.getBaseUrl(),
    log: paths.log,
  };
}
function result(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    details: {},
  };
}
async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  for (const c of clients.values()) c.inbox.reset();
  try {
    await phone.stop();
  } catch (err) {
    closing = false;
    throw err;
  }
  await teacher.stop();
  await server.close();
  await new Promise<void>((resolve) => ipc.close(() => resolve()));
  fs.unlinkSync(paths.lock);
  if (fs.existsSync(paths.socket)) fs.unlinkSync(paths.socket);
}
const tools: ClassroomTool[] = [
  {
    ...serviceToolDefinitions[0],
    async execute(args: { action: string }) {
      if (args.action === "status" || args.action === "start") return result(status());
      if (args.action !== "stop") throw new Error("Unknown service action.");
      // Clean the route before reporting success. Keep the service live if cleanup fails.
      await phone.stop();
      setTimeout(() => {
        void stop()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error(err);
            closing = false;
          });
      }, 50);
      return result("Classroom service is stopping.");
    },
  },
  {
    ...serviceToolDefinitions[1],
    async execute(args: {
      action: string;
      classroom?: string;
      lesson?: string;
      https_port?: number;
    }) {
      if (args.action === "status") return result(await phone.status());
      if (args.action === "stop") return result(await phone.stop());
      if (args.action !== "start") throw new Error("Unknown phone action.");
      if (!args.classroom || !store.readClassroom(args.classroom))
        throw new Error("A classroom is required for phone access.");
      if (args.lesson && !store.readLesson(args.classroom, args.lesson))
        throw new Error("No such lesson.");
      teacher.attach(args.classroom);
      const base = await phone.start(server.getBaseUrl()!, args.https_port);
      const url = `${base}/c/${encodeURIComponent(args.classroom)}${args.lesson ? `/${encodeURIComponent(args.lesson)}` : ""}`;
      const checked = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!checked.ok) throw new Error(`Phone URL check returned ${checked.status}: ${url}`);
      await checked.body?.cancel();
      return result(`[Open ${args.lesson ? "lesson" : "classroom"}](${url})`);
    },
  },
];

function session(id: string, backend?: Backend): McpSession {
  const existing = clients.get(id);
  if (existing) return existing.session;
  const inbox = new LearnerInbox();
  const mcp = new McpSession(inbox, {
    tools,
    async open(classroom, requested) {
      if (requested !== undefined && requested !== "claude" && requested !== "codex")
        throw new Error("Invalid teacher_backend.");
      const selected = (requested as Backend | undefined) ?? backend;
      for (const name of classroom ? [classroom] : store.listClassrooms().map((c) => c.name))
        teacher.attach(
          name,
          requested === undefined && readTeacherState(name) ? undefined : selected,
        );
      return server.urlFor(classroom ?? undefined)!;
    },
  });
  clients.set(id, { session: mcp, inbox });
  return mcp;
}
const ipc = http.createServer((req, res) => {
  void (async () => {
    let value: unknown;
    if (req.url === "/status" && req.method === "GET") value = status();
    else {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error("Control body is too large.");
      }
      const args = JSON.parse(body);
      if (req.url === "/disconnect") {
        clients.get(args.client)?.inbox.reset();
        clients.delete(args.client);
        value = { detached: true };
      } else if (req.url === "/stop") {
        await phone.stop();
        value = { stopping: true };
        setTimeout(() => {
          void stop()
            .then(() => process.exit(0))
            .catch(console.error);
        }, 50);
      } else if (req.url === "/rpc") {
        if (
          typeof args.client !== "string" ||
          ![undefined, "codex", "claude"].includes(args.backend)
        )
          throw new Error("Invalid client identity.");
        value = await session(args.client, args.backend).handle(args.message as JsonRpcMessage);
      } else throw new Error("Unknown control endpoint.");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  })().catch((err) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  });
});
try {
  if (fs.existsSync(paths.socket)) fs.unlinkSync(paths.socket);
  teacher.connect();
  await server.start(port);
  teacher.restore();
  await new Promise<void>((resolve, reject) => {
    ipc.once("error", reject);
    ipc.listen(paths.socket, resolve);
  });
  fs.chmodSync(paths.socket, 0o600);
  console.log(
    `Classroom service ${process.pid} owns ${classroomsRoot()} on ${server.getBaseUrl()}.`,
  );
} catch (err) {
  fs.unlinkSync(paths.lock);
  throw err;
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err);
        closing = false;
      });
  });
