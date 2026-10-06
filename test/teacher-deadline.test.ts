import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TeacherDeadline } from "../src/teacher-deadline.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("allows a grading turn to exceed 180 seconds while output progresses", () => {
  const fail = vi.fn();
  const deadline = new TeacherDeadline(fail);
  deadline.enter("grading quiz request test in rust/001-ownership");
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(60_000);
    deadline.progress("item/agentMessage/delta");
  }
  expect(fail).not.toHaveBeenCalled();
  deadline.stop();
  vi.advanceTimersByTime(180_000);
  expect(fail).not.toHaveBeenCalled();
});

it("fails a stalled turn with its phase, last progress, and elapsed time", () => {
  const fail = vi.fn();
  const deadline = new TeacherDeadline(fail);
  deadline.enter("running turn turn-1 in thread thread-1");
  vi.advanceTimersByTime(60_000);
  deadline.progress("item/reasoning/textDelta");
  vi.advanceTimersByTime(179_999);
  expect(fail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(fail.mock.calls[0][0].message).toBe(
    "Codex teacher made no progress for 180 seconds while running turn turn-1 in thread thread-1. " +
      "Last progress: item/reasoning/textDelta. Elapsed: 240 seconds.",
  );
});

it("times out setup and gives the turn its own deadline", () => {
  const fail = vi.fn();
  const deadline = new TeacherDeadline(fail);
  deadline.enter("waiting for initialize");
  vi.advanceTimersByTime(50_000);
  deadline.enter("waiting for thread/resume");
  vi.advanceTimersByTime(50_000);
  deadline.enter("running turn turn-1");
  vi.advanceTimersByTime(180_000);
  expect(fail).toHaveBeenCalledOnce();
  expect(fail.mock.calls[0][0].message).toContain("running turn turn-1");
});

it("fails a request at its total limit despite continued output", () => {
  const fail = vi.fn();
  const deadline = new TeacherDeadline(fail);
  deadline.enter("running turn-1");
  for (let i = 0; i < 5; i++) {
    vi.advanceTimersByTime(59_000);
    deadline.progress("item/agentMessage/delta");
  }
  expect(fail).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5_000);
  expect(fail).toHaveBeenCalledOnce();
  expect(fail.mock.calls[0][0].message).toContain("300 second request limit");
  expect(fail.mock.calls[0][0].message).toContain("item/agentMessage/delta");
  deadline.enter("late notification");
  vi.advanceTimersByTime(300_000);
  expect(fail).toHaveBeenCalledOnce();
});

it("reports only one failure when both limits expire together", () => {
  const fail = vi.fn();
  const deadline = new TeacherDeadline(fail, 1000, 1000);
  vi.advanceTimersByTime(1000);
  expect(fail).toHaveBeenCalledOnce();
  deadline.stop();
});
