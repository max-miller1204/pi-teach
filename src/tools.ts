/**
 * tools.ts — the tools the teacher uses to reach the learner's browser.
 *
 * `answer_lesson_question` and `grade_lesson_quiz` are the only way an answer or a
 * grade appears on the page; the scaffold tools exist so the canonical directory
 * layout is created correctly without the model having to remember it.
 *
 * The definitions are host-agnostic: Pi registers them as extension tools, and the MCP
 * server (`src/mcp.ts`) lists them for Claude Code and Codex. Parameters are plain JSON
 * Schema, which Pi's validator compiles as-is.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { applyAnswer, applyGrade } from "./bridge.ts";
import { classroomDir, isValidSlug, lessonDir, slugify, templatesDir } from "./paths.ts";
import { missionStub, notesStub } from "./prompts.ts";
import * as server from "./server.ts";
import * as store from "./store.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

export interface ClassroomTool {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
  execute(params: any): Promise<ToolResult>;
}

/** What differs between the hosts that run these tools. */
export interface ToolHost {
  /** Tells the model how to show a classroom when the server is not running. */
  browseHint: string;
}

export const PI_HOST: ToolHost = { browseHint: "Run /classroom to open it in a browser." };

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    details: { error: true, ...details },
  };
}

/** Whether a tool result reports a failure. */
export function isFailure(result: ToolResult): boolean {
  return result.details["error"] === true;
}

export function registerClassroomTools(pi: any): void {
  for (const tool of classroomTools(PI_HOST)) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: (_toolCallId: string, params: unknown) => tool.execute(params),
    });
  }
}

/** JSON Schema helpers, kept tiny so the definitions below stay readable. */
function str(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function object(
  properties: Record<string, Record<string, unknown>>,
  optional: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
  };
}

export function classroomTools(host: ToolHost): ClassroomTool[] {
  return [
    // ── answer_lesson_question ──────────────────────────────────────────────────

    {
      name: "answer_lesson_question",
      label: "Answer Lesson Question",
      description:
        "Answer a question a learner asked by highlighting text in a classroom lesson. " +
        "The answer appears in a card pinned to the passage they highlighted — this tool is the only thing that puts it on their screen. " +
        "A card is a thread: the answer attaches to whichever turn is still waiting, so the same annotation_id answers the original question and every follow-up asked in that card. " +
        "Only call it with an annotation_id you were given in a classroom question notification.",
      parameters: object({
        annotation_id: str("The annotation id from the question or follow-up notification."),
        answer_markdown: str(
          "The answer, as markdown. Renders in a narrow card, so favour a few short paragraphs over headings and long lists.",
        ),
      }),
      async execute(params: { annotation_id: string; answer_markdown: string }) {
        const annotation = store.findAnnotation(params.annotation_id);
        if (!annotation) {
          return fail(`No such question: ${params.annotation_id}`, {
            annotationId: params.annotation_id,
          });
        }
        const answer = params.answer_markdown.trim();
        if (!answer) return fail("answer_markdown is empty.");

        // Resolved before the write, so the message can name the turn that was answered.
        const turn = store.answerTarget(annotation);
        const asked =
          turn === null
            ? annotation.question
            : ((annotation.followUps ?? []).find((f) => f.id === turn)?.question ??
              annotation.question);

        const updated = applyAnswer(params.annotation_id, answer);
        if (!updated) return fail(`Could not save the answer for ${params.annotation_id}.`);

        return ok(
          `Answered ${turn === null ? "" : "the follow-up "}"${truncate(asked, 80)}" in ${annotation.classroom}/${annotation.lesson}. It is on the learner's page now.`,
          {
            annotationId: updated.id,
            classroom: updated.classroom,
            lesson: updated.lesson,
            followUpId: turn,
          },
        );
      },
    },

    // ── grade_lesson_quiz ───────────────────────────────────────────────────────

    {
      name: "grade_lesson_quiz",
      label: "Grade Lesson Quiz",
      description:
        "Grade a quiz a learner submitted from a classroom lesson. The grade is written to the lesson's quiz/grades directory and rendered inline on their page. " +
        "Only call it with a submission_id you were given in a quiz submission notification.",
      parameters: object({
        submission_id: str("The submission id from the notification."),
        score: { type: "number", description: "Overall score out of 100." },
        feedback_markdown: str(
          "Short markdown feedback on the quiz as a whole — what they have, and what to work on.",
        ),
        questions: {
          type: "array",
          description: "One entry per question in the submission.",
          items: object({
            question_id: str("The question id, exactly as given in the notification."),
            correct: { type: "boolean", description: "Whether the learner's answer was correct." },
            feedback: str(
              "One or two sentences on this answer. For a wrong answer, name the idea they missed rather than only restating the right answer.",
            ),
          }),
        },
      }),
      async execute(params: {
        submission_id: string;
        score: number;
        feedback_markdown: string;
        questions: Array<{ question_id: string; correct: boolean; feedback: string }>;
      }) {
        const submission = store.findSubmission(params.submission_id);
        if (!submission) {
          return fail(`No such submission: ${params.submission_id}`, {
            submissionId: params.submission_id,
          });
        }

        const submitted = new Set(submission.answers.map((a) => a.questionId));
        const graded = new Set(params.questions.map((q) => q.question_id));
        const missing = [...submitted].filter((id) => !graded.has(id));
        if (missing.length > 0) {
          return fail(
            `Missing feedback for: ${missing.join(", ")}. Grade every question in the submission.`,
            { missing },
          );
        }

        const grade = applyGrade(submission, {
          score: params.score,
          feedbackMarkdown: params.feedback_markdown,
          questions: params.questions.map((q) => ({
            questionId: q.question_id,
            correct: q.correct,
            feedback: q.feedback,
          })),
        });

        return ok(
          `Graded ${submission.quizTitle} in ${submission.classroom}/${submission.lesson}: ${Math.round(grade.score)}%. The learner can see it now.`,
          { submissionId: submission.id, score: grade.score },
        );
      },
    },

    // ── scaffold_classroom ──────────────────────────────────────────────────────

    {
      name: "scaffold_classroom",
      label: "Scaffold Classroom",
      description:
        "Create a classroom in the canonical location (~/.pi/agent/classrooms/<name>/) with MISSION.md and NOTES.md stubs. " +
        "Call this once at the start of teaching a new topic, before writing any lesson.",
      parameters: object(
        {
          name: str("Topic or classroom name; it is slugified into a directory name."),
          title: str("Display title. Defaults to the name."),
          emoji: str("One emoji shown on the classroom card."),
        },
        ["title", "emoji"],
      ),
      async execute(params: { name: string; title?: string; emoji?: string }) {
        const slug = slugify(params.name);
        const dir = classroomDir(slug);
        const existed = fs.existsSync(dir);

        fs.mkdirSync(dir, { recursive: true });
        const title = params.title?.trim() || store.titleFromSlug(slug);

        if (!existed) {
          store.writeClassroomMeta(slug, {
            title,
            emoji: params.emoji?.trim() || "📚",
            createdAt: Date.now(),
          });
        }

        const missionPath = path.join(dir, "MISSION.md");
        if (!fs.existsSync(missionPath)) fs.writeFileSync(missionPath, missionStub(title), "utf8");
        const notesPath = path.join(dir, "NOTES.md");
        if (!fs.existsSync(notesPath)) fs.writeFileSync(notesPath, notesStub(), "utf8");

        return ok(
          [
            `${existed ? "Classroom already existed" : "Created classroom"}: ${slug}`,
            `Directory: ${dir}`,
            `Mission: ${missionPath}${existed ? "" : " (a stub — interview the learner and fill in Why before writing lessons)"}`,
            server.urlFor(slug) ? `URL: ${server.urlFor(slug)}` : host.browseHint,
          ].join("\n"),
          { classroom: slug, dir, existed },
        );
      },
    },

    // ── scaffold_lesson ─────────────────────────────────────────────────────────

    {
      name: "scaffold_lesson",
      label: "Scaffold Lesson",
      description:
        "Create a lesson directory from the canonical template and return its path. " +
        "Write the actual lesson by editing the returned lesson.html — it contains the quiz markup contract in comments. " +
        "Lessons are numbered in the order they are created.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          name: str("Short lesson name; slugified and given a numeric prefix."),
          title: str("Lesson title, shown in the classroom's lesson list."),
          summary: str("One line describing the single win of this lesson."),
        },
        ["summary"],
      ),
      async execute(params: { classroom: string; name: string; title: string; summary?: string }) {
        if (!isValidSlug(params.classroom) || !fs.existsSync(classroomDir(params.classroom))) {
          return fail(`No such classroom: ${params.classroom}. Call scaffold_classroom first.`);
        }

        const next = nextLessonNumber(params.classroom);
        const slug = `${String(next).padStart(3, "0")}-${slugify(params.name)}`;
        const dir = lessonDir(params.classroom, slug);
        if (fs.existsSync(dir)) return fail(`Lesson directory already exists: ${dir}`);

        fs.mkdirSync(dir, { recursive: true });

        const template = fs.readFileSync(path.join(templatesDir(), "lesson.html"), "utf8");
        const htmlPath = path.join(dir, "lesson.html");
        fs.writeFileSync(
          htmlPath,
          template
            .replace(/\{\{LESSON_TITLE\}\}/g, params.title)
            .replace(/\{\{ONE_LINE_SUMMARY\}\}/g, params.summary ?? ""),
          "utf8",
        );

        store.writeLessonMeta(params.classroom, slug, {
          title: params.title,
          summary: params.summary ?? "",
          createdAt: Date.now(),
        });

        const url = server.urlFor(params.classroom, slug);
        return ok(
          [
            `Created lesson ${slug} in ${params.classroom}.`,
            `Edit: ${htmlPath}`,
            `Quiz markup contract: ${path.join(templatesDir(), "quiz.html")}`,
            url ? `URL: ${url}` : host.browseHint,
          ].join("\n"),
          { classroom: params.classroom, lesson: slug, path: htmlPath, url },
        );
      },
    },
  ];
}

/** One past the highest numeric prefix already used in the classroom. */
function nextLessonNumber(classroom: string): number {
  const used = store
    .listLessonDirs(classroom)
    .map((name) => store.orderPrefix(name))
    .filter((n): n is number => n !== null);
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}
