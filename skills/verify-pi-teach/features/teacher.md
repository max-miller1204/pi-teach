# Passage questions and teacher replies

A dedicated Claude or Codex teacher answers saved learner requests after the initiating host exits. Learners can reply in the lesson's teacher panel.

## Sub-features

- `teacher.idle`: Answer a request after host exit.
- `teacher.card`: Render the saved answer on its card.
- `teacher.reply`: Accept a panel reply and resume the teacher session.
- `teacher.failure`: Show an error and an explicit retry action.

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
- **Handles:** The panel uses `.cl-teacher`, `.cl-teacher-messages`, and the button named `Send reply`. Inspect `scripts/e2e.ts` for the exact API payload and waiting conditions.

## Gotchas

The first question uses `/api/ask`. This does not verify highlight selection, composer submission, or follow-up controls. The harness verifies successful replies. It does not drive error retries. State these gaps in the report. Model output can vary. Do not suppress a failed plan, switch models, or write an answer directly to make the evaluation pass. `npm run e2e:pi` covers the live Pi path. Its last run passed. An earlier run failed on a model-issued Bash call after answering and grading. Diagnose any failure before reporting Pi as verified.
