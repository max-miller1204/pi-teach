## Rules

- Keep the package self-contained. There is no build step.
- Keep Pi's server in its live session. Keep the Claude Code and Codex service persistent.
- Keep teacher requests sequential and durable. Save plans before writes. Do not grade twice after recovery.
- Show specific errors. Require an explicit retry. Do not add fallbacks.
- Keep HTTP on loopback. Tailnet links are automatic while Tailscale is connected, tailnet-only, and can be disabled in config. Preserve unrelated Tailscale routes. Never enable Funnel.
- Keep private quiz files off static routes. Use the path guards in `src/paths.ts`.
- Keep the teaching brief out of the system prompt and MCP instructions.
- Keep learner questions and replies on the lesson page after the lesson starts.
- Use `.ts` imports and type-only imports. Browser modules use `.mjs` or `.js`. Add a declaration sidecar when TypeScript imports a browser module.
- Keep `.codex-plugin/plugin.json` and `package.json` versions equal. Declare new `PI_*` settings in `.codex-plugin/mcp.json`.
- Use `npm ci`. Do not regenerate the lockfile with `npm install` on macOS. Edit both root version fields by hand for version changes.
- Keep `docs/ATTRIBUTION.md` with any copy of `docs/`.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing shared state or host behavior.

## Skills

- Use [verify-pi-teach](.agents/skills/verify-pi-teach/SKILL.md) for browser, bridge, service, MCP, and authoring changes. It defines checks by change scope.
- Keep tests for contracts, data recovery, request order, and private file access. Use live browser checks for UI behavior. Avoid tests for fixed wording or layout details.
- Run `npm run verify` after changes. Run `claude plugin validate .` after plugin manifest changes.
- Use [docs/EVALUATION.md](docs/EVALUATION.md) for teaching quality and human learning evaluations.

## Pull requests

- Use a `type(scope): subject` title. Use a short command with no final period. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.
- Keep PRs small and independently reviewable. Use isolated worktrees. Stage named files or selected hunks.
- Target the default branch for independent PRs. Stack only real dependencies. Target the parent branch at its exact tip for a stacked PR.
- Open PRs ready for review unless drafts are requested. Confirm the URL, base branch, and status.
- Report only checks that ran. Do not add AI attribution trailers.
