---
name: classroom
description: Open the user's classrooms in the browser, or list their classrooms and lessons with quiz scores. Use when the user asks to see, open, browse, or list their lessons or classrooms.
---

# Classroom

- To open the classrooms in a browser, call `open_classroom` from the `classroom` MCP
  server. Pass a classroom name as `classroom` to open that classroom. Give the user the
  URL it returns.
- To list classrooms and lessons in the terminal, call `list_classrooms`.

The classroom server runs inside this session. It stops when the session ends. All
material stays on disk.

If the user will read a lesson now, call `wait_for_learner` after you give them the
URL, so their questions and quizzes reach you.
