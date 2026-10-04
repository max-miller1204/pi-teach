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

import { classroomDir, docsDir, lessonDir, templatesDir } from "./paths.ts";
import { answerDetail, answersByQuestion, kindOf } from "./quiz.ts";
import { relativeDay, type ReviewSummary } from "./review.ts";
import type { Annotation, FollowUp, QuizGrade, QuizSubmission, Reflection } from "./store.ts";

/** Read a required teaching document. */
function readDoc(name: string): string {
  return fs.readFileSync(path.join(docsDir(), name), "utf8");
}

/**
 * How a wake-up message reached the model. Pi pushes it into the session; Claude Code
 * and Codex receive it as the result of a `wait_for_learner` call.
 */
export type Delivery = "push" | "wait";

function arrivalNote(delivery: Delivery): string {
  return delivery === "push"
    ? "This notification was delivered automatically; nothing was polled."
    : "It arrived as the result of your `wait_for_learner` call.";
}

/** The same quiz follow-up rule applies to every host. */
export const QUIZ_FOLLOW_UP =
  "If any answer is wrong, stay on this lesson. Explain the missed idea briefly, then ask one new retrieval question in chat about that idea. Use a different example. Keep the graded browser quiz locked. Do not ask for an immediate retake. Review the idea later through spaced review. Do not give its answer yet. End your turn and wait for the learner's chat reply. Check their reply and repeat with one question at a time until they demonstrate understanding. Do not create or start the next lesson during this check. If the learner asks to skip the check, record the unresolved gap in notes. A wrong answer alone is not evidence of learning. Write a learning record only after they demonstrate understanding. Then call record_retrieval_check with the original review key, the active learning record file name, their actual chat answer, and the evidence. Do not change the quiz score. If every answer is correct, ask whether they are ready to continue before starting the next lesson.";

/** What to do after grading a pretest. Wrong answers are expected before teaching. */
export const PRETEST_FOLLOW_UP =
  "This was a pretest. The learner answered before the lesson taught the material, so wrong answers are expected and are not a failure. Do not run the retrieval check. Use the results to decide what the lesson stresses and what it can skip. Tell the learner briefly what the lesson will focus on. Write a learning record only for prior knowledge the pretest shows.";

/**
 * The steps a scaffold tool returns. They repeat the method at the point of use,
 * because a long session can remember an older quiz contract.
 */
export function authoringSteps(
  kind: "lesson" | "review",
  lessonPath: string,
  checkPage: string,
): string {
  const contract = path.join(templatesDir(), "quiz.html");
  const rubric = path.join(path.dirname(lessonPath), "quiz", "key.json");
  const middle =
    kind === "lesson"
      ? [
          "2. State one learning objective: what the learner can do at the end.",
          "3. Choose the lesson experience and the response types that fit the objective and this learner. The sections in lesson.html are optional examples. Change, reorder, or replace them. Use earlier answers, questions, and self-explanations. Vary the approach from recent lessons when that helps.",
          "4. Write the lesson and its questions. Give each interaction one purpose: predict, retrieve, explain, practise, or diagnose. Replace the unfinished CHOOSE-A-TYPE question.",
        ]
      : [
          "2. For each item below, state the idea it tests.",
          "3. Write one new question for each item, with a new example. Choose the response type that fits the idea. It does not have to match the original type.",
          "4. Put the given data-review-of on each question exactly. Keep the items in the order given. Replace the unfinished CHOOSE-A-TYPE question.",
        ];
  return [
    "Authoring steps:",
    `1. Read the current quiz contract: ${contract}. Read it for each ${kind}. It can change between sessions.`,
    ...middle,
    `5. Write the private rubric in ${rubric} before the learner submits. For each question, give the expected answer, the points possible, and the full and partial credit criteria.`,
    `6. Check the page: each control must work, and no contract error may show. ${checkPage}`,
  ].join("\n");
}

/**
 * The review status of a classroom, as a section of the teaching brief.
 *
 * Without it the teacher would only see due reviews if it went looking, and new
 * material would always win over spacing.
 */
export function reviewStatusText(summary: ReviewSummary, now: number): string {
  if (summary.total === 0) {
    return "## Spaced review\n\nNo graded questions yet, so nothing is scheduled for review.";
  }
  const lines = [
    "## Spaced review",
    "",
    `${summary.total} graded questions are on the review schedule. ${summary.mastered} are mastered.`,
  ];
  if (summary.due > 0) {
    lines.push(
      `${summary.due} are due for review now. Before you teach new material, offer the learner a review. If they agree, call \`scaffold_review\`.`,
    );
  } else if (summary.nextDueAt !== null) {
    lines.push(`None are due now. The next one is due ${relativeDay(summary.nextDueAt, now)}.`);
  }
  return lines.join("\n");
}

/**
 * The teaching brief sent by /teach.
 *
 * TEACHING.md carries the methodology; the format docs are referenced by path rather
 * than inlined, so the model reads them only when it needs one.
 */
export function teachingPrompt(
  topic: string,
  classroom: string | null,
  review: string | null = null,
): string {
  const parts: string[] = [];

  parts.push(
    topic
      ? `The user wants to learn about: **${topic}**`
      : "The user wants to continue learning. Work out where they left off before doing anything else.",
  );

  if (classroom) {
    parts.push(
      `Their classroom is \`${classroom}\`, at \`${classroomDir(classroom)}\`.\n` +
        `Read \`MISSION.md\` and the existing lessons and learning records there before deciding what to teach next. ` +
        `Call \`lesson_health\` to see which passages and questions did not land.`,
    );
    if (review) parts.push(review);
  }

  parts.push(readDoc("TEACHING.md"));
  parts.push(
    `The templates are in the extension's \`assets/templates/\` directory (${templatesDir()}). The quiz contract is ${path.join(templatesDir(), "quiz.html")}.`,
  );
  parts.push(`## After grading a quiz\n\n${QUIZ_FOLLOW_UP}`);
  parts.push(
    "Reference documents you can read when you need them, in the extension's `docs/` directory " +
      `(${docsDir()}): MISSION-FORMAT.md, RESOURCES-FORMAT.md, GLOSSARY-FORMAT.md, NOTES-FORMAT.md, ` +
      "LEARNING-RECORD-FORMAT.md.",
  );

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Sent when a learner highlights a phrase and asks about it.
 *
 * The lesson path is included so the model can read the surrounding material — the
 * quoted selection alone is rarely enough to answer well.
 */
export function askPrompt(annotation: Annotation, delivery: Delivery): string {
  return [
    `📚 A question just arrived from the classroom web page — the learner highlighted a passage in a lesson and asked about it. ${arrivalNote(delivery)}`,
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
export function followUpPrompt(
  annotation: Annotation,
  followUp: FollowUp,
  delivery: Delivery,
): string {
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
    `📚 A follow-up question just arrived from the classroom web page — the learner is continuing a thread inside a card they already have an answer in. ${arrivalNote(delivery)}`,
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
 * `previous` is the grade of the attempt before this one, for a retake.
 */
export function gradePrompt(
  submission: QuizSubmission,
  delivery: Delivery,
  previous: QuizGrade | null = null,
): string {
  const kind = kindOf(submission);
  const answers = answersByQuestion(submission.answers)
    .map(([questionId, group], i) => {
      const type = group[0].type ? ` (${group[0].type})` : "";
      const prompt = group[0].prompt ?? "(question text unavailable)";
      return [
        `${i + 1}. [${questionId}]${type} ${prompt}`,
        ...answerDetail(group).map((line) => `   ${line}`),
      ].join("\n");
    })
    .join("\n\n");

  const attempt = submission.attempt ?? 1;
  const attemptLine =
    attempt > 1
      ? `Attempt ${attempt} at this quiz.${previous ? ` The previous attempt scored ${Math.round(previous.score)}%.` : ""} An attempt right after feedback shows fluency, not long-term memory.`
      : null;

  const kindLine = {
    check: null,
    pretest:
      "This is a **pretest**. The learner answered before the lesson taught the material. Grade it honestly, so they see where they stand.",
    review:
      "This is a **spaced review**. Each question reviews an earlier question, named by `Reviews:`. Your grade moves that item to a longer interval, or back to one day.",
  }[kind];

  return [
    `📝 A quiz was just submitted from the classroom web page and is waiting on you to grade it. ${arrivalNote(delivery)}`,
    "",
    `Classroom: \`${submission.classroom}\``,
    `Lesson: \`${submission.lesson}\` (${path.join(lessonDir(submission.classroom, submission.lesson), "lesson.html")})`,
    `Quiz: ${submission.quizTitle} (\`${submission.quizId}\`, ${kind})`,
    ...(attemptLine ? [attemptLine] : []),
    ...(kindLine ? ["", kindLine] : []),
    "",
    "Their answers:",
    "",
    answers,
    "",
    "Read the lesson and its private quiz/key.json rubric before grading. Use the criteria set before submission. Do not change the rubric between attempts. For an incomplete answer, name the missing idea and award only the points specified by the rubric. If no rubric exists, report the authoring gap and stop. Ask the teacher to supply the rubric before grading.",
    "",
    `Then call \`grade_lesson_quiz\` with \`submission_id: "${submission.id}"\`, a \`score\` out of 100, short \`feedback_markdown\` covering the whole quiz, and a \`questions\` entry for every question id above. Set \`correct\` to true only for full credit. For partial credit or weighted questions, supply \`points_earned\` and \`points_possible\` for every question. The score must equal 100 times total earned points divided by total possible points. Integer rounding is allowed. With no points, answers use equal-weight binary grading. That is what renders the grade on their page.`,
    "",
    kind === "pretest" ? PRETEST_FOLLOW_UP : QUIZ_FOLLOW_UP,
  ].join("\n");
}

/**
 * Sent when a learner saves a self-explanation. It is signal, not work to grade, so
 * the teacher reads it and records what it shows.
 */
export function reflectPrompt(reflection: Reflection, delivery: Delivery): string {
  const next =
    delivery === "push"
      ? "Then continue what you were doing."
      : "Then call `wait_for_learner` again.";
  return [
    `💭 The learner saved a self-explanation in a lesson. ${arrivalNote(delivery)}`,
    "",
    `Classroom: \`${reflection.classroom}\``,
    `Lesson: \`${reflection.lesson}\` (${path.join(lessonDir(reflection.classroom, reflection.lesson), "lesson.html")})`,
    "",
    "The prompt:",
    "",
    quote(reflection.prompt || "(prompt unavailable)"),
    "",
    "What they wrote:",
    "",
    quote(reflection.text),
    "",
    `Do not grade it, and do not reply on the page. Read it for what it shows about their understanding. If it shows a gap or a misconception, record it in the classroom notes, and address it in the next lesson or check. If it shows real understanding of something non-trivial, write a learning record. ${next}`,
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
/**
 * The starting NOTES.md: an index rather than a notebook, so the shape that keeps it
 * cheap to read is there before the first note is written. See NOTES-FORMAT.md.
 */
export function notesStub(): string {
  return `# Notes

Index of working notes. Detail lives in \`notes/<slug>.md\`, one file per topic — add
it there and link it below, never here. See NOTES-FORMAT.md.

## Preferences

- _How they like to be taught, in a handful of bullets_

## Index

_No topic files yet._
`;
}

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
