/**
 * Classroom Extension
 *
 * A teacher you can interrupt. Lessons are self-contained HTML documents stored under
 * ~/.pi/agent/classrooms/; a local server presents them, and wires the page back to
 * the agent running in this session so a learner can highlight any passage to ask
 * about it, and hand in a quiz to be graded.
 *
 * Commands:
 *   /teach [<topic>]  — start or continue learning something
 *   /classroom        — browse your classrooms in a browser
 *
 * While the server is up, a widget below the editor reads
 * "📚 classroom server running on port <port>", so it is obvious which session holds
 * the teacher a learner's browser is talking to.
 *
 * Tools:
 *   answer_lesson_question — answer a highlighted-text question (renders in the card)
 *   grade_lesson_quiz      — grade a submitted quiz (renders inline in the lesson)
 *   scaffold_classroom     — create a classroom in the canonical location
 *   scaffold_lesson        — create a lesson from the canonical template
 *   scaffold_review        : create a spaced review session from the due questions
 *   lesson_health          : report the passages and questions that did not land
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ClassroomBridge } from "./src/bridge.ts";
import { registerClassroomCommands } from "./src/commands.ts";
import * as server from "./src/server.ts";
import { attachStatusWidget, detachStatusWidget } from "./src/status-widget.ts";
import { registerClassroomTools } from "./src/tools.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function classroomExtension(pi: ExtensionAPI): void {
  const bridge = new ClassroomBridge(
    pi as unknown as { sendUserMessage(text: string, o?: any): void },
  );

  server.setHooks({
    onAsk: (annotation) => bridge.ask(annotation),
    onFollowUp: (annotation, followUp) => bridge.followUp(annotation, followUp),
    onQuizSubmit: (submission) => bridge.grade(submission),
    onReflect: (reflection) => bridge.reflect(reflection),
  });

  registerClassroomTools(pi);
  registerClassroomCommands(pi, bridge);

  // The idle probe lives on the session context, which is only handed to handlers —
  // capture it once so the bridge can decide between waking the agent and queueing.
  pi.on("session_start", async (_event, ctx) => {
    bridge.setIdleProbe(() => ctx.isIdle());
    // Also adopts the UI for the "server running on port N" widget, so a resumed session
    // that is already serving says so without waiting for a /classroom command.
    attachStatusWidget(ctx.ui as any);
  });

  // Typed inputs start turns too. Recording them keeps the origin FIFO aligned with
  // agent_end, so an answer is never attributed to somebody else's run.
  pi.on("input", async (event: any) => {
    if (event?.source === "interactive") bridge.noteForeignTurn();
  });

  pi.on("agent_end", async (event: any) => {
    bridge.onAgentEnd((event?.messages ?? []) as unknown[]);
  });

  pi.on("session_shutdown", async () => {
    bridge.reset();
    detachStatusWidget();
    await server.close();
  });
}
