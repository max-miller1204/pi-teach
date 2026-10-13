/** Check explicit chat handoffs in isolated, graded historical review fixtures. */
import * as fs from "node:fs";
import * as path from "node:path";
import { ClassroomBridge, applyGrade } from "../src/bridge.ts";
import { TeacherService } from "../src/teacher-service.ts";
import { LearnerInbox, McpSession } from "../src/mcp.ts";
import { resumeTeacherTool, piResumes } from "../src/teacher-resume.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { makeFixture, seedClassroom, lessonHtml, termAnswer } from "../test/helpers.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyResumeBrowser(artifacts: string | null): Promise<void> {
  for (const backend of ["pi", "claude", "codex"] as const) {
    for (const scenario of ["empty", "saved-reply"] as const) {
      const fixture = makeFixture();
      seedClassroom(fixture);
      const location = { classroom: "rust", lesson: "001-ownership" };
      fixture.write(
        "rust/001-ownership/lesson.html",
        lessonHtml(
          "Historical review",
          `<div style="height: 2000px"></div><form class="cl-quiz" data-quiz-id="review" data-kind="review"><ol class="cl-questions"><li class="cl-q" data-question-id="q1" data-type="term" data-review-of="001-ownership/check/q1"><p class="cl-q-prompt">Who owns a moved buffer?</p><input type="text"></li></ol></form>`,
        ),
      );
      const submission = store.createSubmission({
        ...location,
        quizId: "review",
        quizTitle: "Historical review",
        kind: "review",
        answers: [termAnswer("q1", "old binding", { reviewOf: "001-ownership/check/q1" })],
      });
      applyGrade(submission, {
        score: 0,
        feedbackMarkdown: "The new binding owns it.",
        questions: [{ questionId: "q1", correct: false, feedback: "Check the move." }],
      });
      const before = JSON.stringify({
        submissions: store.listSubmissions("rust", location.lesson),
        grades: store.listGrades("rust", location.lesson),
        checks: store.listRetrievalChecks("rust"),
        records: store.readLearningRecords("rust"),
      });
      if (scenario === "saved-reply") {
        const messages = [
          {
            id: "historical-question",
            lesson: location.lesson,
            role: "teacher" as const,
            text: "Which binding owns the buffer after a move?",
            at: 1,
          },
          {
            id: "chat:saved-reply",
            lesson: location.lesson,
            role: "learner" as const,
            text: "The new binding",
            at: Date.now() + 60_000,
          },
        ];
        if (backend === "pi") for (const m of messages) store.addPanelMessage("rust", m);
        else
          saveTeacherState("rust", {
            version: 1,
            identity: { backend, sessionId: "fixture-existing" },
            requests: [],
            messages,
          });
      }
      let runs = 0;
      const prompts: string[] = [];
      const bridge = new ClassroomBridge({
        sendUserMessage: (text) => {
          prompts.push(text);
          runs++;
        },
      });
      const teacher = new TeacherService(async (_identity, prompt) => {
        prompts.push(prompt);
        runs++;
        return {
          calls: [],
          message:
            scenario === "saved-reply"
              ? "Right. The new binding owns it."
              : "Which binding owns the buffer after a move?",
          learning_record: "",
          notes_markdown: "",
        };
      });
      const tool = resumeTeacherTool((input) =>
        backend === "pi" ? bridge.resume(input) : teacher.resume(input),
      );
      if (backend === "pi")
        server.setHooks({
          onAsk: (a) => bridge.ask(a),
          onFollowUp: (a, f) => bridge.followUp(a, f),
          onQuizSubmit: (s) => bridge.grade(s),
          onReflect: (r) => bridge.reflect(r),
          teacherState: (c, l) => bridge.panelState(c, l),
          onTeacherChat: (c, l, text, id) => bridge.chat(c, l, text, id),
          onTeacherRetry: (c, id) => bridge.retry(c, id),
        });
      else {
        teacher.connect();
        teacher.attach("rust", backend);
      }
      const session = `pi-teach-resume-${backend}-${scenario}-${process.pid}`;
      let browserOpen = false;
      try {
        const base = await server.start();
        const input = { ...location, submission_id: submission.id };
        let url: string;
        if (backend === "pi") {
          bridge.setIdleProbe(() => false);
          bridge.noteForeignTurn();
          url = (await tool.execute(input)).details.url as string;
          bridge.onAgentEnd([{ role: "assistant", content: "Continue on the lesson page." }]);
          if (
            store.listPanelMessages("rust", location.lesson).length !==
            (scenario === "saved-reply" ? 2 : 0)
          )
            throw new Error("Initiating chat leaked into the panel.");
        } else {
          const mcp = new McpSession(new LearnerInbox(), { open: async () => base, tools: [tool] });
          const response = await mcp.handle({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "resume_lesson_teacher", arguments: input },
          });
          if (!response || "error" in response || (response.result as any).isError)
            throw new Error(JSON.stringify(response));
          url = `${base}/c/rust/001-ownership#cl-teacher`;
        }
        await playwright(session, fixture.root, "open", url);
        browserOpen = true;
        if (backend === "pi")
          bridge.onAgentEnd([
            {
              role: "assistant",
              content:
                scenario === "saved-reply"
                  ? "Right. The new binding owns it."
                  : "Which binding owns the buffer after a move?",
            },
          ]);
        else await teacher.idle();
        await tool.execute(input);
        if (runs !== 1) throw new Error("Resume repeated the question.");
        if (scenario === "empty") {
          await playwrightCode(
            session,
            fixture.root,
            `async page => {
        await page.waitForFunction(() => document.querySelector('form.cl-quiz')?.dataset.state === 'graded');
        await page.waitForFunction(() => document.querySelector('.cl-teacher-messages')?.textContent.includes('Which binding'));
        if (!await page.locator('#cl-teacher').evaluate(el => el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > 0)) throw new Error('The panel link did not bring the teacher into view.');
        if (!await page.getByRole('button', {name:'Graded',exact:true}).isDisabled()) throw new Error('Historical quiz unlocked.');
        if (!await page.locator('form.cl-quiz').evaluate(el => el.nextElementSibling?.id === 'cl-teacher')) throw new Error('Panel is not after the graded review.');
        await page.getByRole('textbox', {name:'Reply to your teacher',exact:true}).fill('The new binding');
        const response = page.waitForResponse(r => r.url().endsWith('/api/teacher/chat'));
        await page.getByRole('button', {name:'Send reply',exact:true}).click();
        if (!(await response).ok()) throw new Error('Reply failed.');
        return true;
      }`,
          );
          if (backend === "pi")
            bridge.onAgentEnd([{ role: "assistant", content: "Right. The new binding owns it." }]);
          else await teacher.idle();
        } else if (!prompts[0]?.includes("The new binding"))
          throw new Error("The recovered prompt lost the actual learner reply.");
        await playwrightCode(
          session,
          fixture.root,
          `async page => {
        await page.waitForFunction(() => document.querySelectorAll('.cl-teacher-message').length === 3);
        await page.reload();
        await page.waitForFunction(() => document.querySelectorAll('.cl-teacher-message').length === 3);
        if (!await page.locator('.cl-teacher-message').last().evaluate(el => el.dataset.role === 'teacher')) throw new Error('The recovered answer appeared before the saved reply.');
        ${artifacts ? `await page.locator('.cl-teacher').scrollIntoViewIfNeeded(); await page.screenshot({path:${JSON.stringify(path.join(artifacts, `${backend}-${scenario}-resume.png`))}});` : ""}
        return true;
      }`,
        );
        const after = JSON.stringify({
          submissions: store.listSubmissions("rust", location.lesson),
          grades: store.listGrades("rust", location.lesson),
          checks: store.listRetrievalChecks("rust"),
          records: store.readLearningRecords("rust"),
        });
        if (before !== after)
          throw new Error("Resume or reply changed saved assessments or evidence.");
        if (artifacts)
          fs.writeFileSync(
            path.join(artifacts, `${backend}-${scenario}-resume.json`),
            JSON.stringify(
              {
                scenario,
                runs,
                preserved: before === after,
                panel:
                  backend === "pi"
                    ? bridge.panelState("rust", location.lesson)
                    : teacher.publicState("rust", location.lesson),
                requests: backend === "pi" ? piResumes("rust") : readTeacherState("rust")?.requests,
              },
              null,
              2,
            ),
          );
        console.log(
          `PASS: ${backend} ${scenario} historical review resume, panel reply, reload, and preserved grades`,
        );
      } finally {
        await teacher.stop();
        bridge.reset();
        if (browserOpen) await playwright(session, fixture.root, "close");
        await server.close();
        fixture.cleanup();
      }
    }
  }
}
