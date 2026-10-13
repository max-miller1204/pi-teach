# Development

[Back to the README](../README.md)

```bash
npm ci
npm run verify
```

`verify` runs formatting, types, automated tests, and isolated browser checks.
It prints an evidence directory and saves logs, exit codes, screenshots, and stored state.
Use [verify-pi-teach](../.agents/skills/verify-pi-teach/SKILL.md) to select extra checks for the change.

```bash
npm run verify -- checks
npm run verify -- browser --artifacts /tmp/pi-teach-browser
npm run verify -- pi --artifacts /tmp/pi-teach-pi
npm run verify -- claude --artifacts /tmp/pi-teach-claude
npm run verify -- codex --artifacts /tmp/pi-teach-codex
npm run verify -- authoring claude --artifacts /tmp/pi-teach-authoring
```

Keep unit checks for pure contracts and boundary failures. Use HTTP and process tests
for storage, recovery, request order, and private file access. Use browser checks for
learner controls. Avoid checks that repeat fixed prompt text or layout details.
Existing `e2e:*` commands remain available for direct harness runs.

Run this checkout with `pi -e .` or `claude --plugin-dir .`.
Run `claude plugin validate .` after manifest changes.

`e2e:authoring` gives the agent learning objectives only. The agent writes the
lessons from the scaffold. The script inspects them, submits every quiz in the
browser, lets a second session grade them, and checks the page after a reload. It
prints a report of each lesson's outline, quiz kinds, and response types. Model
output varies between runs. A separate evaluator reads the question content, teaching, and private rubric.
It reports source excerpts for semantic alignment, cues, transfer, support, and
equivalent solutions. Structural metadata is checked separately. Read every judgment.
A model evaluator can be wrong. These runs are not human learning evidence.
Use [EVALUATION.md](EVALUATION.md) for the delayed human retention and transfer protocol.

Browser harnesses use the installed `playwright-cli` to drive the lesson page.
The Pi, Claude Code, and Codex tests call a real model. They need a logged-in harness and
are not part of CI. The browser state test uses the grading tool without a model.
They use a temporary classrooms directory. The Codex run also uses a temporary
`CODEX_HOME` that holds a copy of your `auth.json`. The script deletes both when it ends.

The package is installed from git, not npm: `pi install git:github.com/max-miller1204/pi-teach`
clones the repository and runs `npm install`, so whatever is on `main` is what you get.

Browser code under `assets/runtime/` is `.mjs`/`.js` with hand-written `.d.mts` sidecars
where TypeScript needs types. There is no build step. The browser loads these
files directly. `anchor.mjs` is imported by both the browser and the test suite, so
the anchoring logic is tested against the same code that runs.
