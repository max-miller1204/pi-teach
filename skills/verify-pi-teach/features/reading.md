# Reading and navigation

Learners open classrooms and lessons in a browser. They can change the colour theme. Reloading preserves the selected theme. Lessons and reference documents draw Mermaid diagrams.

## Sub-features

- `reading.cards`: Open a classroom from the landing page.
- `reading.lesson`: Open a lesson from its classroom.
- `reading.theme`: Keep the theme after reload.
- `reading.private`: Keep quiz keys private.
- `reading.glossary`: Ask the learner to recall a marked glossary term, then show its definition.
- `reading.diagrams`: Draw each `pre.mermaid` block in a lesson or a reference document, follow the theme, and show an error for a broken diagram.

## How to get to it (user POV)

- Open `/`, then click a classroom card and lesson link.
- Open `/c/verify` directly, then click the lesson link.
- Open `/c/verify/001-reading` directly.
- Use `open_classroom` from Claude Code or Codex.
- Use Pi's `/classroom` command or the classroom skill.
- Click `Toggle colour theme` in a page header.
- Click a dotted glossary term in a lesson, then click `Show the definition`.
- Open a lesson or a `/r/<classroom>/<file>.html` reference document that has a `<pre class="mermaid">` block.

## Driving it with Playwright CLI

Preconditions: Complete the skill's baseline launch and doctor.

- **Navigate:** Run `node skills/verify-pi-teach/scripts/control.mjs drive`. The helper clicks `a[href="/c/verify"]` then `a[href="/c/verify/001-reading"]`. Require `A value has one owner.` in `[data-cl-content]`.
- **Theme:** The same drive clicks the button named `Toggle colour theme`, then reloads. Require identical `html[data-theme]` and `localStorage['pi-classroom-theme']` values.
- **Proof:** Inspect `$PI_VERIFY_RUN/evidence/reading.json` and the three PNG files. The JSON identifies the tested entry point. Inspect `seed-lesson.html` as the stored document view.
- **Glossary:** The baseline seed has no `GLOSSARY.md`. Use the quizzes feature's browser harness. It writes a glossary, clicks `section .cl-term`, then clicks `Show the definition`. Require exit 0. Inspect `glossary-marker.png` and `glossary-definition.png` in its evidence directory.
- **Diagrams:** The baseline seed has no diagram. Use the quizzes feature's browser harness. It seeds `/c/rust/002-diagrams` and `/r/rust/diagrams.html`. It requires two drawn SVG diagrams and one `Diagram did not render` error, no glossary marker or ask pill inside a diagram, a new node fill after `Toggle colour theme`, and the Mermaid source in the submitted stimulus. Require exit 0 and the passed item `diagrams draw, fail loudly, follow the theme, and send their source`. Inspect `diagrams-light.png`, `diagrams-dark.png`, and `diagram-reference.png`.
- **Privacy:** The drive requests `/c/verify/001-reading/quiz/key.json`. Require 404 and no private sentinel in the response.

## Gotchas

The baseline covers landing navigation and the lesson theme toggle. It does not cover Pi commands, MCP opening, other header contexts, or direct-link navigation as separate entry points. Do not report them as verified. The diagram drive uses fixed fixture diagrams. The authoring evaluation reports how many diagrams a real agent drew, and reports a diagram that did not render as a contract error. The seed has no quiz controls and no dedicated teacher. Use the other fixtures for those features.
