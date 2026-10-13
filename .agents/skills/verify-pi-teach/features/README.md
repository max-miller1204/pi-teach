# Feature checks

Start with the shared [launch and doctor instructions](../SKILL.md). Each browser run uses fresh scratch classrooms. Real host checks require model access. Keep one evidence directory per run.

| Feature              | Recipe                   | Entry points                                             |
| -------------------- | ------------------------ | -------------------------------------------------------- |
| Read and ask         | [reading.md](reading.md) | Lesson text, quiz text, cards, glossary, diagrams, theme |
| Answer quizzes       | [quizzes.md](quizzes.md) | Quiz controls, pretest gate, reload, second tab          |
| Teacher conversation | [teacher.md](teacher.md) | Pi and service panels, explicit retry, MCP reconnect     |

Coverage gaps: the phone target changes a real Tailscale Serve route. Run it only for phone changes with an available tailnet. It was not exercised during this setup. Feedback and quality targets remain separate model evaluations. This map does not claim they ran. Landing-page navigation and human retention are outside these browser recipes. Use the HTTP tests and [evaluation protocol](../../../../docs/EVALUATION.md) for those boundaries.
