# Read and ask

The learner reads a lesson and asks about text without leaving the page.

## Sub-features

- Highlight lesson prose or a quiz question and its options.
- Read a card answer and send a card follow-up.
- Restore saved cards and unsent text after reload.
- Open glossary definitions. Draw diagrams and math. Change the theme.

## How to get to it (user POV)

1. Start a lesson from the host.
2. Open its localhost URL.
3. Select text.
4. Select `Ask your teacher`.
5. Enter a question.
6. Submit it.

## Driving it with playwright-cli

Run `npm run verify -- browser --artifacts /tmp/pi-teach-reading`.

The suite selects text with the mouse. It uses `.cl-ask-pill`, `[data-cl-question]`, and `[data-cl-followup]`. It checks saved annotations, draft restoration, and card placement after the quiz question. Asking about an option must not select it. Sending a follow-up must not submit the quiz.

The suite opens glossary definitions and changes the theme. It checks drawn diagrams, accessible descriptions, and a visible error for invalid Mermaid source. Diagram text must not offer the ask pill. It checks drawn math, literal TeX in code, a visible error for invalid TeX, and Markdown math in a card answer. Math text must not offer the ask pill. A highlight around a formula marks the whole formula and quotes it as TeX. Grading receives each formula as TeX.

## Gotchas

The browser suite uses fixture teachers. Use the real host targets for model answers. Quiz help before grading must clarify the question without solving it. Saved cards sit in document flow. A reload must preserve their location.
