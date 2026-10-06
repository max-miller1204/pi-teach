---
name: classroom
description: Open the user's classrooms in the browser, or list their classrooms and lessons with quiz scores. Use when the user asks to see, open, browse, or list their lessons or classrooms.
---

# Classroom

- To open the classrooms in a browser, call `open_classroom` from the `classroom` MCP
  server with `open_browser: true`. Pass a classroom name as `classroom` to open
  that classroom. Give the user the URL it returns.
- To list classrooms and lessons in the terminal, call `list_classrooms`.

Claude Code and Codex attach to a persistent local service. Closing this chat does
not stop it. Each classroom has one dedicated teacher backend and session. Browser
requests start teacher work. Use the teacher panel for retrieval questions and replies.
Pi keeps its in-process server and direct bridge.

- Use `classroom_service` with action status to inspect ownership and the stable URL.
- Use action stop to stop the service explicitly. Material and grades stay on disk.
- When the learner asks for phone access, call `classroom_phone` with action start,
  classroom, and lesson. Give the complete checked URL it returns. This opts in to
  tailnet-only Tailscale Serve. Use status to inspect it. Use stop to remove its route.
- If a port or route conflicts, report the error. Do not select another port silently.
