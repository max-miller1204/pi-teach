# pi-teach

Interactive lessons for [Pi](https://github.com/badlogic/pi-mono), Claude Code, and
Codex. Learn a topic in a local web classroom. Highlight a passage to ask a question,
get answers in a saved thread, and submit quizzes for feedback.

![An answer card below a highlighted passage](screenshots/answer.png)

## What you can do

- Ask questions and follow-ups directly from a lesson.
- Take quizzes with feedback for each question.
- Review learned ideas with spaced practice.
- Keep lessons, reference sheets, and learning records in one place.
- Read diagrams and glossary definitions in light or dark mode.

See the [features and screenshot tour](docs/FEATURES.md) for more detail.

## Install

### Pi

```bash
pi install git:github.com/max-miller1204/pi-teach
```

### Claude Code

```bash
claude plugin marketplace add max-miller1204/pi-teach
claude plugin install pi-teach@pi-teach
```

### Codex

```bash
codex plugin marketplace add max-miller1204/pi-teach
codex plugin add pi-teach@pi-teach
```

Claude Code and Codex require Node 22.18 or later on your `PATH`.
The plugin installs its runtime dependency on first start. No build step is needed.

## Start learning

**Pi:** Start a lesson, then open the classroom browser.

```text
/teach <topic>
/classroom
```

Use `/teach` without a topic to continue learning.

**Claude Code:** Use the plugin skills.

```text
/pi-teach:teach <topic>
/pi-teach:classroom
```

**Codex:** Ask it to teach you a topic. Ask it to open your classroom when you want
the lesson link. You can also name the `teach` or `classroom` skill.

Read the lesson in your browser. Highlight text to ask a question. Submit a quiz to
get feedback. After a missed answer, reply to the teacher's follow-up question.

Keep your Pi session open while you learn. Claude Code and Codex use a persistent
local service with a dedicated teacher for each classroom. The service keeps
running when you close the initiating chat.

Your material is saved in `~/.pi/agent/classrooms/`. All three hosts use this folder.

## Documentation

- [Features and screenshots](docs/FEATURES.md): quizzes, review, diagrams, and the web UI.
- [Usage and service guide](docs/USAGE.md): commands, teacher sessions, phone access, and limitations.
- [Configuration and storage](docs/CONFIGURATION.md): settings, ports, files, and document links.
- [Tool reference](docs/TOOLS.md): authoring tools and service controls.
- [Development](docs/DEVELOPMENT.md): local setup, checks, and end-to-end tests.
- [Teaching method](docs/TEACHING.md): how the teacher plans lessons and checks learning.
- [Teaching evidence](docs/EVIDENCE.md): sources, limits, and product choices.
- [Redesign and validation](docs/RESEARCH-REDESIGN.md): implemented behavior and evaluation limits.
- [Evaluation protocol](docs/EVALUATION.md): software checks and delayed human learning tests.

## License

[MIT](LICENSE). The teaching method is based on Matt Pocock's `teach` skill.
See [attribution](docs/ATTRIBUTION.md) for details.
