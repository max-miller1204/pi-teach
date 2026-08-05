/**
 * prompts.ts — every piece of text this extension sends to the model.
 *
 * Kept pure and separate so the wording is reviewable and testable. The wake-up
 * messages are deliberately self-contained: they arrive out of band, possibly many
 * turns after the lesson was written, so each one restates where it came from, what
 * is being asked, and exactly which tool answers it. Nothing here is injected into
 * the system prompt — sessions that never teach pay nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { classroomDir, docsDir, lessonDir } from "./paths.js";
import type { Annotation, FollowUp, QuizSubmission } from "./store.js";

/** Read a bundled doc, returning "" when it is missing rather than throwing. */
function readDoc(name: string): string {
  try {
    return fs.readFileSync(path.join(docsDir(), name), "utf8");
  } catch {
    return "";
  }
}

/**
 * The teaching brief sent by /teach.
 *
 * TEACHING.md carries the methodology; the format docs are referenced by path rather
 * than inlined, so the model reads them only when it needs one.
 */
export function teachingPrompt(topic: string, classroom: string | null): string {
  const parts: string[] = [];

  parts.push(
    topic
      ? `The user wants to learn about: **${topic}**`
      : "The user wants to continue learning. Work out where they left off before doing anything else.",
  );

  if (classroom) {
    parts.push(
      `Their classroom is \`${classroom}\`, at \`${classroomDir(classroom)}\`.\n` +
        `Read \`MISSION.md\` and the existing lessons and learning records there before deciding what to teach next.`,
    );
  }

  parts.push(readDoc("TEACHING.md"));
  parts.push(
    "Reference documents you can read when you need them, in the extension's `docs/` directory " +
      `(${docsDir()}): MISSION-FORMAT.md, RESOURCES-FORMAT.md, GLOSSARY-FORMAT.md, LEARNING-RECORD-FORMAT.md.`,
  );

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Sent when a learner highlights a phrase and asks about it.
 *
 * The lesson path is included so the model can read the surrounding material — the
 * quoted selection alone is rarely enough to answer well.
 */
export function askPrompt(annotation: Annotation): string {
  return [
    `📚 A question just arrived from the classroom web page — the learner highlighted a passage in a lesson and asked about it. This notification was delivered automatically; nothing was polled.`,
    "",
    `Classroom: \`${annotation.classroom}\``,
    `Lesson: \`${annotation.lesson}\` (${path.join(lessonDir(annotation.classroom, annotation.lesson), "lesson.html")})`,
    "",
    "They highlighted:",
    "",
    quote(annotation.selection),
    "",
    "And asked:",
    "",
    quote(annotation.question),
    "",
    "Read the lesson for context, then answer it as their teacher would: directly, at the level the lesson is pitched at, and grounded in the lesson's own terminology. Keep it to a few short paragraphs — this renders in a small card beside the text they highlighted, not in a chat window.",
    "",
    `When you have the answer, call \`answer_lesson_question\` with \`annotation_id: "${annotation.id}"\` and your answer as markdown. That is what puts it on their screen — replying in chat alone will not reach them.`,
  ].join("\n");
}

/**
 * Sent when a learner asks a follow-up inside a card they already have an answer in.
 *
 * The whole thread so far is inlined: the model may be many turns (or a whole session
 * compaction) away from the original answer, and a follow-up like "why?" is meaningless
 * without it.
 */
export function followUpPrompt(annotation: Annotation, followUp: FollowUp): string {
  const earlier: string[] = [];
  earlier.push("They asked:", "", quote(annotation.question), "");
  earlier.push(
    "You answered:",
    "",
    quote(annotation.answerMarkdown ?? "(no answer was recorded)"),
    "",
  );
  for (const previous of annotation.followUps ?? []) {
    if (previous.id === followUp.id) break;
    earlier.push("They followed up:", "", quote(previous.question), "");
    earlier.push(
      "You answered:",
      "",
      quote(previous.answerMarkdown ?? "(no answer was recorded)"),
      "",
    );
  }

  return [
    `📚 A follow-up question just arrived from the classroom web page — the learner is continuing a thread inside a card they already have an answer in. This notification was delivered automatically; nothing was polled.`,
    "",
    `Classroom: \`${annotation.classroom}\``,
    `Lesson: \`${annotation.lesson}\` (${path.join(lessonDir(annotation.classroom, annotation.lesson), "lesson.html")})`,
    "",
    "They had highlighted:",
    "",
    quote(annotation.selection),
    "",
    "The thread so far:",
    "",
    ...earlier,
    "And they now ask:",
    "",
    quote(followUp.question),
    "",
    "Answer the follow-up in the same voice, building on what you already told them rather than repeating it. Re-read the lesson if the follow-up has moved past what you had in view. Keep it to a few short paragraphs — this renders in a small card beside the text they highlighted.",
    "",
    `When you have the answer, call \`answer_lesson_question\` with \`annotation_id: "${annotation.id}"\` and your answer as markdown. It attaches to the follow-up automatically — the card's earlier answers are left alone.`,
  ].join("\n");
}

/**
 * Sent when a learner submits a quiz.
 *
 * The answers are inlined because they are short and grading should not require a
 * file read; the submission path is given for the cases where it would help.
 */
export function gradePrompt(submission: QuizSubmission): string {
  const answers = submission.answers
    .map((answer, i) => {
      const lines = [
        `${i + 1}. [${answer.questionId}] ${answer.prompt ?? "(question text unavailable)"}`,
      ];
      lines.push(`   Their answer: ${answer.label || answer.value || "(blank)"}`);
      return lines.join("\n");
    })
    .join("\n\n");

  return [
    `📝 A quiz was just submitted from the classroom web page and is waiting on you to grade it. This notification was delivered automatically; nothing was polled.`,
    "",
    `Classroom: \`${submission.classroom}\``,
    `Lesson: \`${submission.lesson}\` (${path.join(lessonDir(submission.classroom, submission.lesson), "lesson.html")})`,
    `Quiz: ${submission.quizTitle} (\`${submission.quizId}\`)`,
    "",
    "Their answers:",
    "",
    answers,
    "",
    "Read the lesson to see what each question was actually testing, then grade it. Be honest — a passing grade the learner did not earn costs them the thing they came for. For a wrong answer, say what is wrong and point at the idea they have missed, rather than just restating the correct answer.",
    "",
    `Then call \`grade_lesson_quiz\` with \`submission_id: "${submission.id}"\`, a \`score\` out of 100, short \`feedback_markdown\` covering the whole quiz, and a \`questions\` entry for every question id above. That is what renders the grade on their page.`,
    "",
    "If they got something wrong that suggests a real gap, consider writing a learning record afterwards.",
  ].join("\n");
}

/** Indent text as a markdown block quote. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** MISSION.md written when a classroom is scaffolded, before the interview happens. */
export function missionStub(title: string): string {
  return `# Mission: ${title}

## Why

_Not yet established. Interview the learner before writing lessons: what concrete,
real-world thing changes for them once they have this skill? Replace this section
with 1–3 sentences in their words._

## Success looks like

- _A specific, observable thing they will be able to do_

## Constraints

- _Time, budget, prior commitments, learning preferences_

## Out of scope

- _Adjacent topics they explicitly do not want to chase right now_
`;
}
