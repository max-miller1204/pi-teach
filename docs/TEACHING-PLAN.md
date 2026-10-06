# Private teaching plan

Write `quiz/plan.json` before sharing a newly scaffolded page. This file is private.
Do not put method labels in public question metadata. Keep `quiz/key.json` separate.
The server binds plan evidence to the saved attempt. Later edits cannot rewrite it.
Old pages need no new metadata. Their evidence context remains unknown.

```json
{
  "version": 1,
  "objectives": {
    "cost": {
      "statement": "Calculate and explain squared error cost on new data.",
      "application": true,
      "retentionDays": 60,
      "interleaveGroup": "regression",
      "strategy": "cost"
    }
  },
  "quizzes": {
    "pretest-1": {
      "purpose": "prequestion",
      "questions": {
        "p1": {
          "objective": "cost",
          "task": "prediction",
          "support": "independent",
          "teaching": "teaching-cost"
        }
      }
    },
    "check-1": {
      "purpose": "assessment",
      "questions": {
        "q1": { "objective": "cost", "task": "transfer", "support": "independent" }
      }
    }
  }
}
```

Give the teaching block `id="teaching-cost"`. Put it inside the matching pretest gate.
Map every authored question. Use the actual quiz and question ids. Do not add mappings
for unused ids. Each upcoming objective needs a prequestion and a later assessment.
The server checks that each prequestion's teaching target exists inside its own gate.
These checks cannot establish semantic alignment. Read each question and teaching block.
Check that both address the objective and that teaching answers the prequestion.

Use these mental tasks: `prediction`, `explanation`, `attempted-solution`, `retrieval`,
`application`, `method-choice`, `diagnosis`, `justification`, or `transfer`.
A prequestion invites one of the first three tasks before instruction. A question
marked `transfer` must use an unfamiliar situation that requires the same principle.
Changing numbers alone is not sufficient evidence of transfer.

Use purpose `prequestion` for the upcoming topic. Use `prerequisite` for a separate
standalone pretest of prerequisites. Use `prior-retrieval` for a separate quiz on
previously taught topics. Use `assessment` for checks and reviews. A prerequisite
diagnostic or prior retrieval cannot replace a gated prequestion.
These separate quizzes can share a page. Their own objectives do not need upcoming
prequestions. Every objective must be used. Objectives used by an upcoming prequestion
or assessment need both when the page has a teaching gate.

Set `support` to `assisted` for hints, supplied method steps, or faded completion.
Use `independent` for questions that require unaided work. This author setting alone
cannot prove independence. The learner also reports assistance on the page.
Confidence is optional and does not affect credit or retention evidence.

`retentionDays` is an optional duration goal. Ask about it when useful. Omit it when
none exists. It is not a deadline. Set both `interleaveGroup` and `strategy` only
when related methods need discrimination. For example, regression can mix prediction,
residual, and cost. Do not group unrelated subjects. Keep early supported practice
suitable for novices. Review prompts must ask the learner to choose the method.

For a review, carry forward the original objective policy shown by `scaffold_review`.
Map each new question to it. Keep `data-review-of` unchanged. Do not label the required
method in the learner's prompt. Use fresh scenarios and accept equivalent solutions.
