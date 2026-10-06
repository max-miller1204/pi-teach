# Development

[Back to the README](../README.md)

```bash
npm ci
npm run check       # tsc --noEmit
npm test            # vitest
pi -e .             # run this checkout in a Pi session without installing it
claude --plugin-dir .   # run this checkout as a Claude Code plugin
claude plugin validate .
npm run e2e:claude      # a real Claude Code session: answer a question, grade a quiz
npm run e2e:codex       # the same, through Codex
npm run e2e:browser     # browser state tests with the real server
npm run e2e:pi          # a real Pi session: question, quiz, and chat follow-up
npm run e2e:quality -- claude     # semantic reviewer must detect bad aligned metadata
npm run e2e:quality -- codex
npm run e2e:feedback -- claude    # alternate, partial, uncertain, assisted, and old answers
npm run e2e:feedback -- codex
npm run e2e:authoring -- claude   # a real agent writes lessons; the script submits them
npm run e2e:authoring -- codex
```

`e2e:authoring` gives the agent learning objectives only. The agent writes the
lessons from the scaffold. The script inspects them, submits every quiz in the
browser, lets a second session grade them, and checks the page after a reload. It
prints a report of each lesson's outline, quiz kinds, and response types. Model
output varies between runs. A separate evaluator reads the question content, teaching, and private rubric.
It reports source excerpts for semantic alignment, cues, transfer, support, and
equivalent solutions. Structural metadata is checked separately. Read every judgment.
A model evaluator can be wrong. These runs are not human learning evidence.
Use [EVALUATION.md](EVALUATION.md) for the delayed human retention and transfer protocol.

All e2e scripts use the installed `playwright-cli` to drive the lesson page.
The Pi, Claude Code, and Codex tests call a real model. They need a logged-in harness and
are not part of CI. The browser state test uses the grading tool without a model.
They use a temporary classrooms directory. The Codex run also uses a temporary
`CODEX_HOME` that holds a copy of your `auth.json`. The script deletes both when it ends.

To save screenshots, pass an output directory to an E2E test:

```bash
npm run e2e:browser -- /tmp/pi-teach-evidence
npm run e2e:pi -- /tmp/pi-teach-evidence
npm run e2e:claude -- /tmp/pi-teach-evidence
npm run e2e:codex -- /tmp/pi-teach-evidence
```

The package is installed from git, not npm: `pi install git:github.com/max-miller1204/pi-teach`
clones the repository and runs `npm install`, so whatever is on `main` is what you get.

Browser code under `assets/runtime/` is `.mjs`/`.js` with hand-written `.d.mts` sidecars
where TypeScript needs types. There is no build step. The browser loads these
files directly. `anchor.mjs` is imported by both the browser and the test suite, so
the anchoring logic is tested against the same code that runs.
