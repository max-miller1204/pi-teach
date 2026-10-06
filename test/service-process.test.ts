/** Exercise process lifetime through the actual MCP launcher and service. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";
import { _overrideClassroomsDir, packageRoot } from "../src/paths.ts";
import { control, ensureService, serviceStatus } from "../src/service-client.ts";

let f: Fixture, env: NodeJS.ProcessEnv, originalPort: string | undefined;
beforeEach(async () => {
  f = makeFixture();
  seedClassroom(f);
  f.write("rust/001-ownership/quiz/key.json", '{"q1":"dropped"}');
  const socket = net.createServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((r) => socket.close(() => r()));
  originalPort = process.env.PI_CLASSROOM_SERVICE_PORT;
  process.env.PI_CLASSROOM_SERVICE_PORT = String(port);
  const bin = path.join(f.root, "bin");
  fs.mkdirSync(bin);
  f.write("behavior.json", "{}");
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}\n` +
      String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const behaviorFile = path.join(process.cwd(), '../behavior.json');
const behavior = JSON.parse(fs.readFileSync(behaviorFile, 'utf8'));
const lines = readline.createInterface({input:process.stdin});
const send = value => process.stdout.write((behavior.packed && value.id ? '{"method":"test/progress","params":{}}' : '') + JSON.stringify(value) + '\n');
lines.on('line', line => {
 const m = JSON.parse(line);
 if (!m.id) return;
 if (m.method === 'initialize') send({id:m.id,result:{}});
 else if (m.method === 'thread/start' || m.method === 'thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId || 'test-dedicated-session'}}});
 else if (m.method === 'turn/start') {
  if (behavior.invalid) { process.stdout.write('diagnostic text\n'); return; }
  if (behavior.truncated) { process.stdout.write('{"method":'); process.exit(0); return; }
  const prompt = m.params.input[0].text;
  const ask = /annotation_id: "([^"]+)"/.exec(prompt);
  const quiz = /submission_id: "([^"]+)"/.exec(prompt);
  const calls = ask ? [{name:'answer_lesson_question',arguments_json:JSON.stringify({annotation_id:ask[1],answer_markdown:'The owner releases the value.'})}] :
   quiz ? [{name:'grade_lesson_quiz',arguments_json:JSON.stringify({submission_id:quiz[1],score:0,feedback_markdown:'Check the lifetime.',questions:[{question_id:'q1',correct:false,feedback:'The value is dropped.'}]})}] : [];
  send({id:m.id,result:{turn:{id:'test-turn'}}});
  const finish = () => {
  if (behavior.foreign) {
   send({method:'item/completed',params:{threadId:'other-thread',turnId:'other-turn',item:{type:'agentMessage',text:'not a plan'}}});
   send({method:'turn/completed',params:{threadId:'other-thread',turn:{id:'other-turn',status:'failed',error:{message:'unrelated failure'}}}});
  }
  send({method:'item/completed',params:{threadId:'test-dedicated-session',turnId:'test-turn',item:{type:'agentMessage',text:JSON.stringify({calls,message:'What happens with another owner?',learning_record:'',notes_markdown:''})}}});
  send({method:'turn/completed',params:{threadId:'test-dedicated-session',turn:{id:'test-turn',status:'completed'}}});
  };
  if (behavior.gate) {
   fs.appendFileSync(path.join(process.cwd(), '../turns.log'), quiz[1] + '\n');
   const timer = setInterval(() => {
    if (behavior.progress) send({method:'item/agentMessage/delta',params:{threadId:'test-dedicated-session',turnId:'test-turn',delta:'working'}});
    if (behavior.noise) send({method:'item/agentMessage/delta',params:{threadId:'unrelated-thread',turnId:'unrelated-turn',delta:'working'}});
    if (fs.existsSync(path.join(process.cwd(), '../release'))) { clearInterval(timer); finish(); }
   }, 50);
  } else finish();
 }
});
`,
    { mode: 0o700 },
  );
  env = {
    ...process.env,
    PI_CLASSROOMS_DIR: f.root,
    PI_CLASSROOM_AUTO_OPEN: "0",
    PATH: `${bin}:${process.env.PATH}`,
  };
});
afterEach(async () => {
  _overrideClassroomsDir(f.root);
  if ((await serviceStatus()).running) await control("/stop", {});
  await new Promise((r) => setTimeout(r, 200));
  if (originalPort === undefined) delete process.env.PI_CLASSROOM_SERVICE_PORT;
  else process.env.PI_CLASSROOM_SERVICE_PORT = originalPort;
  f.cleanup();
});
function client() {
  const child = spawn(process.execPath, [path.join(packageRoot(), "mcp/launch.mjs")], {
    cwd: packageRoot(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>();
  let id = 0;
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  return {
    child,
    exited,
    async call(method: string, params: unknown = {}) {
      const key = ++id;
      const reply = new Promise<any>((resolve) => pending.set(key, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
      return reply;
    },
  };
}
async function waitFor(probe: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Process fixture did not finish.");
}
it("keeps HTTP and submissions alive after MCP exit, reconnects, and preserves grades after restart", async () => {
  const first = client();
  await first.call("initialize", { clientInfo: { name: "codex-test" } });
  const tools = await first.call("tools/list");
  expect(tools.result.tools.map((t: any) => t.name).sort()).toEqual(
    [
      "begin_teaching",
      "classroom_phone",
      "classroom_service",
      "lesson_health",
      "list_classrooms",
      "open_classroom",
      "scaffold_classroom",
      "scaffold_lesson",
      "scaffold_review",
    ].sort(),
  );
  expect(
    tools.result.tools.find((t: any) => t.name === "scaffold_lesson").inputSchema.properties.mode
      .enum,
  ).toEqual(["lesson", "quiz", "pretest"]);
  expect((await serviceStatus()).running).toBe(false);
  const opened = await first.call("tools/call", {
    name: "open_classroom",
    arguments: { classroom: "rust" },
  });
  expect(opened.result.isError).toBe(false);
  const before = await serviceStatus(),
    base = before.url;
  first.child.stdin.end();
  await first.exited;
  expect((await fetch(`${base}/c/rust/001-ownership`)).status).toBe(200);
  const body = { classroom: "rust", lesson: "001-ownership" };
  const asked = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, question: "Why?", anchor: { exact: "Some lesson prose" } }),
  });
  expect(asked.status).toBe(201);
  const submitted = await fetch(`${base}/api/quiz/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      quizId: "check-1",
      kind: "check",
      answers: [{ questionId: "q1", type: "term", prompt: "Lifetime?", value: "forever" }],
    }),
  });
  expect(submitted.status).toBe(201);
  const stateUrl = `${base}/api/state?classroom=rust&lesson=001-ownership`;
  await waitFor(async () => {
    const state = await (await fetch(stateUrl)).json();
    return (
      state.annotations[0]?.status === "answered" &&
      !!state.quizzes[0]?.grade &&
      state.teacher.requests.every((r: any) => r.status === "done")
    );
  });
  const second = client();
  await second.call("initialize", { clientInfo: { name: "codex-test" } });
  await second.call("tools/call", { name: "open_classroom", arguments: { classroom: "rust" } });
  expect((await serviceStatus()).pid).toBe(before.pid);
  second.child.stdin.end();
  await second.exited;
  await control("/stop", {});
  await waitFor(async () => {
    try {
      process.kill(before.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return true;
    }
  });
  expect((await serviceStatus()).running).toBe(false);
  // Use the same fake authenticated executable for the restarted service.
  const oldPath = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    await ensureService();
  } finally {
    process.env.PATH = oldPath;
  }
  const restarted = await (await fetch(stateUrl)).json();
  expect(restarted.quizzes[0].grade.score).toBe(0);
  expect(restarted.teacher.identity.sessionId).toBe("test-dedicated-session");
  const grades = fs.readdirSync(path.join(f.root, "rust/001-ownership/quiz/grades"));
  expect(grades).toHaveLength(1);
  expect((await fetch(`${base}/c/rust/001-ownership/quiz/key.json`)).status).toBe(404);
}, 25_000);

it("attaches simultaneous MCP clients to one owner without a port conflict", async () => {
  const a = client(),
    b = client();
  try {
    await Promise.all([
      a.call("initialize", { clientInfo: { name: "codex-test" } }),
      b.call("initialize", { clientInfo: { name: "codex-test" } }),
    ]);
    const replies = await Promise.all([
      a.call("tools/call", { name: "open_classroom", arguments: { classroom: "rust" } }),
      b.call("tools/call", { name: "open_classroom", arguments: { classroom: "rust" } }),
    ]);
    for (const reply of replies) expect(reply.result.isError).toBe(false);
    expect(replies[0].result.content).toEqual(replies[1].result.content);
    expect((await serviceStatus()).running).toBe(true);
  } finally {
    a.child.stdin.end();
    b.child.stdin.end();
    await Promise.all([a.exited, b.exited]);
  }
}, 15_000);

it("rejects an occupied explicit port without selecting another port", async () => {
  const occupied = net.createServer();
  await new Promise<void>((resolve) =>
    occupied.listen(Number(env.PI_CLASSROOM_SERVICE_PORT), "127.0.0.1", resolve),
  );
  try {
    await expect(ensureService()).rejects.toThrow("failed to start");
    expect((await serviceStatus()).running).toBe(false);
    expect(fs.readFileSync(path.join(f.root, ".pi-teach-service/service.log"), "utf8")).toContain(
      "EADDRINUSE",
    );
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
}, 15_000);

async function openDetached() {
  const c = client();
  try {
    await c.call("initialize", { clientInfo: { name: "codex-test" } });
    const opened = await c.call("tools/call", {
      name: "open_classroom",
      arguments: { classroom: "rust" },
    });
    expect(opened.result.isError).toBe(false);
  } finally {
    c.child.stdin.end();
    await c.exited;
  }
  return (await serviceStatus()).url as string;
}
function quizBody(lesson: string) {
  return {
    classroom: "rust",
    lesson,
    quizId: "check-1",
    kind: "check",
    answers: [{ questionId: "q1", type: "term", prompt: "Lifetime?", value: "forever" }],
  };
}
async function submit(base: string, lesson: string) {
  const response = await fetch(`${base}/api/quiz/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(quizBody(lesson)),
    signal: AbortSignal.timeout(1000),
  });
  expect(response.status).toBe(201);
  return response.json();
}
it("reads several Codex JSON values without a newline", async () => {
  f.write("behavior.json", JSON.stringify({ packed: true, foreign: true }));
  const base = await openDetached();
  await submit(base, "001-ownership");
  await waitFor(async () => {
    const state = await (
      await fetch(`${base}/api/state?classroom=rust&lesson=001-ownership`)
    ).json();
    if (state.teacher.requests[0]?.status === "failed")
      throw new Error(state.teacher.requests[0].error);
    return !!state.quizzes[0]?.grade;
  });
}, 15_000);
it("accepts another lesson submission and control requests during a long Codex grade", async () => {
  seedClassroom(f, { lesson: "002-borrowing" });
  f.write("rust/002-borrowing/quiz/key.json", '{"q1":"dropped"}');
  f.write("behavior.json", JSON.stringify({ gate: true, progress: true }));
  accelerateDeadline();
  const base = await openDetached();
  const first = await submit(base, "001-ownership");
  await waitFor(async () => fs.existsSync(path.join(f.root, "turns.log")));
  const second = await submit(base, "002-borrowing");
  const before = await serviceStatus();
  expect(before.running).toBe(true);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, "rust/.teacher.json"), "utf8"));
  expect(state.requests.map((r: any) => r.status)).toEqual(["running", "queued"]);
  expect(fs.readFileSync(path.join(f.root, "turns.log"), "utf8").trim()).toBe(first.id);
  await new Promise((r) => setTimeout(r, 2000));
  f.write("release", "");
  await waitFor(async () => {
    const state = JSON.parse(fs.readFileSync(path.join(f.root, "rust/.teacher.json"), "utf8"));
    return state.requests.every((r: any) => r.status === "done");
  });
  expect(fs.readFileSync(path.join(f.root, "turns.log"), "utf8").trim().split("\n")).toEqual([
    first.id,
    second.id,
  ]);
  for (const lesson of ["001-ownership", "002-borrowing"])
    expect(fs.readdirSync(path.join(f.root, "rust", lesson, "quiz/grades"))).toHaveLength(1);
  expect((await serviceStatus()).pid).toBe(before.pid);
}, 15_000);

function accelerateDeadline(total = false) {
  // Scale only the teacher deadline. Keep service and HTTP timers unchanged.
  const preload = f.write(
    "deadline.mjs",
    `const original = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === ${total ? 300000 : 180000} ? 1000 : ms, ...args);
`,
  );
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`;
}
it.each(["invalid", "truncated"])(
  "fails malformed Codex stdout loudly: %s",
  async (mode) => {
    f.write("behavior.json", JSON.stringify({ [mode]: true }));
    const base = await openDetached();
    await submit(base, "001-ownership");
    await waitFor(async () => {
      const state = JSON.parse(fs.readFileSync(path.join(f.root, "rust/.teacher.json"), "utf8"));
      return state.requests[0]?.status === "failed";
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.root, "rust/.teacher.json"), "utf8"));
    expect(state.requests[0].error).toContain(
      mode === "invalid" ? "Invalid Codex stdout" : "stdout ended inside a JSON object",
    );
    expect(state.requests[0].error).toContain("rust/001-ownership");
    expect(fs.existsSync(path.join(f.root, "rust/001-ownership/quiz/grades"))).toBe(false);
    expect((await serviceStatus()).running).toBe(true);
  },
  15_000,
);
it.each(["noise", "progress"])(
  "times out an unfinished grade despite %s and requires retry",
  async (mode) => {
    f.write("behavior.json", JSON.stringify({ gate: true, [mode]: true }));
    accelerateDeadline(mode === "progress");
    const base = await openDetached();
    const submission = await submit(base, "001-ownership");
    await waitFor(async () => {
      const state = JSON.parse(fs.readFileSync(path.join(f.root, "rust/.teacher.json"), "utf8"));
      return state.requests[0]?.status === "failed";
    });
    const file = path.join(f.root, "rust/.teacher.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(state.requests[0].error).toContain(
      `quiz request quiz:${submission.id} in rust/001-ownership`,
    );
    expect(state.requests[0].error).toContain(
      "running turn test-turn in thread test-dedicated-session",
    );
    expect(state.requests[0].error).toContain(
      mode === "progress" ? "300 second request limit" : "made no progress",
    );
    expect(state.requests[0].error).toContain(
      `Last progress: ${mode === "progress" ? "item/agentMessage/delta" : "none"}`,
    );
    expect(fs.existsSync(path.join(f.root, "rust/001-ownership/quiz/grades"))).toBe(false);
    f.write("release", "");
    await new Promise((r) => setTimeout(r, 1200));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).requests[0].status).toBe("failed");
    const retried = await fetch(`${base}/api/teacher/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classroom: "rust", id: `quiz:${submission.id}` }),
    });
    expect(retried.status).toBe(200);
    await waitFor(
      async () => JSON.parse(fs.readFileSync(file, "utf8")).requests[0].status === "done",
    );
    expect(fs.readdirSync(path.join(f.root, "rust/001-ownership/quiz/grades"))).toHaveLength(1);
  },
  15_000,
);
