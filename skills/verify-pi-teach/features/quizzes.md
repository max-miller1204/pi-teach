# Quizzes and review

Learners submit typed quiz answers. Grades lock the saved attempt. Stored grades and linked retrieval evidence determine the review schedule.

## Sub-features

- `quiz.controls`: Exercise all nine answer types.
- `quiz.attempt`: Save answers and receive a grade.
- `quiz.lock`: Keep a graded attempt locked after reload.
- `quiz.review`: Derive review state from stored results.
- `quiz.authoring`: Use quizzes produced by a real authoring host.
- `quiz.drafts`: Keep unsent answers and an unsent question through a reload.
- `quiz.reflect`: Save a self-explanation and restore its unsent draft.
- `quiz.reconnect`: Keep unsaved text through a real service restart.

## How to get to it (user POV)

- Open a lesson and fill its `form.cl-quiz` controls.
- Click `Submit for grading`.
- Reload a graded quiz. It stays locked. The page has no next-attempt action.
- Open a review lesson with `data-review-of` questions.
- Reply to a teacher's retrieval question in the panel.
- Save a lesson's self-explanation form.

## Driving it with Playwright CLI and host harnesses

Preconditions: Require the browser CLI and repository dependencies. Each harness creates and removes its own fixture.

- **Controls:** Run `node scripts/e2e-browser.ts "$PI_VERIFY_RUN/evidence/quizzes" > "$PI_VERIFY_RUN/evidence/quizzes.log" 2>&1`. Immediately run `printf '%s\n' "$?" > "$PI_VERIFY_RUN/evidence/quizzes.exit"`. Require exit 0. Inspect the screenshots and log. The harness checks stored submissions, grades, and review values before it removes the fixture.
- **Drafts:** The same harness fills every answer type, waits for the saved draft, and reloads before it submits. It requires each answer back, a `fresh` form, and no draft after the submission. It also reloads an open question composer. It requires a closed composer and the `Open your unsent question` marker, then clicks the marker and requires the text and highlight back. Inspect `restored-draft.png`, `restored-question-marker.png`, and `restored-question-draft.png`. The same run includes the reading feature's diagram drive. Inspect `disk-draft-history.json` for drafts read from disk during the drive.
- **Self-explanation:** The same wait-mode harness fills `form[data-reflect-id="ownership"] textarea`. It waits for the draft, reloads, and requires the text back. It clicks the exact button `Save`, requires HTTP 201, then reloads the saved text. Require one saved reflection and no reflection draft on disk. Inspect `restored-reflection-draft.png`, `saved-reflection.png`, `disk-draft-history.json`, and `stored-learner-paths.json`.
- **Reconnect:** The same command runs a separate persistent-service fixture with a mock Codex executable. It holds four draft writes at the network boundary. It stops the owned service through its control socket and starts it at the same port while the page stays open. Require a new PID, a new `/api/state` response with old disk values, and unchanged unsaved quiz, reflection, follow-up, and teacher reply text. Release the writes and require all four new values on disk. Inspect `service/service-before.json`, `service/service-after.json`, `service/before-reconnect.json`, `service/reconnected-unsaved-text.png`, and `service/after-reconnect.json`. Playwright offline mode does not close the loopback event stream. Do not use it as reconnect proof.
- **Selectors:** Use `form[data-quiz-id="check-1"]`, `[data-question-id]`, `[data-segment]`, and the exact button name `Submit for grading`. The maintained drive is `test/browser.playwright.js`.
- **Real grading:** Use the teacher feature's Claude and Codex recipes. They submit an incorrect choice through the UI. Require a saved wrong grade, locked page after reload, and unchanged grade after a panel reply.
- **Authoring:** Run `node scripts/e2e-authoring.ts claude "$PI_VERIFY_RUN/evidence/authoring-claude"` or `node scripts/e2e-authoring.ts codex "$PI_VERIFY_RUN/evidence/authoring-codex"`. Capture each command's output and exit code. Inspect the generated HTML, private key, report JSON, `<host>-service.log`, and submitted/graded screenshots. The harness saves each lesson and key before the browser drive, so a failed run keeps them. The report counts each lesson's diagrams. Check authentication first.

## Gotchas

The broad browser regression uses a temporary grading control server. It proves UI controls and production grade application. It does not prove model judgment. Do not use this control endpoint as learner proof. The host harness proves one choice question. Neither path alone proves every review or retrieval entry point. The self-explanation and reconnect recipes need no real model calls. Generated authoring output varies. The Codex authoring run is unstable after the lessons are written. On 2026-10-06, one of five runs passed. The others failed with a dedicated teacher timeout after 180 seconds, a dedicated teacher JSON parse error on `main`, or a quiz submission that got no response within 30 seconds. Save the service log of each run. Report each failure with its run. Do not report only a passing rerun. Keep private fixture keys inside local evidence. Do not publish them or expose real rubrics.
