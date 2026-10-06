# Evaluation protocol

## Software and agent adherence

Use isolated classrooms. Preserve real attempts and the running learner service.
Run `npm run check` and `npm test`. Run browser, Pi, Claude, and Codex E2E checks.
Run authoring evaluations for Claude and Codex. Run `e2e:quality` on both hosts
to test a structurally valid lesson with unrelated prequestions and exposed answers.
Run `e2e:feedback` on both hosts for fixed grading cases. Keep every report, including failures.
An agent answering its own questions is not evidence of human learning.

Use structural checks for objective coverage, teaching targets, question identities,
private rubric binding, and gates. Review generated content separately. Metadata
cannot tell whether a question tests a central idea or whether teaching answers it.
For each generated lesson, record these judgments with quoted evidence:

1. Do prequestions target the upcoming objective before instruction?
2. Does the linked teaching address each prequestion?
3. Does assessment require fresh reasoning that matches the objective?
4. Does suitable procedural teaching reduce support toward independent work?
5. Do headings, examples, choices, or diagrams cue graded answers?
6. Does each interaction require a useful mental task?
7. Does the private rubric accept equivalent solutions and specify partial credit?
8. Are strategy distinctions related and kept out of review question cues?
9. Does the rendered diagram match its source and have an accessible description?

Use good and bad cases. Include a prerequisite question disguised as a prequestion,
a copied cloze answer, a novel application, a valid alternate method, a partially
correct explanation, a correct uncertain answer, a hinted answer, and old records.
Run grading cases through dedicated teacher plans and the Pi bridge. Compare point
allocations and feedback with a fixed rubric. Check confidence invariance. Report
leaks and grading disagreements separately from authoring failures.

## Human retention and transfer pilot

Recruit consenting learners. Record prior knowledge before instruction. Explain
what data is saved and how to withdraw. Use unfamiliar parallel questions. Keep
answer keys private. Do not use real learner classrooms for fixture testing.

1. Choose a small set of matched objectives and a retention duration.
2. Predefine question sets, equivalent solutions, and point-level rubrics.
3. Record prior knowledge and assistance. Keep pretest points outside lesson scores.
4. Assign matched objectives to the old and revised approaches where feasible.
   Counterbalance order. Hold study time and content coverage comparable.
5. Measure immediate independent performance with no hints or visible examples.
6. Test delayed retrieval after one week and after the chosen retention duration.
   Record actual elapsed time and study between tests. These test gaps are pilot choices.
7. Test transfer with unfamiliar situations that require method selection and reasoning.
   Do not announce the method. Grade with a reviewer blind to the teaching condition.
8. Record confidence optionally. Compare it with correctness for calibration only.
9. Record time, review workload, errors, incomplete tests, and learner experience.
10. Report item-level results and uncertainty. Separate assisted work, immediate work,
    delayed retrieval, and transfer. Report attrition and repeated-test effects.

Use outcomes to revise question counts, schedule caps, and evidence thresholds.
Compare policies at equal workload when possible. Do not choose the winning policy
from immediate scores alone. A small pilot can find usability problems. It cannot
establish broad scientific validation. No human outcome study has been run for this
redesign. Do not infer human benefit from passing software or agent evaluations.
