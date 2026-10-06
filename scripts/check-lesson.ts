/** Check initial and released lesson controls in a disposable classroom. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  classroomsRoot,
  classroomDir,
  isValidSlug,
  lessonDir,
  _overrideClassroomsDir,
} from "../src/paths.ts";
import { stageLesson } from "../src/pretest.ts";
import { applyGrade } from "../src/bridge.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { playwright, playwrightCode } from "./playwright.ts";

const [classroom, lesson] = process.argv.slice(2);
if (!isValidSlug(classroom) || !isValidSlug(lesson))
  throw new Error("Usage: node scripts/check-lesson.ts <classroom> <lesson>");
const source = classroomDir(classroom);
const document = store.readLesson(classroom, lesson);
if (!document) throw new Error("The lesson does not exist.");
const originalRoot = classroomsRoot();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-page-check-"));
const browser = `page-check-${process.pid}`;
let opened = false;
try {
  const copy = path.join(root, classroom);
  fs.mkdirSync(path.join(copy, lesson), { recursive: true });
  fs.copyFileSync(document.htmlPath, path.join(copy, lesson, "lesson.html"));
  for (const file of ["classroom.json", "GLOSSARY.md", "assets", "reference", `${lesson}/media`]) {
    const input = path.join(source, file);
    if (fs.existsSync(input)) fs.cpSync(input, path.join(copy, file), { recursive: true });
  }
  _overrideClassroomsDir(root);
  server.setHooks({
    onAsk: () => {},
    onFollowUp: () => {},
    onReflect: () => {},
    onQuizSubmit: () => {
      throw new Error("Authoring checks must not submit learner work.");
    },
  });
  const base = await server.start(0);
  const url = `${base}/c/${classroom}/${lesson}`;
  const html = fs.readFileSync(path.join(lessonDir(classroom, lesson), "lesson.html"), "utf8");
  const staged = stageLesson(html, new Set());
  await playwright(browser, root, "open", url);
  opened = true;
  const check = `async page => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.reload();
    if(await page.locator('form.cl-quiz').count() === 0) throw new Error('The page has no quiz.');
    await page.waitForFunction(() => [...document.querySelectorAll('form.cl-quiz')].every(f => f.dataset.state));
    const contract = await page.locator('.cl-contract-error').allTextContents();
    if(contract.length) throw new Error(contract.join(' '));
    const controls = [];
    const buttons = page.locator('main[data-cl-content] button').filter({hasNot:page.locator('[type=submit]')});
    for (let pass = 0; pass < 2; pass++) {
      for (const button of await buttons.all()) {
        if(!await button.evaluate(b => !b.closest('form, .cl-card-panel, .cl-header, .cl-teacher-panel'))) continue;
        if(!await button.isVisible() || await button.isDisabled()) continue;
        await button.focus();
        await page.keyboard.press('Enter');
        controls.push((await button.innerText()).trim());
      }
    }
    for(const detail of await page.locator('main[data-cl-content] details').all()) {
      const wasOpen = await detail.evaluate(d => d.open);
      await detail.locator('summary').focus();
      await page.keyboard.press('Enter');
      if(await detail.evaluate(d => d.open) === wasOpen) throw new Error('A details control did not toggle.');
    }
    await page.waitForTimeout(250);
    if(errors.length) throw new Error(errors.join(' '));
    return { quizzes:await page.locator('form.cl-quiz').count(), controls, contractErrors:0, pageErrors:0 };
  }`;
  const initial = await playwrightCode(browser, root, check);
  for (const id of staged.pendingPretests) {
    const submission = store.createSubmission({
      classroom,
      lesson,
      quizId: id,
      quizTitle: "Isolated authoring preview",
      kind: "pretest",
      answers: [{ questionId: "preview", type: "term", value: "preview" }],
    });
    applyGrade(submission, {
      score: 0,
      feedbackMarkdown: "Isolated preview only.",
      questions: [{ questionId: "preview", correct: false, feedback: "Preview only." }],
    });
  }
  const released = await playwrightCode(browser, root, check);
  console.log(
    JSON.stringify({ classroom, lesson, initial, released, learnerStateChanged: false }, null, 2),
  );
} finally {
  try {
    if (opened) await playwright(browser, root, "close");
  } finally {
    await server.close();
    _overrideClassroomsDir(originalRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
