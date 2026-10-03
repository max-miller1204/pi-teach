/**
 * e2e.ts: drive a real Claude Code or Codex session through one lesson round trip.
 *
 *   node scripts/e2e.ts claude
 *   node scripts/e2e.ts codex
 *
 * The script does what a learner's browser does, and checks what lands on disk:
 *
 *   1. Seed a classroom with one lesson in a temporary classrooms root.
 *   2. Start the harness with this checkout as a plugin, and tell the agent to open the
 *      classroom and listen with `wait_for_learner`.
 *   3. Read the classroom URL from the harness's JSON event stream.
 *   4. Ask a question about a highlighted passage. Wait for the answer on the card.
 *   5. Submit a quiz. Wait for the grade.
 *
 * This calls a real model, so it needs a logged-in harness and is not part of CI.
 * Nothing touches your real classrooms or harness settings: the classrooms root is a
 * temporary directory, and Codex runs with a temporary CODEX_HOME that holds a copy of
 * your auth.json only. Both are deleted at the end.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Harness = "claude" | "codex";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT_MS = 180_000;
const CLASSROOM = "rust";
const LESSON = "001-ownership";

const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  throw new Error("Usage: node scripts/e2e.ts <claude|codex>");
}

const PROMPT = [
  `Call the classroom MCP tool open_classroom with classroom "${CLASSROOM}".`,
  "Then call wait_for_learner with timeout_seconds 120, and do what its result asks.",
  "Keep calling wait_for_learner and handling its results until you have answered one question and graded one quiz.",
  "Keep each answer to two sentences. Then stop.",
].join(" ");

function log(message: string): void {
  console.log(`[e2e:${harness}] ${message}`);
}

function seedClassroom(root: string): void {
  const lesson = path.join(root, CLASSROOM, LESSON);
  fs.mkdirSync(lesson, { recursive: true });
  fs.writeFileSync(
    path.join(root, CLASSROOM, "classroom.json"),
    JSON.stringify({ title: "Rust", emoji: "🦀", createdAt: Date.now() }),
  );
  fs.writeFileSync(
    path.join(lesson, "lesson.json"),
    JSON.stringify({ title: "Ownership", summary: "One owner at a time.", createdAt: Date.now() }),
  );
  fs.writeFileSync(
    path.join(lesson, "lesson.html"),
    "<!doctype html><html><head><title>Ownership</title></head><body><main data-cl-content>" +
      "<p>Every value in Rust has one owner. When the owner goes out of scope, the value is dropped.</p>" +
      "</main></body></html>",
  );
}

/** A temporary CODEX_HOME with this checkout installed as a plugin. */
function codexHome(): string {
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

const REQUIRED_TOOLS = [
  "open_classroom",
  "wait_for_learner",
  "answer_lesson_question",
  "grade_lesson_quiz",
];

/** Claude Code prefixes plugin MCP tools with this. Codex reports the bare name. */
const CLAUDE_PREFIX = "mcp__plugin_pi-teach_classroom__";

function harnessCommand(): [string, string[]] {
  if (harness === "claude") {
    const tools = REQUIRED_TOOLS.map((tool) => `${CLAUDE_PREFIX}${tool}`);
    return [
      "claude",
      [
        "--plugin-dir",
        ROOT,
        "-p",
        PROMPT,
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        [...tools, "Read"].join(","),
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
      PROMPT,
    ],
  ];
}

/**
 * The classroom tool calls in a harness's JSON event stream, in order. Claude Code
 * emits `"name":"mcp__plugin_pi-teach_classroom__<tool>"` on each tool use; Codex emits
 * `"server":"classroom","tool":"<tool>"` on each MCP call's start and end events.
 */
function toolCalls(events: string): string[] {
  const pattern =
    harness === "claude"
      ? new RegExp(`"name":"${CLAUDE_PREFIX}([a-z_]+)"`, "g")
      : /"server":"classroom","tool":"([a-z_]+)"[^\n]*?"status":"in_progress"/g;
  return [...events.matchAll(pattern)].map((match) => match[1]!);
}

async function until<T>(what: string, probe: () => T | null): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201)
    throw new Error(`POST ${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const classrooms = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-e2e-classrooms-"));
  const home = harness === "codex" ? codexHome() : null;
  seedClassroom(classrooms);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CLASSROOMS_DIR: classrooms,
    PI_CLASSROOM_AUTO_OPEN: "0",
  };
  if (home) env["CODEX_HOME"] = home;

  const [command, args] = harnessCommand();
  log(`starting ${command} ${args.slice(0, 2).join(" ")} ...`);
  const child = spawn(command, args, { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });

  let stream = "";
  child.stdout.on("data", (chunk: Buffer) => (stream += chunk.toString()));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

  try {
    const base = await until("the classroom URL", () => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/c\/rust/.exec(stream);
      return match ? `http://127.0.0.1:${match[1]}` : null;
    });
    log(`classroom server: ${base}`);

    const annotationsFile = path.join(classrooms, CLASSROOM, LESSON, "annotations.json");
    const asked = await post(`${base}/api/ask`, {
      classroom: CLASSROOM,
      lesson: LESSON,
      question: "Why does Rust allow only one owner?",
      selection: "one owner",
      anchor: { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 },
    });
    log(`asked question ${String(asked["id"])}`);

    const answer = await until("the answer", () => {
      const raw = readJson<unknown>(annotationsFile);
      const list = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
      const card = list.find((a) => a["id"] === asked["id"]);
      return card && card["status"] === "answered" ? String(card["answerMarkdown"]) : null;
    });
    log(`answer on the card: ${JSON.stringify(answer)}`);

    const submitted = await post(`${base}/api/quiz/submit`, {
      classroom: CLASSROOM,
      lesson: LESSON,
      quizId: "check-1",
      quizTitle: "Check on learning",
      answers: [
        {
          questionId: "q1",
          value: "b",
          label: "The value is dropped",
          prompt: "What happens to a value when its owner goes out of scope?",
        },
      ],
    });
    log(`submitted quiz ${String(submitted["id"])}`);

    const gradesDir = path.join(classrooms, CLASSROOM, LESSON, "quiz", "grades");
    const grade = await until("the grade", () => {
      const files = fs.existsSync(gradesDir) ? fs.readdirSync(gradesDir) : [];
      return files.length > 0
        ? readJson<Record<string, unknown>>(path.join(gradesDir, files[0]!))
        : null;
    });
    log(`grade: ${String(grade["score"])}%, ${JSON.stringify(grade["feedbackMarkdown"])}`);

    const code = await Promise.race([
      exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STEP_TIMEOUT_MS)),
    ]);
    if (code !== 0) throw new Error(`${command} exited with ${code}:\n${stderr}`);

    const calls = toolCalls(stream);
    log(`tool calls: ${calls.join(" → ")}`);
    for (const tool of REQUIRED_TOOLS) {
      if (!calls.includes(tool)) throw new Error(`The agent never called ${tool}`);
    }
    log(`PASS: question answered and quiz graded through ${harness}`);
  } finally {
    child.kill();
    fs.rmSync(classrooms, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
}

await main();
