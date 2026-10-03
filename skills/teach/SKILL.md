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
5. After you give the learner a lesson, call `wait_for_learner`. Answer each question
   with `answer_lesson_question` and grade each quiz with `grade_lesson_quiz`. Then
   call `wait_for_learner` again.

Do not answer the learner's lesson questions in chat. Only the tools put an answer on
their page.
