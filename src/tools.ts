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
import { createHash } from "node:crypto";

import { reviewKey } from "../assets/runtime/quiz.mjs";
import { applyAnswer, applyGrade } from "./bridge.ts";
import { avoidedUses, htmlText } from "./glossary.ts";
import { healthReport, type LessonHealthInput } from "./health.ts";
import { classroomDir, isValidSlug, lessonDir, slugify, templatesDir } from "./paths.ts";
import {
  authoringSteps,
  missionStub,
  notesStub,
  PRETEST_FOLLOW_UP,
  QUIZ_FOLLOW_UP,
} from "./prompts.ts";
import { authoredQuestions } from "./quiz-authoring.ts";
import { parseRubric } from "./rubric.ts";
import { answersByQuestion, kindOf } from "./quiz.ts";
import { pickReviewItems, relativeDay, REVIEW_INTERVALS_DAYS, summarize } from "./review.ts";
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
  /** Tells the model how to check a lesson and present its URL. */
  checkPage: string;
}

export const PI_HOST: ToolHost = {
  browseHint: "Run /classroom to open it in a browser.",
  checkPage:
    "Call lesson_health for this lesson. It reports unfinished question types and a missing rubric. Check the lesson URL in a headless browser. Look for contract errors and press each local control. Give the learner the lesson URL. Do not open a visible browser window. If the classroom server is not running, ask the learner to run /classroom. If headless checks cannot run, report the specific error and state that the controls were not checked. Do not switch to a visible browser.",
};

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

    {
      name: "record_retrieval_check",
      label: "Record Retrieval Check",
      description:
        "Record demonstrated understanding after a successful chat retrieval check. Link the original review item to an active learning record. Preserve quiz grades and schedule later review. Do not use for material merely covered or an unverified answer.",
      parameters: object({
        classroom: str("Classroom directory name."),
        review_key: str(
          "Original <lesson>/<quiz id>/<question id> from the grade or review schedule.",
        ),
        learning_record: str("Existing active learning record file name, such as 0002-exec.md."),
        answer: str("The learner's actual answer to the new chat question."),
        evidence: str("The new question and why the answer demonstrates the missed idea."),
      }),
      async execute(params: {
        classroom: string;
        review_key: string;
        learning_record: string;
        answer: string;
        evidence: string;
      }) {
        if (!store.readClassroom(params.classroom))
          return fail(`No such classroom: ${params.classroom}`);
        try {
          const check = store.recordRetrievalCheck(params.classroom, {
            key: params.review_key,
            learningRecord: params.learning_record,
            answer: params.answer,
            evidence: params.evidence,
          });
          return ok(
            `Recorded chat evidence for ${check.key}. The quiz grade is preserved. Later review remains scheduled.`,
            { check },
          );
        } catch (err) {
          return fail((err as Error).message);
        }
      },
    },

    // ── grade_lesson_quiz ───────────────────────────────────────────────────────

    {
      name: "grade_lesson_quiz",
      label: "Grade Lesson Quiz",
      description:
        "Grade a quiz a learner submitted from a classroom lesson. The grade is written to the lesson's quiz/grades directory and rendered inline on their page. " +
        "Only call it with a submission_id you were given in a quiz submission notification. " +
        "For a check or review, check a missed idea with a new question in chat. For a pretest, treat errors as diagnostic and continue to teaching without a retrieval check.",
      parameters: object({
        submission_id: str("The submission id from the notification."),
        score: {
          type: "number",
          description:
            "Overall score out of 100. Must equal 100 times total points earned divided by total points possible. Integer rounding is allowed.",
        },
        feedback_markdown: str(
          "Short markdown feedback on the quiz as a whole — what they have, and what to work on.",
        ),
        questions: {
          type: "array",
          description: "One entry per question in the submission.",
          items: object(
            {
              question_id: str("The question id, exactly as given in the notification."),
              correct: {
                type: "boolean",
                description: "True only for full credit. Partial credit is false.",
              },
              points_earned: {
                type: "number",
                description:
                  "Points earned under the quiz rubric. Supply both point fields for every question when using points.",
              },
              points_possible: {
                type: "number",
                description: "Maximum points under the rubric. Must be greater than zero.",
              },
              feedback: str(
                "One or two sentences on this answer. For a wrong answer, name the idea they missed rather than only restating the right answer.",
              ),
            },
            ["points_earned", "points_possible"],
          ),
        },
      }),
      async execute(params: {
        submission_id: string;
        score: number;
        feedback_markdown: string;
        questions: Array<{
          question_id: string;
          correct: boolean;
          feedback: string;
          points_earned?: number;
          points_possible?: number;
        }>;
      }) {
        const submission = store.findSubmission(params.submission_id);
        if (submission?.rubricDigest) {
          const rubric = path.join(
            lessonDir(submission.classroom, submission.lesson),
            "quiz",
            "key.json",
          );
          if (
            !fs.existsSync(rubric) ||
            createHash("sha256").update(fs.readFileSync(rubric)).digest("hex") !==
              submission.rubricDigest
          )
            return fail(
              "The private rubric changed after submission. Restore the original rubric before grading.",
            );
        }
        if (!submission) {
          return fail(`No such submission: ${params.submission_id}`, {
            submissionId: params.submission_id,
          });
        }

        const lesson = store.readLesson(submission.classroom, submission.lesson);
        if (submission.assessmentContract === 1) {
          try {
            if (!lesson) throw new Error("The submitted lesson no longer exists.");
            const rubric = parseRubric(
              fs.readFileSync(
                path.join(lessonDir(submission.classroom, submission.lesson), "quiz", "key.json"),
                "utf8",
              ),
              fs.readFileSync(lesson.htmlPath, "utf8"),
            );
            for (const question of params.questions) {
              const expected = rubric[submission.quizId]?.[question.question_id];
              if (!expected) throw new Error("The question is missing from the private rubric.");
              if (question.points_possible !== expected.points)
                throw new Error(
                  `Use the rubric points for ${question.question_id}: ${expected.points}. Supply points for every question.`,
                );
            }
          } catch (err) {
            return fail(`Invalid assessment rubric: ${(err as Error).message}`);
          }
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
        const unknown = [...graded].filter((id) => !submitted.has(id));
        if (unknown.length > 0) {
          return fail(
            `No such question in the submission: ${unknown.join(", ")}. Use the question ids from the notification.`,
            { unknown },
          );
        }

        let grade: store.QuizGrade;
        try {
          const withPoints = params.questions.some(
            (q) => q.points_earned !== undefined || q.points_possible !== undefined,
          );
          if (
            withPoints &&
            params.questions.some(
              (q) => q.points_earned === undefined || q.points_possible === undefined,
            )
          ) {
            throw new Error(
              "Supply points_earned and points_possible for every question when using points.",
            );
          }
          grade = applyGrade(submission, {
            score: params.score,
            feedbackMarkdown: params.feedback_markdown,
            questions: params.questions.map((q) => ({
              questionId: q.question_id,
              correct: q.correct,
              pointsEarned: q.points_earned,
              pointsPossible: q.points_possible,
              feedback: q.feedback,
            })),
          });
        } catch (err) {
          return fail((err as Error).message);
        }
        const kind = kindOf(submission);
        const reviewKeys =
          kind === "pretest"
            ? []
            : answersByQuestion(submission.answers).map(
                ([questionId, group]) =>
                  group[0].reviewOf ?? reviewKey(submission.lesson, submission.quizId, questionId),
              );
        const incorrectQuestionIds = grade.questions
          .filter((question) => !question.correct)
          .map((question) => question.questionId);

        const notes: string[] = reviewKeys.length
          ? [
              `Review item keys for later chat evidence: ${reviewKeys.join(", ")}. After a successful chat check, write a learning record and call record_retrieval_check for the resolved item.`,
            ]
          : [];
        if (kind === "pretest") {
          notes.push(PRETEST_FOLLOW_UP);
        } else {
          notes.push(
            incorrectQuestionIds.length > 0
              ? `Missed questions: ${incorrectQuestionIds.join(", ")}.\n\n${QUIZ_FOLLOW_UP}`
              : "Every answer is correct. Ask whether the learner is ready to continue before starting the next lesson.",
          );
          notes.push(reviewScheduleLine(submission));
        }

        return ok(
          `Graded ${submission.quizTitle} in ${submission.classroom}/${submission.lesson}: ${Math.round(grade.score)}%. The learner can see it now.\n\n${notes.join("\n\n")}`,
          {
            submissionId: submission.id,
            score: grade.score,
            kind,
            incorrectQuestionIds,
          },
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
        "Create a numbered page and return its path. Use mode lesson for teaching with a pretest, quiz for a quiz-only request, or pretest for a standalone diagnostic. " +
        "The template is a shell with optional example sections, not a fixed lesson script. " +
        "The result lists the authoring steps: read the current quiz contract, state the objective, choose the lesson experience and response types, write the questions, write the private rubric, and check the page. " +
        "Lessons are numbered in the order they are created.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          name: str("Short lesson name; slugified and given a numeric prefix."),
          title: str("Lesson title, shown in the classroom's lesson list."),
          summary: str("One line describing the single win of this lesson."),
          mode: {
            type: "string",
            enum: ["lesson", "quiz", "pretest"],
            description:
              "Default lesson. Use quiz for a quiz or test request. Use pretest for diagnosis only.",
          },
        },
        ["summary", "mode"],
      ),
      async execute(params: {
        classroom: string;
        name: string;
        title: string;
        summary?: string;
        mode?: "lesson" | "quiz" | "pretest";
      }) {
        const mode = params.mode ?? "lesson";
        if (!["lesson", "quiz", "pretest"].includes(mode))
          return fail(`Unknown page mode: ${mode}.`);
        if (!isValidSlug(params.classroom) || !fs.existsSync(classroomDir(params.classroom))) {
          return fail(`No such classroom: ${params.classroom}. Call scaffold_classroom first.`);
        }

        const next = nextLessonNumber(params.classroom);
        const slug = `${String(next).padStart(3, "0")}-${slugify(params.name)}`;
        const dir = lessonDir(params.classroom, slug);
        if (fs.existsSync(dir)) return fail(`Lesson directory already exists: ${dir}`);

        fs.mkdirSync(dir, { recursive: true });

        const template = fs.readFileSync(
          path.join(templatesDir(), mode === "lesson" ? "lesson.html" : "assessment.html"),
          "utf8",
        );
        const htmlPath = path.join(dir, "lesson.html");
        fs.writeFileSync(
          htmlPath,
          template
            .replace(/\{\{LESSON_TITLE\}\}/g, params.title)
            .replace(/\{\{ONE_LINE_SUMMARY\}\}/g, params.summary ?? "")
            .replace(/\{\{QUIZ_KIND\}\}/g, mode === "pretest" ? "pretest" : "check"),
          "utf8",
        );

        store.writeLessonMeta(params.classroom, slug, {
          title: params.title,
          summary: params.summary ?? "",
          createdAt: Date.now(),
          assessmentContract: 1,
        });

        const url = server.urlFor(params.classroom, slug);
        return ok(
          [
            `Created lesson ${slug} in ${params.classroom}.`,
            `Edit: ${htmlPath}`,
            url ? `URL: ${url}` : host.browseHint,
            "",
            authoringSteps(mode, htmlPath, host.checkPage),
          ].join("\n"),
          { classroom: params.classroom, lesson: slug, path: htmlPath, url },
        );
      },
    },

    // ── scaffold_review ─────────────────────────────────────────────────────────

    {
      name: "scaffold_review",
      label: "Scaffold Review",
      description:
        "Create a spaced review session from the questions that are due for review, and return them. " +
        "Each graded question has a review schedule: a correct answer moves it to a longer interval, a wrong answer moves it back to one day. " +
        "Write one new question with a new example for each returned item, and mark it with the given data-review-of key. The result lists the authoring steps. " +
        "Fails when nothing is due.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          limit: {
            type: "number",
            description: `How many due questions to include. Default ${DEFAULT_REVIEW_SIZE}, maximum ${MAX_REVIEW_SIZE}.`,
          },
        },
        ["limit"],
      ),
      async execute(params: { classroom: string; limit?: number }) {
        if (!isValidSlug(params.classroom) || !fs.existsSync(classroomDir(params.classroom))) {
          return fail(`No such classroom: ${params.classroom}.`);
        }
        const limit = params.limit ?? DEFAULT_REVIEW_SIZE;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEW_SIZE) {
          return fail(`limit must be a whole number from 1 to ${MAX_REVIEW_SIZE}.`);
        }

        const now = Date.now();
        const items = store.reviewItems(params.classroom);
        const picked = pickReviewItems(items, now, limit);
        if (picked.length === 0) {
          const summary = summarize(items, now);
          return fail(
            summary.nextDueAt === null
              ? "Nothing is due for review: no question has been graded yet."
              : `Nothing is due for review. The next question is due ${relativeDay(summary.nextDueAt, now)}.`,
          );
        }

        const date = new Date(now).toISOString().slice(0, 10);
        const slug = `${String(nextLessonNumber(params.classroom)).padStart(3, "0")}-review-${date}`;
        const dir = lessonDir(params.classroom, slug);
        if (fs.existsSync(dir)) return fail(`Lesson directory already exists: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });

        const title = `Review: ${date}`;
        const summaryLine = `Spaced review of ${picked.length} earlier question${picked.length === 1 ? "" : "s"}.`;
        const template = fs.readFileSync(path.join(templatesDir(), "review.html"), "utf8");
        const htmlPath = path.join(dir, "lesson.html");
        fs.writeFileSync(
          htmlPath,
          template
            .replace(/\{\{LESSON_TITLE\}\}/g, title)
            .replace(/\{\{ONE_LINE_SUMMARY\}\}/g, summaryLine),
          "utf8",
        );
        store.writeLessonMeta(params.classroom, slug, {
          title,
          summary: summaryLine,
          createdAt: now,
          kind: "review",
          assessmentContract: 1,
        });

        const listing = picked.map((item, i) =>
          [
            `${i + 1}. data-review-of="${item.key}"`,
            `   Interval: box ${item.box + 1} of ${REVIEW_INTERVALS_DAYS.length}, due ${relativeDay(item.dueAt, now)}, ${item.attempts} recorded attempt${item.attempts === 1 ? "" : "s"}.`,
            `   Original question: ${item.prompt || "(question text unavailable)"}`,
            `   Their last answer (${item.lastCorrect ? "correct" : item.lastCredit > 0 ? "partial credit" : "wrong"}): ${item.lastAnswer || "(blank)"}`,
            `   Your last feedback: ${item.lastFeedback}`,
          ].join("\n"),
        );

        const url = server.urlFor(params.classroom, slug);
        return ok(
          [
            `Created review session ${slug} in ${params.classroom}.`,
            `Edit: ${htmlPath}`,
            url ? `URL: ${url}` : host.browseHint,
            "",
            authoringSteps("review", htmlPath, host.checkPage),
            "",
            "Due items:",
            ...listing,
          ].join("\n"),
          {
            classroom: params.classroom,
            lesson: slug,
            path: htmlPath,
            url,
            items: picked.map((item) => item.key),
          },
        );
      },
    },

    // ── lesson_health ───────────────────────────────────────────────────────────

    {
      name: "lesson_health",
      label: "Lesson Health",
      description:
        "Report where lessons did not land: long question threads, quiz questions missed more than once, glossary words to avoid, GLOSSARY.md errors, and the learner's self-explanations. " +
        "Call it before you plan the next lesson, and fix a lesson that keeps failing.",
      parameters: object(
        {
          classroom: str("Classroom directory name."),
          lesson: str("Lesson directory name. Omit it for every lesson in the classroom."),
        },
        ["lesson"],
      ),
      async execute(params: { classroom: string; lesson?: string }) {
        const classroom = store.readClassroom(params.classroom);
        if (!classroom) return fail(`No such classroom: ${params.classroom}.`);

        const lessons = store.listLessons(params.classroom);
        const chosen = params.lesson ? lessons.filter((l) => l.name === params.lesson) : lessons;
        if (params.lesson && chosen.length === 0) {
          return fail(`No such lesson in ${params.classroom}: ${params.lesson}.`);
        }

        const glossary = store.readGlossary(params.classroom);
        // Review answers live in other lessons. Read them before selecting the report.
        const checks = store.listRetrievalChecks(params.classroom);
        const inputs: LessonHealthInput[] = lessons.map((lesson) => {
          const html = fs.readFileSync(lesson.htmlPath, "utf8");
          let rubricError: string | undefined;
          if (lesson.assessmentContract === 1) {
            const rubric = path.join(lessonDir(params.classroom, lesson.name), "quiz", "key.json");
            if (fs.existsSync(rubric)) {
              try {
                parseRubric(fs.readFileSync(rubric, "utf8"), html);
              } catch (err) {
                rubricError = (err as Error).message;
              }
            }
          }
          return {
            lesson: lesson.name,
            title: lesson.title,
            questions: authoredQuestions(html),
            rubricError,
            hasRubric: fs.existsSync(
              path.join(lessonDir(params.classroom, lesson.name), "quiz", "key.json"),
            ),
            annotations: store.listAnnotations(params.classroom, lesson.name),
            submissions: store.listSubmissions(params.classroom, lesson.name),
            grades: store.latestGrades(params.classroom, lesson.name),
            reflections: store.listReflections(params.classroom, lesson.name),
            retrievalChecks: checks.filter((check) => check.key.split("/")[0] === lesson.name),
            avoided: avoidedUses(htmlText(html), glossary),
          };
        });

        return ok(healthReport(params.classroom, inputs, glossary.errors, params.lesson), {
          classroom: params.classroom,
          lessons: chosen.map((l) => l.name),
          glossaryErrors: glossary.errors,
        });
      },
    },
  ];
}

export const DEFAULT_REVIEW_SIZE = 5;
export const MAX_REVIEW_SIZE = 12;

/** When each question in a graded submission comes up for review next. */
function reviewScheduleLine(submission: store.QuizSubmission): string {
  const now = Date.now();
  const items = new Map(store.reviewItems(submission.classroom).map((item) => [item.key, item]));
  const parts = answersByQuestion(submission.answers).map(([questionId, group]) => {
    const key = group[0].reviewOf ?? reviewKey(submission.lesson, submission.quizId, questionId);
    const item = items.get(key);
    if (!item) throw new Error(`No review item for ${key} after grading it.`);
    return `${questionId} ${relativeDay(item.dueAt, now)}`;
  });
  return `Next review: ${parts.join(", ")}.`;
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
