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
import type { PerformanceEvidence } from "../src/evidence.ts";

const T0 = Date.UTC(2026, 0, 1);
const evidence = (extra: Partial<PerformanceEvidence> = {}): PerformanceEvidence => ({
  objectiveId: "cost",
  objective: { statement: "Apply cost", application: false },
  task: "retrieval",
  support: "independent",
  assistance: "none",
  ...extra,
});
const event = (day: number, extra: Partial<ReviewEvent> = {}): ReviewEvent => ({
  key: "001-cost/check/q1",
  at: T0 + day * DAY_MS,
  correct: true,
  prompt: `Prompt at ${day}`,
  answer: "answer",
  feedback: "feedback",
  evidence: evidence(),
  ...extra,
});

describe("scheduleItems", () => {
  it("keeps historical evidence unknown and never invents independence", () => {
    const events = [0, 3, 7, 21].map((day) => event(day, { evidence: undefined }));
    const [item] = scheduleItems(events);
    expect(item).toMatchObject({
      box: 0,
      attempts: 4,
      progress: "context-unknown",
      delayedSuccesses: 0,
    });
    expect(item.dueAt).toBe(T0 + DAY_MS);
  });
  it("does not promote or postpone immediate independent corrections", () => {
    const [item] = scheduleItems([event(0), event(0.001, { source: "chat" }), event(0.002)]);
    expect(item).toMatchObject({ box: 0, progress: "immediate-success", delayedSuccesses: 0 });
    expect(item.dueAt).toBe(T0 + DAY_MS);
  });
  it("requires actual elapsed time since practice and first feedback", () => {
    const [item] = scheduleItems([event(0, { feedbackAt: T0 + 2 * DAY_MS }), event(2.5)]);
    expect(item.box).toBe(0);
    expect(item.dueAt).toBe(T0 + 3 * DAY_MS);
  });
  it("extends intervals only on a due independent success", () => {
    const [item] = scheduleItems([event(0), event(1), event(4), event(11)]);
    expect(item).toMatchObject({
      box: 3,
      progress: "retained-evidence",
      delayedSuccesses: 3,
      evidenceSpanDays: 11,
    });
    expect(item.dueAt).toBe(T0 + 32 * DAY_MS);
    expect(item.scheduleReason).toContain("7.0 days");
    expect(item.prompt).toBe("Prompt at 0");
  });
  it("requires delayed transfer for an application objective", () => {
    const e = evidence({ objective: { statement: "Apply cost", application: true } });
    const events = [0, 1, 8].map((day) => event(day, { evidence: e }));
    expect(scheduleItems(events)[0].progress).toBe("transfer-needed");
    expect(
      scheduleItems([...events, event(9, { evidence: { ...e, task: "transfer" } })])[0].progress,
    ).toBe("retained-evidence");
  });
  it.each(["hint", "solution", "unknown"] as const)(
    "does not treat %s as independent evidence",
    (assistance) => {
      const [item] = scheduleItems([event(0), event(7, { evidence: evidence({ assistance }) })]);
      expect(item).toMatchObject({ box: 0, delayedSuccesses: 0 });
      expect(item.dueAt).toBe(T0 + DAY_MS);
    },
  );
  it("does not promote authored assisted work even if the learner reports no help", () => {
    expect(
      scheduleItems([event(0), event(7, { evidence: evidence({ support: "assisted" }) })])[0].box,
    ).toBe(0);
  });
  it("resets retained evidence after incomplete retrieval and records partial credit", () => {
    const [item] = scheduleItems([
      event(0),
      event(1),
      event(8),
      event(30, { correct: false, credit: 0.5 }),
    ]);
    expect(item).toMatchObject({
      progress: "needs-practice",
      delayedSuccesses: 0,
      delayedTransfers: 0,
      box: 0,
      lastCredit: 0.5,
    });
    expect(item.dueAt).toBe(T0 + 31 * DAY_MS);
  });
  it("caps the base interval for an explicit retention duration without a deadline", () => {
    const e = evidence({
      objective: { statement: "Recall", application: false, retentionDays: 8 },
    });
    const [item] = scheduleItems([event(0, { evidence: e }), event(1, { evidence: e })]);
    expect(item.dueAt).toBe(T0 + 3 * DAY_MS);
    expect(item.scheduleReason).toContain("retention goal 8 days");
  });
  it("keeps schedule and credit invariant under confidence and replays deterministically", () => {
    const events = [event(0), event(1), event(8)];
    const ratings = events.map((e) => ({ ...e, confidence: "guess" }));
    expect(scheduleItems(ratings)).toEqual(scheduleItems(events));
    expect(scheduleItems([...events].reverse())).toEqual(scheduleItems(events));
  });
  it("does not backfill retention from old attempts when new context becomes available", () => {
    const [item] = scheduleItems([event(0, { evidence: undefined }), event(7), event(8)]);
    expect(item.delayedSuccesses).toBe(1);
    expect(item.progress).toBe("delayed-success");
  });
});

describe("pickReviewItems", () => {
  const grouped = (key: string, strategy: string, interleaveGroup = "regression") =>
    event(0, {
      key,
      evidence: evidence({
        objective: { statement: strategy, application: true, interleaveGroup, strategy },
      }),
    });
  it("mixes related strategies within one lesson and across lessons", () => {
    const items = scheduleItems([
      grouped("a/q/1", "cost"),
      grouped("a/q/2", "cost"),
      grouped("a/q/3", "residual"),
      grouped("b/q/1", "prediction"),
    ]);
    expect(pickReviewItems(items, T0 + DAY_MS, 10).map((i) => i.key)).toEqual([
      "a/q/1",
      "a/q/3",
      "b/q/1",
      "a/q/2",
    ]);
  });
  it("keeps unrelated subjects in due order rather than calling lesson alternation interleaving", () => {
    const items = scheduleItems([
      event(0, { key: "a/q/1", evidence: undefined }),
      event(0, { key: "a/q/2", evidence: undefined }),
      event(1, { key: "b/q/1", evidence: undefined }),
    ]);
    expect(pickReviewItems(items, T0 + 3 * DAY_MS, 10).map((i) => i.key)).toEqual([
      "a/q/1",
      "a/q/2",
      "b/q/1",
    ]);
    expect(pickReviewItems(items, T0, 10)).toEqual([]);
    expect(pickReviewItems(items, T0 + 3 * DAY_MS, 1)).toHaveLength(1);
  });
});
it("summarizes retained evidence, transfer needs, and unknown context", () => {
  const items = scheduleItems([
    event(0, { key: "a/q/1", evidence: undefined }),
    ...[0, 1, 8].map((day) => event(day)),
  ]);
  expect(summarize(items, T0 + 9 * DAY_MS)).toMatchObject({
    total: 2,
    due: 1,
    retained: 1,
    unknown: 1,
    transferNeeded: 0,
  });
});
it("keeps bounded base intervals", () => {
  expect(nextBox(0, true)).toBe(1);
  expect(nextBox(4, true)).toBe(4);
  expect(nextBox(3, false)).toBe(0);
});
it("describes days in words", () => {
  expect(relativeDay(T0, T0)).toBe("today");
  expect(relativeDay(T0 + DAY_MS, T0)).toBe("tomorrow");
  expect(relativeDay(T0 + 5 * DAY_MS, T0)).toBe("in 5 days");
  expect(relativeDay(T0 - 3 * DAY_MS, T0)).toBe("3 days ago");
});
