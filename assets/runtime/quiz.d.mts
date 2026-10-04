/**
 * Types for quiz.mjs: hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by the server and vitest.
 */

export type QuestionType =
  "choice" | "multi" | "term" | "short" | "numeric" | "cloze" | "order" | "match" | "locate";

export type QuizKind = "check" | "pretest" | "review";

export declare const QUESTION_TYPES: readonly QuestionType[];
export declare const RETRIEVAL_TYPES: readonly QuestionType[];
export declare const RECOGNITION_TYPES: readonly QuestionType[];
export declare const QUIZ_KINDS: readonly QuizKind[];
export declare const LOCATE_SELECT: readonly string[];

export declare function isQuestionType(value: unknown): value is QuestionType;
export declare function isQuizKind(value: unknown): value is QuizKind;
export declare function parseNumber(text: unknown): number | null;
export declare function isContractId(value: unknown): value is string;
export declare function reviewKey(lesson: string, quizId: string, questionId: string): string;
export declare function parseReviewKey(
  value: unknown,
): { lesson: string; quizId: string; questionId: string } | null;

export interface QuestionShape {
  id: string | null;
  type: string | null;
  kind: QuizKind;
  reviewOf: string | null;
  /** `data-select` on a `locate` question. */
  select: string | null;
  hasStimulus: boolean;
  hasCloze: boolean;
  radios: number;
  checkboxes: number;
  textInputs: number;
  textareas: number;
  numbers: number;
  units: number;
  blanks: string[];
  orderItems: string[];
  matchLeft: string[];
  matchRight: string[];
  segments: string[];
}

export declare function questionErrors(shape: QuestionShape): string[];
