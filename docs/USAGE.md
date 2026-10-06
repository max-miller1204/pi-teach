# Usage and service guide

[Back to the README](../README.md)

## Pi commands

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
ends, and always reports the port in use.

The server binds to `127.0.0.1` on an ephemeral port and runs **inside your Pi session**.
That is what makes questions and grading work: a detached daemon could serve the pages,
but it could not reach your agent. It stops when the session ends. `/classroom` starts
it again, and nothing is lost, because all state is on disk.

## Claude Code and Codex

The plugin gives Claude Code and Codex the same classrooms, lessons, and web UI as Pi. It
has two skills and one MCP server, `classroom`.

```text
/pi-teach:teach <topic>     Claude Code: start or continue learning something
/pi-teach:classroom         Claude Code: open or list your classrooms
```

In Codex, ask it to teach you a topic, or mention the `teach` or `classroom` skill.

Pi keeps its server inside the live Pi session. Claude Code and Codex attach to a
persistent local service. Closing the initiating chat does not stop the service.

1. The initiating agent writes a lesson and its private rubric.
2. It calls `open_classroom`. The service records one teacher backend per classroom.
3. A browser question or submission starts work in that classroom's dedicated teacher.
4. The service validates and saves the teacher's plan. It applies answers and grades
   in the process that owns the browser's SSE connection.
5. After a missed answer, the teacher asks a new retrieval question in the lesson's
   teacher panel. Reply in that panel. The graded quiz stays locked.

The teacher does not advance lessons. Ask the initiating agent for new material after
completing the check. Learning records and spaced review keep the existing teaching
method. Historical grades remain unchanged. Skipped checks stay in notes as unresolved gaps.
A pretest can record prior knowledge demonstrated by a correct answer.

The persistent service requires Unix local sockets. The service owns one classrooms root. It binds to `127.0.0.1:43123` by default. Set
`PI_CLASSROOM_SERVICE_PORT` to an explicit port before starting it. A port conflict
stops startup. The service never selects another port. Pi's existing port setting
and lifecycle remain unchanged.

The initiating host selects the teacher backend. Set `PI_CLASSROOM_TEACHER` to
`codex` or `claude`, or pass `teacher_backend` to `open_classroom`, when the host is
unknown. An existing classroom cannot silently change backend. The service records
the dedicated session ID. Codex uses its supported app-server `thread/start`,
`thread/resume`, and `turn/start` calls. Claude uses its authenticated CLI with
`--json-schema` and `--resume`. Both return structured plans. They do not write grades
or answer files directly. The service uses the shared tool validation to apply them.

### Service controls and recovery

Use `classroom_service` with action start, status, or stop. You can also use:

```sh
npm run service -- start
npm run service -- status
npm run service -- stop
```

Status reports the owner process, package path, classrooms root, port, and log path.
A different package version or port must be stopped explicitly before replacement.
The service stores control state in `<classrooms root>/.pi-teach-service/`. Its control
socket permits access only to the local user. Classroom teacher state lives in
`.teacher.json`, which is never a static route. The service saves each request and
plan before applying writes. It skips grades already saved for that submission.
An interrupted model call becomes a visible error. Use Retry request in the teacher
panel to run it again. Saved plans finish without another model call. Model calls
have a 180-second limit. Model and authentication errors remain visible.

### Phone access

For phone access, ask the agent to call `classroom_phone` with action start,
classroom, and lesson. The helper uses the existing Tailscale installation and node.
It creates a tailnet-only HTTPS Serve route on explicit port 8443 by default. It
checks the complete URL before returning it. Use `https_port` to select a free port
explicitly if that port is occupied. The helper rejects conflicts and Funnel-enabled
ports. It preserves unrelated Serve routes. Use its status and stop actions to
inspect and remove the owned route. Service stop removes that route first.
This does not enable public access. Tailnet members allowed by your Tailscale policy
can reach the classroom pages and submit requests.

The adapters follow the official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server),
[Claude CLI documentation](https://code.claude.com/docs/en/headless), and
[Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Limitations

- **Pi is session-scoped.** Close the Pi session and its pages stop serving.
  Claude Code and Codex use the persistent service. Stop it explicitly.
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
  question has been answered.
- **One question at a time per card.** `answer_lesson_question` takes only an annotation
  id and attaches the answer to the oldest turn still waiting, so firing several
  follow-ups before any is answered is fine, but answers land in the order asked.
- **One quiz form per `data-quiz-id`.** Reusing an id within a lesson means the second
  form rehydrates from the first one's submission.
- **Never renumber `data-question-id`** after a learner has submitted. Grades are
  matched back to questions by that id.
- **Teacher failures require a retry.** The teacher panel shows the specific error.
  Saved requests stay on disk. Click Retry request after resolving the cause.
- **Loopback only.** The HTTP service binds to `127.0.0.1`. Phone access uses an
  opt-in Tailscale Serve route. It does not use Funnel.
