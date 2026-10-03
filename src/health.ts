/**
 * health.ts: the lesson health report: where a lesson did not land.
 *
 * Pure. The `lesson_health` tool reads the data and passes it in. A question is
 * signal, a long thread is louder signal, and a question missed again and again is
 * the loudest. This report puts those in one place so the teacher can fix the lesson
 * instead of only answering around it.
 */

import { answersByQuestion } from "./quiz.ts";
import type { AvoidedUse } from "./glossary.ts";
import type { Annotation, QuizGrade, QuizSubmission, Reflection } from "./store.ts";

export interface LessonHealthInput {
  lesson: string;
  title: string;
  annotations: Annotation[];
  /** Every submission in the lesson, oldest first. */
  submissions: QuizSubmission[];
  grades: QuizGrade[];
  reflections: Reflection[];
  avoided: AvoidedUse[];
}

/** A card with this many turns or more is a hotspot: the passage did not land. */
export const HOTSPOT_TURNS = 3;

/** A question missed this many times or more needs a lesson change, not one more answer. */
export const REPEAT_MISS = 2;

interface QuestionStats {
  quizId: string;
  questionId: string;
  prompt: string;
  attempts: number;
  misses: number;
  confidentMisses: number;
  lastCorrect: boolean;
}

function questionStats(input: LessonHealthInput): QuestionStats[] {
  const grades = new Map(input.grades.map((g) => [g.submissionId, g]));
  const stats = new Map<string, QuestionStats>();
  for (const submission of input.submissions) {
    const grade = grades.get(submission.id);
    if (!grade) continue;
    for (const [questionId, group] of answersByQuestion(submission.answers)) {
      const verdict = grade.questions.find((q) => q.questionId === questionId);
      if (!verdict) continue;
      const key = `${submission.quizId}/${questionId}`;
      const entry = stats.get(key) ?? {
        quizId: submission.quizId,
        questionId,
        prompt: group[0].prompt ?? "",
        attempts: 0,
        misses: 0,
        confidentMisses: 0,
        lastCorrect: true,
      };
      entry.attempts += 1;
      if (!verdict.correct) entry.misses += 1;
      if (!verdict.correct && group[0].confidence === "sure") entry.confidentMisses += 1;
      entry.lastCorrect = verdict.correct;
      stats.set(key, entry);
    }
  }
  return [...stats.values()];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** The report for one lesson, as markdown lines. Empty when nothing needs attention. */
export function lessonHealthLines(input: LessonHealthInput): string[] {
  const lines: string[] = [];

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

  const stats = questionStats(input);
  const repeated = stats.filter((s) => s.misses >= REPEAT_MISS);
  if (repeated.length > 0) {
    lines.push("- **Quiz questions missed more than once:**");
    for (const s of repeated) {
      lines.push(
        `  - \`${s.quizId}/${s.questionId}\` "${clip(s.prompt, 80)}": missed ${s.misses} of ${s.attempts}`,
      );
    }
  }
  const confident = stats.filter((s) => s.confidentMisses > 0);
  if (confident.length > 0) {
    lines.push('- **Wrong while "Sure"** (likely misconceptions):');
    for (const s of confident) {
      lines.push(`  - \`${s.quizId}/${s.questionId}\` "${clip(s.prompt, 80)}"`);
    }
  }
  const open = stats.filter((s) => !s.lastCorrect && s.misses < REPEAT_MISS);
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
): string {
  const out = [`# Lesson health: ${classroom}`, ""];

  if (glossaryErrors.length > 0) {
    out.push("## GLOSSARY.md errors", "", ...glossaryErrors.map((e) => `- ${e}`), "");
  }

  let quiet = 0;
  for (const lesson of lessons) {
    const lines = lessonHealthLines(lesson);
    if (lines.length === 0) {
      quiet += 1;
      continue;
    }
    out.push(`## ${lesson.title} (\`${lesson.lesson}\`)`, "", ...lines, "");
  }

  if (quiet === lessons.length && glossaryErrors.length === 0) {
    out.push("Nothing needs attention. No long threads, repeated misses, or glossary problems.");
  } else if (quiet > 0) {
    out.push(`${quiet} other lesson${quiet === 1 ? "" : "s"}: nothing needs attention.`);
  }

  out.push(
    "",
    "Fix a lesson when the same passage or question keeps failing: add the explanation a thread ended up with, or teach the missing prerequisite first.",
  );
  return out.join("\n").trimEnd();
}
