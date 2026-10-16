---
name: verify-pi-teach
description: Verify pi-teach lessons in the browser and select Pi, Claude Code, Codex, or authoring checks for changes to the runtime, bridge, service, MCP, and teaching contracts.
---

# Verify pi-teach

Use this skill from the repository root. Read [features/README.md](features/README.md). Select checks from the changed behavior and its callers.

## Launch

1. Install repository dependencies with `npm ci` when missing.
2. Run `npm run verify -- --artifacts /tmp/pi-teach-verify-local`.

The default target runs formatting, types, automated tests, and the browser suite. The browser suite starts isolated classrooms and loopback servers. It drives reading, quizzes, the Pi bridge, and the persistent service. It closes owned sessions and removes scratch classrooms.

## Doctor

Run `npm run verify -- doctor`. For a real host, use `npm run verify -- doctor pi`, `doctor claude`, or `doctor codex`.

Doctor checks Node, dependencies, headless configuration, and required commands. Codex also needs an existing `auth.json`. Real hosts need a signed-in model account. Doctor does not prove that model access works. A missing command or account is a blocker. Use `dots` to manage global packages.

Real model checks use fixed settings. Pi uses `openai-codex/gpt-6-luna` with `low` thinking. Claude uses `claude-haiku-5-5` with `low` effort. Codex uses `gpt-6-luna` with `low` reasoning effort. These settings apply to initiating sessions, dedicated teachers, authoring, feedback, and semantic evaluation. Test settings override user defaults. Codex uses a temporary home. The test plugin passes that home to its MCP service. Pi checks its active model and thinking level before it starts the browser drive. Do not substitute a model when access fails.

During a browser drive, the harness checks readiness through the lesson's `data-state` and the service's status API. It checks stored state before teardown. Inspect the saved service log after a failure. Do not switch backends to bypass a failure.

## Drive

Use the installed `playwright-cli` through the repository harness. Each run has its own browser session. These documented checks require headless mode.

| Change                                                              | Check after the default target                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Pi bridge, extension hooks, or Pi prompts                           | `npm run verify -- pi`                                                         |
| MCP, persistent teacher service, shared prompts, or teaching skills | `npm run verify -- claude`, then `npm run verify -- codex`                     |
| Templates or authoring guidance                                     | `npm run verify -- authoring claude`, then `npm run verify -- authoring codex` |
| Grading policy                                                      | Select `feedback claude` and `feedback codex`                                  |
| Semantic evaluator                                                  | Select `quality claude` and `quality codex`                                    |
| Plugin manifests                                                    | `claude plugin validate .`                                                     |
| Tailnet links or phone access                                       | Read the tailnet note in the feature index before selecting `phone`            |

Pass `--artifacts <directory>` to any target. Use a new directory for each run. `checks` runs only formatting, types, and automated tests. `browser` runs only browser checks. Do not repeat completed checks unless code changes or a finding requires it.

## Verdicts and quality reports

The default target, the real `pi`, `claude`, and `codex` drives, and `feedback` set a PASS or FAIL verdict. They check whether the product works.

`authoring` sets its verdict from mechanical checks only: lessons exist, rubrics exist, pages load without contract or page errors, quizzes submit, grades save, and reload keeps them. Its semantic judgments are a quality report. They give a score and findings, but they do not change the verdict. `quality` reports how many known defects the judge detects. Only an evaluator error fails it.

Model output and model judgments change between runs. Do not hold a change because a quality finding appears, and do not rerun until the score improves. Fix a finding only when it shows a code or contract defect. Report other findings to the user. When a change affects authoring guidance or templates, compare quality reports with `main` over more than one run.

## Evidence

The runner prints the evidence directory. It saves stdout, stderr, exit codes, revision, and working tree status in `run.json`. Browser drives save screenshots and stored state below `browser/`. Real hosts save their event streams and teacher state. Keep failed evidence.

Inspect screenshots before citing them. Fixture teachers prove UI, storage, SSE, and failure handling. They do not prove model behavior. Real host runs prove the model connection for the tested account and lesson. Authoring reports are evaluations, not evidence of human learning. Read each report, including semantic findings.

Real service targets retain `classroom/` on success and failure. Inspect its private `.teacher.json` for the rejected plan and applied call count. The quality target saves `<host>-quality-raw.json` before it validates source excerpts. Read that plan after an evaluator failure. Preserve the exact-source check.

## Cleanup

Harnesses close their named browser sessions and owned servers in `finally`. They remove temporary classrooms and temporary Codex homes. They retain the evidence directory. Do not stop a shared server by port or process name. If a run is interrupted, identify its scratch root and owned process from its saved logs before cleanup.

## Helpers

`scripts/verify.ts` is the command entry point. It runs existing `scripts/e2e*.ts` harnesses in sequence and stops on failure. `scripts/playwright.ts` manages CLI sessions. `scripts/browser-actions.ts` holds shared learner interactions. `scripts/check-lesson.ts <classroom> <lesson>` checks an authored page in a disposable copy without changing learner state.
