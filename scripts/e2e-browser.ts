/** Check browser state against the real HTTP server and grading tool. */
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applyGrade } from "../src/bridge.ts";
import * as server from "../src/server.ts";
import { classroomTools, PI_HOST } from "../src/tools.ts";
import * as store from "../src/store.ts";
import { makeFixture, lessonHtml, seedClassroom } from "../test/helpers.ts";
import { playwright } from "./playwright.ts";

const fixture = makeFixture();
const session = `pi-teach-browser-${process.pid}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
seedClassroom(fixture);
fixture.write("rust/GLOSSARY.md", "**Borrow checker**:\nChecks that borrows are valid.\n");
fixture.write(
  "rust/001-ownership/lesson.html",
  lessonHtml(
    "Browser regression",
    `
  <section><p><strong>borrow</strong> checker rejects it.</p><p>The borrow checker checks again.</p></section>
  <form class="cl-quiz" data-quiz-id="check-1" data-title="Check">
    <ol class="cl-questions">
      <li class="cl-q" data-question-id="q1" data-type="multi">
        <p class="cl-q-prompt">Select the statements.</p>
        <label><input type="checkbox" value="a">First statement</label>
        <label><input type="checkbox" value="b">Second statement</label>
        <label><input type="checkbox" value="c">Third statement</label>
      </li>
      <li class="cl-q" data-question-id="q2" data-type="locate">
        <div class="cl-q-stimulus"><span data-segment="s1">First line</span> <span data-segment="s2">Second line</span> <span data-segment="s3">Third line</span></div>
        <p class="cl-q-prompt">Select one line.</p>
      </li>
    </ol>
  </form>
  <form class="cl-quiz" data-quiz-id="instant" data-title="Immediate grade" data-confidence="off">
    <ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="term">
      <p class="cl-q-prompt">Name the owner.</p><input type="text">
    </li></ol>
  </form>`,
  ),
);

server.setHooks({
  onAsk() {},
  onFollowUp() {},
  onReflect() {},
  onQuizSubmit(submission) {
    if (submission.quizId === "instant")
      applyGrade(submission, {
        score: 100,
        feedbackMarkdown: "Immediate grade",
        questions: [{ questionId: "q1", correct: true, feedback: "Right." }],
      });
  },
});
const gradeTool = classroomTools(PI_HOST).find((tool) => tool.name === "grade_lesson_quiz")!;
const control = http.createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { submissionId, feedback } = JSON.parse(body) as {
      submissionId: string;
      feedback: string;
    };
    const submission = store.findSubmission(submissionId);
    if (!submission) throw new Error(`No submission ${submissionId}`);
    const result = await gradeTool.execute({
      submission_id: submission.id,
      score: 100,
      feedback_markdown: feedback,
      questions: submission.answers.map((answer) => ({
        question_id: answer.questionId,
        correct: true,
        feedback,
      })),
    });
    if (result.details["error"]) throw new Error(result.content[0].text);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.details));
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});

let browserOpen = false;
try {
  const base = await server.start();
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("No control server address");
  const url = `${base}/c/rust/001-ownership?control=${address.port}`;
  await playwright(session, fixture.root, "open", url);
  browserOpen = true;
  console.log(
    await playwright(
      session,
      fixture.root,
      "run-code",
      "--filename",
      path.join(root, "test/browser.playwright.js"),
    ),
  );
} finally {
  if (browserOpen) await playwright(session, fixture.root, "close");
  await server.close();
  await new Promise<void>((resolve, reject) =>
    control.close((error) => (error ? reject(error) : resolve())),
  );
  fixture.cleanup();
}
