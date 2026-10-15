# Teacher conversation

The learner receives follow-up questions and answers them in the lesson's teacher panel.

## Sub-features

- Place the panel after the submitted quiz.
- Show new-message notices and render teacher Markdown.
- Resume a graded historical review from initiating chat with `resume_lesson_teacher`.
- Reuse pending panel work and reject cross-lesson or cross-host handoffs.
- Recover a saved panel reply whose teacher request was lost.
- Save replies and restore the conversation after reload.
- Link a successful panel check to a learning record without changing the quiz grade.
- Show specific failures and require an explicit retry.
- Regenerate a plan rejected before writes. Keep valid plans for recovery.
- Request a new grade plan after an explicit retry of a rejected score.
- Keep the persistent service available after MCP exit.

## How to get to it (user POV)

1. Submit a quiz.
2. Read the teacher's question below it.
3. Enter an answer in `Reply to your teacher`.
4. Select `Send reply`.
5. Use `Retry request` only when a request fails.
6. To resume a graded review from chat, ask to continue. Open the returned lesson link.
   Read the existing question or the response to your saved panel reply.

## Driving it with playwright-cli

Run `npm run verify -- browser --artifacts /tmp/pi-teach-teacher`.

The Pi fixture checks `.cl-teacher` follows the quiz, a prose-only grading run fails, and an explicit retry permits grading. It checks the panel reply reaches the correct prompt and all three conversation messages survive reload.

The service fixture checks failure, retry, MCP disconnect and reconnect, request isolation between lessons, and teacher drafts. Inspect `pi-panel/pi-panel.json` and service state evidence.

The service fixture also submits a quiz with an invalid teacher score. It checks the visible error and the absence of a saved grade. `Retry request` must request one corrected plan. Reload must show the corrected grade. Inspect `service/rejected-grade.json`, `service/retried-grade.json`, and `service/grading-turns.json`. The grading turns must each permit exactly one grade call.

The resume fixtures use a saved review with an empty panel or an unanswered saved reply. They check the explicit handoff, panel link, reply recovery, message order, reload, and unchanged assessment and evidence files for Pi, Claude, and Codex. Repeated handoffs must reuse the request. Inspect `resume/`. The real Pi and service host drives also resume a historical 67% review from initiating chat. They check the saved grade and teacher identity.

For a changed real Pi path, run `npm run verify -- pi`. For shared service or prompt changes, run `npm run verify -- claude`, then `npm run verify -- codex`. Add `--artifacts <directory>` to retain host evidence. These drives ask a question, submit a wrong answer, and reply in the panel. They check that the quiz score remains unchanged.

The service reply fixture reports no help. The drives require the actual reply and reported assistance in a saved retrieval check. They require a linked learning record and keep immediate correction outside retained evidence. Inspect `stored-teacher-state.json` and the retained `classroom/` files.

## Gotchas

Fixture teachers do not prove model responses. Claude and Codex use a persistent teacher session. Pi uses the live agent bridge. Starting a new lesson still requires the initiating host. Private quiz keys must remain unavailable over HTTP.
