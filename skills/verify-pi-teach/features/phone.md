# Phone access

The phone helper returns a checked lesson link through a tailnet-only Tailscale Serve route. It preserves unrelated routes.

## Sub-features

- `phone.link`: Return a full clickable HTTPS lesson URL.
- `phone.ownership`: Add and remove only the owned route.
- `phone.conflict`: Reject occupied routes and Funnel conflicts.

## How to get to it (user POV)

- Call `classroom_phone` with action `start`, a classroom, and a lesson.
- Click the returned lesson link from a phone signed into the same tailnet.
- Call `classroom_phone` with action `status` or `stop`.

## Driving it with Tailscale CLI and service harnesses

Preconditions: Obtain explicit authorization to add a temporary tailnet Serve route. Require an authenticated Tailscale client. Require the chosen HTTPS port 8443 to be available. Keep unrelated routes unchanged.

- **Doctor:** Run `tailscale status --json` and `tailscale serve status --json`. Save both outputs in the evidence directory. Require a running client and a `ts.net` DNS name. Do not log authentication secrets.
- **Link:** Run `npm run e2e:phone > "$PI_VERIFY_RUN/evidence/phone.log" 2>&1`. Immediately run `printf '%s\n' "$?" > "$PI_VERIFY_RUN/evidence/phone.exit"`. The harness creates a separate fixture, invokes the production MCP helper, checks the clickable full URL, and removes its route.
- **Preservation:** Run `tailscale serve status --json` again. Compare it with the saved initial configuration. Require unrelated routes to match.
- **Phone:** When authorized, open the returned link on a physical phone in the same tailnet. Capture the lesson and the browser URL. Record this as a separate entry point.

## Gotchas

The automated URL check originates on the desktop. It does not prove physical phone access. Never enable Funnel. Never reset all Serve routes. Do not change a conflicting port to make a failed evaluation pass. The baseline run does not include this external route mutation. Report it as unverified unless separately executed and authorized.
