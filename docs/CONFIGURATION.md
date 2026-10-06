# Configuration and storage

[Back to the README](../README.md)

## Configuration

Optional, at `~/.pi/agent/classroom.json`:

```json
{
  "port": 4098,
  "autoOpen": true
}
```

| Key        | Default   | Meaning                                                                        |
| ---------- | --------- | ------------------------------------------------------------------------------ |
| `port`     | ephemeral | Fixed port. An occupied or invalid port causes an error.                       |
| `autoOpen` | `true`    | Whether `/classroom` opens your browser. `PI_CLASSROOM_AUTO_OPEN=0` overrides. |

Claude Code and Codex read the same file. `open_classroom` returns a link by default.
Set `open_browser: true` only for a requested browser launch. `autoOpen: false` or
`PI_CLASSROOM_AUTO_OPEN=0` also disables that explicit launch. Starting or continuing
a lesson does not open a visible browser. Lesson checks run in a separate headless
session. The scaffold instructions name the packaged headless config.
Set `PI_CLASSROOM_CONFIG` to read the settings from another file.

For Pi, use a configured fixed port to keep URLs stable across session restarts. Only one
session can use that port at a time. With no port configured, each session uses an
ephemeral port. Claude Code and Codex use service port `43123` by default.
Set `PI_CLASSROOM_SERVICE_PORT` to change it. See the [service guide](USAGE.md#claude-code-and-codex).
Get the current URL from `open_classroom` or `/classroom`.

## Storage

```text
~/.pi/agent/classrooms/
  <classroom-name>/
    classroom.json          title and emoji
    MISSION.md              why you are learning this
    RESOURCES.md            trusted sources, split Knowledge / Wisdom
    GLOSSARY.md             canonical terminology
    NOTES.md                your preferences, and an index of the teacher's notes
    notes/                  slug.md: the topic files NOTES.md indexes
    quiz/retrieval-checks/  successful chat checks linked to review items
    learning-records/       NNNN-slug.md: what you have actually learned
    reference/*.html        cheat sheets, built to be revisited and printed
    assets/                 shared components across lessons
    NNN-lesson-name/
      lesson.html           the lesson
      lesson.json           title and summary
      annotations.json      your question threads and their answers
      reflections.json      your self-explanations
      quiz/
        submissions/*.json  your answers
        grades/*.json       your teacher's grading
```

Set `PI_CLASSROOMS_DIR` to keep material somewhere else. Pi, Claude Code, and Codex all
use the same directory, so a classroom you start in one continues in the others.

A lesson directory is recognised by containing an HTML document: `lesson.html` if
present, else the first `lesson-*.html` (so a literal `lesson-001.html` works), else the
first `.html` file. Lesson order comes from the numeric prefix on the directory name.

The `quiz/` directory is never served as static files, only through the JSON API. An
answer key written to `quiz/key.json` is therefore not readable from the page.

### Links in teaching documents

Links to other sites and PDFs open in a new tab. This applies to lessons,
reference documents, and the classroom's markdown pages. Classroom and lesson
navigation stay in the current tab. Links that set their own `target`, or carry a
`download` attribute, are left alone.

Lesson URLs use `/c/<classroom>/<lesson>` without a trailing slash. They do not match
filesystem paths. From a lesson, use:

- `./` for the classroom page.
- `assets/<path>` for shared classroom assets.
- `<other-lesson>` for another lesson in the same classroom.
- `/r/<classroom>/<file>.html` for a reference document.

Do not use `../assets/<path>` from a lesson. It resolves to `/c/assets/<path>`.
From a reference document, use `/c/<classroom>/<lesson>` for lesson links. Replace
`{{CLASSROOM_NAME}}` in the reference template with the classroom directory name.
