# Answer quizzes

The learner submits typed answers and reads grades on the lesson page.

## Sub-features

- Submit and restore all nine question types.
- Preserve drafts and optional assistance reports.
- Lock a graded quiz. Display partial credit.
- Keep the newest attempt and grade revision across reload and two tabs.
- Release gated teaching after a pretest grade.

## How to get to it (user POV)

1. Open a lesson.
2. Answer its quiz.
3. Select `Submit for grading`.
4. Read the grade and feedback.

## Driving it with playwright-cli

Run `npm run verify -- browser --artifacts /tmp/pi-teach-quizzes`.

The suite drives `form.cl-quiz` and checks `data-state`. It submits all contract examples, reloads, and compares stored answers with the page. It checks `Graded` is disabled, partial verdicts remain visible, and a stale grade cannot replace the active attempt.

Invalid option values must show contract errors and block submission. A grade that arrives before the submit response must keep the quiz graded. A pretest grade must release teaching through one reload and preserve a reflection draft.

## Gotchas

The fixture grading tool proves page and storage behavior. It does not prove model grading quality. API attempts from older clients are checked separately from the learner's locked quiz controls. Immediate correct answers do not prove retention.
