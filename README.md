# pi-teach

A fully-featured [Pi](https://github.com/badlogic/pi-mono) extension based on Matt Pocock's `teach` skill (see `docs/ATTRIBUTION.md`).

Lessons are self-contained HTML documents stored under `~/.pi/agent/classrooms/`. A
local server presents them — a landing page of classrooms, each with its lessons,
reference material, and mission — and wires every lesson back to the agent running in
your Pi session. Highlight any sentence to ask about it and the answer appears in a card
pinned to that passage. Hand in a quiz and your teacher grades it.

## Features

- **`/classroom`** — a local web UI for everything you have learned. Clean, responsive,
  and light/dark following your system preference with a manual override.
- **Highlight to ask.** Select text in a lesson, hit _Ask_, type a question. It reaches
  the agent in your session; the answer streams back into a card anchored to the
  highlight. Minimise a card to a small badge in the margin of the text; click to reopen.
  Everything persists, so it is all still there after a reload.
- **Follow-ups in the card.** Every card has a box at the bottom for the next question.
  The teacher gets the whole thread — the passage, every question, every answer so far —
  so "why?" is a complete question. The thread stays anchored to the same highlight.
- **Quizzes that get graded.** A canonical HTML markup contract for quizzes, tests, and
  checks on learning. Submitting writes your answers to the lesson directory and asks
  your teacher to grade them; the grade renders inline, per question.
- **A widget that says who is teaching.** While the server is up, the TUI shows
  `📚 classroom server running on port <port>` below the editor. With several Pi sessions
  open, that is how you find the one a learner's browser is actually talking to.
- **Canonical storage.** One place for all teaching material, so lessons are not
  scattered across whatever directory you happened to be in.

## Install

```bash
pi install npm:pi-teach
```

The extension registers two commands, `/teach` and `/classroom`, four tools, and a status
widget. It has one runtime dependency (`marked`) and no build step.

## Usage

```text
/teach <topic>          start learning something new
/teach                  continue where you left off
/teach rust-ownership   continue a specific classroom

/classroom              open the classroom browser (starts the server if needed)
/classroom rust         open one classroom directly
/classroom list         list classrooms and lessons in the TUI
/classroom status       is the server running, and where
/classroom start|stop   manage the server explicitly
```

While it is running, the TUI carries a `📚 classroom server running on port <port>` widget
below the editor. It appears when the server starts, clears when it stops or the session
ends, and always reports the port actually in use — including when a preferred port was
taken and an ephemeral one was used instead.

The server binds to `127.0.0.1` on an ephemeral port and runs **inside your Pi session**.
That is what makes questions and grading work: a detached daemon could serve the pages,
but it could not reach your agent. It stops when the session ends — `/classroom` starts
it again, and nothing is lost, because all state is on disk.

## Storage

```text
~/.pi/agent/classrooms/
  <classroom-name>/
    classroom.json          title and emoji
    MISSION.md              why you are learning this
    RESOURCES.md            trusted sources, split Knowledge / Wisdom
    GLOSSARY.md             canonical terminology
    NOTES.md                your preferences, the teacher's working notes
    learning-records/       NNNN-slug.md — what you have actually learned
    reference/*.html        cheat sheets, built to be revisited and printed
    assets/                 shared components across lessons
    NNN-lesson-name/
      lesson.html           the lesson
      lesson.json           title and summary
      annotations.json      your question threads and their answers
      quiz/
        submissions/*.json  your answers
        grades/*.json       your teacher's grading
```

Set `PI_CLASSROOMS_DIR` to keep material somewhere else.

A lesson directory is recognised by containing an HTML document: `lesson.html` if
present, else the first `lesson-*.html` (so a literal `lesson-001.html` works), else the
first `.html` file. Lesson order comes from the numeric prefix on the directory name.

The `quiz/` directory is never served as static files, only through the JSON API. An
answer key written to `quiz/key.json` is therefore not readable from the page.

## Configuration

Optional, at `~/.pi/agent/classroom.json`:

```json
{
  "port": 4098,
  "autoOpen": true
}
```

| Key        | Default   | Meaning                                                                           |
| ---------- | --------- | --------------------------------------------------------------------------------- |
| `port`     | ephemeral | Preferred port. If taken (another Pi session), an ephemeral port is used instead. |
| `autoOpen` | `true`    | Whether `/classroom` opens your browser. `PI_CLASSROOM_AUTO_OPEN=0` overrides.    |

## Tools

\*used by the agent

| Tool                     | Purpose                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `answer_lesson_question` | Answer a highlighted-text question or a follow-up. The only thing that puts an answer on the learner's page. |
| `grade_lesson_quiz`      | Grade a submitted quiz. Writes to `quiz/grades/` and renders inline.                                         |
| `scaffold_classroom`     | Create a classroom in the canonical location with a `MISSION.md` stub.                                       |
| `scaffold_lesson`        | Create a numbered lesson directory from the template.                                                        |

## Limitations and gotchas

- **The server is session-scoped.** Close the session and the pages stop serving. This is
  deliberate — see above. Your material is on disk regardless. The port widget is the
  quickest way to tell which session is the live one.
- **The widget needs a UI.** In non-interactive modes there is nowhere to draw it, so it
  is silently skipped; `/classroom status` still reports the server.
- **Asking requires a live session.** Highlight-to-ask and grading go to the agent in the
  Pi session that started the server. With no session, lessons are still readable but
  nothing answers.
- **Highlights can orphan.** Anchoring uses a text-quote selector, so a highlight
  survives reflow and edits around it. If the teacher rewrites the exact sentence you
  highlighted, the card survives but arrives minimised and unanchored rather than
  pointing at the wrong text.
- **Follow-ups wait for the first answer.** The box appears once the card's original
  question has been answered — a thread with nothing in it has no context to build on.
- **One question at a time per card.** `answer_lesson_question` takes only an annotation
  id and attaches the answer to the oldest turn still waiting, so firing several
  follow-ups before any is answered is fine, but answers land in the order asked.
- **One quiz form per `data-quiz-id`.** Reusing an id within a lesson means the second
  form rehydrates from the first one's submission.
- **Never renumber `data-question-id`** after a learner has submitted — grades are
  matched back to questions by that id.
- **Loopback only.** There is no auth and none is needed; nothing binds beyond
  `127.0.0.1`.

## Development

```bash
npm install
npm run check       # tsc --noEmit
npm test            # vitest
npm run test:pack   # verify the published tarball, not just the working tree
```

`npm run test:pack -- --keep` prints a path you can hand to `pi -e` to run exactly what
an npm consumer would install. Release candidates are published automatically for every
pull request under the `rc` dist-tag — see [`RELEASING.md`](RELEASING.md).

Browser code under `assets/runtime/` is `.mjs`/`.js` with hand-written `.d.mts` sidecars
where TypeScript needs types — this repo has no build step, and the browser has to load
these files directly. `anchor.mjs` is imported by both the browser and the test suite, so
the anchoring logic is tested against the same code that runs.

## License

MIT — see `LICENSE`. The teaching methodology under `docs/` is derived from the `teach`
skill by [Matt Pocock](https://github.com/mattpocock/skills).
