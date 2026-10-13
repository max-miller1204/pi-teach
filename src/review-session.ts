/** Save browser review requests and publish only complete review documents. */
import * as fs from "node:fs";
import * as path from "node:path";
import { classroomDir, isValidSlug, lessonDir } from "./paths.ts";
import { parseReviewKey, questionErrors } from "../assets/runtime/quiz.mjs";
import {
  DEFAULT_REVIEW_SIZE,
  pickReviewItems,
  relativeDay,
  summarize,
  type ReviewItem,
} from "./review.ts";
import { authoredQuizzes, authoredQuestionShapes } from "./quiz-authoring.ts";
import { parseRubric } from "./rubric.ts";
import { parseTeachingPlan } from "./teaching-plan.ts";
import * as store from "./store.ts";

export type ReviewOwner = "pi" | "service";

export interface ReviewSession {
  owner: ReviewOwner;
  ownerPid: number;
  id: string;
  classroom: string;
  lesson: string;
  at: number;
  items: ReviewItem[];
  status: "queued" | "running" | "done" | "failed";
  error?: string;
}
export interface ReviewDocument {
  lesson_html: string;
  rubric_json: string;
  teaching_plan_json: string;
}

function file(classroom: string): string {
  if (!isValidSlug(classroom)) throw new Error("Invalid classroom.");
  return path.join(classroomDir(classroom), ".reviews.json");
}
export function reviewSessions(classroom: string): ReviewSession[] {
  try {
    const saved = JSON.parse(fs.readFileSync(file(classroom), "utf8"));
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.requests) ||
      saved.requests.some(
        (request: ReviewSession) =>
          !request ||
          request.classroom !== classroom ||
          !["pi", "service"].includes(request.owner) ||
          !Number.isSafeInteger(request.ownerPid) ||
          request.ownerPid < 1 ||
          !isValidSlug(request.lesson) ||
          typeof request.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(request.id) ||
          !Number.isFinite(request.at) ||
          !["queued", "running", "done", "failed"].includes(request.status) ||
          !Array.isArray(request.items) ||
          request.items.length === 0 ||
          request.items.some((item) => !item || !parseReviewKey(item.key)),
      )
    )
      throw new Error(`Invalid review requests for ${classroom}.`);
    return saved.requests;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
function save(classroom: string, requests: ReviewSession[]): void {
  const target = file(classroom);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify({ version: 1, requests }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(`${target}.tmp`, target);
}
export function updateReview(
  session: ReviewSession,
  status: ReviewSession["status"],
  error?: string,
): void {
  const requests = reviewSessions(session.classroom);
  const request = requests.find((r) => r.id === session.id);
  if (!request) throw new Error("The review request no longer exists.");
  request.status = status;
  if (status === "queued" || status === "running") request.ownerPid = process.pid;
  if (error) request.error = error;
  else delete request.error;
  save(session.classroom, requests);
}
export function currentReview(classroom: string): ReviewSession | null {
  return reviewSessions(classroom).at(-1) ?? null;
}
export function resumableReview(session: ReviewSession): boolean {
  return (
    session.status !== "done" ||
    !store.latestQuizStates(session.classroom, session.lesson).some((s) => s.grade)
  );
}
export function startReview(
  classroom: string,
  id: string,
  owner: ReviewOwner,
): { session: ReviewSession; added: boolean } {
  if (!store.readClassroom(classroom)) throw new Error(`No such classroom: ${classroom}.`);
  const requests = reviewSessions(classroom);
  const existing =
    requests.find((r) => r.id === id) ?? [...requests].reverse().find(resumableReview);
  if (existing) {
    requireReviewOwner(existing, owner);
    return { session: existing, added: false };
  }
  const at = Date.now();
  const items = store.reviewItems(classroom);
  const picked = pickReviewItems(items, at, DEFAULT_REVIEW_SIZE);
  if (!picked.length) {
    const next = summarize(items, at).nextDueAt;
    throw new Error(
      next === null
        ? "No graded questions are due for review."
        : `The next review is due ${relativeDay(next, at)}.`,
    );
  }
  const order = Math.max(
    0,
    ...store.listLessons(classroom).map((l) => Number(/^(\d+)-/.exec(l.name)?.[1] ?? 0)),
  );
  const session: ReviewSession = {
    id,
    owner,
    ownerPid: process.pid,
    classroom,
    lesson: `${String(order + 1).padStart(3, "0")}-review-${id.slice(0, 8)}`,
    at,
    items: picked,
    status: "queued",
  };
  if (fs.existsSync(lessonDir(classroom, session.lesson)))
    throw new Error("Review directory already exists.");
  requests.push(session);
  save(classroom, requests);
  return { session, added: true };
}
export function publicReview(session: ReviewSession | null): unknown {
  if (!session) return null;
  return {
    id: session.id,
    status: session.status,
    error: session.error,
    count: session.items.length,
    resumable: resumableReview(session),
    url: `/c/${encodeURIComponent(session.classroom)}/${encodeURIComponent(session.lesson)}`,
  };
}
export function validateReview(session: ReviewSession, document: ReviewDocument): void {
  for (const value of Object.values(document))
    if (typeof value !== "string" || !value.trim())
      throw new Error("Review documents must be nonempty strings.");
  const quizzes = authoredQuizzes(document.lesson_html);
  if (quizzes.length !== 1 || quizzes[0].kind !== "review")
    throw new Error("A review needs exactly one review quiz.");
  const keys = quizzes[0].questions.map((q) => q.reviewOf);
  if (keys.length !== session.items.length || keys.some((key, i) => key !== session.items[i].key))
    throw new Error("Review questions must use the selected item keys in order.");
  const shapes = authoredQuestionShapes(document.lesson_html);
  if (shapes.length !== keys.length)
    throw new Error("Review controls must be visible in the quiz.");
  for (const shape of shapes) {
    const errors = questionErrors(shape);
    if (errors.length) throw new Error(`Review question ${shape.id}: ${errors.join(" ")}`);
  }
  parseRubric(document.rubric_json, document.lesson_html);
  const plan = parseTeachingPlan(document.teaching_plan_json, document.lesson_html);
  const mapping = plan.quizzes[quizzes[0].id!];
  for (const [i, question] of quizzes[0].questions.entries()) {
    const original = session.items[i].objective;
    const objective = plan.objectives[mapping.questions[question.id!].objective];
    if (!original) {
      if (
        objective.retentionDays !== undefined ||
        objective.interleaveGroup !== undefined ||
        objective.strategy !== undefined
      )
        throw new Error(
          `Historical review question ${question.id} cannot invent retention or strategy policy.`,
        );
      continue;
    }
    for (const field of [
      "statement",
      "application",
      "retentionDays",
      "interleaveGroup",
      "strategy",
    ] as const)
      if (objective[field] !== original[field])
        throw new Error(`Review question ${question.id} changed its original objective policy.`);
  }
}
/** Reject symlinks before writing model output to the reserved directory. */
function checkPath(target: string, root: string): void {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Review classroom cannot be a symlink.");
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Review path cannot be a symlink: ${current}.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
export function publishReview(session: ReviewSession, document: ReviewDocument): void {
  validateReview(session, document);
  const dir = lessonDir(session.classroom, session.lesson);
  const files = {
    "quiz/key.json": document.rubric_json,
    "quiz/plan.json": document.teaching_plan_json,
    "lesson.html": document.lesson_html,
  };
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    checkPath(target, classroomDir(session.classroom));
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== text)
      throw new Error(`Review publication conflicts with ${name}.`);
  }
  checkPath(path.join(dir, "lesson.json"), classroomDir(session.classroom));
  fs.mkdirSync(path.join(dir, "quiz"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target))
      fs.writeFileSync(target, text, {
        flag: "wx",
        mode: name.startsWith("quiz/") ? 0o600 : 0o644,
      });
  }
  store.writeLessonMeta(session.classroom, session.lesson, {
    title: `Review: ${new Date(session.at).toISOString().slice(0, 10)}`,
    summary: `Spaced review of ${session.items.length} earlier question${session.items.length === 1 ? "" : "s"}.`,
    createdAt: session.at,
    kind: "review",
    assessmentContract: 1,
    instructionalContract: 1,
  });
}
export function readReviewDocument(session: ReviewSession): ReviewDocument {
  const dir = lessonDir(session.classroom, session.lesson);
  const read = (name: string) => {
    checkPath(path.join(dir, name), classroomDir(session.classroom));
    return fs.readFileSync(path.join(dir, name), "utf8");
  };
  return {
    lesson_html: read("lesson.html"),
    rubric_json: read("quiz/key.json"),
    teaching_plan_json: read("quiz/plan.json"),
  };
}

/** A host must not take over another host's review work. */
export function requireReviewOwner(session: ReviewSession, owner: ReviewOwner): void {
  if (session.owner !== owner)
    throw new Error(
      `This review belongs to ${session.owner}. Open that classroom host to continue.`,
    );
}
