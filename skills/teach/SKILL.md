---
name: teach
description: Teach the user a topic one short interactive lesson at a time, in a local web UI where they can highlight any passage to ask about it and hand in quizzes to be graded. Use when the user asks to learn, study, or be taught something, or to continue their lessons.
---

# Teach

1. Find the topic in the user's request. If they named none, they want to continue
   where they left off.
2. Call the `begin_teaching` tool from the `classroom` MCP server. Pass the topic as
   `topic`, or omit it to continue.
3. Follow the method that `begin_teaching` returns. It is the full teaching brief.
4. Before you give the learner a lesson URL, call `open_classroom`.
5. After you give the learner a lesson, call `wait_for_learner`. Use at most 60
   seconds. If it times out, say that listening has paused and end your turn.
   Resume when the learner asks to continue. Browser requests cannot wake an idle
   MCP agent. Reopen the classroom after a restart to recover pending requests.
6. Answer page questions with `answer_lesson_question`.
7. Grade quizzes with `grade_lesson_quiz`. Treat a pretest as diagnostic. Follow
   the shared quiz follow-up rule from `begin_teaching` and the grading result.
8. After a wrong answer, explain the missed idea and ask one new retrieval question
   in chat with a different example. Keep the graded browser quiz locked. Review
   the idea later through spaced review. End your turn and wait for the learner's
   chat reply. Do not call `wait_for_learner` while you need that reply. Check
   understanding before moving on. Write a learning record after a successful
   check. Call `record_retrieval_check` to link that evidence to the original
   review item. Keep historical scores and attempts.
9. Resume `wait_for_learner` when the learner returns to the page. Do not start the
   next lesson without their agreement.
10. When `begin_teaching` reports questions due for review, offer a review before new
    material. Create it with `scaffold_review`.
11. Before you plan a lesson, call `lesson_health`. Fix a lesson that keeps failing.
12. Create each lesson with `scaffold_lesson` and each review with `scaffold_review`.
    Follow the authoring steps they return. Read the current quiz contract each time.
    The lesson template is a shell. Design the lesson from its objective and the
    learner. Choose response types that fit each skill.
13. Write the private quiz rubric before submission. Use it for every attempt.
    For partial credit, supply points for every question. Keep the overall score
    consistent with those points.

Do not answer the learner's highlighted-passage questions only in chat. Only
`answer_lesson_question` puts those answers on their page. Your retrieval questions
and the learner's replies belong in chat.
