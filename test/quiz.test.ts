/**
 * The quiz contract: the markup rules the page enforces (quiz.mjs, the same file the
 * browser runs) and the answer rules the server enforces (src/quiz.ts).
 */

import { describe, expect, it } from "vitest";

import {
  parseNumber,
  parseReviewKey,
  questionErrors,
  type QuestionShape,
} from "../assets/runtime/quiz.mjs";
import {
  AnswerError,
  answerDetail,
  answersByQuestion,
  answerSummary,
  parseAnswer,
  parseAnswers,
} from "../src/quiz.ts";

function shape(overrides: Partial<QuestionShape>): QuestionShape {
  return {
    id: "q1",
    type: "short",
    kind: "check",
    reviewOf: null,
    select: null,
    hasStimulus: false,
    hasCloze: false,
    radios: 0,
    checkboxes: 0,
    textInputs: 0,
    textareas: 0,
    numbers: 0,
    units: 0,
    options: [],
    blanks: [],
    orderItems: [],
    matchLeft: [],
    matchRight: [],
    segments: [],
    ...overrides,
  };
}

describe("questionErrors", () => {
  it("accepts a well-formed question of every type", () => {
    const valid: Array<Partial<QuestionShape>> = [
      { type: "choice", radios: 3, options: ["a", "b", "c"] },
      { type: "multi", checkboxes: 2, options: ["a", "b"] },
      { type: "term", textInputs: 1 },
      { type: "short", textareas: 1 },
      { type: "numeric", numbers: 1, units: 1 },
      { type: "numeric", numbers: 1 },
      { type: "cloze", hasCloze: true, blanks: ["b1", "b2"] },
      { type: "order", orderItems: ["a", "b", "c"] },
      { type: "match", matchLeft: ["l1", "l2"], matchRight: ["r1", "r2"] },
      { type: "locate", hasStimulus: true, segments: ["s1", "s2"] },
      { type: "locate", hasStimulus: true, segments: ["s1", "s2"], select: "many" },
    ];
    for (const overrides of valid) expect(questionErrors(shape(overrides))).toEqual([]);
  });

  it("refuses a question with no type or an unknown type, and names the valid ones", () => {
    expect(questionErrors(shape({ type: null }))[0]).toContain("has no data-type");
    const unknown = questionErrors(shape({ type: "essay" }))[0];
    expect(unknown).toContain('unknown data-type "essay"');
    expect(unknown).toContain("cloze");
  });

  it("refuses a question with no id", () => {
    expect(questionErrors(shape({ id: null, textareas: 1 }))).toContain("has no data-question-id.");
  });

  it("refuses inputs that do not belong to the type", () => {
    const errors = questionErrors(shape({ type: "short", textareas: 1, radios: 2 }));
    expect(errors.join(" ")).toContain('must not contain input type="radio"');
  });

  it("checks the parts each structured type needs", () => {
    expect(questionErrors(shape({ type: "choice", radios: 1 })).join(" ")).toContain(
      "at least 2 radio options",
    );
    expect(questionErrors(shape({ type: "cloze", blanks: ["b1"] })).join(" ")).toContain(
      ".cl-cloze",
    );
    expect(questionErrors(shape({ type: "order", orderItems: ["a", "a"] })).join(" ")).toContain(
      "repeats order items ids: a",
    );
    expect(questionErrors(shape({ type: "order", orderItems: ["a", ""] })).join(" ")).toContain(
      "invalid ids",
    );
    expect(questionErrors(shape({ type: "locate", segments: ["s1", "s2"] })).join(" ")).toContain(
      ".cl-q-stimulus",
    );
    expect(
      questionErrors(
        shape({ type: "locate", hasStimulus: true, segments: ["s1", "s2"], select: "all" }),
      ).join(" "),
    ).toContain('unknown data-select "all"');
    expect(questionErrors(shape({ textareas: 1, select: "one" })).join(" ")).toContain(
      'only a "locate" question',
    );
  });

  it("requires a unique, valid value on every choice and multi option", () => {
    const missing = questionErrors(shape({ type: "multi", checkboxes: 2, options: ["a", null] }));
    expect(missing).toEqual([
      'has 1 option with no value. Give each option a unique value, such as value="a".',
    ]);
    expect(
      questionErrors(shape({ type: "choice", radios: 2, options: ["", ""] })).join(" "),
    ).toContain("has 2 options with no value");
    expect(questionErrors(shape({ type: "choice", radios: 3, options: ["a", "b", "a"] }))).toEqual([
      "repeats option values: a.",
    ]);
    expect(
      questionErrors(shape({ type: "multi", checkboxes: 2, options: ["a", "two words"] })).join(
        " ",
      ),
    ).toContain("not valid ids: two words");
  });

  it("requires data-review-of in a review quiz, and only there", () => {
    expect(questionErrors(shape({ kind: "review", textareas: 1 })).join(" ")).toContain(
      "no data-review-of",
    );
    expect(
      questionErrors(shape({ kind: "review", textareas: 1, reviewOf: "not a key" })).join(" "),
    ).toContain("invalid data-review-of");
    expect(
      questionErrors(shape({ kind: "review", textareas: 1, reviewOf: "001-a/check-1/q1" })),
    ).toEqual([]);
    expect(
      questionErrors(shape({ textareas: 1, reviewOf: "001-a/check-1/q1" })).join(" "),
    ).toContain('only a quiz with data-kind="review"');
  });
});

describe("parseNumber", () => {
  it("reads the numbers a learner types", () => {
    expect(parseNumber("9.81")).toBe(9.81);
    expect(parseNumber(" -2 ")).toBe(-2);
    expect(parseNumber("3e8")).toBe(3e8);
    expect(parseNumber(".5")).toBe(0.5);
  });

  it("refuses anything ambiguous rather than guessing", () => {
    for (const text of ["", "1,000", "ten", "1.2.3", "Infinity", "0x10", "12 m"]) {
      expect(parseNumber(text)).toBeNull();
    }
  });
});

describe("parseReviewKey", () => {
  it("splits a key into its lesson, quiz, and question", () => {
    expect(parseReviewKey("001-ownership/check-1/q2")).toEqual({
      lesson: "001-ownership",
      quizId: "check-1",
      questionId: "q2",
    });
  });

  it("refuses malformed keys", () => {
    for (const key of ["", "a/b", "a/b/c/d", "../x/q1", "Upper/check/q1", 3]) {
      expect(parseReviewKey(key)).toBeNull();
    }
  });
});

describe("parseAnswer", () => {
  it("keeps only the fields that belong to the type", () => {
    const answer = parseAnswer(
      { questionId: "q1", type: "term", value: "scope", parts: [{ id: "x", value: "y" }] },
      "check",
    );
    expect(answer).toEqual({
      questionId: "q1",
      type: "term",
      prompt: undefined,
      stimulus: undefined,
      value: "scope",
    });
  });

  it("validates each structured type", () => {
    expect(
      parseAnswer({ questionId: "q1", type: "numeric", value: " 9.81 ", unit: " m/s² " }, "check"),
    ).toMatchObject({ value: "9.81", unit: "m/s²" });
    expect(
      parseAnswer(
        {
          questionId: "q2",
          type: "cloze",
          passage: "A [[b1]] owns it.",
          parts: [{ id: "b1", value: "variable" }],
        },
        "check",
      ).parts,
    ).toEqual([{ id: "b1", value: "variable" }]);
    expect(
      parseAnswer(
        {
          questionId: "q3",
          type: "match",
          pairs: [{ left: "l1", right: "r2", leftLabel: "Move", rightLabel: "Elsewhere" }],
        },
        "check",
      ).pairs,
    ).toHaveLength(1);
  });

  it("refuses answers that break the contract", () => {
    const bad: Array<[unknown, string]> = [
      [{ questionId: "q1", value: "x" }, "unknown type"],
      [{ questionId: "q1", type: "essay", value: "x" }, "unknown type"],
      [{ questionId: "bad id!", type: "term", value: "x" }, "Invalid questionId"],
      [{ questionId: "q1", type: "term", value: "  " }, "empty"],
      [{ questionId: "q1", type: "numeric", value: "1,000" }, "not a number"],
      [{ questionId: "q1", type: "choice", value: "a" }, "label must be a string"],
      [{ questionId: "q1", type: "order", parts: [{ id: "a", value: "A" }] }, "at least 2"],
      [
        {
          questionId: "q1",
          type: "multi",
          parts: [
            { id: "a", value: "A" },
            { id: "a", value: "A" },
          ],
        },
        "repeats an id",
      ],
      [{ questionId: "q1", type: "term", value: "x", confidence: "very" }, "unknown confidence"],
      [{ questionId: "q1", type: "term", value: "x", reviewOf: "a/b/c" }, "not a review"],
    ];
    for (const [raw, message] of bad) {
      expect(() => parseAnswer(raw, "check")).toThrow(message);
    }
    expect(() => parseAnswer({ questionId: "q1", type: "term", value: "x" }, "review")).toThrow(
      "no valid reviewOf",
    );
  });

  it("refuses a submission that answers one question twice", () => {
    const answer = { questionId: "q1", type: "term", value: "x" };
    expect(() => parseAnswers([answer, answer], "check")).toThrow(AnswerError);
    expect(() => parseAnswers([], "check")).toThrow("No answers");
  });
});

describe("reading answers back", () => {
  it("groups answers written before types existed, one entry for each ticked box", () => {
    const groups = answersByQuestion([
      { questionId: "q1", value: "a", label: "First" },
      { questionId: "q1", value: "c", label: "Third" },
      { questionId: "q2", value: "free text" },
    ]);
    expect(groups.map(([id, group]) => [id, group.length])).toEqual([
      ["q1", 2],
      ["q2", 1],
    ]);
    expect(answerSummary(groups[0][1])).toBe("First; Third");
  });

  it("shows the teacher a cloze passage with the learner's words in the blanks", () => {
    const lines = answerDetail([
      {
        questionId: "q1",
        type: "cloze",
        passage: "A value has one [[b1]]. It is dropped at the end of its [[b2]].",
        parts: [
          { id: "b1", value: "owner" },
          { id: "b2", value: "scope" },
        ],
        confidence: "sure",
      },
    ]);
    expect(lines.join("\n")).toContain(
      "A value has one [b1: «owner»]. It is dropped at the end of its [b2: «scope»].",
    );
    expect(lines).not.toContain("Their confidence");
  });

  it("shows order, match, locate, numeric, and the stimulus", () => {
    const detail = (answer: Parameters<typeof answerDetail>[0][0]) =>
      answerDetail([answer]).join("\n");
    expect(
      detail({
        questionId: "q1",
        type: "order",
        parts: [
          { id: "b", value: "Bind" },
          { id: "d", value: "Drop" },
        ],
      }),
    ).toContain("1. Bind (b)");
    expect(
      detail({
        questionId: "q1",
        type: "match",
        pairs: [{ left: "l1", right: "r1", leftLabel: "Move", rightLabel: "Elsewhere" }],
      }),
    ).toContain("Move (l1) → Elsewhere (r1)");
    expect(
      detail({
        questionId: "q1",
        type: "locate",
        stimulus: "let t = s;",
        parts: [{ id: "s2", value: "let t = s;" }],
      }),
    ).toContain("> let t = s;");
    expect(detail({ questionId: "q1", type: "numeric", value: "4", unit: "" })).toContain(
      "Their unit: (blank)",
    );
  });
});
