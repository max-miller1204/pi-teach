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
| Phone access                                                        | Read the coverage gap in the feature index before selecting `phone`            |

Pass `--artifacts <directory>` to any target. Use a new directory for each run. `checks` runs only formatting, types, and automated tests. `browser` runs only browser checks. Do not repeat completed checks unless code changes or a finding requires it.

## Evidence

The runner prints the evidence directory. It saves stdout, stderr, exit codes, revision, and working tree status in `run.json`. Browser drives save screenshots and stored state below `browser/`. Real hosts save their event streams and teacher state. Keep failed evidence.

Inspect screenshots before citing them. Fixture teachers prove UI, storage, SSE, and failure handling. They do not prove model behavior. Real host runs prove the model connection for the tested account and lesson. Authoring reports are evaluations, not evidence of human learning. Read each report, including semantic findings.

## Cleanup

Harnesses close their named browser sessions and owned servers in `finally`. They remove temporary classrooms and temporary Codex homes. They retain the evidence directory. Do not stop a shared server by port or process name. If a run is interrupted, identify its scratch root and owned process from its saved logs before cleanup.

## Helpers

`scripts/verify.ts` is the command entry point. It runs existing `scripts/e2e*.ts` harnesses in sequence and stops on failure. `scripts/playwright.ts` manages CLI sessions. `scripts/browser-actions.ts` holds shared learner interactions. `scripts/check-lesson.ts <classroom> <lesson>` checks an authored page in a disposable copy without changing learner state.
