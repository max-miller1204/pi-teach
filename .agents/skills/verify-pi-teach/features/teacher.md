# Teacher conversation

The learner receives follow-up questions and answers them in the lesson's teacher panel.

## Sub-features

- Place the panel after the submitted quiz.
- Show new-message notices and render teacher Markdown.
- Save replies and restore the conversation after reload.
- Show specific failures and require an explicit retry.
- Keep the persistent service available after MCP exit.

## How to get to it (user POV)

1. Submit a quiz.
2. Read the teacher's question below it.
3. Enter an answer in `Reply to your teacher`.
4. Select `Send reply`.
5. Use `Retry request` only when a request fails.

## Driving it with playwright-cli

Run `npm run verify -- browser --artifacts /tmp/pi-teach-teacher`.

The Pi fixture checks `.cl-teacher` follows the quiz, a prose-only grading run fails, and an explicit retry permits grading. It checks the panel reply reaches the correct prompt and all three conversation messages survive reload.

The service fixture checks failure, retry, MCP disconnect and reconnect, request isolation between lessons, and teacher drafts. Inspect `pi-panel/pi-panel.json` and service state evidence.

For a changed real Pi path, run `npm run verify -- pi`. For shared service or prompt changes, run `npm run verify -- claude`, then `npm run verify -- codex`. Add `--artifacts <directory>` to retain host evidence. These drives ask a question, submit a wrong answer, and reply in the panel. They check that the quiz score remains unchanged.

## Gotchas

Fixture teachers do not prove model responses. Claude and Codex use a persistent teacher session. Pi uses the live agent bridge. Starting a new lesson still requires the initiating host. Private quiz keys must remain unavailable over HTTP.
