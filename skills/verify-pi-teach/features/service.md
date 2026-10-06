# Service lifecycle

Claude and Codex attach to a persistent loopback service. Closing an MCP client leaves the classroom available. Explicit stop closes the owned service.

## Sub-features

- `service.controls`: Start, check, and stop a service.
- `service.detach`: Keep HTTP available after MCP exit.
- `service.reconnect`: Attach to the same PID.
- `service.recovery`: Preserve grades and session identity across restart.
- `service.conflict`: Reject an occupied port.

## How to get to it (user POV)

- Run `npm run service -- start`, `status`, or `stop`.
- Call `classroom_service` with action `start`, `status`, or `stop` from an MCP host.
- Use `open_classroom` to start or attach to a service.
- Exit the initiating Claude or Codex session, then continue in the browser.

## Driving it with service CLI and subprocess harnesses

Preconditions: Complete baseline launch. Retain its marker and data directory until cleanup.

- **CLI status:** Run `PI_CLASSROOMS_DIR="$PI_VERIFY_RUN/data" PI_CLASSROOM_SERVICE_PORT=43124 npm run service -- status`. Require the baseline PID, root, port, and package version. Save stdout and exit code in the evidence directory.
- **Owned controls:** Use the skill's launch, doctor, and cleanup. The helper calls the same production start/status/stop implementation. `cleanup.json` must report `running: false` and `dataRemoved: true`.
- **MCP lifecycle:** Run `npm test -- test/service-process.test.ts > "$PI_VERIFY_RUN/evidence/service-process.log" 2>&1`. Immediately run `printf '%s\n' "$?" > "$PI_VERIFY_RUN/evidence/service-process.exit"`. This subprocess harness checks real MCP and HTTP entry points, stored grades, reconnection, restart, concurrent clients, and occupied ports.
- **Live host exit:** Use both teacher feature recipes. Require the service to remain available after the initiating host exits.

## Gotchas

The subprocess tests mock the Codex executable at the existing CLI boundary. They prove transport and recovery behavior. They do not prove authenticated model execution. Baseline helper controls do not prove the MCP control tool's wording. A root has one service. Always use the same absolute root spelling. Never issue stop against the user's default study directory. The production default port is 43123. This baseline explicitly selects 43124.
