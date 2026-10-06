# pi-teach verification map

This map is the maintained source for user behavior verification. Read the matching feature file before each drive.

## Baseline preconditions

- Run from the checkout under review with Node 22.18 or later and installed repository dependencies.
- Use the skill's launch commands to create a separate classrooms root, port, and browser session.
- Require the doctor to report the expected package path, version, PID, port, and root.
- The baseline seed is `Verification classroom` with `Reading lesson` at `/c/verify/001-reading`.
- Never drive the user's study directory or shared browser profile.

## Driving conventions

- Use `control.mjs` for the baseline service and browser session.
- Use the existing harnesses for model teachers, quiz controls, and phone routes.
- Prefer link paths, accessible names, and `data-*` selectors.
- Keep each harness in its own fixture. A baseline fixture is not a model evaluation fixture.

## Proof and skip reporting

Record the feature ID and entry point. Save actions and resulting state. Keep screenshots, ARIA snapshots, response bodies, logs, exit codes, and stored-value assertions where the harness supports them. Report missing proof. A successful API request does not cover the browser composer. A successful CLI action does not cover the equivalent MCP tool. Phone URL reachability from a desktop does not cover a physical phone.

## Features

- [Reading and navigation](reading.md): classroom cards, lesson links, theme persistence, glossary recall, and private rubric access.
- [Passage questions and teacher replies](teacher.md): question APIs, card answers, panel replies, and session resume.
- [Quizzes and review](quizzes.md): submissions, grades, locked attempts, typed controls, and stored review evidence.
- [Service lifecycle](service.md): explicit controls, MCP detach, reconnection, restart, and conflicts.
- [Phone access](phone.md): checked links and owned tailnet routes.
