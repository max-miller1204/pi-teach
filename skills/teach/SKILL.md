---
name: teach
description: Teach a topic or create challenging quizzes and tests in the classroom web UI. Use when the user asks to learn, study, continue lessons, or make a quiz, test, or pretest.
---

# Teach

1. Find the topic in the user's request. If they named none, they want to continue
   where they left off.
2. Call the `begin_teaching` tool from the `classroom` MCP server. Pass the topic as
   `topic`, or omit it to continue.
3. Follow the method that `begin_teaching` returns. It is the full teaching brief.
4. Before you give the learner a lesson URL, call `open_classroom` with
   `open_browser: false`. Give the learner the link. Do not open a browser when
   starting or continuing a lesson.
5. The persistent service selects a dedicated teacher for each classroom. Use the
   initiating host or pass teacher_backend explicitly to `open_classroom`. Do not
   change an existing classroom's backend.
6. Browser questions and quiz submissions start teacher work when they arrive.
   The initiating chat can end. Do not run a wait loop or a looping subagent.
7. The dedicated teacher answers and grades through the service. Its results reach
   the page through the service's SSE connection.
8. After a wrong answer on a check or review, use the teacher panel on the lesson page for the retrieval
   question and learner reply. Keep the graded quiz locked. Preserve grades and
   attempts. Record learning only after demonstrated understanding.
9. Do not start the next lesson without learner agreement. Use `classroom_service`
   to inspect or explicitly stop the service. For requested phone access, use
   `classroom_phone` with action start and the classroom and lesson. Give the full
   checked URL it returns. Use status or stop to inspect or remove its route.
10. When `begin_teaching` reports questions due for review, offer a review before new
    material. Create it with `scaffold_review`.
11. Before you plan a lesson, call `lesson_health`. Fix a lesson that keeps failing.
12. Create each lesson with `scaffold_lesson` and each review with `scaffold_review`.
    Use mode quiz for an explicit quiz or test request. Keep it assessment-only.
    Use mode pretest for a standalone diagnostic. New lessons start with a pretest
    by default. Keep teaching and later checks behind its server gate.
    Ask prequestions about central ideas in the UPCOMING lesson. Invite a prediction,
    explanation, or attempted solution before instruction. Wrong answers are expected.
    Prior-topic retrieval and prerequisite diagnostics cannot replace prequestions.
    Map questions and teaching in private quiz/plan.json. Read TEACHING-PLAN.md.
    The gate releases prewritten teaching. The teacher can clarify and stress ideas
    in feedback. It cannot rewrite that teaching.
    Treat pretest errors as diagnostic. Do not run a retrieval check after them.
    Follow the authoring steps they return. Read the current quiz contract each time.
    Check each lesson in a headless browser before giving the learner its link.
    Follow the scaffold instructions for the headless config and test session.
    Do not open a visible browser window. Report a headless check failure.
    State when controls were not checked.
    The lesson template is a shell. Design the lesson from its objective and the
    learner. Choose response types that fit each skill.
    Plan the mental work before choosing types. Test recall, reasoning, and transfer
    with new situations. Do not build a test from copied sentences or easy blanks.
    For suitable new procedures, move from a worked example to principle-focused
    self-explanation, faded completion, and independent practice. Adjust support
    to demonstrated knowledge. Do not require one fixed layout or a type quota.
    Use Mermaid to inspect relationships. Keep a text description beside it.
    Inspect the rendered diagram and the source sent to grading.
    Inspect the page for answer cues before sharing it.
13. Write the private quiz rubric before submission. Use it for every attempt.
    For partial credit, supply points for every question. Keep the overall score
    consistent with those points.

The dedicated teacher puts passage answers on the page. Retrieval questions and
learner replies use the teacher panel. Pi keeps its live-session bridge.

Confidence is optional. It informs feedback only. Record assistance honestly.
Immediate correction is not delayed retention. Application objectives need transfer
evidence. See EVIDENCE.md for sources and design choices. See EVALUATION.md for
agent checks and the separate human learning protocol.
