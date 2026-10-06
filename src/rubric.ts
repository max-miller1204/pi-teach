/** Validate the canonical private rubric for newly scaffolded assessments. */
import { authoredQuizzes } from "./quiz-authoring.ts";
import { isQuestionType, isQuizKind } from "../assets/runtime/quiz.mjs";

export interface RubricQuestion {
  expected: unknown;
  points: number;
  full: string;
  partial: string;
}
export type Rubric = Record<string, Record<string, RubricQuestion>>;

export function parseRubric(text: string, html: string): Rubric {
  const rubric: unknown = JSON.parse(text);
  if (!rubric || typeof rubric !== "object" || Array.isArray(rubric))
    throw new Error("Private rubric must be an object keyed by quiz id.");
  const quizzes = authoredQuizzes(html);
  if (quizzes.length === 0) throw new Error("An assessment needs an authored quiz.");
  if (new Set(quizzes.map((q) => q.id)).size !== quizzes.length)
    throw new Error("Every authored quiz needs a unique id.");
  for (const quiz of quizzes) {
    if (!quiz.id) throw new Error("An authored quiz needs data-quiz-id.");
    if (!isQuizKind(quiz.kind) || quiz.questions.length === 0)
      throw new Error(`Invalid authored quiz ${quiz.id}.`);
    if (new Set(quiz.questions.map((q) => q.id)).size !== quiz.questions.length)
      throw new Error(`Duplicate question ids in ${quiz.id}.`);
    const entries = (rubric as Rubric)[quiz.id];
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error(`Private rubric is missing quiz ${quiz.id}.`);
    for (const question of quiz.questions) {
      const where = `${quiz.id}/${question.id}`;
      if (!question.id || !isQuestionType(question.type))
        throw new Error(`Unfinished authored question ${where}.`);
      const entry = question.id ? entries[question.id] : undefined;
      if (
        !entry ||
        typeof entry !== "object" ||
        entry.expected === undefined ||
        entry.expected === null ||
        entry.expected === ""
      )
        throw new Error(`Private rubric needs an expected answer for ${where}.`);
      if (!Number.isFinite(entry.points) || entry.points <= 0)
        throw new Error(`Private rubric needs positive points for ${where}.`);
      if (
        typeof entry.full !== "string" ||
        !entry.full.trim() ||
        typeof entry.partial !== "string" ||
        !entry.partial.trim()
      )
        throw new Error(`Private rubric needs full and partial credit criteria for ${where}.`);
    }
  }
  return rubric as Rubric;
}
