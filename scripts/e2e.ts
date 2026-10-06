/** Real host and dedicated teacher evaluation. All material is a temporary fixture. */
import { highlightText } from "./browser-actions.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { codexHome, harnessCommand, parseHarness } from "./harness.ts";
import { playwright, playwrightCode } from "./playwright.ts";
import { _overrideClassroomsDir } from "../src/paths.ts";
import { control, serviceStatus } from "../src/service-client.ts";

const harness = parseHarness(
  process.argv[2],
  "Usage: node scripts/e2e.ts <claude|codex> [artifacts]",
);
const CLASSROOM = "rust",
  LESSON = "001-ownership";
const artifacts = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
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

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-teach-e2e-${harness}-`));
  const home = harness === "codex" ? codexHome() : null;
  seedClassroom(root);
  _overrideClassroomsDir(root);
  const port = await freePort(),
    browser = `pi-teach-${harness}-${process.pid}`;
  process.env.PI_CLASSROOM_SERVICE_PORT = String(port);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CLASSROOMS_DIR: root,
    PI_CLASSROOM_AUTO_OPEN: "0",
    PI_CLASSROOM_TEACHER: harness,
  };
  if (home) env.CODEX_HOME = home;
  const prompt = `Call begin_teaching with topic rust. Call open_classroom with classroom rust and teacher_backend ${harness}. Return the URL and end this turn. Do not write material or wait for browser requests. The persistent service handles them.`;
  const [command, args] = harnessCommand(harness, prompt, ["begin_teaching", "open_classroom"]);
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "",
    browserOpen = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Initiating host did not exit within 180 seconds.")),
          180_000,
        );
      }),
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr}`);
    if (!stdout.includes(`http://127.0.0.1:${port}`))
      throw new Error(`Host did not return the service URL: ${stdout}`);
    const status = await serviceStatus();
    if (!status.running) throw new Error("Service stopped with initiating host.");
    const base = status.url;
    log(`initiating host exited; service remains at ${base}`);
    await playwright(browser, root, "open", `${base}/c/${CLASSROOM}/${LESSON}`);
    browserOpen = true;
    const question = await playwrightCode<any>(
      browser,
      root,
      `async page => {
      await page.waitForSelector('form.cl-quiz');
      await (${highlightText.toString()})(page, 'main > p', 'one owner');
      await page.locator('.cl-ask-pill').click();
      await page.locator('[data-cl-question]').fill('Why does Rust allow only one owner?');
      const response = page.waitForResponse(r => r.url().endsWith('/api/ask') && r.request().method() === 'POST');
      await page.getByRole('button', {name:'Ask your teacher', exact:true}).click();
      const result = await response;
      if(result.status() !== 201) throw new Error(await result.text());
      const annotation = await result.json();
      if (!annotation.anchor.exact.includes('one owner')) throw new Error('The composer lost its highlight.');
      return annotation;
    }`,
    );
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "composer-submission.json"),
        JSON.stringify(question, null, 2),
      );
    async function state(): Promise<any> {
      return (await fetch(`${base}/api/state?classroom=rust&lesson=001-ownership`)).json();
    }
    async function wait(what: string, predicate: (s: any) => boolean): Promise<any> {
      const deadline = Date.now() + 185_000;
      while (Date.now() < deadline) {
        const s = await state();
        const failed = s.teacher.requests.find((r: any) => r.status === "failed");
        if (failed) throw new Error(`Teacher request ${failed.id}: ${failed.error}`);
        if (predicate(s)) return s;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`Timed out waiting for ${what}.`);
    }
    const answered = await wait(
      "answer after idle",
      (s) =>
        s.annotations[0]?.status === "answered" &&
        s.teacher.requests.every((r: any) => r.status === "done"),
    );
    const savedAnnotation = JSON.parse(
      fs.readFileSync(path.join(root, CLASSROOM, LESSON, "annotations.json"), "utf8"),
    ).find((annotation: any) => annotation.id === question.id);
    if (savedAnnotation.question !== question.question || savedAnnotation.status !== "answered")
      throw new Error("The composer question or its answer was not saved.");
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "composer-annotation.json"),
        JSON.stringify(savedAnnotation, null, 2),
      );
    log(`dedicated session ${answered.teacher.identity.sessionId} answered the card`);
    await playwrightCode(
      browser,
      root,
      `async page => {
      await page.waitForSelector('.cl-card-answer');
      await page.locator('input[value="b"]').check();
      await page.locator('form.cl-quiz button[type="submit"]').click();
      return true;
    }`,
    );
    const graded = await wait(
      "quiz grade",
      (s) => !!s.quizzes[0]?.grade && s.teacher.requests.every((r: any) => r.status === "done"),
    );
    if (graded.quizzes[0].grade.questions[0].correct !== false)
      throw new Error("Wrong answer was not marked incorrect.");
    if (!graded.teacher.messages.at(-1).text.includes("?"))
      throw new Error("Teacher did not ask a retrieval question.");
    await playwrightCode(
      browser,
      root,
      `async page => {
      await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
      if (!await page.getByRole('button',{name:'Graded',exact:true}).isDisabled()) throw new Error('Graded quiz is unlocked.');
      await page.locator('.cl-teacher textarea').fill('The value is dropped when its owner leaves scope. If a String moves to another variable, the new variable owns it. The old variable cannot use it, so the same value is not freed twice.');
      await page.locator('.cl-teacher button[type="submit"]').click();
      ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, `${harness}-teacher-panel.png`))},fullPage:true});` : ""}
      return true;
    }`,
    );
    const checked = await wait(
      "retrieval reply",
      (s) =>
        s.teacher.requests.some((r: any) => r.kind === "chat") &&
        s.teacher.requests.every((r: any) => r.status === "done"),
    );
    log(`retrieval feedback: ${checked.teacher.messages.at(-1).text}`);
    if (checked.teacher.identity.sessionId !== answered.teacher.identity.sessionId)
      throw new Error("Teacher changed session.");
    const grades = fs.readdirSync(path.join(root, CLASSROOM, LESSON, "quiz/grades"));
    if (grades.length !== 1) throw new Error("Teacher changed the historical grade.");
    const lessons = fs
      .readdirSync(path.join(root, CLASSROOM))
      .filter((f) => fs.existsSync(path.join(root, CLASSROOM, f, "lesson.html")));
    if (lessons.length !== 1) throw new Error("Teacher advanced without agreement.");
    if ((await fetch(`${base}/c/rust/001-ownership/quiz/key.json`)).status !== 404)
      throw new Error("Rubric is public.");
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "stored-teacher-state.json"),
        JSON.stringify(
          {
            checked,
            savedAnnotation,
            grade: JSON.parse(
              fs.readFileSync(path.join(root, CLASSROOM, LESSON, "quiz/grades", grades[0]), "utf8"),
            ),
          },
          null,
          2,
        ),
      );
    log(
      "PASS: host exit, idle wake, answer, grade, locked quiz, teacher reply, stable session, private rubric",
    );
  } finally {
    if (artifacts) {
      fs.writeFileSync(path.join(artifacts, "host-stdout.log"), stdout);
      fs.writeFileSync(path.join(artifacts, "host-stderr.log"), stderr);
      const serviceLog = path.join(root, ".pi-teach-service/service.log");
      if (fs.existsSync(serviceLog))
        fs.copyFileSync(serviceLog, path.join(artifacts, "service.log"));
    }
    clearTimeout(timer);
    child.kill();
    if ((await serviceStatus()).running) {
      await control("/stop", {});
      await new Promise((r) => setTimeout(r, 300));
    }
    if (browserOpen) await playwright(browser, root, "close");
    fs.rmSync(root, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
}
await main();
