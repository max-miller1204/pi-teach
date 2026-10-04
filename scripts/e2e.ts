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
 *   4. Ask about a highlighted passage. Check the answer in the browser state.
 *   5. Submit a wrong answer. Wait for the grade and a retrieval question in chat.
 *   6. Check that the agent ends its turn without starting another lesson or wait.
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
import { playwright, playwrightCode } from "./playwright.ts";

type Harness = "claude" | "codex";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT_MS = 180_000;
const CLASSROOM = "rust";
const LESSON = "001-ownership";

const artifacts = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
const harness = process.argv[2];
if (harness !== "claude" && harness !== "codex") {
  throw new Error("Usage: node scripts/e2e.ts <claude|codex> [artifacts]");
}

const PROMPT = [
  `Call begin_teaching with topic "${CLASSROOM}" to get the teaching method.`,
  `Use the existing lesson. Call open_classroom with classroom "${CLASSROOM}".`,
  "Then call wait_for_learner with timeout_seconds 60, and do what its result asks.",
  "Keep calling wait_for_learner and handling its results until you have answered one question and graded one quiz.",
  "After grading, follow the teaching method, then end this run. Keep explanations short.",
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
      '<form class="cl-quiz" data-quiz-id="check-1" data-title="Check on learning">' +
      '<ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="choice">' +
      '<p class="cl-q-prompt">What happens to a value when its owner goes out of scope?</p>' +
      '<label><input type="radio" name="q1" value="a">The value is dropped</label>' +
      '<label><input type="radio" name="q1" value="b">The value stays alive forever</label>' +
      "</li></ol></form>" +
      "</main></body></html>",
  );
  fs.mkdirSync(path.join(lesson, "quiz"), { recursive: true });
  fs.writeFileSync(
    path.join(lesson, "quiz", "key.json"),
    JSON.stringify({
      "check-1": {
        q1: {
          pointsPossible: 1,
          criteria: "One point for option a: the value is dropped. Zero points for b.",
        },
      },
    }),
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
  "begin_teaching",
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

/** Only chat text after grading can count as a retrieval question. */
function chatTextAfterGrade(events: string): string {
  let graded = false;
  const messages: string[] = [];
  for (const line of events.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (harness === "claude" && event.type === "assistant") {
      for (const block of event.message.content) {
        if (block.type === "tool_use" && block.name === `${CLAUDE_PREFIX}grade_lesson_quiz`) {
          graded = true;
        } else if (graded && block.type === "text") {
          messages.push(block.text);
        }
      }
    }
    if (harness === "codex" && event.type === "item.completed") {
      if (event.item?.type === "mcp_tool_call" && event.item.tool === "grade_lesson_quiz") {
        graded = true;
      } else if (graded && event.item?.type === "agent_message") {
        messages.push(event.item.text);
      }
    }
  }
  return messages.join("\n");
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

async function main(): Promise<void> {
  const classrooms = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-e2e-classrooms-"));
  const home = harness === "codex" ? codexHome() : null;
  seedClassroom(classrooms);
  const browserSession = `pi-teach-${harness}-${process.pid}`;
  let browserOpen = false;

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
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const base = await until("the classroom URL", () => {
      const match = /http:\/\/127\.0\.0\.1:(\d+)\/c\/rust/.exec(stream);
      return match ? `http://127.0.0.1:${match[1]}` : null;
    });
    log(`classroom server: ${base}`);
    await playwright(browserSession, classrooms, "open", `${base}/c/${CLASSROOM}/${LESSON}`);
    browserOpen = true;

    const annotationsFile = path.join(classrooms, CLASSROOM, LESSON, "annotations.json");
    const asked = await playwrightCode<Record<string, unknown>>(
      browserSession,
      classrooms,
      `async page => {
      await page.evaluate(() => {
        const text = document.querySelector('main > p').firstChild;
        const start = text.textContent.indexOf('one owner');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'one owner'.length);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await page.locator('.cl-ask-pill').click();
      await page.locator('[data-cl-question]').fill('Why does Rust allow only one owner?');
      const response = page.waitForResponse(r => r.url().endsWith('/api/ask') && r.request().method() === 'POST');
      await page.getByRole('button', {name:'Ask your teacher', exact:true}).click();
      const result = await response;
      if (result.status() !== 201) throw new Error(await result.text());
      return await result.json();
    }`,
    );
    log(`asked question ${String(asked["id"])}`);

    const answer = await until("the answer", () => {
      const raw = readJson<unknown>(annotationsFile);
      const list = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
      const card = list.find((a) => a["id"] === asked["id"]);
      return card && card["status"] === "answered" ? String(card["answerMarkdown"]) : null;
    });
    log(`answer on the card: ${JSON.stringify(answer)}`);

    const stateResponse = await fetch(`${base}/api/state?classroom=${CLASSROOM}&lesson=${LESSON}`);
    if (stateResponse.status !== 200) {
      throw new Error(`GET browser state returned ${stateResponse.status}`);
    }
    const state = (await stateResponse.json()) as {
      annotations: Array<{ id: string; answerMarkdown: string; answerHtml: string }>;
    };
    const card = state.annotations.find((annotation) => annotation.id === asked["id"]);
    if (!answer.trim() || card?.answerMarkdown !== answer || !card.answerHtml?.trim()) {
      throw new Error("The browser state does not contain the rendered card answer.");
    }

    const submitted = await playwrightCode<Record<string, unknown>>(
      browserSession,
      classrooms,
      `async page => {
      await page.waitForFunction(() => document.querySelector('.cl-card-answer')?.textContent.trim()
        && !document.querySelector('.cl-card-answer .cl-card-status'));
      await page.locator('.cl-q input[value=b]').check();
      const response = page.waitForResponse(r => r.url().endsWith('/api/quiz/submit') && r.request().method() === 'POST');
      await page.getByRole('button', {name:'Submit for grading', exact:true}).click();
      const result = await response;
      if (result.status() !== 201) throw new Error(await result.text());
      return await result.json();
    }`,
    );
    if (
      (submitted["answers"] as Array<Record<string, unknown>>).some(
        (answer) => "confidence" in answer,
      )
    )
      throw new Error("The browser submitted confidence metadata.");
    log(`submitted quiz ${String(submitted["id"])}`);

    const gradesDir = path.join(classrooms, CLASSROOM, LESSON, "quiz", "grades");
    const grade = await until("the grade", () => {
      const files = fs.existsSync(gradesDir) ? fs.readdirSync(gradesDir) : [];
      return files.length > 0
        ? readJson<Record<string, unknown>>(path.join(gradesDir, files[0]!))
        : null;
    });
    log(`grade: ${String(grade["score"])}%, ${JSON.stringify(grade["feedbackMarkdown"])}`);
    await playwrightCode(
      browserSession,
      classrooms,
      `async page => {
      await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
      if (await page.locator('.cl-confidence').count()) throw new Error('The page has confidence controls.');
      if (!await page.locator('.cl-q-verdict').count()) throw new Error('The page has no question verdict.');
      if (await page.getByRole('button', {name:'Try again', exact:true}).count()) throw new Error('The page has a retry button.');
      if (!await page.getByRole('button', {name:'Graded', exact:true}).isDisabled()) throw new Error('The graded quiz is unlocked.');
      ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, `${harness}-graded-quiz.png`))},fullPage:true});` : ""}
      return true;
    }`,
    );
    const questions = grade["questions"] as Array<{ questionId: string; correct: boolean }>;
    if (
      grade["submissionId"] !== submitted["id"] ||
      questions.length !== 1 ||
      questions[0]?.questionId !== "q1" ||
      questions[0].correct !== false ||
      typeof grade["score"] !== "number" ||
      !Number.isFinite(grade["score"]) ||
      grade["score"] < 0 ||
      grade["score"] >= 100
    ) {
      throw new Error("The agent did not mark the submitted wrong answer as incorrect.");
    }

    const code = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        exitTimer = setTimeout(
          () => reject(new Error(`${command} did not end its turn after grading.`)),
          STEP_TIMEOUT_MS,
        );
      }),
    ]);
    if (code !== 0) throw new Error(`${command} exited with ${code}:\n${stderr}`);

    const calls = toolCalls(stream);
    log(`tool calls: ${calls.join(" → ")}`);
    for (const tool of REQUIRED_TOOLS) {
      if (!calls.includes(tool)) throw new Error(`The agent never called ${tool}`);
    }
    const afterGrade = calls.slice(calls.indexOf("grade_lesson_quiz") + 1);
    if (afterGrade.includes("wait_for_learner")) {
      throw new Error("The agent waited for browser input instead of a chat reply.");
    }
    const chat = chatTextAfterGrade(stream);
    if (!chat.includes("?")) {
      throw new Error(`The agent did not ask a retrieval question in chat:\n${chat}`);
    }
    const classroomDir = path.join(classrooms, CLASSROOM);
    const lessons = fs
      .readdirSync(classroomDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && fs.existsSync(path.join(classroomDir, entry.name, "lesson.html")),
      );
    if (lessons.length !== 1 || lessons[0]?.name !== LESSON) {
      throw new Error("The agent changed the lesson set before the learner agreed.");
    }
    log(`chat check: ${JSON.stringify(chat)}`);
    log(`PASS: wrong answer followed by a chat check through ${harness}`);
  } finally {
    clearTimeout(exitTimer);
    child.kill();
    if (browserOpen) await playwright(browserSession, classrooms, "close");
    fs.rmSync(classrooms, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
}

await main();
