/**
 * Check, in a real browser, that a learner never needs the terminal in Pi: they can ask
 * about a quiz question in place, and the teacher's follow-up after grading arrives in
 * the lesson's teacher panel, where they answer it.
 *
 * The Pi session is the real bridge with a recording sender. This script plays the
 * agent: it reads each prompt and ends each run with the text a model would write.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { applyGrade, ClassroomBridge } from "../src/bridge.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { makeFixture, lessonHtml, seedClassroom } from "../test/helpers.ts";
import { highlightText } from "./browser-actions.ts";
import { playwright, playwrightCode } from "./playwright.ts";

const run = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];

export async function verifyPiPanelBrowser(artifacts: string | null): Promise<void> {
  const fixture = makeFixture();
  seedClassroom(fixture);
  fixture.write(
    "rust/001-ownership/lesson.html",
    lessonHtml(
      "Pi panel",
      `
    <p>Every value has one owner.</p>
    <div style="height: 2400px"></div>
    <form class="cl-quiz" data-quiz-id="check" data-title="Check">
      <ol class="cl-questions">
        <li class="cl-q" data-question-id="q1" data-type="choice">
          <p class="cl-q-prompt">Which binding frees the heap buffer?</p>
          <label><input type="radio" name="q1" value="a">The original binding</label>
          <label><input type="radio" name="q1" value="b">The binding it moved into</label>
        </li>
        <li class="cl-q" data-question-id="q2" data-type="term">
          <p class="cl-q-prompt">Name the trait that runs cleanup.</p><input type="text">
        </li>
      </ol>
    </form>
    <p>Prose after the quiz.</p>`,
    ),
  );
  const sent: string[] = [];
  const bridge = new ClassroomBridge({ sendUserMessage: (text) => sent.push(text) });
  server.setHooks({
    onAsk: (annotation) => bridge.ask(annotation),
    onFollowUp: (annotation, followUp) => bridge.followUp(annotation, followUp),
    onQuizSubmit: (submission) => bridge.grade(submission),
    onReflect: (reflection) => bridge.reflect(reflection),
    teacherState: (classroom, lesson) => bridge.panelState(classroom, lesson),
    onTeacherChat: (classroom, lesson, text, id) => bridge.chat(classroom, lesson, text, id),
    onTeacherRetry: (classroom, id) => bridge.retry(classroom, id),
  });
  const session = `pi-teach-pi-panel-${process.pid}`;
  const evidence: Record<string, unknown> = {};
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  let browserOpen = false;
  try {
    const base = await server.start();
    await playwright(session, fixture.root, "open", `${base}/c/rust/001-ownership`);
    browserOpen = true;
    const code = (body: string) =>
      playwrightCode<Record<string, unknown>>(session, fixture.root, `async page => {${body}}`);

    // 1. Highlight an option's text and ask about it. The option stays unchosen.
    await code(`
      await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
      return {};`);
    evidence.ask = await code(`
      ${highlightSource}
      await highlightText(page, 'form.cl-quiz', 'moved into');
      if (await page.locator('input[value="b"]').isChecked()) throw new Error('Highlighting chose the option.');
      await page.locator('.cl-ask-pill').click();
      await page.locator('[data-cl-question]').fill('What does moved mean here?');
      const asked = page.waitForResponse(r => r.url().endsWith('/api/ask'));
      await page.getByRole('button', {name:'Ask your teacher', exact:true}).click();
      const response = await asked;
      if (response.status() !== 201) throw new Error(await response.text());
      const card = page.locator('.cl-card-inline');
      await card.waitFor();
      const placed = await card.evaluate(el => ({
        afterQuestion: el.previousElementSibling?.dataset.questionId ?? null,
        inQuestionList: el.parentElement.classList.contains('cl-questions'),
      }));
      if (placed.afterQuestion !== 'q1' || !placed.inQuestionList) throw new Error('The card is not after its question: ' + JSON.stringify(placed));
      return { quiz: (await response.json()).quiz, placed };`);
    const askPromptText = sent.at(-1) ?? "";
    assert(
      askPromptText.includes("question `q1` of quiz `check`") &&
        askPromptText.includes("Do not give the answer"),
      "The ask prompt does not guard the ungraded quiz question.",
    );
    bridge.onAgentEnd(run("Ownership passed to the new binding."));

    // 2. A follow-up inside the quiz must not submit the quiz or save a quiz draft.
    evidence.followUp = await code(`
      await page.waitForFunction(() => document.querySelector('.cl-card-answer')?.textContent.includes('Ownership passed'));
      let quizPosts = 0;
      page.on('request', r => { if (r.url().endsWith('/api/quiz/submit')) quizPosts++; });
      await page.locator('[data-cl-followup]').fill('So the old binding is unusable?');
      const followed = page.waitForResponse(r => r.url().includes('/follow-up'));
      await page.locator('[data-cl-followup-form]').getByRole('button', {name:'Ask', exact:true}).click();
      if ((await followed).status() !== 201) throw new Error('The follow-up was refused.');
      await page.waitForTimeout(600);
      const state = await page.locator('form.cl-quiz').getAttribute('data-state');
      if (quizPosts !== 0 || state !== 'fresh') throw new Error('The card follow-up submitted the quiz.');
      return { quizPosts, state };`);
    assert(
      !Object.hasOwn(store.readDrafts("rust", "001-ownership"), "quiz:check"),
      "Typing in the card saved a quiz draft.",
    );
    bridge.onAgentEnd(run("Yes. After a move, the old binding cannot be used."));

    // 3. Submit. The panel moves under the quiz and says the teacher is grading.
    evidence.submit = await code(`
      await page.waitForFunction(() => [...document.querySelectorAll('.cl-card-answer')].some(a => a.textContent.includes('cannot be used')));
      await page.locator('input[value="b"]').check();
      await page.locator('[data-question-id="q2"] input').fill('Clone');
      await page.getByRole('button', {name:'Submit for grading', exact:true}).click();
      await page.waitForFunction(() => document.querySelector('form.cl-quiz').nextElementSibling?.classList.contains('cl-teacher'));
      await page.waitForFunction(() => document.querySelector('.cl-teacher-requests')?.textContent.includes('grading your quiz'));
      await page.evaluate(() => window.scrollTo(0, 0));
      return {};`);
    const [submission] = store.listSubmissions("rust", "001-ownership");
    const choice = submission.answers.find((a) => a.questionId === "q1");
    assert(
      choice?.label === "The binding it moved into",
      `A card marker leaked into the answer: ${JSON.stringify(choice)}`,
    );
    assert(sent.at(-1)?.includes("teacher panel"), "The grade prompt does not name the panel.");
    bridge.onAgentEnd(run("I will grade this next."));
    evidence.retry = await code(`
      await page.waitForFunction(() => document.querySelector('.cl-teacher-requests')?.textContent.includes('finished without grading'));
      const state = await page.locator('form.cl-quiz').getAttribute('data-state');
      if (state !== 'submitted') throw new Error('Prose changed the quiz state.');
      const retried = page.waitForResponse(r => r.url().endsWith('/api/teacher/retry'));
      await page.getByRole('button', {name:'Retry request', exact:true}).click();
      if (!(await retried).ok()) throw new Error('The explicit retry failed.');
      await page.waitForFunction(() => document.querySelector('.cl-teacher-requests')?.textContent.includes('grading your quiz'));
      await page.evaluate(() => window.scrollTo(0, 0));
      return {ungradedState: state, explicitRetry: true};`);
    assert(store.listGrades("rust", "001-ownership").length === 0, "Prose wrote a grade.");
    applyGrade(submission, {
      score: 50,
      feedbackMarkdown: "One of two.",
      questions: [
        { questionId: "q1", correct: true, feedback: "Right." },
        { questionId: "q2", correct: false, feedback: "Clone copies. It does not clean up." },
      ],
    });
    bridge.onAgentEnd(
      run("Clone copies a value. **Which trait** runs when a value goes out of scope?"),
    );

    // 4. The question arrives in the panel. The learner answers there.
    evidence.reply = await code(`
      const notice = page.locator('.cl-teacher-notice');
      await notice.waitFor({state:'visible'});
      await notice.click();
      await page.waitForFunction(() => document.querySelector('.cl-teacher-message[data-role="teacher"] strong')?.textContent === 'Which trait');
      await page.getByRole('textbox', {name:'Reply to your teacher', exact:true}).fill('Drop');
      await page.getByRole('button', {name:'Send reply', exact:true}).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.cl-teacher-message[data-role="learner"]')].some(m => m.textContent.includes('Drop')));
      await page.waitForFunction(() => document.querySelector('.cl-teacher-requests')?.textContent.includes('replying'));
      return { noticeShown: true };`);
    const replyPrompt = sent.at(-1) ?? "";
    assert(
      replyPrompt.includes("Which trait") &&
        replyPrompt.includes("> Drop") &&
        replyPrompt.includes("record_retrieval_check"),
      "The panel reply prompt lost its context.",
    );
    bridge.onAgentEnd(run("Right. `Drop` runs the cleanup."));

    // 5. Everything survives a reload, in place.
    evidence.reload = await code(`
      await page.waitForFunction(() => document.querySelectorAll('.cl-teacher-message').length === 3);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('.cl-teacher-message').length === 3);
      const result = await page.evaluate(() => ({
        panelAfterQuiz: document.querySelector('form.cl-quiz').nextElementSibling?.classList.contains('cl-teacher'),
        cardAfterQuestion: document.querySelector('.cl-card-inline')?.previousElementSibling?.dataset.questionId,
        highlightInLabel: Boolean(document.querySelector('label mark.cl-hl')),
        state: document.querySelector('form.cl-quiz').dataset.state,
      }));
      if (!result.panelAfterQuiz || result.cardAfterQuestion !== 'q1' || !result.highlightInLabel || result.state !== 'graded') throw new Error('Reload lost the panel or the card: ' + JSON.stringify(result));
      ${artifacts ? `await page.setViewportSize({ width: 1000, height: 1500 }); await page.locator('form.cl-quiz').evaluate(el => el.scrollIntoView()); await page.screenshot({ path: ${JSON.stringify(path.join(artifacts, "pi-panel.png"))} });` : ""}
      return result;`);
    console.log("PASS: quiz highlight and Pi teacher panel");
  } catch (error) {
    evidence.failure = String(error);
    evidence.sent = sent;
    throw error;
  } finally {
    if (artifacts) {
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, "pi-panel.json"), JSON.stringify(evidence, null, 2));
    }
    if (browserOpen) await playwright(session, fixture.root, "close");
    await server.close();
    fixture.cleanup();
  }
}

/** `highlightText`, as source for a run-code body. */
const highlightSource = `const highlightText = ${highlightText.toString()};`;
