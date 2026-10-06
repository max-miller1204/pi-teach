# Research-informed teaching redesign

Version: 0.7.0. See [EVIDENCE.md](EVIDENCE.md) for research findings and limits.
See [EVALUATION.md](EVALUATION.md) for the human evaluation protocol.

## Implementation map

| Approved area             | Implemented behavior                                                                                                                           | Main verification                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Upcoming prequestions     | Private objective and teaching mappings. Server gate. Separate diagnostic purposes. Expected errors carry no lesson or review penalty.         | Plan, gate, score, and semantic checks                            |
| Retrieval and transfer    | Objective-based tasks, fresh cases, method choice, diagnosis, justification, and equivalent solutions in authoring and grading instructions.   | Separate semantic review and fixed grading cases                  |
| Support progression       | Suitable worked examples, principle-focused explanation, faded completion, then independent work. No fixed layout or type quota.               | Semantic review of actual teaching                                |
| Retention evidence        | Save objective policy and assistance with attempts. Separate immediate, assisted, delayed, and transfer evidence. Keep old context unknown.    | Time, revision, partial-credit, and historical tests              |
| Spaced review             | Deterministic history replay. Extend intervals from elapsed independent retrieval. Record policy and reasons. Optional retention duration cap. | Early, delayed, goal, and replay tests                            |
| Interleaving              | Mix distinct strategies within related private groups. Keep unrelated items in due order.                                                      | Same-lesson and cross-lesson strategy cases                       |
| Confidence and feedback   | Optional confidence and assistance controls. Confidence informs explanation, not credit. Keep immediate correction separate.                   | Draft, reload, submission, equal-credit, and live feedback checks |
| Diagrams and interactions | Preserve all nine types. Preserve accessible Mermaid names and descriptions. Grade from source.                                                | Browser rendering, source, and all-type checks                    |
| Evidence registry         | Rule sources, findings, limits, behavior, product choices, and verification.                                                                   | Linked teaching brief and review                                  |
| Evaluation                | Structural checks, separate semantic review, fixed grading cases, and a delayed human protocol.                                                | Live hosts, negative calibration, and retained reports            |

The gate releases prewritten teaching. Teacher feedback can stress or clarify a
pretest response. Dedicated teachers cannot rewrite lessons or research sources.
Initiating agents own new authoring and research.

The review policy uses two independent delayed successes over at least seven days.
Application objectives also need delayed transfer. These thresholds and the base
intervals are product choices. They are not scientific constants or proof of mastery.

## Validation record

The implementation used isolated classrooms and separate service ports. It did not
submit work to the learner classrooms or stop the installed service. It preserved
historical grades and the unsubmitted CMDA attempt.
The T3 preview host was unavailable. Browser checks used isolated headless sessions.

TypeScript, 417 unit tests, browser checks, live Pi, live Claude, live Codex, and
Claude plugin validation passed. Both quality evaluators detected a bad lesson
whose structural metadata passed. Both fixed grading evaluations awarded the
expected 87.5%. They accepted an alternate schedule, used specific partial credit,
and explained a correct uncertain answer without reducing credit. One initial
Codex grading run reached its 300-second limit. A fresh run passed.

Authoring quality is a separate result. Initial Codex runs passed browser and
structural checks but failed semantic review. They exposed cross-question cues,
reuse of a solved practice case, and a rubric that required unnecessarily specific
closure timing. One reviewer failed the exact-source quote check. The evaluation
failed loudly. The authoring brief now checks the whole assessment for cues.
Raw reviewer plans are saved before validation when an artifact directory is given.
Model judgments still require review. A supplied problem state is not automatically
an answer leak. A request for dynamic pretest rewriting exceeds current capabilities.

Final authoring reports are recorded in the implementation PR. All local reports,
including failures, live under `work/research-redesign-20261006/` in the implementation
worktree. Private rubrics and synthetic service records remain local. PR screenshots
contain synthetic page content only.

Both final authoring runs passed browser checks and failed some semantic criteria.
The final Claude assessment-only quiz passed semantic review. Its teaching pages
failed checks for cues, support gaps, and weak interaction tasks. The final Codex
pages failed checks for cues and rubric equivalence. These runs show that stronger
instructions do not guarantee consistent question quality. Read each source excerpt
and rubric before using a generated page.

No human learning study has run. Passing software checks or an agent answering its
own quiz does not establish human retention or transfer. Generated lessons can
still fail quality checks. Do not describe pi-teach as scientifically validated.
