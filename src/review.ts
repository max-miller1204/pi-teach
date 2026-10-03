/**
 * review.ts: spaced review, derived from grade history.
 *
 * Each graded question is a review item. Its schedule is never stored: it is computed
 * from every graded answer to that item, oldest first, so it cannot drift from the
 * grades on disk. A retake of the original quiz and a question in a review quiz both
 * count as one more attempt at the same item.
 *
 * The schedule is a Leitner system. A correct answer moves the item up one box. A
 * wrong answer moves it back to the first box. A correct answer marked "Guessing" does
 * not move it, because a guess is not evidence of memory.
 */

import type { Confidence } from "./quiz.ts";

/** Days until the next review, for each box. */
export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 21, 60] as const;

/** An item in this box or higher counts as mastered on the progress view. */
export const MASTERED_BOX = 3;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One graded answer to one item. */
export interface ReviewEvent {
  /** `<lesson>/<quiz id>/<question id>` of the original question. */
  key: string;
  /** When the learner answered. */
  at: number;
  correct: boolean;
  confidence?: Confidence;
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
  dueAt: number;
  lastAt: number;
  lastCorrect: boolean;
  lastConfidence?: Confidence;
  lastAnswer: string;
  lastFeedback: string;
  attempts: number;
  /** The last answer was wrong although the learner said "Sure". */
  confidentlyWrong: boolean;
}

/** The box after one more graded answer. */
export function nextBox(box: number, correct: boolean, confidence?: Confidence): number {
  if (!correct) return 0;
  if (confidence === "guess") return box;
  return Math.min(box + 1, REVIEW_INTERVALS_DAYS.length - 1);
}

/** Build every item's schedule from its graded answers. */
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
    for (const event of list) box = nextBox(box, event.correct, event.confidence);
    const last = list[list.length - 1];
    items.push({
      key,
      lesson,
      quizId,
      questionId,
      prompt: list[0].prompt,
      box,
      dueAt: last.at + REVIEW_INTERVALS_DAYS[box] * DAY_MS,
      lastAt: last.at,
      lastCorrect: last.correct,
      lastConfidence: last.confidence,
      lastAnswer: last.answer,
      lastFeedback: last.feedback,
      attempts: list.length,
      confidentlyWrong: !last.correct && last.confidence === "sure",
    });
  }
  return items.sort((a, b) => a.dueAt - b.dueAt);
}

export function isDue(item: ReviewItem, now: number): boolean {
  return item.dueAt <= now;
}

/**
 * Choose the items for one review session: due items only, the most overdue first,
 * and interleaved across lessons so that two questions from one lesson do not sit
 * side by side when another lesson has one waiting.
 */
export function pickReviewItems(items: ReviewItem[], now: number, limit: number): ReviewItem[] {
  const due = items.filter((item) => isDue(item, now)).sort((a, b) => a.dueAt - b.dueAt);

  const byLesson = new Map<string, ReviewItem[]>();
  for (const item of due) {
    const list = byLesson.get(item.lesson);
    if (list) list.push(item);
    else byLesson.set(item.lesson, [item]);
  }

  // Map iteration follows insertion order, so the lesson with the most overdue item
  // goes first in each round.
  const picked: ReviewItem[] = [];
  const queues = [...byLesson.values()];
  while (picked.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && picked.length < limit) picked.push(next);
    }
  }
  return picked;
}

export interface ReviewSummary {
  total: number;
  due: number;
  /** Items that become due within the next three days, not counting those due now. */
  dueSoon: number;
  mastered: number;
  /** The earliest due time among items that are not due yet. */
  nextDueAt: number | null;
}

export function summarize(items: ReviewItem[], now: number): ReviewSummary {
  const upcoming = items.filter((item) => !isDue(item, now));
  return {
    total: items.length,
    due: items.length - upcoming.length,
    dueSoon: upcoming.filter((item) => item.dueAt <= now + 3 * DAY_MS).length,
    mastered: items.filter((item) => item.box >= MASTERED_BOX).length,
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
