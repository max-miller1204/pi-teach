/**
 * Spaced review: the Leitner schedule derived from grade history.
 */

import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  nextBox,
  pickReviewItems,
  relativeDay,
  scheduleItems,
  summarize,
  type ReviewEvent,
} from "../src/review.ts";

const T0 = Date.UTC(2026, 0, 1);

function event(key: string, day: number, correct: boolean, extra: Partial<ReviewEvent> = {}) {
  return {
    key,
    at: T0 + day * DAY_MS,
    correct,
    prompt: `Prompt ${key} day ${day}`,
    answer: "an answer",
    feedback: "feedback",
    ...extra,
  };
}

describe("nextBox", () => {
  it("moves up on a correct answer, back to the start on a wrong one, and stays on a guess", () => {
    expect(nextBox(0, true)).toBe(1);
    expect(nextBox(3, false)).toBe(0);
    expect(nextBox(2, true, "guess")).toBe(2);
    expect(nextBox(2, true, "unsure")).toBe(3);
    expect(nextBox(4, true, "sure")).toBe(4);
  });
});

describe("scheduleItems", () => {
  it("builds one item for each key, scheduled from its last answer", () => {
    const [item] = scheduleItems([
      event("001-a/check-1/q1", 0, true),
      event("001-a/check-1/q1", 3, true),
    ]);
    expect(item).toMatchObject({
      key: "001-a/check-1/q1",
      lesson: "001-a",
      quizId: "check-1",
      questionId: "q1",
      box: 2,
      attempts: 2,
      // The original question names the item, not the review question.
      prompt: "Prompt 001-a/check-1/q1 day 0",
    });
    expect(item.dueAt).toBe(T0 + 3 * DAY_MS + 7 * DAY_MS);
  });

  it("orders events by time, whatever order they arrive in", () => {
    const [item] = scheduleItems([event("a/q/1", 5, false), event("a/q/1", 0, true)]);
    expect(item.box).toBe(0);
    expect(item.lastCorrect).toBe(false);
  });

  it("flags a wrong answer the learner was sure of", () => {
    const [item] = scheduleItems([event("a/q/1", 0, false, { confidence: "sure" })]);
    expect(item.confidentlyWrong).toBe(true);
  });
});

describe("pickReviewItems", () => {
  const items = scheduleItems([
    event("001-a/check/q1", 0, false),
    event("001-a/check/q2", 0, false),
    event("002-b/check/q1", 1, false),
    event("003-c/check/q1", 30, true),
  ]);

  it("takes due items only, interleaved across lessons", () => {
    const picked = pickReviewItems(items, T0 + 5 * DAY_MS, 10);
    expect(picked.map((item) => item.key)).toEqual([
      "001-a/check/q1",
      "002-b/check/q1",
      "001-a/check/q2",
    ]);
  });

  it("respects the limit", () => {
    expect(pickReviewItems(items, T0 + 5 * DAY_MS, 1)).toHaveLength(1);
  });
});

describe("summarize", () => {
  it("counts what is due, what is soon, and what is mastered", () => {
    const items = scheduleItems([
      event("a/q/1", 0, false),
      event("a/q/2", 0, true),
      ...[0, 2, 6, 14].map((day) => event("a/q/3", day, true)),
    ]);
    const now = T0 + 1.5 * DAY_MS;
    expect(summarize(items, now)).toEqual({
      total: 3,
      due: 1,
      dueSoon: 1,
      mastered: 1,
      nextDueAt: T0 + 3 * DAY_MS,
    });
  });
});

describe("relativeDay", () => {
  it("says when, in words", () => {
    expect(relativeDay(T0, T0)).toBe("today");
    expect(relativeDay(T0 + DAY_MS, T0)).toBe("tomorrow");
    expect(relativeDay(T0 + 5 * DAY_MS, T0)).toBe("in 5 days");
    expect(relativeDay(T0 - 3 * DAY_MS, T0)).toBe("3 days ago");
  });
});
