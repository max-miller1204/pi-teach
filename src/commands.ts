/**
 * commands.ts — /classroom and /teach.
 *
 * /classroom manages the local server and opens pages in a browser.
 * /teach is the entry point to a teaching session, and replaces the old teach skill.
 *
 * Anything here that starts or stops the server also refreshes the status widget, so the
 * "running on port N" line never outlives (or lags behind) the server it describes.
 */

import * as fs from "node:fs";

import { shouldAutoOpen } from "./config.js";
import { openUrl } from "./open-browser.js";
import { classroomDir, slugify } from "./paths.js";
import { teachingPrompt } from "./prompts.js";
import * as server from "./server.js";
import { attachStatusWidget, refreshStatusWidget } from "./status-widget.js";
import * as store from "./store.js";
import type { ClassroomBridge } from "./bridge.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal shape of the pi API used here, so tests can pass a stub. */
export interface CommandHost {
  registerCommand(name: string, spec: unknown): void;
  sendUserMessage(text: string, options?: { deliverAs?: string }): void;
}

export function registerClassroomCommands(pi: any, bridge: ClassroomBridge): void {
  // ── /classroom ──────────────────────────────────────────────────────────────

  pi.registerCommand("classroom", {
    description:
      "Browse your classrooms in the browser. Usage: /classroom [start|stop|status|list|open [<name>]]",
    getArgumentCompletions: async (prefix: string) => {
      const verbs = ["start", "stop", "status", "list", "open"];
      const names = store.listClassrooms().map((c) => c.name);
      const matches = [...verbs, ...names].filter((v) => v.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const trimmed = (args ?? "").trim();
      const [verb, ...rest] = trimmed.split(/\s+/).filter(Boolean);
      const argument = rest.join(" ");

      switch (verb) {
        case undefined:
          return handleOpen(ctx, null);
        case "start":
          return handleStart(ctx);
        case "stop":
          return handleStop(ctx);
        case "status":
          return handleStatus(ctx);
        case "list":
          return handleList(ctx);
        case "open":
          return handleOpen(ctx, argument || null);
        default:
          // A bare name is the common case: /classroom rust-ownership
          return handleOpen(ctx, trimmed);
      }
    },
  });

  // ── /teach ──────────────────────────────────────────────────────────────────

  pi.registerCommand("teach", {
    description:
      "Learn something, one short lesson at a time. Usage: /teach [<topic or classroom name>]",
    getArgumentCompletions: async (prefix: string) => {
      const names = store.listClassrooms().map((c) => c.name);
      const matches = names.filter((name) => name.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: any) => {
      const topic = (args ?? "").trim();
      const classroom = resolveClassroom(topic);

      // The teaching turn is a normal turn, but the bridge's FIFO must stay aligned
      // with agent_end or a later answer would be attributed to the wrong run.
      bridge.noteForeignTurn();
      const prompt = teachingPrompt(topic, classroom);
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });

      const baseUrl = server.getBaseUrl();
      ctx.ui.notify(
        classroom
          ? `📚 Continuing ${classroom}${baseUrl ? ` — ${server.urlFor(classroom)}` : " (run /classroom to open it)"}`
          : "📚 Starting a new classroom. Expect some questions about why you want to learn this.",
        "info",
      );
    },
  });
}

/**
 * Match free text to an existing classroom.
 *
 * Exact directory name first, then the slugified topic, then a title match — a user
 * typing "/teach rust ownership" should land back in the classroom they already have.
 */
export function resolveClassroom(topic: string): string | null {
  if (!topic) {
    const classrooms = store.listClassrooms();
    return classrooms.length === 1 ? classrooms[0].name : null;
  }

  const classrooms = store.listClassrooms();
  const slug = slugify(topic);
  const byName = classrooms.find((c) => c.name === topic || c.name === slug);
  if (byName) return byName.name;

  const byTitle = classrooms.find((c) => c.title.toLowerCase() === topic.toLowerCase());
  return byTitle?.name ?? null;
}

// ── /classroom handlers ───────────────────────────────────────────────────────

async function handleStart(ctx: any): Promise<void> {
  if (server.isRunning()) {
    ctx.ui.notify(`Classroom server already running at ${server.getBaseUrl()}`, "info");
    return;
  }
  const baseUrl = await server.start();
  // Reason: session_start may have run before any server existed, so every command that
  // starts or stops the server re-adopts this session's UI and redraws the widget.
  attachStatusWidget(ctx.ui);
  ctx.ui.notify(`Classroom server started at ${baseUrl}`, "info");
}

async function handleStop(ctx: any): Promise<void> {
  if (!server.isRunning()) {
    ctx.ui.notify("Classroom server is not running.", "info");
    return;
  }
  await server.close();
  refreshStatusWidget();
  ctx.ui.notify("Classroom server stopped.", "info");
}

function handleStatus(ctx: any): void {
  const baseUrl = server.getBaseUrl();
  const classrooms = store.listClassrooms();
  const lessons = classrooms.reduce((sum, c) => sum + c.lessonCount, 0);
  ctx.ui.notify(
    baseUrl
      ? `Classroom server running at ${baseUrl}\n${classrooms.length} classroom${classrooms.length === 1 ? "" : "s"}, ${lessons} lesson${lessons === 1 ? "" : "s"}`
      : `Classroom server is not running. ${classrooms.length} classroom${classrooms.length === 1 ? "" : "s"} on disk — run /classroom to browse them.`,
    "info",
  );
}

function handleList(ctx: any): void {
  const classrooms = store.listClassrooms();
  if (classrooms.length === 0) {
    ctx.ui.notify("No classrooms yet. Run /teach <topic> to start one.", "info");
    return;
  }

  const lines = ["📚 **Classrooms**", ""];
  for (const classroom of classrooms) {
    lines.push(`${classroom.emoji} **${classroom.title}**  \`${classroom.name}\``);
    for (const lesson of store.listLessons(classroom.name)) {
      const score = lesson.latestScore !== null ? `  ·  ${Math.round(lesson.latestScore)}%` : "";
      const pending = lesson.hasUngradedSubmission ? "  ·  awaiting grading" : "";
      lines.push(
        `   ${String(lesson.order ?? 0).padStart(3, "0")}  ${lesson.title}${score}${pending}`,
      );
    }
    if (classroom.lessonCount === 0) lines.push("   (no lessons yet)");
    lines.push("");
  }
  ctx.ui.notify(lines.join("\n").trimEnd(), "info");
}

async function handleOpen(ctx: any, requested: string | null): Promise<void> {
  let target = requested;

  if (target && !fs.existsSync(classroomDir(target))) {
    const resolved = resolveClassroom(target);
    if (!resolved) {
      ctx.ui.notify(`No such classroom: ${target}. Try /classroom list.`, "error");
      return;
    }
    target = resolved;
  }

  // With no argument and several classrooms, let the user pick rather than guessing.
  if (!target && ctx.hasUI) {
    const classrooms = store.listClassrooms();
    if (classrooms.length > 1) {
      const items = [
        "All classrooms",
        ...classrooms.map((c) => `${c.emoji} ${c.title}  (${c.name})`),
      ];
      const selected = await ctx.ui.select("Open which classroom?", items);
      if (!selected) return;
      if (selected !== "All classrooms") {
        target = selected.slice(selected.lastIndexOf("(") + 1, -1);
      }
    }
  }

  const baseUrl = await server.start();
  attachStatusWidget(ctx.ui);
  const url = target ? server.urlFor(target)! : baseUrl;
  if (shouldAutoOpen()) openUrl(url);
  ctx.ui.notify(`📚 ${url}`, "info");
}
