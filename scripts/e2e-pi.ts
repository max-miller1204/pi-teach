/** Test browser questions, quiz grading, and the teacher panel check in a real Pi session. */
import { highlightText } from "./browser-actions.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as store from "../src/store.ts";
import { DAY_MS } from "../src/review.ts";
import { currentReview } from "../src/review-session.ts";
import {
  makeFixture,
  lessonHtml,
  seedClassroom,
  writeGradedAttempt,
  termAnswer,
} from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";
import { TEST_MODELS } from "./harness.ts";

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
    "--provider",
    TEST_MODELS.pi.provider,
    "--model",
    TEST_MODELS.pi.model,
    "--thinking",
    TEST_MODELS.pi.effort,
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
  if (
    state.data.model.provider !== TEST_MODELS.pi.provider ||
    state.data.model.id !== TEST_MODELS.pi.model ||
    state.data.thinkingLevel !== TEST_MODELS.pi.effort
  )
    throw new Error(`Pi did not use the test model: ${JSON.stringify(state.data)}`);
  console.log(
    `[e2e:pi] model: ${state.data.model.provider}/${state.data.model.id} ${state.data.thinkingLevel}`,
  );
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

  // A question about the quiz itself, asked before grading, from the question text.
  {
    const start = events.length;
    await playwrightCode(
      session,
      fixture.root,
      `async page => {
      await (${highlightText.toString()})(page, '.cl-q-prompt', 'What happens');
      await page.locator('.cl-ask-pill').click();
      await page.locator('[data-cl-question]').fill('What does this question mean by what happens?');
      const response = page.waitForResponse(r => r.url().endsWith('/api/ask') && r.request().method() === 'POST');
      await page.getByRole('button', {name:'Ask your teacher', exact:true}).click();
      if ((await response).status() !== 201) throw new Error('The quiz question was refused');
      return true;
    }`,
    );
    const quizCard = await until(
      "quiz question answer",
      () =>
        store
          .listAnnotations("rust", "001-ownership")
          .find((a) => a.quiz && a.status === "answered") ?? null,
    );
    if (quizCard.quiz?.questionId !== "q1" || quizCard.quiz.graded)
      throw new Error(`The quiz card lost its question: ${JSON.stringify(quizCard.quiz)}`);
    await until("quiz question turn", () =>
      events.slice(start).some((e) => e.type === "agent_settled") ? true : null,
    );
    console.log(`[e2e:pi] quiz question answered before grading: ${quizCard.answerMarkdown}`);
  }

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
    const panel = await until(
      "retrieval question in the panel",
      () =>
        store
          .listPanelMessages("rust", "001-ownership")
          .find((m) => m.role === "teacher" && m.id === `quiz:${submitted.id}`) ?? null,
    );
    if (!panel.text.includes("?"))
      throw new Error("Pi did not ask a retrieval question in the panel");
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
      await page.waitForFunction(() => document.querySelector('form.cl-quiz').nextElementSibling?.classList.contains('cl-teacher'));
      await page.waitForFunction(() => document.querySelector('.cl-teacher-message[data-role="teacher"]')?.textContent.includes('?'));
      ${artifacts ? `await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({path:${JSON.stringify(path.join(artifacts, `pi-attempt-${attempt}.png`))},fullPage:true});` : ""}
      return true;
    }`,
    );
    console.log(
      `[e2e:pi] attempt ${attempt}: ${grade.score}%, ${expected ? "correct" : "wrong"}; panel: ${JSON.stringify(panel.text)}`,
    );
  }
  // The learner answers in the panel. Nothing is typed into Pi.
  const reply =
    "When the owner of a value leaves scope, Rust drops that value and frees its resources. If ownership moved to another variable, that new owner controls when the value is dropped. I answered without help.";
  await playwrightCode(
    session,
    fixture.root,
    `async page => {
    await page.getByRole('textbox', {name:'Reply to your teacher', exact:true}).fill(${JSON.stringify(reply)});
    const response = page.waitForResponse(r => r.url().endsWith('/api/teacher/chat'));
    await page.getByRole('button', {name:'Send reply', exact:true}).click();
    if ((await response).status() !== 201) throw new Error('The panel reply was refused');
    return true;
  }`,
  );
  const checkedReply = await until("panel answer check", () => {
    const message = store
      .listPanelMessages("rust", "001-ownership")
      .filter((m) => m.role === "teacher")[1];
    return message?.text.trim() ? message.text : null;
  });
  await playwrightCode(
    session,
    fixture.root,
    `async page => {
      await page.waitForFunction(() => document.querySelectorAll('.cl-teacher-message[data-role="teacher"]').length === 2);
      ${artifacts ? `await page.locator('.cl-teacher').scrollIntoViewIfNeeded(); await page.screenshot({path:${JSON.stringify(path.join(artifacts, "pi-panel-check.png"))}});` : ""}
      return true;
    }`,
  );
  if (events.some((e) => e.type === "prompt" && e.id === "chat-reply"))
    throw new Error("The check used the terminal");
  if (store.listSubmissions("rust", "001-ownership").length !== 1)
    throw new Error("The panel check created another quiz attempt");
  const review = store.reviewItems("rust");
  const historicalGrades = store.listGrades("rust", "001-ownership");
  if (
    historicalGrades.length !== 1 ||
    historicalGrades[0].score !== 0 ||
    historicalGrades[0].questions[0].correct ||
    review.length !== 1
  )
    throw new Error("The panel check changed the saved quiz grade or removed its review item.");
  const checks = store.listRetrievalChecks("rust");
  if (checks.length > 0 && review[0].lastSource !== "chat")
    throw new Error("Linked retrieval evidence did not reach the review schedule.");
  console.log(
    `[e2e:pi] panel answer check: ${JSON.stringify(checkedReply)}; retrieval checks linked: ${checks.length}`,
  );
  if (artifacts)
    fs.writeFileSync(path.join(artifacts, "pi-events.json"), JSON.stringify(events, null, 2));
  if (store.listLessons("rust").length !== 1)
    throw new Error("Pi created another lesson without agreement");
  writeGradedAttempt({
    at: Date.now() - 2 * DAY_MS,
    quizId: "historical",
    answers: [
      termAnswer("q1", "dropped", { prompt: "What happens when a value's owner leaves scope?" }),
    ],
    correct: { q1: true },
  });
  await playwrightCode(
    session,
    fixture.root,
    `async page => {
    await page.goto(${JSON.stringify(base)} + '/c/rust');
    await page.waitForFunction(() => !document.querySelector('[data-cl-review-start]').disabled);
    await page.getByRole('button', {name:'Start review',exact:true}).click();
    return true;
  }`,
  );
  const reviewSession = await until("browser review authoring", () => {
    const session = currentReview("rust");
    if (session?.status === "failed") throw new Error(session.error);
    return session?.status === "done" ? session : null;
  });
  await playwrightCode(
    session,
    fixture.root,
    `async page => {
    await page.waitForURL(${JSON.stringify(base)} + ${JSON.stringify(`/c/rust/${reviewSession.lesson}`)});
    await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
    if (await page.locator('.cl-quiz-error').count()) throw new Error('Authored review has contract errors.');
    ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "pi-review.png"))},fullPage:true});` : ""}
    return true;
  }`,
  );
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "stored-review.json"),
      JSON.stringify(reviewSession, null, 2),
    );
  console.log("[e2e:pi] PASS: review authoring starts from the classroom page");
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
    "[e2e:pi] PASS: browser question, quiz question, wrong-answer panel check, locked quiz, spaced review, widget, and server stop",
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
