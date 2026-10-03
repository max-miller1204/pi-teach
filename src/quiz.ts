/**
 * quiz.ts: quiz answers on the server side: their shape, their validation, and the
 * text the teacher reads when grading.
 *
 * The contract constants come from `assets/runtime/quiz.mjs`, the module the page
 * uses to build a submission, so the browser and the server cannot disagree about
 * what a valid answer is.
 */

import {
  CONFIDENCE_LABELS,
  isConfidence,
  isContractId,
  isQuestionType,
  parseNumber,
  parseReviewKey,
  type Confidence,
  type QuestionType,
  type QuizKind,
} from "../assets/runtime/quiz.mjs";

export type { Confidence, QuestionType, QuizKind };

/** One piece of a structured answer: a chosen option, a filled blank, an ordered item. */
export interface AnswerPart {
  /** The id the author gave the option, blank, item, or segment. */
  id: string;
  /** What the learner saw or typed for it. */
  value: string;
}

/** One pair in a `match` answer. */
export interface AnswerPair {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
}

export interface QuizAnswer {
  questionId: string;
  /** Absent only on answers written before question types were enforced. */
  type?: QuestionType;
  prompt?: string;
  /** Plain text of the `.cl-q-stimulus` block, when the question has one. */
  stimulus?: string;
  /** `cloze`: the passage, with each blank written as `[[<blank id>]]`. */
  passage?: string;
  /** `choice`: the option value. `term`, `short`: the text. `numeric`: the number as typed. */
  value?: string;
  /** `choice`: the option text. */
  label?: string;
  /** `numeric`: the unit the learner typed, when the question asks for one. */
  unit?: string;
  /** `multi`: chosen options. `cloze`: blanks. `order`: items in the learner's order. `locate`: chosen segments. */
  parts?: AnswerPart[];
  /** `match`: one pair for each left-hand item. */
  pairs?: AnswerPair[];
  confidence?: Confidence;
  /** `review` quizzes: the key of the item this question reviews. */
  reviewOf?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Thrown for a submission that breaks the contract. The message says what is wrong. */
export class AnswerError extends Error {}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new AnswerError(`${field} must be a string.`);
  if (required && value.trim().length === 0) throw new AnswerError(`${field} is empty.`);
  return value.slice(0, max);
}

function parts(value: unknown, field: string, min: number, unique: boolean): AnswerPart[] {
  if (!Array.isArray(value)) throw new AnswerError(`${field} must be an array.`);
  if (value.length < min) throw new AnswerError(`${field} needs at least ${min} entries.`);
  const out = value.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new AnswerError(`${field}[${i}] must be an object.`);
    const part = raw as Record<string, unknown>;
    const id = text(part["id"], `${field}[${i}].id`, 128, true)!;
    return { id, value: text(part["value"], `${field}[${i}].value`, 2000, true)! };
  });
  if (unique) {
    const ids = out.map((p) => p.id);
    if (new Set(ids).size !== ids.length) throw new AnswerError(`${field} repeats an id.`);
  }
  return out;
}

function pairs(value: unknown, field: string): AnswerPair[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AnswerError(`${field} must be a non-empty array.`);
  }
  const out = value.map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new AnswerError(`${field}[${i}] must be an object.`);
    const pair = raw as Record<string, unknown>;
    return {
      left: text(pair["left"], `${field}[${i}].left`, 128, true)!,
      right: text(pair["right"], `${field}[${i}].right`, 128, true)!,
      leftLabel: text(pair["leftLabel"], `${field}[${i}].leftLabel`, 1000, true)!,
      rightLabel: text(pair["rightLabel"], `${field}[${i}].rightLabel`, 1000, true)!,
    };
  });
  const lefts = out.map((p) => p.left);
  if (new Set(lefts).size !== lefts.length) throw new AnswerError(`${field} repeats a left item.`);
  return out;
}

/**
 * Validate one answer from an untrusted browser and return it in canonical form.
 *
 * Only the fields that belong to the answer's type are kept. Anything the contract
 * requires and the answer lacks is an `AnswerError`.
 */
export function parseAnswer(raw: unknown, kind: QuizKind): QuizAnswer {
  if (!raw || typeof raw !== "object") throw new AnswerError("An answer must be an object.");
  const a = raw as Record<string, unknown>;

  const questionId = a["questionId"];
  if (!isContractId(questionId)) {
    throw new AnswerError(`Invalid questionId: ${JSON.stringify(questionId)}.`);
  }
  const where = `Question ${questionId}`;

  const type = a["type"];
  if (!isQuestionType(type)) {
    throw new AnswerError(`${where} has an unknown type: ${JSON.stringify(type)}.`);
  }

  const answer: QuizAnswer = {
    questionId,
    type,
    prompt: text(a["prompt"], `${where} prompt`, 2000, false),
    stimulus: text(a["stimulus"], `${where} stimulus`, 4000, false),
  };

  if (a["confidence"] !== undefined) {
    if (!isConfidence(a["confidence"])) {
      throw new AnswerError(
        `${where} has an unknown confidence: ${JSON.stringify(a["confidence"])}.`,
      );
    }
    answer.confidence = a["confidence"];
  }

  if (kind === "review") {
    if (!parseReviewKey(a["reviewOf"])) {
      throw new AnswerError(`${where} is in a review quiz but has no valid reviewOf.`);
    }
    answer.reviewOf = a["reviewOf"] as string;
  } else if (a["reviewOf"] !== undefined) {
    throw new AnswerError(`${where} has reviewOf, but the quiz is not a review.`);
  }

  switch (type) {
    case "choice":
      answer.value = text(a["value"], `${where} value`, 1000, true);
      answer.label = text(a["label"], `${where} label`, 1000, true);
      break;
    case "term":
      answer.value = text(a["value"], `${where} value`, 1000, true);
      break;
    case "short":
      answer.value = text(a["value"], `${where} value`, 8000, true);
      break;
    case "numeric": {
      const value = text(a["value"], `${where} value`, 64, true)!;
      if (parseNumber(value) === null)
        throw new AnswerError(`${where} is not a number: "${value}".`);
      answer.value = value.trim();
      answer.unit = text(a["unit"], `${where} unit`, 64, false)?.trim();
      break;
    }
    case "multi":
      answer.parts = parts(a["parts"], `${where} parts`, 1, true);
      break;
    case "cloze":
      answer.passage = text(a["passage"], `${where} passage`, 8000, true);
      answer.parts = parts(a["parts"], `${where} parts`, 1, true);
      break;
    case "order":
      answer.parts = parts(a["parts"], `${where} parts`, 2, true);
      break;
    case "locate":
      answer.parts = parts(a["parts"], `${where} parts`, 1, true);
      break;
    case "match":
      answer.pairs = pairs(a["pairs"], `${where} pairs`);
      break;
  }

  return answer;
}

/** Validate every answer in a submission. Each question may be answered once. */
export function parseAnswers(raw: unknown, kind: QuizKind): QuizAnswer[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AnswerError("No answers submitted.");
  const answers = raw.map((answer) => parseAnswer(answer, kind));
  const ids = answers.map((answer) => answer.questionId);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0) {
    throw new AnswerError(`Each question can be answered once. Repeated: ${repeated.join(", ")}.`);
  }
  return answers;
}

// ── Reading answers back ──────────────────────────────────────────────────────

/**
 * Group answers by question, in submission order.
 *
 * Reason: before question types were enforced, a `multi` question was stored as one
 * answer for each ticked box, all with the same questionId. Those submissions are
 * still on disk.
 */
export function answersByQuestion(answers: QuizAnswer[]): Array<[string, QuizAnswer[]]> {
  const groups = new Map<string, QuizAnswer[]>();
  for (const answer of answers) {
    const group = groups.get(answer.questionId);
    if (group) group.push(answer);
    else groups.set(answer.questionId, [answer]);
  }
  return [...groups.entries()];
}

/** The learner's answer to one question, as one line of plain text. */
export function answerSummary(group: QuizAnswer[]): string {
  const answer = group[0];
  if (!answer.type) return group.map((a) => a.label || a.value || "(blank)").join("; ");
  switch (answer.type) {
    case "choice":
      return answer.label || answer.value || "";
    case "term":
    case "short":
      return answer.value ?? "";
    case "numeric":
      return answer.unit ? `${answer.value} ${answer.unit}` : (answer.value ?? "");
    case "multi":
    case "locate":
      return (answer.parts ?? []).map((p) => p.value).join("; ");
    case "cloze":
      return (answer.parts ?? []).map((p) => `${p.id}: ${p.value}`).join("; ");
    case "order":
      return (answer.parts ?? []).map((p) => p.value).join(" → ");
    case "match":
      return (answer.pairs ?? []).map((p) => `${p.leftLabel} = ${p.rightLabel}`).join("; ");
  }
}

/** The learner's answer to one question, as the lines the grading prompt shows. */
export function answerDetail(group: QuizAnswer[]): string[] {
  const answer = group[0];
  const indent = (line: string) => `   ${line}`;
  const lines: string[] = [];

  if (answer.stimulus) {
    lines.push("Stimulus:", ...answer.stimulus.split("\n").map((line) => `> ${line}`));
  }

  switch (answer.type) {
    case undefined:
    case "choice":
    case "term":
    case "short":
    case "multi":
      lines.push(`Their answer: ${answerSummary(group) || "(blank)"}`);
      break;
    case "numeric":
      lines.push(`Their number: ${answer.value}`);
      if (answer.unit !== undefined) lines.push(`Their unit: ${answer.unit || "(blank)"}`);
      break;
    case "cloze": {
      const filled = (answer.parts ?? []).reduce(
        (passage, part) => passage.split(`[[${part.id}]]`).join(`[${part.id}: «${part.value}»]`),
        answer.passage ?? "",
      );
      lines.push("The passage with their blanks filled in:", `> ${filled}`);
      break;
    }
    case "order":
      lines.push(
        "Their order:",
        ...(answer.parts ?? []).map((p, i) => indent(`${i + 1}. ${p.value} (${p.id})`)),
      );
      break;
    case "match":
      lines.push(
        "Their pairs:",
        ...(answer.pairs ?? []).map((p) =>
          indent(`- ${p.leftLabel} (${p.left}) → ${p.rightLabel} (${p.right})`),
        ),
      );
      break;
    case "locate":
      lines.push(
        "The parts of the stimulus they selected:",
        ...(answer.parts ?? []).map((p) => indent(`- «${p.value}» (${p.id})`)),
      );
      break;
  }

  if (answer.confidence) lines.push(`Their confidence: ${CONFIDENCE_LABELS[answer.confidence]}`);
  if (answer.reviewOf) lines.push(`Reviews: \`${answer.reviewOf}\``);
  return lines;
}

/** The quiz kind of a submission. Submissions written before kinds existed are checks. */
export function kindOf(submission: { kind?: QuizKind }): QuizKind {
  return submission.kind ?? "check";
}
