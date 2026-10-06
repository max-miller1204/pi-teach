# Diagrams

A lesson or a reference document can show a Mermaid diagram. The page draws it from
text that you write in the HTML. The classroom bundles Mermaid, so the diagram works
offline. Do not link a CDN.

## When to draw a diagram

Draw a diagram when the idea has a shape that prose hides:

- a process with steps or decisions,
- messages between parts over time,
- states and the events that move between them,
- the structure of a system or a data model,
- the order of events on a timeline.

Put the diagram next to the words that explain it. Name the same parts in the text
and in the diagram, with the glossary terms. Do not add a diagram only for
decoration. A diagram that repeats a sentence adds reading time and no learning.

A diagram can also be the thing a question asks about. Put it in a `.cl-q-stimulus`.
For example, show a state diagram and ask which event moves the system to a given
state. Keep a stimulus diagram small: the stimulus text has a limit of 4000
characters.

## Markup

Write the source in a `<pre class="mermaid">`. Wrap it in a `<figure>` with a
`<figcaption>`:

```html
<figure>
  <pre class="mermaid">
    flowchart LR
      accTitle: How a request reaches the database
      accDescr: The client calls the API, and the API reads from the database.
      Client -->|HTTP request| API
      API -->|SQL query| DB[(Database)]
  </pre>
  <figcaption>The API is the only part that talks to the database.</figcaption>
</figure>
```

- The learner cannot highlight text inside a drawn diagram to ask about it. Put
  the words they may ask about in the caption or in the text around the figure.
- Add `accTitle:` and `accDescr:` lines. A screen reader reads them.
- Indent the source as you like. The page removes the indent that all lines share.
- Write `<` as `&lt;` and `&` as `&amp;` in the source, because the browser reads
  the source as HTML first. You do not need to escape `>`.
- Do not add a `%%{init: ...}%%` directive or a theme. The page colours each diagram
  from the classroom theme, and draws it again when the learner changes the theme.
- Grading receives the Mermaid source of a stimulus diagram, not the drawn labels.

## Choosing a diagram type

| Type                              | Use it for                                                     |
| --------------------------------- | -------------------------------------------------------------- |
| `flowchart LR` or `flowchart TD`  | A process, an algorithm, a decision, or how data moves.        |
| `sequenceDiagram`                 | Messages between parts in time order: protocols and API calls. |
| `stateDiagram-v2`                 | A lifecycle: states and the events that change them.           |
| `classDiagram`                    | Types, their fields, and how they relate.                      |
| `erDiagram`                       | A data model: entities and the relations between them.         |
| `timeline`                        | Events in order: history and versions.                         |
| `gitGraph`                        | Branches, commits, and merges.                                 |
| `mindmap`                         | An overview of how sub-topics relate to one topic.             |
| `quadrantChart`                   | Items placed on two axes.                                      |
| `xychart-beta` or `pie`           | A small set of numbers. Use a table when exact values matter.  |
| `block-beta`, `architecture-beta` | The parts of a system and where they connect.                  |

The Mermaid documentation at https://mermaid.js.org/intro/ has the full syntax of
each type. The bundled version is in the extension's
`assets/runtime/vendor/mermaid/VERSION`.

## Syntax mistakes to avoid

- Put a label in double quotes when it has `( ) [ ] { } : ; #` or a keyword:
  `A["f(x) = x + 1"]`. Write a double quote inside a label as `#quot;`.
- A flowchart node cannot have the id `end` in lower case. Use `End` or `done`.
- In a flowchart, a node id that starts with `o` or `x` right after `---` or `-->`
  makes a circle or cross edge. Put a space before the id.
- In `classDiagram`, write the arrow `<|--` as `&lt;|--`, and generics as
  `List~int~`.
- A mindmap reads its structure from indentation. Indent each child more than its
  parent.
- `%%` starts a comment.

## Check the diagram

Open the page in your browser tool. A diagram that does not parse shows
"Diagram did not render" with the Mermaid error, and the console logs it. Fix the
source until each diagram draws. Check that it reads well in the light and the dark
theme.
