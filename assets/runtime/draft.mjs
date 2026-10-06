/**
 * The draft contract: text and answers the learner has typed but not sent yet.
 *
 * The page saves a draft as the learner types, and puts it back after a reload. The
 * server imports this module too, so the page and the server accept the same drafts.
 * This module has no DOM dependencies.
 *
 * A draft key names one place on the page:
 *
 *   quiz:<quiz id>          the unsubmitted answers of one quiz
 *   reflect:<reflect id>    the unsaved text of one self-explanation
 *   followup:<card id>      the follow-up box of one card
 *   ask                     the open question composer, with its highlight
 *   teacher                 the reply box of the teacher panel
 */

import { isContractId } from "./quiz.mjs";

export const MAX_DRAFT_TEXT = 8000;
const MAX_ITEMS = 200;
const MAX_ITEM = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The fields one question draft can hold. Each question type uses some of them. */
const QUESTION_FIELDS = [
  "checked",
  "text",
  "unit",
  "blanks",
  "order",
  "pairs",
  "segments",
  "confidence",
  "assistance",
];

export function isDraftKey(value) {
  if (value === "ask" || value === "teacher") return true;
  if (typeof value !== "string") return false;
  const colon = value.indexOf(":");
  if (colon === -1) return false;
  const kind = value.slice(0, colon);
  const id = value.slice(colon + 1);
  if (kind === "quiz" || kind === "reflect") return isContractId(id);
  if (kind === "followup") return UUID_RE.test(id);
  return false;
}

/** The kind part of a draft key: `quiz`, `reflect`, `followup`, `ask`, or `teacher`. */
export function draftKind(key) {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(0, colon);
}

/** The id part of a draft key, or null for `ask` and `teacher`. */
export function draftId(key) {
  const colon = key.indexOf(":");
  return colon === -1 ? null : key.slice(colon + 1);
}

/** Every problem with a draft value for `key`. An empty list means the draft is valid. */
export function draftErrors(key, value) {
  if (!isDraftKey(key)) return [`Unknown draft key ${JSON.stringify(key)}.`];
  switch (draftKind(key)) {
    case "reflect":
    case "followup":
    case "teacher":
      return textErrors(value, "The draft");
    case "ask":
      return askErrors(value);
    case "quiz":
      return quizErrors(value);
  }
  throw new Error(`Draft kind ${draftKind(key)} has no rules.`);
}

function textErrors(value, label) {
  if (typeof value !== "string") return [`${label} must be text.`];
  if (value.length > MAX_DRAFT_TEXT)
    return [`${label} is longer than ${MAX_DRAFT_TEXT} characters.`];
  return [];
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function askErrors(value) {
  if (!isPlainObject(value)) return ["The question draft must be an object."];
  const errors = textErrors(value.text, "The question draft text");
  const anchor = value.anchor;
  if (!isPlainObject(anchor)) return [...errors, "The question draft needs an anchor."];
  if (
    typeof anchor.exact !== "string" ||
    anchor.exact.length === 0 ||
    anchor.exact.length > MAX_ITEM
  )
    errors.push("The question draft anchor needs exact text.");
  for (const side of ["prefix", "suffix"]) {
    if (typeof anchor[side] !== "string" || anchor[side].length > MAX_ITEM)
      errors.push(`The question draft anchor needs a ${side}.`);
  }
  if (!Number.isInteger(anchor.occurrence) || anchor.occurrence < 0)
    errors.push("The question draft anchor needs an occurrence.");
  return errors;
}

function quizErrors(value) {
  if (!isPlainObject(value)) return ["The quiz draft must be an object."];
  const questions = Object.entries(value);
  if (questions.length > MAX_ITEMS) return [`The quiz draft has more than ${MAX_ITEMS} questions.`];
  const errors = [];
  for (const [questionId, draft] of questions) {
    if (!isContractId(questionId)) {
      errors.push(`The quiz draft names an invalid question id ${JSON.stringify(questionId)}.`);
      continue;
    }
    if (!isPlainObject(draft)) {
      errors.push(`The draft of question ${questionId} must be an object.`);
      continue;
    }
    for (const [field, fieldValue] of Object.entries(draft)) {
      if (!QUESTION_FIELDS.includes(field)) {
        errors.push(`The draft of question ${questionId} has an unknown field ${field}.`);
      } else if (!fieldIsValid(field, fieldValue)) {
        errors.push(`The draft of question ${questionId} has an invalid ${field}.`);
      }
    }
  }
  return errors;
}

function isItem(value) {
  return typeof value === "string" && value.length <= MAX_ITEM;
}

function fieldIsValid(field, value) {
  switch (field) {
    case "confidence":
      return ["guess", "unsure", "sure"].includes(value);
    case "assistance":
      return ["none", "hint", "solution", "unknown"].includes(value);
    case "text":
    case "unit":
      return typeof value === "string" && value.length <= MAX_DRAFT_TEXT;
    case "checked":
    case "order":
    case "segments":
      return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(isItem);
    case "blanks":
    case "pairs":
      return (
        isPlainObject(value) &&
        Object.keys(value).length <= MAX_ITEMS &&
        Object.entries(value).every(([id, item]) => isItem(id) && isItem(item))
      );
  }
  return false;
}
