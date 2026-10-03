# pi-teach — extension guidance

This repository is a standalone Pi package containing one extension, installed from
git. A local web UI for teaching material, wired back into the live Pi session so a
learner can ask questions from inside a lesson and hand in quizzes to be graded. The pedagogy comes from
Matt Pocock's `teach` skill; the attribution lives in `docs/ATTRIBUTION.md` and must
travel with any copy of `docs/`.

The package root _is_ the extension root: `package.json` declares `pi.extensions:
["./index.ts"]`, so `pi install git:github.com/max-miller1204/pi-teach` and
`pi install /path/to/pi-teach` both work. Nothing may depend on files outside this
directory.

This is a fork of `joshrnoll/pi-teach` (the `upstream` remote), which is published to
npm; this fork is not. A copy also lives in Josh's private `my-pi-packages` repo as
`extensions/classroom`. They are all independent — a change here does not propagate.

## The three rules that shape everything

**1. The server is in-process, and that is the whole point.** It runs inside the Pi
session so `POST /api/ask` can call `pi.sendUserMessage` directly. If you ever find
yourself wanting the `web` extension's detached daemon, remember that a detached process
cannot reach the agent — questions and grading would stop working. Session-scoped is the
feature, not a limitation to fix.

**2. TS runs in the extension, `.mjs` runs in the browser.** There is no build step.

- `.ts` (`index.ts`, `src/`) — the extension process: commands, tools, server, store.
- `.mjs` / `.js` (`assets/runtime/`) — loaded by the browser over `/static/`. Anything a
  TS file or a test imports needs a hand-written `.d.mts` sidecar (`anchor.d.mts` is the
  example; the `preview` and `web` extensions use the same trick).

`anchor.mjs` is deliberately DOM-free so the test suite exercises the same code the
browser runs. Keep it that way — DOM work belongs in `classroom.js`.

**3. Nothing goes in the system prompt.** The wake-up messages in `src/prompts.ts` are
self-contained: they restate the classroom, the lesson, the question, and the exact tool
that answers it, because they arrive out of band, possibly many turns later. Sessions
that never teach pay nothing. Do not add a `before_agent_start` injection.

## Module map

Extension side (`.ts`):

- `index.ts` — wires the bridge to the server hooks, registers tools and commands, hooks
  `session_start` / `input` / `agent_end` / `session_shutdown`.
- `src/paths.ts` — the canonical root, slug validation, and `safeJoin`. Every static
  route goes through it; this is the traversal guard.
- `src/store.ts` — all disk I/O. Discovery is filesystem-first: a directory with a lesson
  document _is_ a lesson, whether or not `lesson.json` exists, because the model often
  writes material with plain file writes.
- `src/server.ts` — the HTTP singleton, routes, and the SSE registry keyed by
  `<classroom>/<lesson>`.
- `src/bridge.ts` — waking the agent, and the origin FIFO that keeps `agent_end`
  attribution honest.
- `src/tools.ts` — the four tools.
- `src/commands.ts` — `/classroom` and `/teach`.
- `src/status-widget.ts` — the "classroom server running on port N" widget below the
  editor.
- `src/prompts.ts` — every string sent to the model.
- `src/pages.ts`, `src/lesson-html.ts`, `src/markdown.ts`, `src/config.ts` — pure-ish
  helpers, all tested.

Browser side (`assets/runtime/`):

- `classroom.js` — the lesson runtime: highlight-to-ask, card threads, quiz harness.
- `anchor.mjs` (+ `.d.mts`) — pure text-quote anchoring.
- `theme.mjs` — the light/dark toggle.
- `shell.js` — the landing/classroom/document pages (just the toggle).
- `classroom.css` — one stylesheet for every page and every lesson.

Authoring contracts (`assets/templates/`) and the teaching methodology (`docs/`).

## Key behaviours

- **Origin FIFO.** `agent_end` fires once per run. `bridge.noteForeignTurn()` is called
  for typed input and for `/teach`, and `bridge.ask()` pushes an ask origin, so a run's
  final assistant text is only ever used to fill the question that started it. Get this
  wrong and answers land on the wrong card. Adapted from `slack-bridge`.
- **A card is a thread, not a single Q&A.** `Annotation.question`/`answer*` are turn one;
  `Annotation.followUps[]` are the rest. `followUps` is optional so annotation files
  written before follow-ups existed still parse — read it as `annotation.followUps ?? []`
  everywhere. `answer_lesson_question` still takes only an annotation id: `store.answerTarget()`
  resolves the turn (oldest pending, else the most recent, so a revision is not lost), and
  `applyAnswer` routes through it.
- **The status widget is derived, never stored.** `refreshStatusWidget()` reads
  `server.getPort()` each time rather than being handed a port, so an ephemeral-port
  fallback cannot desync it. It uses plain string lines (the only content RPC mode
  honours) and swallows `setWidget` failures — a mode without widgets must not take the
  server down with it. Call it after anything that starts or stops the server.
- **Grading has no prose fallback.** A half-invented grade is worse than none, so
  `bridge.grade()` records a foreign origin and only `grade_lesson_quiz` writes a grade.
- **Answers render server-side.** `applyAnswer` and `applyGrade` store markdown _and_
  HTML, so the browser needs no markdown parser.
- **Submission timestamps are strictly increasing per lesson.** "Latest submission" is
  what the page rehydrates from, so the ordering has to be total — two submissions in the
  same millisecond would otherwise resolve by random UUID.
- **Transient UI floats; cards do not.** The ask pill and the composer are absolutely
  positioned. A saved card is inserted into the document flow after the block holding
  the highlight, so it can never cover the passage it explains — and needs no
  repositioning on scroll or resize. Do not "improve" this back into a floating panel.
- **Lessons get their header from the runtime.** A lesson on disk is a bare document, so
  `buildHeader()` adds the breadcrumb and theme toggle. `initTheme()` must run _after_
  it, since it wires up the button the header creates.
- **Themes.** Light tokens on `:root`, dark under `prefers-color-scheme`, and explicit
  `[data-theme]` beating both so the toggle works in either direction. The inline
  bootstrap in `<head>` exists to stop a dark-mode reader seeing a white flash — keep it
  inline and keep it first.
- **`quiz/` is never a static route.** It holds submissions and any answer key. Adding a
  route that serves lesson directories wholesale would leak it; the media route is
  deliberately narrow (`<lesson>/media/*` only).

## When making changes

- Keep pure logic out of the I/O modules and add tests in `test/`. `test/helpers.ts`
  builds a temp classrooms root via `_overrideClassroomsDir`.
- `test/server.test.ts` drives the real server over HTTP, including the SSE paths — add
  route changes there, and keep the traversal cases green.
- After changes: `npm run check` and `npm test` from the repo root.
- Commit `package-lock.json` with any dependency change — Pi runs `npm install` after
  cloning a git target.
- **Never commit a lockfile produced by a bare `npm install` on macOS.** The Pi dev
  dependency pulls optional platform-gated packages (`@mariozechner/clipboard-*`), and
  installing on one platform prunes the others from the lockfile — roughly 440 lines of
  churn that flips back and forth between macOS and the Ubuntu CI runners. Even
  `npm install --package-lock-only` does it on macOS, so a version bump means editing the
  two root `version` fields by hand; real dependency changes are best made on Linux. Use
  `npm ci` to install.
- There is no npm release. `pi install git:` and `pi update` take whatever is on `main`,
  so keep `main` green.
- Update `assets/templates/quiz.html` when the quiz contract changes — the model reads
  that file, so it is documentation and API at once.
