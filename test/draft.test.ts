/** The draft contract: the keys and values the page saves and the server accepts. */

import { describe, expect, it } from "vitest";

import { draftErrors, draftId, draftKind, isDraftKey } from "../assets/runtime/draft.mjs";

describe("draft keys", () => {
  it("accepts the five places a draft can live", () => {
    for (const key of [
      "ask",
      "teacher",
      "quiz:check-1",
      "reflect:explain_1",
      "followup:0b5b1c56-3f2a-4f4e-9a59-1c0b8f6f1e2d",
    ]) {
      expect(isDraftKey(key)).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const key of [
      "",
      "notes",
      "quiz:",
      "quiz:has space",
      "reflect:../x",
      "followup:abc",
      "grade:q1",
      3,
      null,
    ]) {
      expect(isDraftKey(key)).toBe(false);
    }
  });

  it("splits a key into its kind and id", () => {
    expect([draftKind("quiz:check-1"), draftId("quiz:check-1")]).toEqual(["quiz", "check-1"]);
    expect([draftKind("ask"), draftId("ask")]).toEqual(["ask", null]);
  });
});

describe("draft values", () => {
  it("accepts text up to the limit for text drafts", () => {
    expect(draftErrors("teacher", "Hello")).toEqual([]);
    expect(draftErrors("reflect:r1", "x".repeat(8000))).toEqual([]);
    expect(draftErrors("reflect:r1", "x".repeat(8001))).toHaveLength(1);
    expect(draftErrors("teacher", { text: "x" })).toEqual(["The draft must be text."]);
  });

  it("accepts every question field in a quiz draft", () => {
    expect(
      draftErrors("quiz:check-1", {
        q1: { checked: ["a", "b"] },
        q2: { text: "partial" },
        q3: { text: "9.8", unit: "m/s" },
        q4: { blanks: { b1: "own" } },
        q5: { order: ["c", "a", "b"] },
        q6: { pairs: { l1: "r2" } },
        q7: { segments: ["s1"] },
      }),
    ).toEqual([]);
  });

  it("names each problem in a quiz draft", () => {
    expect(
      draftErrors("quiz:check-1", {
        "bad id": { text: "x" },
        q1: "x",
        q2: { guess: "a" },
        q3: { checked: "a" },
        q4: { blanks: { b1: 3 } },
      }),
    ).toEqual([
      'The quiz draft names an invalid question id "bad id".',
      "The draft of question q1 must be an object.",
      "The draft of question q2 has an unknown field guess.",
      "The draft of question q3 has an invalid checked.",
      "The draft of question q4 has an invalid blanks.",
    ]);
    expect(draftErrors("quiz:check-1", [])).toEqual(["The quiz draft must be an object."]);
  });

  it("needs a full anchor on a question draft", () => {
    const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };
    expect(draftErrors("ask", { anchor, text: "Why?" })).toEqual([]);
    expect(draftErrors("ask", { anchor: { ...anchor, exact: "" }, text: "Why?" })).toEqual([
      "The question draft anchor needs exact text.",
    ]);
    expect(draftErrors("ask", { anchor: { ...anchor, occurrence: -1 }, text: "Why?" })).toEqual([
      "The question draft anchor needs an occurrence.",
    ]);
    expect(draftErrors("ask", { text: "Why?" })).toEqual(["The question draft needs an anchor."]);
  });

  it("refuses a value for an unknown key", () => {
    expect(draftErrors("notes", "x")).toEqual(['Unknown draft key "notes".']);
  });
});
