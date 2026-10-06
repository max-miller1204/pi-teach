/** Test browser questions, quiz grading, and chat follow-up in a real Pi session. */
import { highlightText } from "./browser-actions.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "../src/store.ts";
import { makeFixture, lessonHtml, seedClassroom } from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";

const fixture = makeFixture();
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
seedClassroom(fixture);
fixture.write(
  "rust/001-ownership/lesson.html",
  lessonHtml(
    "Ownership",
    `
  <h1>Ownership</h1>
  <p>Every value in Rust has one owner. When the owner goes out of scope, the value is dropped.</p>
  <form class="cl-quiz" data-quiz-id="check-1" data-title="Check on learning">
    <ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="choice">
      <p class="cl-q-prompt">What happens to a value when its owner goes out of scope?</p>
      <label><input type="radio" name="q1" value="a">The value is dropped</label>
      <label><input type="radio" name="q1" value="b">The value stays alive forever</label>
    </li></ol>
  </form>`,
  ).replace("<main data-cl-content>", '<main class="cl-lesson-shell" data-cl-content>'),
);

fixture.write(
  "rust/001-ownership/quiz/key.json",
  JSON.stringify({
    "check-1": {
      q1: {
        expected: "a",
        points: 1,
        fullCredit: "The value is dropped.",
        noCredit: "The value stays alive forever.",
      },
    },
  }),
);

const session = `pi-teach-pi-${process.pid}`;
const child = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--offline",
    "--extension",
    path.join(root, "index.ts"),
  ],
  {
    cwd: fixture.root,
    // The user's own classroom config may set a port that a live Pi session holds.
    env: {
      ...process.env,
      PI_CLASSROOMS_DIR: fixture.root,
      PI_CLASSROOM_AUTO_OPEN: "0",
      PI_CLASSROOM_CONFIG: path.join(fixture.root, "test-config.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

const events: Array<Record<string, any>> = [];
let buffer = "";
let failure: Error | null = null;
let stderr = "";
child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).replace(/\r$/, "");
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "extension_error" || (event.type === "response" && !event.success))
        failure = new Error(JSON.stringify(event));
      if (event.type === "tool_execution_end" && event.isError)
        failure = new Error(`Tool failed: ${event.toolName}`);
    } catch (error) {
      failure = error as Error;
    }
  }
});
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});
child.on("error", (error) => {
  failure = error;
});
child.on("exit", (code) => {
  failure = new Error(`Pi exited with ${code}: ${stderr}`);
});
const send = (command: Record<string, unknown>) =>
  child.stdin.write(`${JSON.stringify(command)}\n`);
async function until<T>(label: string, probe: () => T | null): Promise<T> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const result = probe();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}. ${stderr}`);
}

let browserOpen = false;
try {
  send({ id: "state", type: "get_state" });
  const state = await until(
    "Pi state",
    () => events.find((e) => e.id === "state" && e.type === "response") ?? null,
  );
  console.log(`[e2e:pi] model: ${state.data.model.provider}/${state.data.model.id}`);
  send({ id: "start", type: "prompt", message: "/classroom start" });
  const base = await until("server URL", () => {
    const event = events.find(
      (e) =>
        e.type === "extension_ui_request" &&
        e.method === "notify" &&
        /Classroom server started at/.test(e.message),
    );
    return event ? (/http:\/\/127\.0\.0\.1:\d+/.exec(event.message)?.[0] ?? null) : null;
  });
  await until("status widget", () =>
    events.some(
      (e) =>
        e.method === "setWidget" &&
        e.widgetLines?.some((line: string) => line.includes("server running on port")),
    )
      ? true
      : null,
  );
  send({ id: "open", type: "prompt", message: "/classroom rust" });
  const classroomUrl = await until("classroom link", () => {
    const event = events.find(
      (e) =>
        e.type === "extension_ui_request" && e.method === "notify" && /^📚 http/.test(e.message),
    );
    return event ? (/http:\/\/127\.0\.0\.1:\d+\/c\/rust/.exec(event.message)?.[0] ?? null) : null;
  });
  await playwright(session, fixture.root, "open", classroomUrl);
  browserOpen = true;
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "pi-reading.json"),
      JSON.stringify(
        {
          command: "/classroom rust",
          classroomUrl,
          lessonUrl: `${base}/c/rust/001-ownership`,
          lesson: fs.readFileSync(
            path.join(fixture.root, "rust/001-ownership/lesson.html"),
            "utf8",
          ),
        },
        null,
        2,
      ),
    );
  await playwrightCode(
    session,
    fixture.root,
    `async page => {
    await page.locator('a[href="/c/rust/001-ownership"]').click();
    await page.locator('[data-cl-content]').getByText('Every value in Rust has one owner.', {exact:false}).waitFor();
    if (await page.locator('.cl-confidence').count()) throw new Error('The page has confidence controls');
    ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "pi-fresh-lesson.png"))},fullPage:true});` : ""}
    return true;
  }`,
  );
  await playwrightCode(
    session,
    fixture.root,
    `async page => {
    await (${highlightText.toString()})(page, 'main > p', 'one owner');
    await page.locator('.cl-ask-pill').click();
    await page.locator('[data-cl-question]').fill('Why does Rust allow only one owner?');
    const response = page.waitForResponse(r => r.url().endsWith('/api/ask') && r.request().method() === 'POST');
    await page.getByRole('button', {name:'Ask your teacher', exact:true}).click();
    if ((await response).status() !== 201) throw new Error('The question was refused');
    return true;
  }`,
  );
  await until("page answer", () =>
    store
      .listAnnotations("rust", "001-ownership")
      .some((a) => a.status === "answered" && a.answerHtml)
      ? true
      : null,
  );
  await until("answer turn", () =>
    events.some(
      (e) => e.type === "tool_execution_end" && e.toolName === "answer_lesson_question",
    ) && events.some((e) => e.type === "agent_settled")
      ? true
      : null,
  );
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "pi-composer-annotation.json"),
      JSON.stringify(store.listAnnotations("rust", "001-ownership"), null, 2),
    );
  console.log("[e2e:pi] browser question answered through answer_lesson_question");

  const attempt = 1;
  const option = "b";
  const expected = false;
  {
    const start = events.length;
    const submitted = await playwrightCode<{ id: string }>(
      session,
      fixture.root,
      `async page => {
      const form = page.locator('form.cl-quiz');
      await form.locator('input[value="${option}"]').check();
      const response = page.waitForResponse(r => r.url().endsWith('/api/quiz/submit') && r.request().method() === 'POST');
      await form.getByRole('button', {name:'Submit for grading', exact:true}).click();
      const result = await response;
      if (result.status() !== 201) throw new Error(await result.text());
      return await result.json();
    }`,
    );
    const saved = store.findSubmission(submitted.id);
    if (!saved || saved.answers.some((answer) => answer.confidence !== undefined))
      throw new Error("The browser submission contains confidence metadata");
    const grade = await until(
      "quiz grade",
      () =>
        store.listGrades("rust", "001-ownership").find((g) => g.submissionId === submitted.id) ??
        null,
    );
    if (grade.questions.length !== 1 || grade.questions[0].correct !== expected)
      throw new Error(`Wrong verdict for attempt ${attempt}`);
    const run = await until("grading turn", () => {
      const next = events.slice(start);
      return next.some((e) => e.type === "agent_settled") ? next : null;
    });
    if (!run.some((e) => e.type === "tool_execution_end" && e.toolName === "grade_lesson_quiz"))
      throw new Error("Pi did not grade with the tool");
    const chat = run
      .filter((e) => e.type === "message_end" && e.message.role === "assistant")
      .flatMap((e) =>
        e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text),
      )
      .join("\n");
    if (!chat.includes("?")) throw new Error("Pi did not ask a retrieval question in chat");
    await playwrightCode(
      session,
      fixture.root,
      `async page => {
      await page.waitForFunction(() => {
        const form = document.querySelector('form.cl-quiz');
        return form.dataset.state === 'graded' && form.dataset.attempts === '${attempt}';
      });
      if (await page.locator('.cl-confidence').count()) throw new Error('The graded page has confidence controls');
      if (await page.getByRole('button', {name:'Try again', exact:true}).count()) throw new Error('The page has a retry button');
      if (!await page.getByRole('button', {name:'Graded', exact:true}).isDisabled()) throw new Error('The graded quiz is unlocked');
      if (!await page.locator('input[value="${option}"]').isChecked()) throw new Error('The page shows the wrong answer');
      ${artifacts ? `await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({path:${JSON.stringify(path.join(artifacts, `pi-attempt-${attempt}.png`))},fullPage:true});` : ""}
      return true;
    }`,
    );
    console.log(
      `[e2e:pi] attempt ${attempt}: ${grade.score}%, ${expected ? "correct" : "wrong"}; chat: ${JSON.stringify(chat)}`,
    );
  }
  const replyStart = events.length;
  send({
    id: "chat-reply",
    type: "prompt",
    message:
      "My answer: When the owner of a value leaves scope, Rust drops that value and frees its resources. If ownership moved to another variable, that new owner controls when the value is dropped. Please check my answer to your question. Stay on this lesson.",
  });
  const replyRun = await until("chat answer check", () => {
    const next = events.slice(replyStart);
    return next.some((e) => e.type === "agent_settled") ? next : null;
  });
  const checkedReply = replyRun
    .filter((e) => e.type === "message_end" && e.message.role === "assistant")
    .flatMap((e) => e.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text))
    .join("\n");
  if (!checkedReply.trim()) throw new Error("Pi did not check the learner's chat reply");
  if (store.listSubmissions("rust", "001-ownership").length !== 1)
    throw new Error("The chat check created another quiz attempt");
  const review = store.reviewItems("rust");
  const historicalGrades = store.listGrades("rust", "001-ownership");
  if (
    historicalGrades.length !== 1 ||
    historicalGrades[0].score !== 0 ||
    historicalGrades[0].questions[0].correct ||
    review.length !== 1
  )
    throw new Error("The chat check changed the saved quiz grade or removed its review item.");
  const checks = store.listRetrievalChecks("rust");
  if (checks.length > 0 && review[0].lastSource !== "chat")
    throw new Error("Linked retrieval evidence did not reach the review schedule.");
  console.log(`[e2e:pi] chat answer check: ${JSON.stringify(checkedReply)}`);
  if (artifacts)
    fs.writeFileSync(path.join(artifacts, "pi-events.json"), JSON.stringify(events, null, 2));
  if (store.listLessons("rust").length !== 1)
    throw new Error("Pi created another lesson without agreement");
  send({ id: "stop", type: "prompt", message: "/classroom stop" });
  await until("server stop", () =>
    events.some((e) => e.id === "stop" && e.type === "response") ? true : null,
  );
  try {
    await fetch(`${base}/`);
    throw new Error("The Pi server still runs after /classroom stop");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  console.log(
    "[e2e:pi] PASS: browser question, wrong-answer chat check, locked quiz, spaced review, widget, and server stop",
  );
} finally {
  if (artifacts) {
    fs.writeFileSync(path.join(artifacts, "pi-events.json"), JSON.stringify(events, null, 2));
    fs.writeFileSync(path.join(artifacts, "pi-stderr.log"), stderr);
  }
  if (browserOpen) await playwright(session, fixture.root, "close");
  child.kill();
  fixture.cleanup();
}
