# Quizzes and review

Learners submit typed quiz answers. Grades lock the saved attempt. Stored grades and linked retrieval evidence determine the review schedule.

## Sub-features

- `quiz.controls`: Exercise all nine answer types.
- `quiz.attempt`: Save answers and receive a grade.
- `quiz.lock`: Keep a graded attempt locked after reload.
- `quiz.review`: Derive review state from stored results.
- `quiz.authoring`: Use quizzes produced by a real authoring host.
- `quiz.drafts`: Keep unsent answers and an unsent question through a reload.

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
- **Drafts:** The same harness fills every answer type, waits for the saved draft, and reloads before it submits. It requires each answer back, a `fresh` form, and no draft after the submission. It also reloads an open question composer. It requires a closed composer and the `Open your unsent question` marker, then clicks the marker and requires the text and highlight back. Inspect `restored-draft.png`, `restored-question-marker.png`, and `restored-question-draft.png`. The same run includes the reading feature's diagram drive. To test that a reconnect keeps unsaved text, restart the service with `npm run service -- stop` and `start` while the page stays open. Playwright offline mode does not close an open event stream to `127.0.0.1`, so it causes no reconnect.
- **Selectors:** Use `form[data-quiz-id="check-1"]`, `[data-question-id]`, `[data-segment]`, and the exact button name `Submit for grading`. The maintained drive is `test/browser.playwright.js`.
- **Real grading:** Use the teacher feature's Claude and Codex recipes. They submit an incorrect choice through the UI. Require a saved wrong grade, locked page after reload, and unchanged grade after a panel reply.
- **Authoring:** Run `node scripts/e2e-authoring.ts claude "$PI_VERIFY_RUN/evidence/authoring-claude"` or `node scripts/e2e-authoring.ts codex "$PI_VERIFY_RUN/evidence/authoring-codex"`. Capture each command's output and exit code. Inspect the generated HTML, private key, report JSON, `<host>-authoring.jsonl`, `<host>-service.log`, `classroom/.teacher.json`, and submitted/graded screenshots. The harness saves each lesson and key before the browser drive, so a failed run keeps them. The report counts each lesson's diagrams. Check authentication first.

## Gotchas

The broad browser regression uses a temporary grading control server. It proves UI controls and production grade application. It does not prove model judgment. Do not use this control endpoint as learner proof. The host harness proves one choice question. Neither path alone proves every review or retrieval entry point. No harness clicks a self-explanation `Save` button or reloads a self-explanation draft. Report them as unverified. Generated authoring output varies. On 2026-10-06, one of five original Codex authoring runs passed. The others failed with a dedicated teacher timeout, a dedicated teacher JSON parse error on `main`, or a browser wait for a submit response. A restored locate draft could make the old drive clear the selected answer and send no POST. The fixed drive keeps that answer selected. The Codex teacher reads complete JSON objects across chunks and fails after 180 seconds without progress from its active turn. A productive turn can run longer. For a submit timeout, check the recorded requests and form status first. For a teacher failure, inspect the saved request, phase, and last progress. Save the authoring output, teacher state, and service log of each run. Report each failure with its run. Do not report only a passing rerun. Keep private fixture keys inside local evidence. Do not publish them or expose real rubrics.
