# Feature checks

Start with the shared [launch and doctor instructions](../SKILL.md). Each browser run uses fresh scratch classrooms. Real host checks require model access. Keep one evidence directory per run.

| Feature              | Recipe                   | Entry points                                                   |
| -------------------- | ------------------------ | -------------------------------------------------------------- |
| Read and ask         | [reading.md](reading.md) | Lesson text, quiz text, cards, glossary, diagrams, math, theme |
| Answer quizzes       | [quizzes.md](quizzes.md) | Quiz controls, pretest gate, reload, second tab                |
| Start a review       | [review.md](review.md)   | Classroom progress, durable authoring, explicit retry          |
| Teacher conversation | [teacher.md](teacher.md) | Pi and service panels, explicit retry, MCP reconnect           |

Tailnet links: `npm run verify -- phone` changes a real Tailscale Serve route. Run it only for link or phone changes with a connected tailnet. It checks the automatic classroom and lesson links from `open_classroom`, the route in `classroom_service` status, removal after `"tailscale": false`, removal on service stop, and unchanged unrelated routes. Set `PI_TEACH_PHONE_PORT` to a free HTTPS port when 8443 holds another route. No repository harness drives Pi's tailnet route yet. Pi `/classroom` tailnet links, session-end cleanup, and stale route replacement need a manual drive.

Coverage gaps: Feedback and quality targets remain separate model evaluations. This map does not claim they ran. Other landing-page navigation and human retention are outside these browser recipes. Use the HTTP tests and [evaluation protocol](../../../../docs/EVALUATION.md) for those boundaries.
