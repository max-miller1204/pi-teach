/**
 * e2e-authoring.ts: evaluate how a real agent writes lessons from the scaffold.
 *
 *   node scripts/e2e-authoring.ts claude [artifacts]
 *   node scripts/e2e-authoring.ts codex [artifacts]
 *
 * The other e2e scripts seed a finished lesson. This one gives the agent learning
 * objectives only, and looks at what it writes:
 *
 *   1. Seed a temporary classroom: a mission, notes, a glossary, and one earlier
 *      lesson whose quiz uses only short answers.
 *   2. Authoring session: the agent writes one lesson for each objective with
 *      scaffold_lesson. The prompt names no response types and no lesson patterns.
 *   3. Inspect each lesson: its outline, quiz kinds, response types, stimuli,
 *      self-explanations, local controls, and private rubric.
 *   4. Open each lesson in a real browser with this script's own classroom server.
 *      Check for contract errors and page errors. Press each local control. Answer
 *      every quiz and submit it.
 *   5. Grading session: a second agent session opens the classroom, which restores
 *      the ungraded submissions from disk. It grades each one from its rubric.
 *   6. Reload each lesson. Check that every quiz shows its grade and its answers.
 *   7. Print a report. Save it, the lessons, and screenshots when an artifacts
 *      directory is given.
 *
 * Hard failures: a missing lesson, an unfinished question, a missing rubric, a
 * contract error, a page error, a refused submission, or a missing grade. Variety is
 * reported, not enforced: a model can author differently on every run, and suitable
 * repetition is valid. Read the report.
 *
 * This calls a real model, so it needs a logged-in harness and is not part of CI. The
 * classrooms root and any CODEX_HOME are temporary directories, deleted at the end.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _overrideClassroomsDir } from "../src/paths.ts";
import { authoredQuestions, typeCounts } from "../src/quiz-authoring.ts";
import { isQuestionType, type QuestionType } from "../assets/runtime/quiz.mjs";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import {
  codexHome,
  harnessCommand,
  parseHarness,
  toolCalls,
  until,
  type Harness,
} from "./harness.ts";
import { playwright, playwrightCode } from "./playwright.ts";

const AUTHORING_TIMEOUT_MS = 30 * 60_000;
const GRADING_TIMEOUT_MS = 20 * 60_000;
const CLASSROOM = "os";
const EARLIER_LESSON = "001-processes";

const OBJECTIVES = [
  "Predict how many processes a short C program with several fork() calls creates.",
  "Find which pipe file descriptors each process must close, so that the reader sees end of file.",
  "Explain how two threads that increment a shared counter without a lock can lose an update.",
];

const harness: Harness = parseHarness(
  process.argv[2],
  "Usage: node scripts/e2e-authoring.ts <claude|codex> [artifacts]",
);
const artifacts = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });

function log(message: string): void {
  console.log(`[e2e:authoring:${harness}] ${message}`);
}

// ── Seed ──────────────────────────────────────────────────────────────────────

function write(root: string, relative: string, contents: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function seedClassroom(root: string): void {
  write(
    root,
    `${CLASSROOM}/classroom.json`,
    JSON.stringify({ title: "Operating Systems", emoji: "🖥️", createdAt: 1 }),
  );
  write(
    root,
    `${CLASSROOM}/MISSION.md`,
    "# Mission: Operating Systems\n\n## Why\n\nPass the systems course and write a working Unix shell for its first project.\n\n## Success looks like\n\n- Trace process creation in C programs.\n- Connect processes with pipes without hangs.\n- Explain race conditions in threaded code.\n",
  );
  write(
    root,
    `${CLASSROOM}/NOTES.md`,
    "# Notes\n\n## Preferences\n\n- Learns best from concrete traces of real C code.\n- Short lessons. One idea at a time.\n\n## Index\n\n_No topic files yet._\n",
  );
  write(
    root,
    `${CLASSROOM}/GLOSSARY.md`,
    "# Operating Systems Glossary\n\n## Terms\n\n**Process**:\nA running program with its own address space.\n\n**File descriptor**:\nA small integer that names an open file in one process.\n_Avoid_: file handle\n",
  );
  write(
    root,
    `${CLASSROOM}/${EARLIER_LESSON}/lesson.json`,
    JSON.stringify({ title: "Processes", summary: "What a process is.", createdAt: 2 }),
  );
  write(
    root,
    `${CLASSROOM}/${EARLIER_LESSON}/lesson.html`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Processes</title></head><body>
<main class="cl-lesson-shell" data-cl-content>
<header><h1>Processes</h1><p class="cl-lede">What a process is.</p></header>
<section><h2>The idea</h2><p>A process is a running program with its own address space.</p></section>
<section><h2>Worked example</h2><pre><code>int main(void) { printf("%d\\n", getpid()); }</code></pre></section>
<form class="cl-quiz" data-quiz-id="check-1" data-title="Check on learning"><ol class="cl-questions">
${[1, 2, 3].map((i) => `<li class="cl-q" data-question-id="q${i}" data-type="short"><p class="cl-q-prompt">Explain idea ${i} about processes.</p><textarea rows="3"></textarea></li>`).join("\n")}
</ol></form>
<section><h2>Go deeper</h2><p><a href="https://pages.cs.wisc.edu/~remzi/OSTEP/cpu-intro.pdf">OSTEP, "The Abstraction: The Process"</a></p></section>
<footer><p><a href="./">Back to the classroom</a></p></footer>
</main></body></html>`,
  );
  write(
    root,
    `${CLASSROOM}/${EARLIER_LESSON}/quiz/key.json`,
    JSON.stringify({ "check-1": { q1: { points: 1 }, q2: { points: 1 }, q3: { points: 1 } } }),
  );
}

// ── Agent sessions ────────────────────────────────────────────────────────────

const AUTHORING_PROMPT = [
  "This is an automated authoring run in a temporary classroom.",
  `Call begin_teaching with topic "${CLASSROOM}". The mission and notes are written, so do not interview the learner.`,
  "The learner has agreed to these lessons. Write one lesson for each objective, in this order:",
  ...OBJECTIVES.map((objective, i) => `${i + 1}. ${objective}`),
  "Create each lesson with scaffold_lesson and follow the authoring steps it returns. Write the files with your file tools.",
  "Do not call wait_for_learner and do not ask the learner anything. Nobody will reply during this run.",
  "When all three lessons are written, end with one line per lesson that states why you chose its activities.",
].join("\n");

function gradingPrompt(count: number): string {
  return [
    "This is an automated grading run in a temporary classroom.",
    `Call open_classroom with classroom "${CLASSROOM}". Then call wait_for_learner with timeout_seconds 60.`,
    `The learner has submitted ${count} quizzes. Grade each one with grade_lesson_quiz, from the lesson and its private quiz/key.json rubric.`,
    `Keep calling wait_for_learner until you have graded all ${count}.`,
    "Nobody will reply in chat during this run. Do not ask chat questions, do not write learning records, and do not create lessons.",
    "After the last grade, end with one short line.",
  ].join("\n");
}

interface Session {
  stream(): string;
  stop(): void;
  exited: Promise<number | null>;
}

function startSession(
  prompt: string,
  tools: string[],
  extraTools: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Session {
  const [command, args] = harnessCommand(harness, prompt, tools, extraTools);
  log(`starting ${command} ${args.slice(0, 2).join(" ")} ...`);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stream = "";
  child.stdout.on("data", (chunk: Buffer) => (stream += chunk.toString()));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on("close", (code) => {
      if (code !== 0 && code !== null) log(`${command} exited with ${code}:\n${stderr}`);
      resolve(code);
    }),
  );
  return { stream: () => stream, stop: () => child.kill(), exited };
}

async function within<T>(what: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The agent's final chat text, for the report. */
function finalText(stream: string): string {
  const texts: string[] = [];
  for (const line of stream.split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (harness === "claude" && event.type === "result" && typeof event.result === "string") {
      texts.push(event.result);
    }
    if (
      harness === "codex" &&
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      texts.push(event.item.text);
    }
  }
  return texts[texts.length - 1] ?? "";
}

// ── Inspection ────────────────────────────────────────────────────────────────

interface LessonReport {
  lesson: string;
  objective: string;
  title: string;
  headings: string[];
  outline: string[];
  quizzes: Array<{ id: string; kind: string; types: string[] }>;
  typeCounts: string;
  stimuli: number;
  reflections: number;
  inlineScripts: number;
  localControls: Array<{ label: string; keyboard: boolean; changed: boolean }>;
  details: number;
  tables: number;
  images: number;
  rubric: boolean;
  problems: string[];
}

function count(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

function inspectLesson(root: string, lesson: string, objective: string): LessonReport {
  const dir = path.join(root, CLASSROOM, lesson);
  const html = fs.readFileSync(path.join(dir, "lesson.html"), "utf8");
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const problems: string[] = [];
  const questions = authoredQuestions(html);
  for (const q of questions.filter((q) => !isQuestionType(q.type))) {
    problems.push(`Question ${q.id ?? "(no id)"} has data-type ${JSON.stringify(q.type)}.`);
  }
  if (questions.length === 0) problems.push("The lesson has no quiz questions.");
  if (body.includes("{{")) problems.push("A template placeholder is still in the lesson.");

  const keyFile = path.join(dir, "quiz", "key.json");
  const rubric = fs.existsSync(keyFile);
  if (!rubric) problems.push("The lesson has no quiz/key.json rubric.");
  else JSON.parse(fs.readFileSync(keyFile, "utf8"));

  const quizzes = [
    ...body.matchAll(/<form\b[^>]*class="[^"]*\bcl-quiz\b[^"]*"[^>]*>[\s\S]*?<\/form>/g),
  ].map((match) => ({
    id: /data-quiz-id="([^"]*)"/.exec(match[0])?.[1] ?? "(no id)",
    kind: /data-kind="([^"]*)"/.exec(match[0])?.[1] ?? "check",
    types: authoredQuestions(match[0]).map((q) => q.type ?? "(none)"),
  }));
  const types = questions.map((q) => q.type).filter((t): t is QuestionType => isQuestionType(t));
  return {
    lesson,
    objective,
    title: store.readLesson(CLASSROOM, lesson)?.title ?? lesson,
    headings: [...body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
    outline: [],
    quizzes,
    typeCounts: typeCounts(types),
    stimuli: count(body, /class="[^"]*\bcl-q-stimulus\b/g),
    reflections: count(body, /class="[^"]*\bcl-reflect\b/g),
    inlineScripts: count(body, /<script\b(?![^>]*type="application\/json")/g),
    localControls: [],
    details: count(body, /<details\b/g),
    tables: count(body, /<table\b/g),
    images: count(body, /<(?:img|svg)\b/g),
    rubric,
    problems,
  };
}

// ── Browser ───────────────────────────────────────────────────────────────────

/** Load a lesson, check it, press its local controls, then answer and submit each quiz. */
const SUBMIT_LESSON = `async page => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('form.cl-quiz')].every((f) => f.dataset.state));
  const contract = await page.locator('.cl-contract-error').allInnerTexts();
  const outline = await page.evaluate(() =>
    [...document.querySelector('main[data-cl-content]').children].map((el) => {
      const kind = el.matches('form.cl-quiz') ? '[' + (el.dataset.kind || 'check') + ']' : '';
      const cls = [...el.classList].filter((c) => c !== 'cl-lesson-shell')[0];
      return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + kind;
    }),
  );
  const controls = [];
  const buttons = page.locator('main[data-cl-content] button');
  for (let i = 0; i < await buttons.count(); i++) {
    const button = buttons.nth(i);
    const authored = await button.evaluate((b) =>
      !b.closest('form, .cl-header, .cl-card-inline, .cl-card-panel') && !/\\bcl-/.test(b.className));
    if (!authored || !(await button.isVisible())) continue;
    const label = ((await button.getAttribute('aria-label')) || (await button.innerText())).trim();
    const before = await page.evaluate(() => document.querySelector('main').innerHTML);
    await button.focus();
    const keyboard = await button.evaluate((b) => document.activeElement === b);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => document.querySelector('main').innerHTML);
    controls.push({ label, keyboard, changed: before !== after });
  }
  const submitted = [];
  for (const form of await page.locator('form.cl-quiz').all()) {
    if ((await form.getAttribute('data-state')) !== 'fresh') continue;
    for (const q of await form.locator('.cl-q').all()) {
      const type = await q.getAttribute('data-type');
      if (type === 'choice') await q.locator('input[type=radio]').first().check();
      if (type === 'multi') await q.locator('input[type=checkbox]').first().check();
      if (type === 'term') await q.locator('input[type=text]:not([data-blank]):not(.cl-number):not(.cl-unit), input:not([type]):not([data-blank]):not(.cl-number):not(.cl-unit)').first().fill('not sure');
      if (type === 'short') await q.locator('textarea').fill('I think it depends on the order of events.');
      if (type === 'numeric') {
        await q.locator('.cl-number').fill('2');
        const unit = q.locator('.cl-unit');
        if (await unit.count()) {
          if ((await unit.evaluate((u) => u.tagName)) === 'SELECT') await unit.selectOption({ index: 1 });
          else await unit.fill('processes');
        }
      }
      if (type === 'cloze') for (const blank of await q.locator('input[data-blank]').all()) await blank.fill('x');
      if (type === 'match') for (const select of await q.locator('select').all()) await select.selectOption({ index: 1 });
      if (type === 'locate') await q.locator('.cl-segment').first().click();
    }
    const saved = await form.evaluate((f) => ({
      checked: [...f.querySelectorAll('input:checked')].map((i) => i.value),
      text: [...f.querySelectorAll('input[type=text], input:not([type]), textarea')].map((i) => i.value),
      selects: [...f.querySelectorAll('select')].map((s) => s.value),
      order: [...f.querySelectorAll('.cl-order > li')].map((li) => li.dataset.item),
      segments: [...f.querySelectorAll('.cl-segment[aria-pressed="true"]')].map((s) => s.dataset.segment),
    }));
    const response = page.waitForResponse((r) => r.url().endsWith('/api/quiz/submit') && r.request().method() === 'POST');
    await form.getByRole('button', { name: 'Submit for grading', exact: true }).click();
    const result = await response;
    submitted.push({ quizId: await form.getAttribute('data-quiz-id'), status: result.status(), body: result.status() === 201 ? null : await result.text(), saved });
  }
  return { errors, contract, outline, controls, submitted };
}`;

/** Reload a lesson and read each quiz's state, grade, and restored answers. */
const READ_GRADED = `async page => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
  await page.waitForFunction(() => [...document.querySelectorAll('form.cl-quiz')].every((f) => f.dataset.state));
  const quizzes = await page.evaluate(() => [...document.querySelectorAll('form.cl-quiz')].map((f) => ({
    quizId: f.dataset.quizId,
    state: f.dataset.state,
    attempts: f.dataset.attempts,
    grade: f.querySelector('.cl-grade-banner')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    saved: {
      checked: [...f.querySelectorAll('input:checked')].map((i) => i.value),
      text: [...f.querySelectorAll('input[type=text], input:not([type]), textarea')].map((i) => i.value),
      selects: [...f.querySelectorAll('select')].map((s) => s.value),
      order: [...f.querySelectorAll('.cl-order > li')].map((li) => li.dataset.item),
      segments: [...f.querySelectorAll('.cl-segment[aria-pressed="true"]')].map((s) => s.dataset.segment),
    },
  })));
  return { errors, quizzes };
}`;

async function screenshot(browser: string, root: string, name: string): Promise<void> {
  if (!artifacts) return;
  const file = JSON.stringify(path.join(artifacts, name));
  await playwrightCode(
    browser,
    root,
    `async page => { await page.screenshot({ path: ${file}, fullPage: true }); return true; }`,
  );
}

interface Submitted {
  quizId: string;
  status: number;
  body: string | null;
  saved: unknown;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-e2e-authoring-"));
  _overrideClassroomsDir(root);
  seedClassroom(root);
  const home = harness === "codex" ? codexHome() : null;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CLASSROOMS_DIR: root,
    PI_CLASSROOM_AUTO_OPEN: "0",
  };
  if (home) env["CODEX_HOME"] = home;
  const browser = `pi-teach-authoring-${harness}-${process.pid}`;
  let browserOpen = false;
  const sessions: Session[] = [];
  const failures: string[] = [];

  try {
    // Authoring session.
    const authoring = startSession(
      AUTHORING_PROMPT,
      ["begin_teaching", "list_classrooms", "lesson_health", "scaffold_lesson", "open_classroom"],
      ["Read", "Write", "Edit", "Glob", "Grep"],
      env,
      root,
    );
    sessions.push(authoring);
    const code = await within("the authoring session", AUTHORING_TIMEOUT_MS, authoring.exited);
    if (code !== 0) throw new Error(`The authoring session exited with ${code}.`);
    const authoringCalls = toolCalls(harness, authoring.stream());
    log(`authoring tool calls: ${authoringCalls.join(" → ")}`);
    if (authoringCalls.filter((call) => call === "scaffold_lesson").length !== OBJECTIVES.length) {
      failures.push(
        `The agent called scaffold_lesson ${authoringCalls.filter((c) => c === "scaffold_lesson").length} times.`,
      );
    }
    if (authoringCalls.includes("wait_for_learner"))
      failures.push("The authoring agent waited for the learner.");

    const lessons = store
      .listLessons(CLASSROOM)
      .map((lesson) => lesson.name)
      .filter((name) => name !== EARLIER_LESSON);
    if (lessons.length !== OBJECTIVES.length) {
      throw new Error(`Expected ${OBJECTIVES.length} new lessons, found: ${lessons.join(", ")}`);
    }
    const reports = lessons.map((lesson, i) => inspectLesson(root, lesson, OBJECTIVES[i]!));

    // Browser: check, press, answer, submit.
    const base = await server.start();
    let submissions = 0;
    for (const report of reports) {
      const url = `${base}/c/${CLASSROOM}/${report.lesson}`;
      if (!browserOpen) {
        await playwright(browser, root, "open", url);
        browserOpen = true;
      } else {
        await playwright(browser, root, "goto", url);
      }
      const result = await playwrightCode<{
        errors: string[];
        contract: string[];
        outline: string[];
        controls: LessonReport["localControls"];
        submitted: Submitted[];
      }>(browser, root, SUBMIT_LESSON);
      report.outline = result.outline;
      report.localControls = result.controls;
      for (const error of result.errors) report.problems.push(`Page error: ${error}`);
      for (const error of result.contract) report.problems.push(`Contract error: ${error}`);
      for (const control of result.controls) {
        if (!control.keyboard)
          report.problems.push(`Control "${control.label}" cannot take focus.`);
      }
      for (const quiz of result.submitted) {
        if (quiz.status !== 201)
          report.problems.push(`Quiz ${quiz.quizId} was refused: ${quiz.body}`);
        else submissions += 1;
      }
      (report as LessonReport & { submitted?: Submitted[] }).submitted = result.submitted;
      await screenshot(browser, root, `${harness}-${report.lesson}-submitted.png`);
    }
    log(`submitted ${submissions} quizzes`);
    if (submissions === 0) throw new Error("No quiz could be submitted.");

    // Grading session. Opening the classroom restores the ungraded submissions.
    const grading = startSession(
      gradingPrompt(submissions),
      ["open_classroom", "wait_for_learner", "grade_lesson_quiz"],
      ["Read"],
      env,
      root,
    );
    sessions.push(grading);
    const ungraded = () =>
      lessons.flatMap((lesson) => {
        const graded = new Set(store.latestGrades(CLASSROOM, lesson).map((g) => g.submissionId));
        return store.listSubmissions(CLASSROOM, lesson).filter((s) => !graded.has(s.id));
      });
    await until("every grade", GRADING_TIMEOUT_MS, () => (ungraded().length === 0 ? true : null));
    await within("the grading session to end", 180_000, grading.exited).catch((error: Error) => {
      failures.push(error.message);
    });
    const gradingCalls = toolCalls(harness, grading.stream());
    log(`grading tool calls: ${gradingCalls.join(" → ")}`);

    // Reload: each quiz shows its grade and its answers.
    for (const report of reports) {
      await playwright(browser, root, "goto", `${base}/c/${CLASSROOM}/${report.lesson}`);
      const result = await playwrightCode<{
        errors: string[];
        quizzes: Array<{
          quizId: string;
          state: string;
          attempts: string;
          grade: string | null;
          saved: unknown;
        }>;
      }>(browser, root, READ_GRADED);
      for (const error of result.errors) report.problems.push(`Page error after grading: ${error}`);
      const submitted = (report as LessonReport & { submitted?: Submitted[] }).submitted ?? [];
      for (const quiz of submitted) {
        const shown = result.quizzes.find((q) => q.quizId === quiz.quizId);
        if (!shown || shown.state !== "graded" || !shown.grade) {
          report.problems.push(`Quiz ${quiz.quizId} shows no grade after reload.`);
        } else if (JSON.stringify(shown.saved) !== JSON.stringify(quiz.saved)) {
          report.problems.push(`Quiz ${quiz.quizId} restored different answers after reload.`);
        } else if (shown.attempts !== "1") {
          report.problems.push(`Quiz ${quiz.quizId} shows ${shown.attempts} attempts.`);
        }
      }
      await screenshot(browser, root, `${harness}-${report.lesson}-graded.png`);
      if (artifacts) {
        fs.copyFileSync(
          path.join(root, CLASSROOM, report.lesson, "lesson.html"),
          path.join(artifacts, `${harness}-${report.lesson}.html`),
        );
        fs.copyFileSync(
          path.join(root, CLASSROOM, report.lesson, "quiz", "key.json"),
          path.join(artifacts, `${harness}-${report.lesson}-key.json`),
        );
      }
    }

    // Report.
    const summary = {
      harness,
      agentSummary: finalText(authoring.stream()),
      lessons: reports.map((r) => ({ ...r, submitted: undefined })),
      variety: {
        distinctOutlines: new Set(reports.map((r) => r.outline.join(" > "))).size,
        distinctHeadingSets: new Set(reports.map((r) => r.headings.join(" | "))).size,
        distinctTypeSets: new Set(reports.map((r) => r.typeCounts)).size,
        typesUsed: [...new Set(reports.flatMap((r) => r.quizzes.flatMap((q) => q.types)))],
        lessonsWithPretest: reports.filter((r) => r.quizzes.some((q) => q.kind === "pretest"))
          .length,
        lessonsWithLocalControls: reports.filter((r) => r.localControls.length > 0).length,
        lessonsWithReflection: reports.filter((r) => r.reflections > 0).length,
      },
    };
    for (const r of reports) {
      log(`── ${r.lesson}: ${r.title}`);
      log(`   objective: ${r.objective}`);
      log(`   headings: ${r.headings.join(" | ") || "(none)"}`);
      log(`   outline: ${r.outline.join(" > ")}`);
      log(
        `   quizzes: ${r.quizzes.map((q) => `${q.id} [${q.kind}] ${q.types.join(", ")}`).join("; ")}`,
      );
      log(
        `   stimuli ${r.stimuli}, reflections ${r.reflections}, scripts ${r.inlineScripts}, details ${r.details}, tables ${r.tables}, images ${r.images}`,
      );
      log(
        `   local controls: ${r.localControls.map((c) => `${c.label}${c.changed ? "" : " (no visible change)"}`).join(", ") || "none"}`,
      );
      log(`   problems: ${r.problems.join(" ") || "none"}`);
      failures.push(...r.problems.map((p) => `${r.lesson}: ${p}`));
    }
    log(`variety: ${JSON.stringify(summary.variety)}`);
    log(`agent summary: ${summary.agentSummary}`);
    if (artifacts) {
      fs.writeFileSync(
        path.join(artifacts, `${harness}-report.json`),
        JSON.stringify(summary, null, 2),
      );
    }
    if (failures.length > 0)
      throw new Error(`Authoring evaluation failed:\n- ${failures.join("\n- ")}`);
    log("PASS: the agent authored, the learner submitted, the agent graded, and reload kept it.");
  } finally {
    for (const session of sessions) session.stop();
    if (browserOpen) await playwright(browser, root, "close");
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
}

await main();
