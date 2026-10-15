---
name: classroom
description: Give the user a link to their classrooms, or list their classrooms and lessons with quiz scores. Use when the user asks to see, open, browse, or list their lessons or classrooms.
---

# Classroom

- To open the classrooms, call `open_classroom` from the `classroom` MCP server.
  Pass a classroom name as `classroom` to open that classroom. Give the user the
  URL it returns. Never open a browser for the user.
- To list classrooms and lessons in the terminal, call `list_classrooms`.

Claude Code and Codex attach to a persistent local service. Closing this chat does
not stop it. Each classroom has one dedicated teacher backend and session. Browser
requests start teacher work. Use the teacher panel for retrieval questions and replies.
Pi keeps its in-process server and direct bridge.

- Use `classroom_service` with action status to inspect ownership, the stable URL,
  and the tailnet route.
- Use action stop to stop the service explicitly. It removes the tailnet route.
  Material and grades stay on disk.
- When Tailscale is connected, `open_classroom` returns a checked tailnet-only link
  that also works on a phone. Give it as returned. The learner turns tailnet links
  off or changes their port in `classroom.json`.
- If a port or route conflicts, report the error. Do not select another port silently.
