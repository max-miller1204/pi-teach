/**
 * quiz.mjs: the quiz contract that the browser and the server share.
 *
 * DOM-free, like anchor.mjs. The page checks its own markup with these rules, and the
 * server checks a submission with the same constants, so the two cannot drift. The
 * tests import this file, so they exercise the code the browser runs.
 */

/** What the learner produces. The stimulus (what they look at) is separate. */
export const QUESTION_TYPES = [
  "choice",
  "multi",
  "term",
  "short",
  "numeric",
  "cloze",
  "order",
  "match",
  "locate",
];

/** Types that make the learner produce the answer. Prefer these. */
export const RETRIEVAL_TYPES = ["term", "short", "numeric", "cloze", "order", "locate"];

/** Types that let the learner recognise the answer. Use these for quick checks. */
export const RECOGNITION_TYPES = ["choice", "multi", "match"];

/**
 * `check` is the normal quiz. `pretest` comes before teaching and is diagnostic.
 * `review` is a spaced review of questions that were graded earlier.
 */
export const QUIZ_KINDS = ["check", "pretest", "review"];

/** How many segments a `locate` question lets the learner select. `one` is the default. */
export const LOCATE_SELECT = ["one", "many"];

export function isQuestionType(value) {
  return typeof value === "string" && QUESTION_TYPES.includes(value);
}

export function isQuizKind(value) {
  return typeof value === "string" && QUIZ_KINDS.includes(value);
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse a number the way a learner types it: digits, an optional sign, an optional
 * decimal point, and an optional exponent. Returns null for anything else.
 *
 * Strict on purpose: "1,000" is ambiguous across locales, so it is refused rather than
 * guessed at.
 */
export function parseNumber(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!NUMBER_RE.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

const SLUG_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** A question or quiz id: letters, digits, `_`, `.`, and `-`. */
export function isContractId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

/**
 * The key of a review item: `<lesson>/<quiz id>/<question id>`. A review question
 * names the item it reviews with `data-review-of` set to this key.
 */
export function reviewKey(lesson, quizId, questionId) {
  return `${lesson}/${quizId}/${questionId}`;
}

/** Split a review key into its parts, or return null when it is malformed. */
export function parseReviewKey(value) {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  if (parts.length !== 3) return null;
  const [lesson, quizId, questionId] = parts;
  if (!SLUG_RE.test(lesson) || lesson.length > 128) return null;
  if (!isContractId(quizId) || !isContractId(questionId)) return null;
  return { lesson, quizId, questionId };
}

/**
 * The inputs each type is built from. Anything else inside the question is a mistake
 * in the markup, so it is reported rather than ignored.
 */
const ALLOWED_INPUTS = {
  choice: ["radios"],
  multi: ["checkboxes"],
  term: ["textInputs"],
  short: ["textareas"],
  numeric: ["numbers", "units"],
  cloze: ["blanks"],
  order: [],
  match: [],
  locate: [],
};

const INPUT_NAMES = {
  radios: 'input type="radio"',
  checkboxes: 'input type="checkbox"',
  textInputs: 'input type="text"',
  textareas: "textarea",
  numbers: "input.cl-number",
  units: ".cl-unit",
  blanks: "input[data-blank]",
};

function duplicates(ids) {
  const seen = new Set();
  const repeated = new Set();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
}

/**
 * Each radio or checkbox needs its own value. The answer stores the value, and the
 * page restores a saved answer by it. A missing value reads as "on" in the browser.
 */
function checkOptionValues(errors, values) {
  const missing = values.filter((value) => value === null || value === "").length;
  if (missing > 0) {
    errors.push(
      `has ${missing} option${missing === 1 ? "" : "s"} with no value. Give each option a unique value, such as value="a".`,
    );
  }
  const invalid = values.filter((value) => value && !isContractId(value));
  if (invalid.length > 0) {
    errors.push(
      `has option values that are not valid ids: ${invalid.join(", ")}. Use letters, digits, "_", ".", and "-".`,
    );
  }
  const repeated = duplicates(values.filter(Boolean));
  if (repeated.length > 0) errors.push(`repeats option values: ${repeated.join(", ")}.`);
}

function checkIds(errors, ids, what, min) {
  if (ids.length < min) errors.push(`needs at least ${min} ${what}, found ${ids.length}.`);
  const invalid = ids.filter((id) => !isContractId(id));
  if (invalid.length > 0)
    errors.push(`has ${what} with invalid ids: ${invalid.join(", ") || '""'}.`);
  const repeated = duplicates(ids);
  if (repeated.length > 0) errors.push(`repeats ${what} ids: ${repeated.join(", ")}.`);
}

/**
 * Check one question against the contract for its type.
 *
 * The page summarises the question's markup as plain data (`shape`) and passes it in.
 * Every problem is returned, so the page can show all of them at once.
 *
 * shape: {
 *   id, type, kind, reviewOf, select, hasStimulus, hasCloze,
 *   radios, checkboxes, textInputs, textareas, numbers, units,   (counts)
 *   options,                     (the value attribute of each radio and checkbox)
 *   blanks, orderItems, matchLeft, matchRight, segments,         (id lists)
 * }
 */
export function questionErrors(shape) {
  const errors = [];

  if (!shape.id) errors.push("has no data-question-id.");
  else if (!isContractId(shape.id)) errors.push(`has an invalid data-question-id "${shape.id}".`);

  if (!shape.type) {
    errors.push(`has no data-type. Use one of: ${QUESTION_TYPES.join(", ")}.`);
    return errors;
  }
  if (!isQuestionType(shape.type)) {
    errors.push(
      `has an unknown data-type "${shape.type}". Use one of: ${QUESTION_TYPES.join(", ")}.`,
    );
    return errors;
  }

  if (shape.kind === "review") {
    if (!shape.reviewOf) errors.push("is in a review quiz but has no data-review-of.");
    else if (!parseReviewKey(shape.reviewOf)) {
      errors.push(
        `has an invalid data-review-of "${shape.reviewOf}". Use <lesson>/<quiz id>/<question id>.`,
      );
    }
  } else if (shape.reviewOf) {
    errors.push('has data-review-of, but only a quiz with data-kind="review" can use it.');
  }

  const allowed = ALLOWED_INPUTS[shape.type];
  const blankCount = (shape.blanks ?? []).length;
  const counts = { ...shape, blanks: blankCount };
  for (const [key, name] of Object.entries(INPUT_NAMES)) {
    if (!allowed.includes(key) && counts[key] > 0) {
      errors.push(`is a "${shape.type}" question, so it must not contain ${name}.`);
    }
  }

  switch (shape.type) {
    case "choice":
      if (shape.radios < 2) errors.push(`needs at least 2 radio options, found ${shape.radios}.`);
      checkOptionValues(errors, shape.options);
      break;
    case "multi":
      if (shape.checkboxes < 2) {
        errors.push(`needs at least 2 checkbox options, found ${shape.checkboxes}.`);
      }
      checkOptionValues(errors, shape.options);
      break;
    case "term":
      if (shape.textInputs !== 1) {
        errors.push(`needs exactly 1 input type="text", found ${shape.textInputs}.`);
      }
      break;
    case "short":
      if (shape.textareas !== 1) errors.push(`needs exactly 1 textarea, found ${shape.textareas}.`);
      break;
    case "numeric":
      if (shape.numbers !== 1)
        errors.push(`needs exactly 1 input.cl-number, found ${shape.numbers}.`);
      if (shape.units > 1) errors.push(`can have at most 1 .cl-unit, found ${shape.units}.`);
      break;
    case "cloze":
      if (!shape.hasCloze) errors.push("needs a .cl-cloze passage that holds the blanks.");
      checkIds(errors, shape.blanks, "blanks", 1);
      break;
    case "order":
      checkIds(errors, shape.orderItems, "order items", 2);
      break;
    case "match":
      checkIds(errors, shape.matchLeft, "left-hand match items", 2);
      checkIds(errors, shape.matchRight, "right-hand match items", 2);
      break;
    case "locate":
      if (!shape.hasStimulus) errors.push("needs a .cl-q-stimulus that holds the segments.");
      checkIds(errors, shape.segments, "segments", 2);
      if (shape.select !== null && !LOCATE_SELECT.includes(shape.select)) {
        errors.push(`has an unknown data-select "${shape.select}". Use "one" or "many".`);
      }
      break;
  }
  if (shape.type !== "locate" && shape.select !== null) {
    errors.push('has data-select, but only a "locate" question can use it.');
  }

  return errors;
}
