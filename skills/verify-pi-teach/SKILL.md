---
name: verify-pi-teach
description: Verify pi-teach browser lessons, persistent service controls, dedicated teachers, and phone links with isolated fixtures and retained evidence.
---

# Verify pi-teach

Read the repository `AGENTS.md` and [feature map](features/README.md). Run commands from the repository root. Use the checkout under review. Do not use an installed plugin as proof of checkout changes.

## Launch

Require Unix local sockets, Node 22.18 or later, npm, `ps`, `lsof`, and `playwright-cli`. The browser CLI must have a usable browser. If a tool is missing, stop and report its name. Global packages use the user's `dots` policy. Do not install packages without authorization.

There is no build step. If dependencies are missing, run `npm ci --ignore-scripts --no-audit --no-fund` once. Do not rewrite the lockfile. Run `npm run check` before launch.

```sh
mkdir -p work/verification
export PI_VERIFY_RUN="$(mktemp -d "$PWD/work/verification/run-XXXXXX")"
export PI_VERIFY_PORT=43124
node skills/verify-pi-teach/scripts/control.mjs launch
node skills/verify-pi-teach/scripts/control.mjs doctor
```

Launch seeds a disposable classroom and a bare reading lesson. This is verification scaffolding. It uses the production service launcher with `PI_CLASSROOMS_DIR=$PI_VERIFY_RUN/data`, `PI_CLASSROOM_SERVICE_PORT=43124`, and `PI_CLASSROOM_AUTO_OPEN=0`. It records the service PID and a separate browser session name in `run.json`. The HTTP server binds loopback. The default product port is 43123. This run uses 43124. Concurrent runs need different explicit ports. An occupied port is an error. Never select another port after a failed launch without diagnosing the conflict.

Readiness requires HTTP 200 from `/`, `/c/verify`, `/c/verify/001-reading`, and `/static/classroom.js`. Reading and theme controls need no model authentication. This fixture has no teacher session. Do not submit teacher work to it.

Teardown command:

```sh
node skills/verify-pi-teach/scripts/control.mjs cleanup
```

## Doctor

Run `doctor` before the first drive and after each failed drive. It is read-only except for its evidence file. It checks service status, PID, process command, package path, version, classrooms root, the owned loopback listener, HTTP readiness, and browser CLI availability. The expected version comes from `package.json`. The PID must match launch.

```sh
node skills/verify-pi-teach/scripts/control.mjs doctor
```

For a fresh model-host evaluation, check the chosen host before each run:

```sh
codex --version
codex login status
```

or:

```sh
claude --version
claude auth status
```

A failed login check blocks that host. Do not change credentials or switch backends to conceal the failure. The model-host harnesses use authenticated local CLIs. They make real model calls. The Codex harness copies authentication into a temporary profile. The Claude harness uses the current CLI authentication. Neither needs a shared browser session. Phone checks require a running, authenticated Tailscale client and explicit authorization to change a tailnet Serve route.

## Drive

Run the baseline reading feature:

```sh
node skills/verify-pi-teach/scripts/control.mjs drive
```

The helper opens a separate browser session through the repository's `scripts/playwright.ts`. It clicks classroom and lesson links. It toggles the theme and reloads. It checks local storage and the reloaded theme. It checks that the private rubric route returns 404. The helper does not call internal setters or test endpoints.

Read the mapped feature recipe before using another harness. The broader browser harness has a separate grading control endpoint. It proves browser behavior against the production grading boundary. It does not prove model behavior. The dedicated teacher harness makes real model calls. It injects the first passage question through the public HTTP API. That entry point does not prove the highlight composer.

Stop at a failing action. Save the failure. Run the doctor for the affected service. Diagnose the cause. Do not report a different entry point as proof of the failed path.

## Evidence

Keep baseline proof in `$PI_VERIFY_RUN/evidence/`. `launch.json` and `doctor.json` identify the instance. `reading.json` contains actions, ARIA snapshots, the private-route response, browser errors, and theme state. PNG files show the landing page, lesson, and reloaded theme. `seed-lesson.html` provides the separate stored lesson view. `service.log` and `cleanup.json` remain after cleanup. Failures produce an action-specific JSON file.

Other mapped harnesses write into subdirectories of the same evidence directory. Capture stdout, stderr, and the exit code. Keep failed reports as well as successful reports. Screenshots alone do not prove durable grades. Check the harness's stored-value assertions. Do not treat test-only setters as learner actions.

## Cleanup

Run cleanup after success and after a failed attempt. It closes only the recorded browser session. It stops only the matching service PID through the service control socket. It waits for the service to stop. It copies the service log before it removes the run's `data` directory. It retains evidence and `run.json`. Do not kill by process name.

If ownership checks fail, inspect `run.json`, the doctor report, and the service log. Report the conflict. Do not stop another service. Existing harnesses have their own cleanup in `finally` blocks. If a harness terminates abruptly, inspect its saved root and process information before any manual cleanup.

Confirm retained evidence:

```sh
node skills/verify-pi-teach/scripts/control.mjs cleanup
ls "$PI_VERIFY_RUN/evidence"
```

## Helpers

`node skills/verify-pi-teach/scripts/control.mjs launch` creates the fixture and starts the service. `doctor` checks that instance. `drive` exercises reading and theme persistence. `cleanup` removes only owned runtime state. The helper is executable. It accepts no other action. Keep `PI_VERIFY_RUN` set for all four actions.

Use `maintain-verification-skill` to update this skill and its feature map when user paths change. Add proof for each changed entry point. Do not infer coverage from another entry point.
