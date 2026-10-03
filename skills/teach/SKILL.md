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
5. After you give the learner a lesson, call `wait_for_learner`.
6. Answer page questions with `answer_lesson_question`.
7. Grade quizzes with `grade_lesson_quiz`. Follow the shared quiz follow-up rule from
   `begin_teaching` and the grading result.
8. After a wrong answer, explain the missed idea and ask one new retrieval question
   in chat. End your turn and wait for the learner's chat reply. Do not call
   `wait_for_learner` while you need that reply. Check understanding before moving on.
9. Resume `wait_for_learner` when the learner returns to the page. Do not start the
   next lesson without their agreement.

Do not answer the learner's highlighted-passage questions only in chat. Only
`answer_lesson_question` puts those answers on their page. Your retrieval questions
and the learner's replies belong in chat.
