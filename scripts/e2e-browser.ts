import { verifyResumeBrowser } from "./e2e-resume-browser.ts";
import { verifyCardBrowser } from "./e2e-card-browser.ts";
import { verifyReviewBrowser } from "./e2e-review-browser.ts";
/** Check browser state against the real HTTP server and grading tool. */
import { browserRegression } from "./browser-regression.mjs";
import { highlightText } from "./browser-actions.ts";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applyAnswer, applyGrade } from "../src/bridge.ts";
import * as server from "../src/server.ts";
import { classroomTools, PI_HOST } from "../src/tools.ts";
import * as store from "../src/store.ts";
import { makeFixture, lessonHtml, seedClassroom } from "../test/helpers.ts";
import { verifyPiPanelBrowser } from "./e2e-pi-panel-browser.ts";
import { verifyServiceBrowser } from "./e2e-service-browser.ts";
import { playwright, playwrightCode } from "./playwright.ts";

const fixture = makeFixture();
const session = `pi-teach-browser-${process.pid}`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
seedClassroom(fixture);
fixture.write("rust/GLOSSARY.md", "**Borrow checker**:\nChecks that borrows are valid.\n");
const contract = fs
  .readFileSync(path.join(root, "assets/templates/quiz.html"), "utf8")
  .split("-->")
  .slice(1)
  .join("-->");
const allTypes = contract
  .slice(contract.indexOf('<form class="cl-quiz"'), contract.indexOf("</form>") + 7)
  .replace('data-quiz-id="check-1"', 'data-quiz-id="all-types"');
const partialQuiz = `<form class="cl-quiz" data-quiz-id="partial" data-title="Partial credit regression"><ol class="cl-questions">${[1, 2, 3].map((i) => `<li class="cl-q" data-question-id="q${i}" data-type="short"><p class="cl-q-prompt">Explain idea ${i}.</p><textarea></textarea></li>`).join("")}</ol></form>`;
const invalidOptionsQuiz = `<form class="cl-quiz" data-quiz-id="invalid-options" data-title="Invalid option values"><ol class="cl-questions">
  <li class="cl-q" data-question-id="q1" data-type="multi"><p class="cl-q-prompt">Select both.</p><label><input type="checkbox" value="a">First option</label><label><input type="checkbox">Second option</label></li>
  <li class="cl-q" data-question-id="q2" data-type="choice"><p class="cl-q-prompt">Select one.</p><label><input type="radio" name="dup" value="a">First option</label><label><input type="radio" name="dup" value="a">Other option</label></li>
</ol></form>`;
fixture.write(
  "rust/001-ownership/lesson.html",
  lessonHtml(
    "Browser regression",
    `
  <form class="cl-reflect" data-reflect-id="ownership"><p class="cl-reflect-prompt">Explain ownership.</p><textarea></textarea></form>
  <p data-draft-passage>Every value has one owner.</p>
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
  <form class="cl-quiz" data-quiz-id="instant" data-title="Immediate grade" data-confidence="optional" data-evidence="report">
    <ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="term">
      <p class="cl-q-prompt">Name the owner.</p><input type="text">
    </li></ol>
  </form>${allTypes}${partialQuiz}${invalidOptionsQuiz}`,
  ).replace("<main data-cl-content>", '<main class="cl-lesson-shell" data-cl-content>'),
);
const flowchart = `
      flowchart LR
        accTitle: Borrow check
        Source["fn main()"] -->|borrow checker| Check{"x &lt; y?"}
        Check --> Done`;
fixture.write(
  "rust/002-diagrams/lesson.html",
  lessonHtml(
    "Diagrams",
    `
  <section>
    <p>The borrow checker runs before code generation.</p>
    <figure><pre class="mermaid" aria-label="Borrow check" aria-describedby="borrow-description">${flowchart}</pre><figcaption id="borrow-description">The source passes through the borrow check before code generation.</figcaption></figure>
    <pre class="mermaid">flowchart LR
      A --> </pre>
  </section>
  <form class="cl-quiz" data-quiz-id="diagram-check" data-title="Diagram check">
    <ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="term">
      <div class="cl-q-stimulus"><p>Read the chart.</p><pre class="mermaid">
        sequenceDiagram
          Caller->>Owner: borrow
          Owner-->>Caller: reference
      </pre></div>
      <p class="cl-q-prompt">Who returns the reference?</p><input type="text">
    </li></ol>
  </form>`,
  ).replace("<main data-cl-content>", '<main class="cl-lesson-shell" data-cl-content>'),
);
fixture.write(
  "rust/reference/diagrams.html",
  lessonHtml("Diagram reference", `<pre class="mermaid">stateDiagram-v2\n  [*] --> Owned</pre>`),
);
fixture.write(
  "rust/003-math/lesson.html",
  lessonHtml(
    "Math",
    String.raw`
  <section>
    <p data-math-prose>A move costs \(O(1)\) time, so \(n\) moves cost \(O(n)\) in total.</p>
    <p>\[ \sum_{i=1}^{n} i = \frac{n(n+1)}{2} \]</p>
    <p>Write <code>\(x\)</code> for inline math.</p>
    <p data-math-bound>Bound: \(0 &lt; x\)</p>
    <p>Broken: \(\frac{a\)</p>
  </section>
  <form class="cl-quiz" data-quiz-id="math-check" data-title="Math check">
    <ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="choice">
      <div class="cl-q-stimulus"><p>Let \(f(x) = x^2\).</p></div>
      <p class="cl-q-prompt">What is \(f'(3)\)?</p>
      <label><input type="radio" name="q1" value="a">\(6\)</label>
      <label><input type="radio" name="q1" value="b">\(9\)</label>
    </li></ol>
  </form>`,
  ).replace("<main data-cl-content>", '<main class="cl-lesson-shell" data-cl-content>'),
);
fixture.write(
  "rust/reference/math.html",
  lessonHtml("Math reference", String.raw`<p>\(e^{i\pi} + 1 = 0\)</p>`),
);

server.setHooks({
  delivery: "wait",
  onAsk(annotation) {
    const answer =
      annotation.lesson === "003-math"
        ? String.raw`Each move is $O(1)$, so the total is $$\sum_{i=1}^{n} O(1) = O(n).$$`
        : "The owner releases the value.";
    setTimeout(() => applyAnswer(annotation.id, answer), 100);
  },
  onFollowUp() {},
  onReflect() {},
  onQuizSubmit(submission) {
    if (submission.quizId === "gate-before")
      setTimeout(
        () =>
          applyGrade(submission, {
            score: 0,
            feedbackMarkdown: "Diagnostic only.",
            questions: [{ questionId: "p1", correct: false, feedback: "We will teach this idea." }],
          }),
        100,
      );
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
    const { submissionId, feedback, correct, partial } = JSON.parse(body) as {
      submissionId: string;
      feedback: string;
      correct: boolean;
      partial?: boolean;
    };
    const submission = store.findSubmission(submissionId);
    if (!submission) throw new Error(`No submission ${submissionId}`);
    const result = await gradeTool.execute({
      submission_id: submission.id,
      score: partial ? 78 : correct ? 100 : 0,
      feedback_markdown: feedback,
      questions: submission.answers.map((answer, index) => ({
        question_id: answer.questionId,
        correct: partial ? index === 0 : correct,
        points_earned: partial ? [9, 7, 5][index] : undefined,
        points_possible: partial ? 9 : undefined,
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
const draftHistory: unknown[] = [];
let lastDraft = "";
const draftWatcher = setInterval(() => {
  const file = path.join(fixture.root, "rust/001-ownership/drafts.json");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  if (text !== lastDraft) {
    draftHistory.push(JSON.parse(text));
    lastDraft = text;
  }
}, 25);
try {
  const base = await server.start();
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("No control server address");
  const url = `${base}/c/rust/001-ownership?control=${address.port}${artifacts ? `&artifacts=${encodeURIComponent(artifacts)}` : ""}`;
  await playwright(session, fixture.root, "open", url);
  browserOpen = true;
  const browserResult = await playwright(
    session,
    fixture.root,
    "run-code",
    `async page => {
      const highlightText = ${highlightText.toString()};
      const browserRegression = ${browserRegression.toString()};
      return browserRegression(page, highlightText);
    }`,
  );
  console.log(browserResult);
  fixture.write(
    "rust/099-gate/lesson.html",
    lessonHtml(
      "Pretest gate",
      `
    <form class="cl-reflect" data-reflect-id="gate-draft"><p class="cl-reflect-prompt">Keep a note.</p><textarea></textarea></form>
    <form class="cl-quiz" data-quiz-id="gate-before" data-kind="pretest"><ol><li class="cl-q" data-question-id="p1" data-type="term"><p class="cl-q-prompt">What do you know?</p><input type="text"></li></ol></form>
    <template data-cl-after-pretest="gate-before"><p>GATED TEACHING SENTINEL</p><script>window.gateReady=true;</script>
    <form class="cl-quiz" data-quiz-id="gate-after"><ol><li class="cl-q" data-question-id="q1" data-type="term"><p class="cl-q-prompt">Apply the idea.</p><input type="text"></li></ol></form></template>`,
    ),
  );
  const gateResult = await playwrightCode(
    session,
    fixture.root,
    `async page => {
    await page.addInitScript(() => {
      if(location.pathname.endsWith('/099-gate')) {
        sessionStorage.setItem('gate-loads', String(Number(sessionStorage.getItem('gate-loads') || 0) + 1));
      }
    });
    await page.goto(${JSON.stringify(`${base}/c/rust/099-gate`)});
    await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
    if((await page.content()).includes('GATED TEACHING SENTINEL')) throw new Error('Initial response exposed teaching.');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/draft') && r.request().method() === 'PUT');
    await page.locator('.cl-reflect textarea').fill('Unsaved diagnostic note');
    if(!(await saved).ok()) throw new Error('The diagnostic note was not saved.');
    await page.locator('form.cl-quiz input').fill('I do not know yet');
    await page.getByRole('button', {name:'Submit for grading', exact:true}).click();
    await page.waitForFunction(() => window.gateReady === true);
    await page.waitForFunction(() => document.querySelector('[data-quiz-id="gate-before"]')?.dataset.state === 'graded');
    if(await page.locator('.cl-reflect textarea').inputValue() !== 'Unsaved diagnostic note') throw new Error('Automatic release lost the draft.');
    if(await page.locator('[data-quiz-id="gate-after"]').getAttribute('data-state') !== 'fresh') throw new Error('The released check is not usable.');
    await page.waitForTimeout(500);
    if(await page.evaluate(() => sessionStorage.getItem('gate-loads')) !== '2') throw new Error('Pretest grade must cause exactly one automatic reload.');
    return {automaticReloads:1, teachingReleased:true, draftPreserved:true};
  }`,
  );
  console.log(JSON.stringify({ pretestGate: gateResult }));
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "pretest-gate.json"),
      JSON.stringify(gateResult, null, 2),
    );
  if (
    !draftHistory.some(
      (draft: any) => draft["reflect:ownership"] === "The owner releases the value.",
    )
  )
    throw new Error("The reflection draft was not stored on disk before reload.");
  if (artifacts) {
    fs.writeFileSync(path.join(artifacts, "browser-result.json"), browserResult);
    fs.writeFileSync(
      path.join(artifacts, "disk-draft-history.json"),
      JSON.stringify(draftHistory, null, 2),
    );
  }
  const reflections = store.listReflections("rust", "001-ownership");
  const annotations = store.listAnnotations("rust", "001-ownership");
  const drafts = JSON.parse(
    fs.readFileSync(path.join(fixture.root, "rust/001-ownership/drafts.json"), "utf8"),
  );
  if (reflections.length !== 1 || reflections[0].text !== "The owner releases the value.")
    throw new Error("The Save button did not store the self-explanation.");
  if (Object.hasOwn(drafts, "reflect:ownership")) throw new Error("Save left a reflection draft.");
  if (
    annotations.length !== 1 ||
    annotations[0].status !== "answered" ||
    annotations[0].followUps?.length
  )
    throw new Error("The saved card or its unsent follow-up changed.");
  if (drafts[`followup:${annotations[0].id}`] !== "Does moving change the owner?")
    throw new Error("The follow-up draft was not stored.");
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "stored-learner-paths.json"),
      JSON.stringify({ reflections, annotations, drafts }, null, 2),
    );
  const submissions = store.listSubmissions("rust", "001-ownership");
  const grades = store.listGrades("rust", "001-ownership");
  if (
    submissions.length !== 5 ||
    submissions.some((submission) => !grades.some((grade) => grade.submissionId === submission.id))
  )
    throw new Error("The browser flow lost saved attempts or grades");
  const review = store.reviewItems("rust");
  if (
    review.length !== 17 ||
    review.some((item) => item.box !== 0 || item.progress === "retained-evidence")
  )
    throw new Error("Immediate answers must not advance retention evidence");
  const mathSubmissions = store.listSubmissions("rust", "003-math");
  const mathGrades = store.listGrades("rust", "003-math");
  const mathReview = review.find((item) => item.lesson === "003-math");
  if (
    mathSubmissions.length !== 1 ||
    mathSubmissions[0].answers[0].prompt !== String.raw`What is \(f'(3)\)?` ||
    mathGrades.length !== 1 ||
    mathGrades[0].submissionId !== mathSubmissions[0].id ||
    mathReview?.prompt !== String.raw`What is \(f'(3)\)?`
  )
    throw new Error("The math flow lost its saved TeX, grade, or review prompt");
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "stored-math.json"),
      JSON.stringify(
        { submissions: mathSubmissions, grades: mathGrades, review: mathReview },
        null,
        2,
      ),
    );
} catch (error) {
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          drafts: store.readDrafts("rust", "001-ownership"),
          annotations: store.listAnnotations("rust", "001-ownership"),
          reflections: store.listReflections("rust", "001-ownership"),
        },
        null,
        2,
      ),
    );
  throw error;
} finally {
  if (artifacts)
    fs.writeFileSync(
      path.join(artifacts, "disk-draft-history.json"),
      JSON.stringify(draftHistory, null, 2),
    );
  clearInterval(draftWatcher);
  if (browserOpen) await playwright(session, fixture.root, "close");
  await server.close();
  await new Promise<void>((resolve, reject) =>
    control.close((error) => (error ? reject(error) : resolve())),
  );
  fixture.cleanup();
}

await verifyPiPanelBrowser(artifacts ? path.join(artifacts, "pi-panel") : null);
await verifyServiceBrowser(artifacts ? path.join(artifacts, "service") : null);

await verifyReviewBrowser(artifacts ? path.join(artifacts, "review") : null);

if (artifacts) fs.mkdirSync(path.join(artifacts, "resume"), { recursive: true });
await verifyResumeBrowser(artifacts ? path.join(artifacts, "resume") : null);
await verifyCardBrowser(artifacts ? path.join(artifacts, "cards") : null);
