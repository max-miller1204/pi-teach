# Teaching evidence registry

Checked: 2026-10-06. This registry records principles and their limits. It does not
claim that pi-teach improves human learning. Sources support conditional practices.
Our counts, intervals, evidence thresholds, and UI remain choices to evaluate.
When a rule changes, update its implementation, tests, and this registry together.
The teaching brief uses these rule ids. Keep the brief and skill consistent.

## P1: Prequestion the upcoming idea

**Sources:** [Pan and Carpenter (2023)](https://link.springer.com/article/10.1007/s10648-023-09814-5),
[Richland, Kornell, and Kao (2009)](https://learninglab.uchicago.edu/Publications_files/RichlandKornellKao.pdf),
[St. Hilaire, Chan, and Ahn (2024)](https://pubmed.ncbi.nlm.nih.gov/37640836/).

**Finding:** Attempts before study can improve later learning even when answers are
wrong. The meta-analysis found benefits concentrated on prequestioned material.
**Limits:** Do not promise improvement on all lesson material. Prerequisite tests
and retrieval of previous topics serve different purposes.
**Behavior:** Ask about central upcoming objectives. Invite predictions, explanations,
or attempted solutions. Gate teaching until grading. Map questions to teaching.
Feedback can stress or clarify an idea. The gate releases prewritten teaching.
**Choice:** Two or three questions is a practical default, not an optimum.
**Verify:** Plan validation, leak tests, semantic authoring review, human delayed tests.

[Yu et al. (2025)](https://sc-pan.github.io/pdf/YHADP_2025.pdf) studied science stories
with children aged 5 to 6. Benefits occurred with immediate feedback. Results without
feedback were not significant in those experiments. This supports prompt feedback
and cautions against applying adult findings to every learner and setting.

## P2: Retrieve and apply

**Sources:** [Roediger and Karpicke (2006)](https://www.psychologicalscience.org/journals/psychological-science/j.1467-9280.2006.01693.x/),
[Butler (2010)](https://pubmed.ncbi.nlm.nih.gov/20804289/).

**Finding:** Retrieval can improve delayed retention. Repeated testing supported
inferential transfer in the studied tasks.
**Limits:** Recognition, copied blanks, and puzzle complexity do not establish
independent application. Transfer depends on what is learned and tested.
**Behavior:** Map questions to objectives. Use fresh situations, method choice,
diagnosis, and justification when relevant. Accept equivalent valid solutions.
**Verify:** Alternate-solution and partial-credit grading cases; unfamiliar delayed
human questions. An agent solving its own quiz tests software and adherence only.

## P3: Fade suitable support

**Source:** [Atkinson, Renkl, and Merrill (2003)](https://experts.azregents.edu/en/publications/transitioning-from-studying-examples-to-solving-problems-effects-/).

**Finding:** Fading worked steps with principle-focused self-explanation supported
transition to problem solving in the studied procedures.
**Limits:** This does not require one layout for every topic or learner.
**Behavior:** For suitable new procedures, use worked examples, principle explanations,
faded completion, then independent practice. Reduce support from demonstrated knowledge.
**Verify:** Semantic authoring review checks the progression and reasons for support.
Supported completion and reflection cannot count as independent retention.

## P4: Separate performance from retention

**Sources:** P2 and P5. Immediate performance can differ from delayed performance.
**Behavior:** Preserve grades. Label prior knowledge, assisted work, immediate
independent work, delayed retrieval, and transfer separately. Mark old context unknown.
**Choice:** The progress labels require independent delayed successes on two occasions,
with a total span of at least seven days. Application objectives also require delayed
transfer. These thresholds are conservative product choices, not scientific constants.
The UI says retained evidence, not mastery. A reflection or confidence rating is no proof.
**Verify:** Time, assistance, transfer, historical, revision, and chat-check tests.

## P5: Space for a retention goal

**Source:** [Cepeda et al. (2008)](https://pubmed.ncbi.nlm.nih.gov/19076480/).

**Finding:** In fact learning, useful spacing depended on the later retention interval.
**Limits:** No universal interval formula follows for every skill or learner.
**Behavior:** Derive schedules from history. Require actual elapsed time and independent
retrieval before extending an interval. An early success does not postpone a due review.
**Choices:** Keep 1, 3, 7, 21, and 60 days as an auditable base schedule. Cap an interval
at one quarter of an optional retention duration, with a one-day minimum. This cap
is a heuristic to evaluate. No goal means no cap. Never invent a deadline.
**Verify:** Deterministic replay, early/late attempts, assistance, and goal cases.
Human pilots compare delayed outcomes and workload across policies.

## P6: Interleave related methods

**Sources:** [Rohrer, Dedrick, and Burgess (2014)](https://pubmed.ncbi.nlm.nih.gov/24578089/),
[Rohrer et al. (2020), classroom trial](https://ies.ed.gov/ncee/wwc/Study/88770),
[Samani and Pan (2021), undergraduate physics](https://pubmed.ncbi.nlm.nih.gov/34772951/).

**Finding:** Mixed practice can support later problem solving when learners must
select a strategy. Newer classroom and physics work extends the evidence settings.
**Limits:** Mixing unrelated subjects is not a substitute for method discrimination.
**Behavior:** Alternate distinct strategies within an authored related group. Keep
ungrouped items in due order. Supply private policy labels to review authors.
**Choice:** Deterministic round-robin strategy selection. Early instruction can remain blocked.
**Verify:** Same-lesson different-strategy, cross-lesson related-group, and unrelated cases.
Check that prompts do not announce the method.

## P7: Calibrate feedback

**Source:** [Butler, Karpicke, and Roediger (2008)](https://pubmed.ncbi.nlm.nih.gov/18605878/).

**Finding:** Feedback benefited low-confidence correct responses in the studied task.
**Limits:** Confidence does not determine correctness or demonstrate understanding.
**Behavior:** Offer optional confidence. Explain correct but uncertain answers. Give
useful correction and one fresh follow-up after errors. Record assistance separately.
**Verify:** Equal credit at all confidence levels, useful uncertain-correct feedback,
and assisted answers excluded from independent retention evidence.

## P8: Use representations for a task

**Source:** [IES practice guide (2007)](https://ies.ed.gov/ncee/wwc/PracticeGuide/1).

**Finding:** The guide recommends combining graphics with verbal descriptions and
asking explanatory questions. Its original evidence ratings are historical ratings.
**Limits:** A diagram or varied response type alone does not cause learning.
**Behavior:** Preserve nine types and Mermaid on every host. Choose types from mental
work. Give diagrams accessible descriptions. Inspect rendered relationships and grading source.
**Verify:** Browser diagrams, source sent to grading, keyboard controls, and all-type tests.

## P9: Verify claims with suitable evidence

**Basis:** Measurement limits of P1 through P8. This is an evaluation policy.
**Behavior:** Test software, agent adherence, and human outcomes separately.
**Verify:** [Evaluation protocol](EVALUATION.md). Publish failed runs and missing evidence.
Do not describe the extension as scientifically validated without human outcome data.
