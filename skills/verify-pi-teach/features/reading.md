# Reading and navigation

Learners open classrooms and lessons in a browser. They can change the colour theme. Reloading preserves the selected theme.

## Sub-features

- `reading.cards`: Open a classroom from the landing page.
- `reading.lesson`: Open a lesson from its classroom.
- `reading.theme`: Keep the theme after reload.
- `reading.private`: Keep quiz keys private.

## How to get to it (user POV)

- Open `/`, then click a classroom card and lesson link.
- Open `/c/verify` directly, then click the lesson link.
- Open `/c/verify/001-reading` directly.
- Use `open_classroom` from Claude Code or Codex.
- Use Pi's `/classroom` command or the classroom skill.
- Click `Toggle colour theme` in a page header.

## Driving it with Playwright CLI

Preconditions: Complete the skill's baseline launch and doctor.

- **Navigate:** Run `node skills/verify-pi-teach/scripts/control.mjs drive`. The helper clicks `a[href="/c/verify"]` then `a[href="/c/verify/001-reading"]`. Require `A value has one owner.` in `[data-cl-content]`.
- **Theme:** The same drive clicks the button named `Toggle colour theme`, then reloads. Require identical `html[data-theme]` and `localStorage['pi-classroom-theme']` values.
- **Proof:** Inspect `$PI_VERIFY_RUN/evidence/reading.json` and the three PNG files. The JSON identifies the tested entry point. Inspect `seed-lesson.html` as the stored document view.
- **Privacy:** The drive requests `/c/verify/001-reading/quiz/key.json`. Require 404 and no private sentinel in the response.

## Gotchas

The baseline covers landing navigation and the lesson theme toggle. It does not cover Pi commands, MCP opening, other header contexts, or direct-link navigation as separate entry points. Do not report them as verified. The seed has no quiz controls and no dedicated teacher. Use the other fixtures for those features.
