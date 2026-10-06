# Passage questions and teacher replies

A dedicated Claude or Codex teacher answers saved learner requests after the initiating host exits. Learners can reply in the lesson's teacher panel.

## Sub-features

- `teacher.idle`: Answer a request after host exit.
- `teacher.card`: Render the saved answer on its card.
- `teacher.reply`: Accept a panel reply and resume the teacher session.
- `teacher.failure`: Show an error and accept an explicit retry action.
- `teacher.composer`: Select text and submit through the highlight composer.
- `teacher.drafts`: Restore unsent card follow-ups and teacher replies.

## How to get to it (user POV)

- Highlight a passage, use the ask pill, then send a question.
- Send a follow-up from a saved card.
- Fill `Reply to your teacher`, then click `Send reply`.
- Click the retry button beside a failed request.
- Submit a question through the public `/api/ask` API.
- Pi users ask through the same lesson UI with a live direct bridge.

## Driving it with Playwright CLI and host harnesses

Preconditions: Run the chosen host's version and login checks from the skill. Authorize real model calls. The harness creates its own fixture and port.

- **Claude:** Run `node scripts/e2e.ts claude "$PI_VERIFY_RUN/evidence/teacher-claude" > "$PI_VERIFY_RUN/evidence/teacher-claude.log" 2>&1`. Record the exit code with `printf '%s\n' "$?" > "$PI_VERIFY_RUN/evidence/teacher-claude.exit"` immediately afterward.
- **Codex:** Run `node scripts/e2e.ts codex "$PI_VERIFY_RUN/evidence/teacher-codex" > "$PI_VERIFY_RUN/evidence/teacher-codex.log" 2>&1`. Record the exit code with `printf '%s\n' "$?" > "$PI_VERIFY_RUN/evidence/teacher-codex.exit"` immediately afterward.
- **Observe:** Require the host-exit, answered-card, panel-reply, and session-resume assertions to pass. Inspect the teacher-panel PNG and logs. The harness reads `/api/state` and checks the saved answer and session identity.
- **Pi:** Run `npm run e2e:pi -- "$PI_VERIFY_RUN/evidence/pi" > "$PI_VERIFY_RUN/evidence/pi.log" 2>&1`. Immediately run `printf '%s\n' "$?" > "$PI_VERIFY_RUN/evidence/pi.exit"`. The harness sets `PI_CLASSROOM_CONFIG` to a file in its fixture. A port in the learner's own `~/.pi/agent/classroom.json` cannot block it.
- **Composer:** Both host harnesses select `one owner` with mouse actions. They click `.cl-ask-pill`, fill `[data-cl-question]`, and click `Ask your teacher`. Require HTTP 201, the selected anchor, and the answered annotation on disk. Inspect `composer-annotation.json`.
- **Retry and drafts:** Run `node scripts/e2e-browser.ts "$PI_VERIFY_RUN/evidence/quizzes"` with output and exit capture from the quizzes recipe. This also runs `scripts/e2e-service-browser.ts` in a separate service fixture. Its mock Codex executable fails the first turn. Require the stored failure and visible error. Click the exact button `Retry request`. Require one request with the same ID, an answered annotation, and exactly one new mock turn in the same session. Inspect `service/failed-request.json`, `service/retried-request.json`, and their PNG files.
- **Handles:** The panel uses `.cl-teacher`, `.cl-teacher-messages`, and the button named `Send reply`. Inspect `scripts/e2e.ts` for the exact API payload and waiting conditions.
- **Drafts:** The wait-mode browser block fills `[data-cl-followup]` on a saved card and reloads. Inspect `restored-followup-draft.png` and `stored-learner-paths.json`. The service fixture fills `[data-cl-followup]` and the textbox named `Reply to your teacher`, waits for both values in `drafts.json`, then reloads. Require both values back and no submitted follow-up or chat request. Inspect `service/before-draft-reload.json` and `service/restored-card-and-teacher-drafts.png`. After the reconnect check, click `Send reply`. Require the learner message on disk and no teacher draft. Inspect `service/sent-teacher-reply.json`.

## Gotchas

The host harnesses prove composer submission and successful replies. The mock service fixture proves the retry control. It does not prove recovery from every real backend error. No harness submits a saved-card follow-up. Keep that entry point unverified. Model output can vary. Do not suppress a failed plan, switch models, or write an answer directly to make the evaluation pass. Diagnose a failed Pi or model-host run before reporting it as verified.
