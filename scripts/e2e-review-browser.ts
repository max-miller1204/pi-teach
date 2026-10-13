/** Drive review creation, reload, failure, retry, and continuation from the classroom page. */
import * as fs from "node:fs";
import * as path from "node:path";
import { applyGrade, ClassroomBridge } from "../src/bridge.ts";
import { currentReview, reviewSessions, type ReviewSession } from "../src/review-session.ts";
import { DAY_MS } from "../src/review.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { readTeacherState } from "../src/service-state.ts";
import { TeacherService } from "../src/teacher-service.ts";
import {
  makeFixture,
  reviewDocument,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
} from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyReviewBrowser(artifacts: string | null): Promise<void> {
  for (const host of ["pi", "service"] as const) {
    const fixture = makeFixture();
    seedClassroom(fixture);
    writeGradedAttempt({
      at: Date.now() - 2 * DAY_MS,
      answers: [termAnswer("q1", "owner")],
      correct: { q1: true },
    });
    const evidence = artifacts ? path.join(artifacts, host) : null;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    const session = `pi-teach-review-${host}-${process.pid}`;
    let browserOpen = false,
      runs = 0,
      chatRuns = 0;
    let release: (() => void) | undefined;
    const bridge = new ClassroomBridge({
      sendUserMessage: () => {
        runs++;
      },
    });
    const teacher = new TeacherService(async (_identity, prompt) => {
      runs++;
      if (prompt.includes("The learner replied in the teacher panel")) {
        chatRuns++;
        return {
          calls: [],
          message: "Return when you are ready.",
          learning_record: chatRuns === 1 ? "An unverified record." : "",
          notes_markdown: "",
        };
      }
      const submitted = /submission_id: "([^"]+)"/.exec(prompt);
      if (submitted) {
        const submission = store.findSubmission(submitted[1])!;
        return {
          calls: [
            {
              name: "grade_lesson_quiz",
              arguments_json: JSON.stringify({
                submission_id: submission.id,
                score: 100,
                feedback_markdown: "The new owner releases it.",
                questions: submission.answers.map((a) => ({
                  question_id: a.questionId,
                  correct: true,
                  points_earned: 1,
                  points_possible: 1,
                  feedback: "Correct.",
                })),
              }),
            },
          ],
          message: "Your review is complete.",
          learning_record: "",
          notes_markdown: "",
        };
      }
      if (runs === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("Fixture review provider failure.");
      }
      const document = reviewDocument(currentReview("rust")!.items);
      if (runs === 2)
        document.lesson_html = document.lesson_html.replace("<textarea></textarea>", "");
      return {
        calls: [
          {
            name: "publish_review",
            arguments_json: JSON.stringify(document),
          },
        ],
        message: "Your review is ready.",
        learning_record: "",
        notes_markdown: "",
      };
    });
    if (host === "service") {
      teacher.connect();
      teacher.attach("rust", "codex");
    } else
      server.setHooks({
        onAsk: (a) => bridge.ask(a),
        onFollowUp: (a, f) => bridge.followUp(a, f),
        onQuizSubmit: (s) => bridge.grade(s),
        onReflect: (r) => bridge.reflect(r),
        reviewOwner: "pi",
        onReview: (s) => bridge.review(s),
        onReviewRetry: (s) => bridge.retryReview(s),
      });
    const code = (body: string) =>
      playwrightCode(
        session,
        fixture.root,
        `async page => {
      page.reviewErrors ??= [];
      if (!page.reviewErrorListener) { page.reviewErrorListener = true; page.on('pageerror', error => page.reviewErrors.push(error.message)); }
      ${body}
      if (page.reviewErrors.length) throw new Error(page.reviewErrors.join('; '));
      return {url:page.url(), snapshot:await page.locator('body').ariaSnapshot()};
    }`,
      );
    const shot = (name: string) =>
      evidence
        ? `await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({path:${JSON.stringify(path.join(evidence, `${name}.png`))},fullPage:true});`
        : "";
    let request: ReviewSession | null = null;
    try {
      const base = await server.start(0);
      await playwright(session, fixture.root, "open", `${base}/c/rust`);
      browserOpen = true;
      await code(`
        await page.getByRole('button', {name:'Start review',exact:true}).waitFor();
        await page.waitForFunction(() => !document.querySelector('[data-cl-review-start]').disabled);
        ${shot("start-review")}
        const response = page.waitForResponse(r => r.url().endsWith('/api/review') && r.request().method() === 'POST');
        await page.getByRole('button', {name:'Start review',exact:true}).click();
        if ((await response).status() !== 202) throw new Error('Start review was refused.');
        await page.getByRole('button', {name:'Creating review…',exact:true}).waitFor();
        await page.reload();
        await page.getByRole('button', {name:'Creating review…',exact:true}).waitFor();
        if (!await page.getByRole('button', {name:'Creating review…',exact:true}).isDisabled()) throw new Error('Creation allowed duplicate clicks.');
        ${shot("creating-after-reload")}
      `);
      request = currentReview("rust");
      if (
        !request ||
        request.status !== "running" ||
        runs !== 1 ||
        reviewSessions("rust").length !== 1
      )
        throw new Error("Reload duplicated review work.");
      if ((await fetch(`${base}/c/rust/${request.lesson}`)).status !== 404)
        throw new Error("An unfinished review was served.");
      if (host === "service") {
        bridge.restoreReviews();
        if (currentReview("rust")!.status !== "running")
          throw new Error("Pi startup changed service work.");
        release!();
        await teacher.idle();
      } else
        bridge.onAgentEnd([
          { role: "assistant", content: [{ type: "text", text: "Review is ready." }] },
        ]);
      await code(`
        await page.getByRole('button', {name:'Retry review',exact:true}).waitFor();
        if (!(await page.locator('[data-cl-review-status]').innerText()).includes(${JSON.stringify(host === "service" ? "Fixture review provider failure" : "Pi review creation failed")})) throw new Error('The creation error is missing.');
        ${shot("failed-review")}
        await page.reload();
        await page.getByRole('button', {name:'Retry review',exact:true}).waitFor();
      `);
      if (runs !== 1) throw new Error("Reload silently retried a failed review.");
      await code(`
        const response = page.waitForResponse(r => r.url().endsWith('/api/review/retry'));
        await page.getByRole('button', {name:'Retry review',exact:true}).click();
        if ((await response).status() !== 202) throw new Error('Retry review was refused.');
      `);
      if (host === "service") await teacher.idle();
      else {
        const doc = reviewDocument(request.items);
        fixture.write(
          `rust/${request.lesson}/lesson.html`,
          doc.lesson_html.replace("<textarea></textarea>", ""),
        );
        fixture.write(`rust/${request.lesson}/quiz/key.json`, doc.rubric_json);
        fixture.write(`rust/${request.lesson}/quiz/plan.json`, doc.teaching_plan_json);
        bridge.onAgentEnd([]);
      }
      await code(`
        await page.getByRole('button', {name:'Retry review',exact:true}).waitFor();
        if (!(await page.locator('[data-cl-review-status]').innerText()).includes('needs exactly 1 textarea')) throw new Error('The invalid control error is missing.');
        ${shot("invalid-review-controls")}
        const response = page.waitForResponse(r => r.url().endsWith('/api/review/retry'));
        await page.getByRole('button', {name:'Retry review',exact:true}).click();
        if ((await response).status() !== 202) throw new Error('Invalid review retry was refused.');
      `);
      if (host === "service") await teacher.idle();
      else {
        const doc = reviewDocument(request.items);
        fixture.write(`rust/${request.lesson}/lesson.html`, doc.lesson_html);
        bridge.onAgentEnd([]);
      }
      await code(`
        await page.waitForURL(${JSON.stringify(`${base}/c/rust/${request.lesson}`)});
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
        if (await page.locator('.cl-quiz-error').count()) throw new Error('Review controls have contract errors.');
        await page.locator('form.cl-quiz textarea').fill('The new owner releases it.');
        ${shot("ready-review")}
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button', {name:'Continue review',exact:true}).waitFor();
        await page.getByRole('button', {name:'Continue review',exact:true}).click();
        await page.waitForURL(${JSON.stringify(`${base}/c/rust/${request.lesson}`)});
        await page.waitForFunction(() => document.querySelector('form.cl-quiz textarea')?.value === 'The new owner releases it.');
        await page.setViewportSize({width:375,height:812});
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button', {name:'Continue review',exact:true}).waitFor();
        await page.getByRole('button', {name:'Toggle colour theme',exact:true}).click();
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Review controls overflow on mobile.');
        ${shot("mobile-continue-review")}
      `);
      if (
        Number(runs) !== 3 ||
        reviewSessions("rust").length !== 1 ||
        currentReview("rust")!.id !== request.id
      )
        throw new Error("Retry or continuation duplicated review work.");
      if (store.listSubmissions("rust", request.lesson).length)
        throw new Error("Opening a review submitted it.");
      for (const privateFile of ["key.json", "plan.json"])
        if ((await fetch(`${base}/c/rust/${request.lesson}/quiz/${privateFile}`)).status !== 404)
          throw new Error("Private review file is public.");
      await code(`
        await page.getByRole('button', {name:'Continue review',exact:true}).click();
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'fresh');
        await page.locator('[data-cl-assistance]').selectOption('none');
        const response = page.waitForResponse(r => r.url().endsWith('/api/quiz/submit'));
        await page.getByRole('button', {name:'Submit for grading',exact:true}).click();
        if ((await response).status() !== 201) throw new Error('The generated review could not be submitted.');
      `);
      if (host === "service") await teacher.idle();
      else {
        const submission = store.listSubmissions("rust", request.lesson)[0];
        applyGrade(submission, {
          score: 100,
          feedbackMarkdown: "The new owner releases it.",
          questions: submission.answers.map((a) => ({
            questionId: a.questionId,
            correct: true,
            pointsEarned: 1,
            pointsPossible: 1,
            feedback: "Correct.",
          })),
        });
        bridge.onAgentEnd([
          { role: "assistant", content: [{ type: "text", text: "Your review is complete." }] },
        ]);
      }
      await code(`
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
        await page.reload();
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
        if (!await page.getByRole('button', {name:'Graded',exact:true}).isDisabled()) throw new Error('The review is unlocked.');
        ${shot("graded-review")}
        await page.goto(${JSON.stringify(`${base}/c/rust`)});
        await page.getByRole('button', {name:'Start review',exact:true}).waitFor();
        if (!await page.getByRole('button', {name:'Start review',exact:true}).isDisabled()) throw new Error('A fresh review is offered when none is due.');
      `);
      const grade = store.latestGrades("rust", request.lesson)[0];
      if (!grade || grade.score !== 100 || store.reviewItems("rust")[0].attempts !== 2)
        throw new Error("The review grade did not update its original item.");
      if (host === "service") {
        await code(`
          await page.goto(${JSON.stringify(`${base}/c/rust/${request.lesson}`)});
          await page.getByRole('textbox', {name:'Reply to your teacher',exact:true}).fill('I will return to this later.');
          await page.getByRole('button', {name:'Send reply',exact:true}).click();
          await page.getByRole('button', {name:'Retry request',exact:true}).waitFor();
          if (!(await page.locator('.cl-teacher-requests').innerText()).includes('A learning record requires verified retrieval evidence')) throw new Error('Invalid panel evidence did not fail.');
          ${shot("invalid-panel-plan")}
          const response = page.waitForResponse(r => r.url().endsWith('/api/teacher/retry'));
          await page.getByRole('button', {name:'Retry request',exact:true}).click();
          if (!(await response).ok()) throw new Error('Panel retry was refused.');
          await page.waitForFunction(() => !document.querySelector('.cl-teacher-requests button'));
          ${shot("retried-panel-plan")}
        `);
        await teacher.idle();
        if (chatRuns !== 2 || readTeacherState("rust")!.requests.some((r) => r.status !== "done"))
          throw new Error("Panel retry did not request a corrected plan.");
        if (
          store.listLearningRecords("rust").length ||
          store.latestGrades("rust", request.lesson).length !== 1
        )
          throw new Error("Panel retry wrote unverified evidence or graded twice.");
      }
      if (evidence)
        fs.writeFileSync(
          path.join(evidence, "result.json"),
          JSON.stringify(
            {
              host,
              runs,
              review: currentReview("rust"),
              teacher: host === "service" ? readTeacherState("rust") : null,
              drafts: store.readDrafts("rust", request.lesson),
              passed: [
                "start",
                "reload",
                "failure",
                "explicit retry",
                "invalid control rejection",
                "host ownership",
                "automatic open",
                "resume draft",
                "mobile",
                "private files",
                "submit and grade",
                "schedule original item",
                ...(host === "service" ? ["regenerate rejected panel plan"] : []),
              ],
            },
            null,
            2,
          ),
        );
      console.log(`PASS: ${host} browser review start, reload, retry, and continuation`);
    } catch (err) {
      if (evidence)
        fs.writeFileSync(
          path.join(evidence, "failure.json"),
          JSON.stringify(
            {
              error: String(err),
              review: currentReview("rust"),
              teacher: readTeacherState("rust"),
            },
            null,
            2,
          ),
        );
      throw err;
    } finally {
      release?.();
      await teacher.stop();
      bridge.reset();
      if (browserOpen) await playwright(session, fixture.root, "close");
      await server.close();
      fixture.cleanup();
    }
  }
}
