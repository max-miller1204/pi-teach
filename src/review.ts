/** Derive review schedules and evidence labels from immutable attempt history. */
import {
  evidenceContext,
  independent,
  type EvidenceContext,
  type PerformanceEvidence,
} from "./evidence.ts";
import type { Objective } from "./teaching-plan.ts";

/** Base intervals are a product policy, not a universal optimum. */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 21, 60] as const;
export const REVIEW_POLICY = "elapsed-independent-v1";
export const RETENTION_SPAN_DAYS = 7;
export const RETENTION_SUCCESSES = 2;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One quiz answer or linked chat check for an item. */
export interface ReviewEvent {
  /** `<lesson>/<quiz id>/<question id>` of the original question. */
  key: string;
  /** When the learner answered. */
  at: number;
  correct: boolean;
  /** Fraction of credit. Absent on historical binary events. */
  credit?: number;
  evidence?: PerformanceEvidence;
  /** First feedback time for the attempt. A regrade does not create a new exposure. */
  feedbackAt?: number;
  source?: "chat";
  learningRecord?: string;
  prompt: string;
  /** The learner's answer, as one line. */
  answer: string;
  feedback: string;
}

export interface ReviewItem {
  key: string;
  lesson: string;
  quizId: string;
  questionId: string;
  /** The prompt of the first graded question for this item: the original question. */
  prompt: string;
  box: number;
  objective?: Objective;
  objectiveId?: string;
  context: EvidenceContext;
  progress:
    | "context-unknown"
    | "needs-practice"
    | "immediate-success"
    | "delayed-success"
    | "transfer-needed"
    | "retained-evidence";
  delayedSuccesses: number;
  delayedTransfers: number;
  evidenceSpanDays: number;
  elapsedDays: number;
  scheduleReason: string;
  schedulePolicy: typeof REVIEW_POLICY;
  dueAt: number;
  lastAt: number;
  lastCorrect: boolean;
  lastCredit: number;
  lastSource?: "chat";
  learningRecord?: string;
  lastAnswer: string;
  lastFeedback: string;
  attempts: number;
}

/** The box after one more graded answer. */
export function nextBox(box: number, correct: boolean): number {
  if (!correct) return 0;
  return Math.min(box + 1, REVIEW_INTERVALS_DAYS.length - 1);
}

/** Build each schedule from quiz answers and linked chat checks. */
export function scheduleItems(events: ReviewEvent[]): ReviewItem[] {
  const byKey = new Map<string, ReviewEvent[]>();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const list = byKey.get(event.key);
    if (list) list.push(event);
    else byKey.set(event.key, [event]);
  }

  const items: ReviewItem[] = [];
  for (const [key, list] of byKey) {
    const [lesson, quizId, questionId] = key.split("/");
    let box = 0;
    let dueAt = list[0].at + DAY_MS;
    let exposureAt = list[0].at;
    let objective: Objective | undefined;
    let objectiveId: string | undefined;
    let context: EvidenceContext = "unknown";
    let delayedSuccesses = 0;
    let delayedTransfers = 0;
    let baselineAt: number | undefined;
    let lastDelayedAt: number | undefined;
    let elapsedDays = 0;
    let scheduleReason = "Initial practice: review in one day.";
    for (const [i, event] of list.entries()) {
      if (!objective && event.evidence) {
        objective = event.evidence.objective;
        objectiveId = event.evidence.objectiveId;
      }
      const elapsed = i === 0 ? 0 : Math.max(0, event.at - exposureAt);
      elapsedDays = elapsed / DAY_MS;
      context = evidenceContext(event.evidence, elapsed);
      const full = event.correct && (event.credit === undefined || event.credit === 1);
      const independentFull = full && independent(event.evidence);
      const feedbackAt = Math.max(event.at, event.feedbackAt ?? event.at);
      if (i === 0) dueAt = feedbackAt + DAY_MS;
      if (!full) {
        box = 0;
        delayedSuccesses = 0;
        delayedTransfers = 0;
        baselineAt = undefined;
        lastDelayedAt = undefined;
        dueAt = feedbackAt + DAY_MS;
        scheduleReason = "Incomplete retrieval: review in one day after feedback.";
      } else if (independentFull) {
        if (baselineAt !== undefined && elapsed >= DAY_MS) {
          delayedSuccesses++;
          lastDelayedAt = event.at;
          if (context === "delayed-transfer") delayedTransfers++;
        }
        baselineAt ??= event.at;
        if (i > 0 && elapsed >= DAY_MS && event.at >= dueAt) {
          box = nextBox(box, true);
          const base = REVIEW_INTERVALS_DAYS[box];
          const interval =
            objective?.retentionDays === undefined
              ? base
              : Math.min(base, Math.max(1, Math.floor(objective.retentionDays / 4)));
          dueAt = feedbackAt + interval * DAY_MS;
          scheduleReason = `Independent retrieval after ${elapsedDays.toFixed(1)} days: ${interval}-day interval${objective?.retentionDays === undefined ? "." : `; retention goal ${objective.retentionDays} days.`}`;
        } else if (i === 0) {
          dueAt = feedbackAt + DAY_MS;
        } else {
          scheduleReason = "Early independent success: keep the scheduled review.";
        }
      } else {
        scheduleReason =
          context === "assisted"
            ? "Assisted performance: keep the scheduled independent review."
            : "Unknown independence: keep the scheduled review; no retention claim.";
      }
      exposureAt = Math.max(exposureAt, feedbackAt);
    }
    const span =
      baselineAt === undefined || lastDelayedAt === undefined
        ? 0
        : (lastDelayedAt - baselineAt) / DAY_MS;
    const retained = delayedSuccesses >= RETENTION_SUCCESSES && span >= RETENTION_SPAN_DAYS;
    const last = list[list.length - 1];
    const progress: ReviewItem["progress"] = !last.correct
      ? "needs-practice"
      : !objective
        ? "context-unknown"
        : retained && (!objective.application || delayedTransfers > 0)
          ? "retained-evidence"
          : retained && objective.application
            ? "transfer-needed"
            : delayedSuccesses > 0
              ? "delayed-success"
              : independent(last.evidence)
                ? "immediate-success"
                : context === "unknown"
                  ? "context-unknown"
                  : "needs-practice";
    items.push({
      key,
      lesson,
      quizId,
      questionId,
      prompt: list[0].prompt,
      box,
      dueAt,
      objective,
      objectiveId,
      context,
      progress,
      delayedSuccesses,
      delayedTransfers,
      evidenceSpanDays: span,
      elapsedDays,
      scheduleReason,
      schedulePolicy: REVIEW_POLICY,
      lastAt: last.at,
      lastCorrect: last.correct,
      lastCredit: last.credit ?? (last.correct ? 1 : 0),
      lastSource: last.source,
      learningRecord: last.learningRecord,
      lastAnswer: last.answer,
      lastFeedback: last.feedback,
      attempts: list.length,
    });
  }
  return items.sort((a, b) => a.dueAt - b.dueAt);
}

export function isDue(item: ReviewItem, now: number): boolean {
  return item.dueAt <= now;
}

/** Mix distinct strategies within related groups. Keep unrelated items in due order. */
export function pickReviewItems(items: ReviewItem[], now: number, limit: number): ReviewItem[] {
  const due = items
    .filter((item) => isDue(item, now))
    .sort((a, b) => a.dueAt - b.dueAt || a.key.localeCompare(b.key));
  const pools = new Map<string, ReviewItem[]>();
  for (const item of due) {
    const group = item.objective?.interleaveGroup;
    const id = group === undefined ? `item:${item.key}` : `group:${group}`;
    const pool = pools.get(id) ?? [];
    pool.push(item);
    pools.set(id, pool);
  }
  const ordered = new Map<string, ReviewItem[]>();
  for (const [id, pool] of pools) {
    const mixed: ReviewItem[] = [];
    const byStrategy = new Map<string, ReviewItem[]>();
    for (const item of pool) {
      const strategy = item.objective?.strategy ?? item.key;
      const queue = byStrategy.get(strategy) ?? [];
      queue.push(item);
      byStrategy.set(strategy, queue);
    }
    const queues = [...byStrategy.values()];
    while (queues.some((queue) => queue.length)) {
      for (const queue of queues) {
        const item = queue.shift();
        if (item) mixed.push(item);
      }
    }
    ordered.set(id, mixed);
  }
  return due.slice(0, limit).map((item) => {
    const id =
      item.objective?.interleaveGroup === undefined
        ? `item:${item.key}`
        : `group:${item.objective.interleaveGroup}`;
    return ordered.get(id)!.shift()!;
  });
}

export interface ReviewSummary {
  total: number;
  due: number;
  /** Items that become due within the next three days, not counting those due now. */
  dueSoon: number;
  retained: number;
  transferNeeded: number;
  unknown: number;
  /** The earliest due time among items that are not due yet. */
  nextDueAt: number | null;
}

export function summarize(items: ReviewItem[], now: number): ReviewSummary {
  const upcoming = items.filter((item) => !isDue(item, now));
  return {
    total: items.length,
    due: items.length - upcoming.length,
    dueSoon: upcoming.filter((item) => item.dueAt <= now + 3 * DAY_MS).length,
    retained: items.filter((item) => item.progress === "retained-evidence").length,
    transferNeeded: items.filter((item) => item.progress === "transfer-needed").length,
    unknown: items.filter((item) => item.progress === "context-unknown").length,
    nextDueAt: upcoming.length > 0 ? Math.min(...upcoming.map((item) => item.dueAt)) : null,
  };
}

/** "today", "tomorrow", "in 5 days", or "3 days ago", relative to `now`. */
export function relativeDay(at: number, now: number): string {
  const days = Math.round((at - now) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
