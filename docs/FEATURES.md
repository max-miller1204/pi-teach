# Features and screenshots

[Back to the README](../README.md)

- **Classroom browser.** Use `/classroom` to open your learning material.
  The UI supports small screens and light or dark themes.
- **Highlight to ask.** Select text in a lesson, hit _Ask_, type a question. It reaches
  the agent in your session; the answer streams back into a card anchored to the
  highlight. Minimise a card to a small badge in the margin of the text; click to reopen.
  Everything persists, so it is all still there after a reload.
- **Follow-ups in the card.** Every card has a box at the bottom for the next question.
  The teacher gets the passage and every question and answer in the thread.
  This gives each follow-up its context. The thread stays anchored to the same highlight.
- **Quizzes that get graded.** A canonical HTML markup contract for quizzes, tests, and
  checks on learning. Submit a quiz to save your answers and ask the teacher to grade them.
  Each question shows its feedback on the page.
- **Nine question types for any topic.** Each question has a `data-type` for what the
  learner produces: `choice`, `multi`, `term`, `short`, `numeric`, `cloze`, `order`,
  `match`, and `locate`. A `.cl-q-stimulus` block holds what they look at: a passage,
  code, a table, or an image. A quiz that breaks the contract shows its errors on the
  page and cannot be submitted.
- **Lessons shaped by the objective.** The lesson template is a shell, not a fixed
  script. The scaffold tools return the authoring steps: read the current quiz
  contract, state the objective, choose the lesson experience and response types,
  write the questions and a private rubric, and check the page. [Teaching method](TEACHING.md)
  lists optional lesson patterns and when to use each feature.
- **Saved quizzes and pretests.** A graded quiz stays locked. Saved attempts and
  grades are kept. Missed ideas get a follow-up question and spaced review later.
  New lessons start with a pretest (`data-kind="pretest"`). Teaching stays out of the
  served page until the pretest is graded. Explicit quiz requests get assessment-only
  pages. A pretest never counts toward
  the score. Confidence is optional and informs feedback only. Assistance reports describe evidence.
- **Spaced review.** Every graded question gets a review schedule: 1, 3, 7, 21, then 60
  days. The schedule is calculated from the grades on disk. `scaffold_review` builds a
  review lesson from the due questions, mixed across lessons. Correctness controls
  the schedule. Confidence never changes the schedule. Immediate success does not extend review. Old context stays unknown.
- **Self-explanations.** A `form.cl-reflect` asks the learner to explain an idea in
  their own words. The teacher reads it. It is never graded.
- **Diagrams.** A `<pre class="mermaid">` block in a lesson or a reference document is
  drawn as a Mermaid diagram, in the colours of the current theme. Mermaid is bundled,
  so diagrams work offline. A diagram that does not parse shows its error on the page.
- **Glossary terms in lessons.** The first use of each `GLOSSARY.md` term in each
  section is underlined. A click asks the learner to recall the meaning before it
  shows the definition.
- **Progress and lesson health.** The classroom page shows what is due, what is
  retained evidence, missing transfer evidence, and the glossary size. `lesson_health` tells the teacher which passages and
  questions did not land.
- **A widget that says who is teaching.** While the server is up, the TUI shows
  `📚 classroom server running on port <port>` below the editor. With several Pi sessions
  open, that is how you find the one a learner's browser is actually talking to.
- **Canonical storage.** One place for all teaching material, so lessons are not
  scattered across whatever directory you happened to be in.

## Screenshot tour

The landing page lists your classrooms.

![The classroom landing page](../screenshots/classrooms.png)

A classroom collects its lessons in order, alongside its mission, reference sheets, and
its newest learning records. A separate page lists all learning records with summaries. Lessons you have been quizzed on carry their score, and lessons you have
asked about carry a question count.

![A classroom page listing three lessons, the first showing a 92% score and two questions](../screenshots/classroom.png)

Select any text in a lesson and an _Ask_ pill appears above it.

![A sentence selected in a lesson with an Ask pill floating above the selection](../screenshots/highlight.png)

The composer keeps the passage you highlighted attached to the question, so the teacher
answers with the context in hand.

![The ask composer open, quoting the highlighted passage above a typed question](../screenshots/ask.png)

The answer appears in a card below the block that contains your highlight. The card is a thread: ask a follow-up in the box at
the bottom and the teacher gets every turn so far.

![An answered question card anchored under the highlighted sentence, with a follow-up in the same thread](../screenshots/answer.png)

Quizzes are graded in place, question by question, with an overall score and feedback at
the top. Submissions and grades live in the lesson directory, so a reload brings the whole
thing back.

After a wrong answer, the teacher explains the missed idea and asks a new question
in your Pi chat or the lesson's teacher panel in Claude Code and Codex.
Reply there so the teacher can check your understanding before moving on.

![A graded quiz showing 92%, overall feedback, and per-question verdicts](../screenshots/quiz.png)

Every page follows your system theme. You can select a different theme.
The selection applies to lessons, cards, and grades.

![The same lesson in dark mode, showing a card and a graded quiz](../screenshots/lesson-dark.png)

<sub>Screenshots use a throwaway demo classroom, not real teaching material.</sub>
