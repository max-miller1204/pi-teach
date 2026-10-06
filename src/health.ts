/**
 * health.ts: the lesson health report: where a lesson did not land.
 *
 * Pure. The `lesson_health` tool reads the data and passes it in. A question is
 * signal, a long thread is louder signal, and a question missed again and again is
 * the loudest. This report puts those in one place so the teacher can fix the lesson
 * instead of only answering around it.
 */

import { questionOutcome } from "../assets/runtime/grade.mjs";
import { isQuestionType, parseReviewKey, reviewKey } from "../assets/runtime/quiz.mjs";
import {
  quizDiversityLines,
  typeCounts,
  unfinishedQuestionLines,
  type AuthoredQuestion,
} from "./quiz-authoring.ts";
import { answersByQuestion, kindOf, type QuestionType } from "./quiz.ts";
import type { AvoidedUse } from "./glossary.ts";
import type { Annotation, QuizGrade, QuizSubmission, Reflection, RetrievalCheck } from "./store.ts";

export interface LessonHealthInput {
  lesson: string;
  title: string;
  annotations: Annotation[];
  /** Every submission in the lesson, oldest first. */
  submissions: QuizSubmission[];
  /** The newest grade for each submission, from `store.latestGrades`. */
  grades: QuizGrade[];
  reflections: Reflection[];
  avoided: AvoidedUse[];
  retrievalChecks?: RetrievalCheck[];
  /** The `.cl-q` elements in the lesson document, as authored. */
  questions?: AuthoredQuestion[];
  /** Whether the lesson has a private `quiz/key.json` rubric. */
  hasRubric?: boolean;
  rubricError?: string;
  alignmentError?: string;
}

/** How many recent lessons the response type summary lists. */
export const RECENT_LESSONS = 5;

function questionTypes(input: LessonHealthInput): QuestionType[] {
  return (input.questions ?? [])
    .map((q) => q.type)
    .filter((type): type is QuestionType => isQuestionType(type));
}

/** A card with this many turns or more is a hotspot: the passage did not land. */
export const HOTSPOT_TURNS = 3;

/** A question missed this many times or more needs a lesson change, not one more answer. */
export const REPEAT_MISS = 2;

interface QuestionStats {
  lesson: string;
  quizId: string;
  questionId: string;
  prompt: string;
  attempts: number;
  misses: number;
  lastCorrect: boolean;
  lastOutcome: "correct" | "partial" | "incorrect";
  lastAt: number;
  learningRecord?: string;
}

function questionStats(inputs: LessonHealthInput[]): QuestionStats[] {
  const grades = new Map(inputs.flatMap((input) => input.grades).map((g) => [g.submissionId, g]));
  const stats = new Map<string, QuestionStats>();
  const submissions = inputs
    .flatMap((input) => input.submissions)
    .sort((a, b) => a.submittedAt - b.submittedAt);
  for (const submission of submissions) {
    const grade = grades.get(submission.id);
    if (!grade || kindOf(submission) === "pretest") continue;
    for (const [questionId, group] of answersByQuestion(submission.answers)) {
      const verdict = grade.questions.find((q) => q.questionId === questionId);
      if (!verdict) continue;
      const key = group[0].reviewOf ?? reviewKey(submission.lesson, submission.quizId, questionId);
      const origin =
        group[0].reviewOf === undefined
          ? { lesson: submission.lesson, quizId: submission.quizId, questionId }
          : parseReviewKey(group[0].reviewOf);
      if (!origin) throw new Error(`Invalid review key in health history: ${key}`);
      const entry = stats.get(key) ?? {
        ...origin,
        prompt: group[0].prompt ?? "",
        attempts: 0,
        misses: 0,
        lastCorrect: true,
        lastOutcome: "correct",
        lastAt: 0,
      };
      entry.attempts += 1;
      if (!verdict.correct) entry.misses += 1;
      entry.lastCorrect = verdict.correct;
      entry.lastOutcome = questionOutcome(verdict);
      entry.lastAt = submission.submittedAt;
      stats.set(key, entry);
    }
  }
  for (const check of inputs
    .flatMap((input) => input.retrievalChecks ?? [])
    .sort((a, b) => a.at - b.at)) {
    const entry = stats.get(check.key);
    if (!entry || check.at <= entry.lastAt) continue;
    entry.lastCorrect = true;
    entry.lastOutcome = "correct";
    entry.lastAt = check.at;
    entry.learningRecord = check.learningRecord;
  }
  return [...stats.values()];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** The report for one lesson, as markdown lines. Empty when nothing needs attention. */
export function lessonHealthLines(
  input: LessonHealthInput,
  stats = questionStats([input]).filter((s) => s.lesson === input.lesson),
): string[] {
  const questions = input.questions ?? [];
  const lines: string[] = [
    ...unfinishedQuestionLines(questions),
    ...quizDiversityLines(questionTypes(input)),
  ];
  if (input.alignmentError) lines.push(`- **Invalid teaching alignment:** ${input.alignmentError}`);
  if (input.rubricError) lines.push(`- **Invalid private rubric:** ${input.rubricError}`);
  if (questions.length > 0 && input.hasRubric === false) {
    lines.push(
      "- **No private rubric:** `quiz/key.json` is missing. Write the expected answers, points, and full and partial credit criteria before the learner submits.",
    );
  }

  const hotspots = input.annotations
    .map((a) => ({ annotation: a, turns: 1 + (a.followUps ?? []).length }))
    .filter((h) => h.turns >= HOTSPOT_TURNS)
    .sort((a, b) => b.turns - a.turns);
  if (hotspots.length > 0) {
    lines.push("- **Passages that did not land** (long question threads):");
    for (const { annotation, turns } of hotspots) {
      lines.push(`  - "${clip(annotation.selection, 80)}": ${turns} turns`);
    }
  }

  const failed = input.annotations.filter(
    (a) => a.status === "failed" || (a.followUps ?? []).some((f) => f.status === "failed"),
  );
  if (failed.length > 0) {
    lines.push(`- **Questions with no answer on the page:** ${failed.length}. Answer them again.`);
  }

  const resolved = stats.filter((s) => s.lastCorrect && s.misses > 0);
  if (resolved.length > 0) {
    lines.push("- **Resolved quiz gaps** (history kept; review remains scheduled):");
    for (const s of resolved)
      lines.push(
        `  - \`${s.quizId}/${s.questionId}\`: ${s.misses} earlier misses.${s.learningRecord ? ` Later chat evidence: ${s.learningRecord}.` : " Correct on the latest attempt."}`,
      );
  }
  const partial = stats.filter((s) => s.lastOutcome === "partial");
  if (partial.length > 0)
    lines.push(
      `- **Partial credit on the last attempt:** ${partial.map((s) => `\`${s.quizId}/${s.questionId}\``).join(", ")}. Check the incomplete ideas.`,
    );
  const repeated = stats.filter((s) => !s.lastCorrect && s.misses >= REPEAT_MISS);
  if (repeated.length > 0) {
    lines.push("- **Quiz questions missed more than once:**");
    for (const s of repeated) {
      lines.push(
        `  - \`${s.quizId}/${s.questionId}\` "${clip(s.prompt, 80)}": missed ${s.misses} of ${s.attempts}`,
      );
    }
  }
  const open = stats.filter((s) => s.lastOutcome === "incorrect" && s.misses < REPEAT_MISS);
  if (open.length > 0) {
    lines.push(
      `- **Missed on the last attempt:** ${open.map((s) => `\`${s.quizId}/${s.questionId}\``).join(", ")}`,
    );
  }

  if (input.avoided.length > 0) {
    lines.push("- **Words the glossary says to avoid:**");
    for (const use of input.avoided) {
      lines.push(`  - "${use.avoided}" (${use.count}×). Use "${use.term}".`);
    }
  }

  if (input.reflections.length > 0) {
    lines.push(`- **Self-explanations:** ${input.reflections.length}. The latest:`);
    const latest = input.reflections[input.reflections.length - 1];
    lines.push(`  > ${clip(latest.text, 240)}`);
  }

  return lines;
}

/** The report for a set of lessons. */
export function healthReport(
  classroom: string,
  lessons: LessonHealthInput[],
  glossaryErrors: string[],
  selectedLesson?: string,
): string {
  const out = [`# Lesson health: ${classroom}`, ""];

  if (glossaryErrors.length > 0) {
    out.push("## GLOSSARY.md errors", "", ...glossaryErrors.map((e) => `- ${e}`), "");
  }

  let quiet = 0;
  const stats = questionStats(lessons);
  const chosen = selectedLesson ? lessons.filter((l) => l.lesson === selectedLesson) : lessons;
  for (const lesson of chosen) {
    const lines = lessonHealthLines(
      lesson,
      stats.filter((s) => s.lesson === lesson.lesson),
    );
    if (lines.length === 0) {
      quiet += 1;
      continue;
    }
    out.push(`## ${lesson.title} (\`${lesson.lesson}\`)`, "", ...lines, "");
  }

  if (quiet === chosen.length && glossaryErrors.length === 0) {
    out.push("Nothing needs attention. No long threads, repeated misses, or glossary problems.");
  } else if (quiet > 0) {
    out.push(`${quiet} other lesson${quiet === 1 ? "" : "s"}: nothing needs attention.`);
  }

  const recent = lessons.filter((l) => questionTypes(l).length > 0).slice(-RECENT_LESSONS);
  if (!selectedLesson && recent.length > 0) {
    out.push(
      "",
      "## Response types in recent lessons",
      "",
      ...recent.map((l) => `- \`${l.lesson}\`: ${typeCounts(questionTypes(l))}`),
      "",
      "Use this to notice repetition. Vary the lesson experience when that helps. Repeat a type when it fits the objective.",
    );
  }

  out.push(
    "",
    "Fix a lesson when the same passage or question keeps failing: add the explanation a thread ended up with, or teach the missing prerequisite first.",
  );
  return out.join("\n").trimEnd();
}
