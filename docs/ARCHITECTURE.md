# Architecture

This repository is a standalone Pi package containing one extension, installed from
git. A local web UI for teaching material, wired back into the live Pi session so a
learner can ask questions from inside a lesson and hand in quizzes to be graded. The pedagogy comes from
Matt Pocock's `teach` skill; the attribution lives in `docs/ATTRIBUTION.md` and must
travel with any copy of `docs/`.

The package root _is_ the extension root: `package.json` declares `pi.extensions:
["./index.ts"]`, so `pi install git:github.com/max-miller1204/pi-teach` and
`pi install /path/to/pi-teach` both work. Nothing may depend on files outside this
directory.

The same root is also a Claude Code and Codex plugin. `.claude-plugin/` and
`.codex-plugin/` hold the manifests, `.claude-plugin/marketplace.json` and
`.agents/plugins/marketplace.json` list the repository root as the plugin, `skills/`
holds the two skills, and `mcp/launch.mjs` starts the MCP server. Pi ignores all of it.

This is a fork of `joshrnoll/pi-teach`, which is published to npm. This fork is not. A copy also lives in Josh's private `my-pi-packages` repo as
`extensions/classroom`. They are all independent: a change here does not propagate.

## The three rules that shape everything

**1. Pi keeps its in-process server and direct bridge.** Browser requests call
`pi.sendUserMessage` in the live Pi session. Do not detach Pi's server.

Claude Code and Codex use a persistent local service. MCP connections attach through
its private local control socket. Closing MCP stdin must not stop the HTTP server.
One service owns one classrooms root and one stable loopback port. Each classroom
has one selected backend and one dedicated teacher session. Browser requests start
teacher work without a listening MCP agent. The service applies teacher plans and
owns browser SSE connections. Keep requests durable and sequential per classroom.
Save each plan before applying writes. Do not grade a submission twice after recovery.
Failed or interrupted work must show a specific error and require an explicit retry.

Phone access is opt-in and tailnet-only. Use the classroom_phone helper. Keep the
HTTP server on loopback. Preserve unrelated Tailscale Serve routes. Never enable
Funnel or silently select another port or backend.

**2. TS runs in the extension, `.mjs` runs in the browser.** There is no build step.

Pi loads the `.ts` files with its own loader. Claude Code and Codex run them with Node's
built-in type stripping (Node 22.18 or later). That is why relative imports end in `.ts`,
and why `tsconfig.json` sets `erasableSyntaxOnly` and `verbatimModuleSyntax`: no enums, no
parameter properties, and `import type` for type-only imports. `npm run check` enforces
it.

- `.ts` (`index.ts`, `src/`): the extension process: commands, tools, server, store.
- `.mjs` / `.js` (`assets/runtime/`): loaded by the browser over `/static/`. Anything a
  TS file or a test imports needs a hand-written `.d.mts` sidecar (`anchor.d.mts` is the
  example; the `preview` and `web` extensions use the same trick).

`anchor.mjs` is deliberately DOM-free so the test suite exercises the same code the
browser runs. Keep it that way: DOM work belongs in `classroom.js`.

**3. Nothing goes in the system prompt.** The wake-up messages in `src/prompts.ts` are
self-contained: they restate the classroom, the lesson, the question, and the exact tool
that answers it, because they arrive out of band, possibly many turns later. Sessions
that never teach pay nothing. Do not add a `before_agent_start` injection. For the same reason, the MCP server
sends no `instructions`: the skills and `begin_teaching` carry the brief.

## Module map

Extension side (`.ts`):

- `index.ts`: wires the bridge to the server hooks, registers tools and commands, hooks
  `session_start` / `input` / `agent_end` / `session_shutdown`.
- `src/paths.ts`: the canonical root, slug validation, and `safeJoin`. Every static
  route goes through it; this is the traversal guard.
- `src/store.ts`: all disk I/O. Discovery is filesystem-first: a directory with a lesson
  document _is_ a lesson, whether or not `lesson.json` exists, because the model often
  writes material with plain file writes.
- `src/server.ts`: the HTTP singleton, routes, and the SSE registry keyed by
  `<classroom>/<lesson>`.
- `src/bridge.ts`: waking the agent, the origin FIFO that keeps `agent_end`
  attribution honest, and Pi's side of the teacher panel.
- `src/tools.ts`: the seven shared tools, as plain JSON Schema. Pi's validator compiles
  JSON Schema as-is, so there is no `typebox` import. `ToolHost` holds the one string
  that differs between hosts.
- `src/mcp.ts`: the MCP server for Claude Code and Codex: a pure JSON-RPC dispatcher
  (`McpSession`), the legacy `LearnerInbox`, and the session tools (`begin_teaching`,
  `open_classroom`, `list_classrooms`, `wait_for_learner`).
- `src/mcp-stdio.ts`: forwards stdio MCP messages to the persistent service.
  stdout is the transport. Closing stdin detaches this client.
- `src/service-main.ts`: owns the HTTP server, private control socket, and teacher workers.
- `src/service-client.ts`: starts and attaches to the service at a stable port.
- `src/service-state.ts`: saves request identity, plans, errors, and teacher messages.
- `src/teacher-service.ts`: runs requests in sequence and applies plans in the service.
- `src/teacher.ts`: Codex app-server and Claude CLI structured output adapters.
- `src/phone-access.ts`: manages only the service-owned Tailscale Serve route.
- `mcp/launch.mjs`: the MCP entry point. Checks the Node version, runs
  `npm ci --omit=dev` on the first start, then imports `src/mcp-stdio.ts`.
- `src/commands.ts`: `/classroom` and `/teach`.
- `src/status-widget.ts`: the "classroom server running on port N" widget below the
  editor.
- `src/prompts.ts`: every string sent to the model.
- `src/quiz.ts`: quiz answers on the server: their typed shape, their validation, and
  the text the teacher grades from.
- `src/quiz-authoring.ts`: reads the questions a lesson document declares, for the
  `lesson_health` authoring diagnostics. Pure. The browser still owns the contract
  check.
- `src/review.ts`: the spaced-review schedule, derived from grade history. Pure.
- `src/review-session.ts`: durable browser review requests, selected items, validation,
  and publication. Private request state lives in `<classroom>/.reviews.json`.
- `src/glossary.ts`: parses `GLOSSARY.md` and finds words the glossary says to avoid.
- `src/health.ts`: the `lesson_health` report. Pure.
- `src/pages.ts`, `src/lesson-html.ts`, `src/markdown.ts`, `src/config.ts`: pure-ish
  helpers, all tested.

Browser side (`assets/runtime/`):

- `classroom.js`: the lesson runtime: highlight-to-ask, card threads, quiz harness.
- `anchor.mjs` (+ `.d.mts`): pure text-quote anchoring.
- `quiz.mjs` (+ `.d.mts`): the quiz contract: question types, kinds, and markup checks.
  The server imports it too, so the page and the server enforce the same rules.
- `diagrams.mjs` (+ `.d.mts`): draws each `<pre class="mermaid">` with the vendored
  Mermaid build. Lessons and reference documents both load it. The build loads only
  on a page that has a diagram.
- `vendor/mermaid/`: `mermaid.min.js`, its `LICENSE`, and `VERSION`. Update it with
  `node scripts/vendor-mermaid.ts <version>`. It is vendored, not an npm dependency,
  because the package installs about 200 MB of Node modules that the browser build
  does not use.
- `glossary.mjs` (+ `.d.mts`): pure glossary term matching. The server imports it for
  the avoided-word check.
- `draft.mjs` (+ `.d.mts`): the draft contract: draft keys and the values each one
  accepts. The server imports it to check `PUT /api/draft`.
- `theme.mjs`: the light/dark toggle.
- `shell.js`: the landing/classroom/document pages (just the toggle).
- `classroom.css`: one stylesheet for every page and every lesson.

Authoring contracts (`assets/templates/`) and the teaching methodology (`docs/`).

## Key behaviours

- **Origin FIFO.** `agent_end` fires once per run. `bridge.noteForeignTurn()` is called
  for typed input and for `/teach`, `bridge.ask()` pushes an ask origin, and grades,
  self-explanations, and panel replies push a panel origin, so a run's final assistant
  text is only ever used for the request that started it. Get this wrong and answers
  land on the wrong card or in the wrong panel. Adapted from `slack-bridge`.
- **The learner never needs the terminal, except to start a lesson.** After grading,
  the retrieval question and the learner's reply go through the lesson's teacher
  panel, in every host. The service's teacher returns it as `plan.message`; in Pi, a
  panel run's final assistant text is posted to `<lesson>/teacher-messages.json`. The
  panel sits after the quiz handed in last. Do not reintroduce "ask in chat" wording
  into `QUIZ_FOLLOW_UP` or the tools.
- **Quiz text can be highlighted, the quiz runtime cannot.** `QUIZ_RUNTIME_UI` (grade,
  verdicts, footer, reports, order buttons) is outside the text index, because it
  changes on grading. A card about a question is placed after the whole `.cl-q`, never
  inside it: inside, `setQuizState` would lock its fields and `collectAnswer` would read
  them. Its nested form's events bubble to the quiz, so the quiz listeners ignore them,
  and the quiz submit button is looked up in its footer. Card markers are detached
  while answers are read. `Annotation.quiz` records whether the quiz was graded, so the
  teacher does not give an answer away before grading.
- **A card is a thread, not a single Q&A.** `Annotation.question`/`answer*` are turn one;
  `Annotation.followUps[]` are the rest. `followUps` is optional so annotation files
  written before follow-ups existed still parse: read it as `annotation.followUps ?? []`
  everywhere. `answer_lesson_question` still takes only an annotation id: `store.answerTarget()`
  resolves the turn (oldest pending, else the most recent, so a revision is not lost), and
  `applyAnswer` routes through it.
- **The status widget is derived, never stored.** `refreshStatusWidget()` reads
  `server.getPort()` each time rather than being handed a port, so the displayed port stays current. It uses plain string lines (the only content RPC mode
  honours) and swallows `setWidget` failures: a mode without widgets must not take the
  server down with it. Call it after anything that starts or stops the server.
- **The legacy learner inbox never drops a prompt.** A prompt that arrives while nobody waits
  stays queued for the next `wait_for_learner`. A cancelled wait (the user pressed Esc)
  gets no response and takes nothing from the queue.
- **Grading has no prose fallback.** A half-invented grade is worse than none, so only
  `grade_lesson_quiz` writes a grade. The grading run's prose goes to the teacher panel,
  never into the grade.
- **Answers render server-side.** `applyAnswer` and `applyGrade` store markdown _and_
  HTML, so the browser needs no markdown parser.
- **Submission timestamps are strictly increasing per lesson.** "Latest submission" is
  what the page rehydrates from, so the ordering has to be total: two submissions in the
  same millisecond would otherwise resolve by random UUID.
- **Transient UI floats; cards do not.** The ask pill and the composer are absolutely
  positioned. A saved card is inserted into the document flow after the block holding
  the highlight, so it can never cover the passage it explains: and needs no
  repositioning on scroll or resize. Do not "improve" this back into a floating panel.
- **Lessons get their header from the runtime.** A lesson on disk is a bare document, so
  `buildHeader()` adds the breadcrumb and theme toggle. `initTheme()` must run _after_
  it, since it wires up the button the header creates.
- **Themes.** Light tokens on `:root`, dark under `prefers-color-scheme`, and explicit
  `[data-theme]` beating both so the toggle works in either direction. The inline
  bootstrap in `<head>` exists to stop a dark-mode reader seeing a white flash: keep it
  inline and keep it first.
- **The quiz contract fails loudly.** Every question needs a `data-type`. A quiz that
  breaks `quiz.mjs` shows its errors on the page and in the console, and it cannot be
  submitted. The server checks each answer against its type with `parseAnswer`. Only
  submissions written before types existed have answers with no `type`; read them
  through `answersByQuestion`, which groups their one-entry-per-box `multi` answers.
- **A Pi regrade is a revision, not an attempt.** `grade_lesson_quiz` can grade a
  submission again. Each grade is a new file, so the history is kept. Read grades
  through `store.latestGrades()`, which keeps the newest grade for each submission.
  Scores, quiz state, health, and review must all agree on that revision. Attempts
  count submissions, never grade files.
- **The lesson template is a shell.** `lesson.html` and `review.html` keep the runtime
  parts and leave one question with `data-type="CHOOSE-A-TYPE"`, so an unwritten quiz
  fails loudly. Do not add a fixed section order or a default question type back.
  `quiz.html` stays the one complete contract. `authoringSteps()` in `prompts.ts` is
  what the scaffold tools return.
- **One state per quiz.** A lesson can hold several quizzes, so `/api/state` returns the
  latest attempt at each `quizId`. A new attempt is refused (409) until the last one is
  graded.
- **Reviews start on the classroom page.** `Start review` saves one request and up to
  five due items. Each request records its host and process. Another host cannot take over
  the request. Pi authors the assigned files in its live session. The persistent
  teacher returns one `publish_review` call. The service saves that plan before it
  writes files. Normal teacher requests cannot publish pages. Validate the item keys,
  private rubric, control shapes, and teaching plan before publication. Hide unfinished reviews from
  lesson lists, static lesson routes, and submissions. Repeated clicks reuse the request.
  Failures require `Retry review`. A saved service plan can resume without another model
  turn. Pi marks interrupted review work failed. `Continue review` returns to a review
  that has not been graded.
- **The review schedule is derived, never stored.** `store.reviewItems()` rebuilds it
  from every graded answer and linked chat retrieval check. Pretests are left out. A review question names its item
  with `data-review-of`, and the server refuses a key that was never graded.
- **Unsent text is a draft, not a submission.** The page saves quiz answers,
  self-explanations, follow-ups, the open question composer, and the teacher reply to
  `<lesson>/drafts.json` as the learner types, and restores them once on load. Drafts
  never reach the teacher and never wake the agent. The handler that accepts the text
  removes its draft. A restored quiz draft only fills a form that is still `fresh`. A
  restored question comes back as a marker at its highlight, not as an open composer,
  because the composer floats over the lesson. A reconnect must not replace typed text,
  so drafts are not applied again.
- **A diagram is drawn, not highlighted.** `initDiagrams()` swaps each
  `pre.mermaid` for a `div.cl-diagram` before anything indexes the text. The text
  index, the glossary, and the ask pill all skip `.cl-diagram`, so an anchor never
  depends on whether a diagram has finished drawing. A stimulus sends the Mermaid
  source to grading, not the SVG labels.
- **`quiz/` is never a static route.** It holds submissions and any answer key. Adding a
  route that serves lesson directories wholesale would leak it; the media route is
  deliberately narrow (`<lesson>/media/*` only).
