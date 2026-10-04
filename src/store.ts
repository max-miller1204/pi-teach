/**
 * store.ts — reads and writes everything under the classrooms root.
 *
 * Discovery is filesystem-first: a directory containing a lesson HTML file *is* a
 * lesson, whether or not anything wrote `lesson.json`. That keeps the store honest
 * when the model authors material with plain file writes instead of the scaffold
 * tools, which it often will.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { reviewKey } from "../assets/runtime/quiz.mjs";
import { parseGlossary, type Glossary } from "./glossary.ts";
import {
  annotationsFile,
  classroomDir,
  classroomsRoot,
  gradesDir,
  isDir,
  isFile,
  isValidSlug,
  lessonDir,
  reflectionsFile,
  submissionsDir,
} from "./paths.ts";
import {
  answerSummary,
  answersByQuestion,
  kindOf,
  type QuizAnswer,
  type QuizKind,
} from "./quiz.ts";
import { scheduleItems, type ReviewEvent, type ReviewItem } from "./review.ts";

export type { QuizAnswer, QuizKind };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClassroomMeta {
  title: string;
  emoji: string;
  createdAt: number;
}

export interface Classroom {
  /** Directory name — also the URL segment. */
  name: string;
  title: string;
  emoji: string;
  createdAt: number;
  updatedAt: number;
  mission: string | null;
  lessonCount: number;
}

/** A normal lesson, or a review session that `scaffold_review` created. */
export type LessonKind = "lesson" | "review";

export interface LessonMeta {
  title: string;
  summary: string;
  createdAt: number;
  /** Absent on lessons written before review sessions existed. */
  kind?: LessonKind;
}

export interface Lesson {
  /** Directory name — also the URL segment. */
  name: string;
  classroom: string;
  title: string;
  summary: string;
  /** Absolute path to the lesson's HTML document. */
  htmlPath: string;
  createdAt: number;
  updatedAt: number;
  /** Numeric ordering prefix on the directory name, if any. */
  order: number | null;
  kind: LessonKind;
  annotationCount: number;
  /** Grade of the most recent graded submission that is not a pretest, when one exists. */
  latestScore: number | null;
  hasUngradedSubmission: boolean;
}

/**
 * A follow-up question asked inside an existing card, continuing the same thread.
 *
 * Follow-ups live on the annotation rather than becoming annotations of their own: they
 * share one highlight, and the teacher needs the earlier turns as context to answer.
 */
export interface FollowUp {
  id: string;
  status: "pending" | "answered" | "failed";
  question: string;
  answerMarkdown: string | null;
  answerHtml: string | null;
  askedAt: number;
  answeredAt: number | null;
}

/**
 * A highlight-and-ask card. `anchor` is a W3C-style text-quote selector so the
 * highlight can be re-found after the page reloads (or after the lesson is edited).
 *
 * The card is a thread: `question`/`answer*` are its first turn and `followUps` are the
 * ones after it. `followUps` is optional so annotation files written before follow-ups
 * existed still parse.
 */
export interface Annotation {
  id: string;
  classroom: string;
  lesson: string;
  status: "pending" | "answered" | "failed";
  question: string;
  /** The text the learner highlighted. */
  selection: string;
  anchor: { exact: string; prefix: string; suffix: string; occurrence: number };
  answerMarkdown: string | null;
  answerHtml: string | null;
  createdAt: number;
  answeredAt: number | null;
  followUps?: FollowUp[];
}

/**
 * Which turn of a card an answer belongs to: `null` is the original question, a string
 * is the id of a follow-up.
 */
export type TurnId = string | null;

export interface QuizSubmission {
  id: string;
  classroom: string;
  lesson: string;
  quizId: string;
  quizTitle: string;
  /** Absent on submissions written before quiz kinds existed. Read it with `kindOf`. */
  kind?: QuizKind;
  /** 1 for the first attempt at this quiz, 2 for the first retake, and so on. */
  attempt?: number;
  answers: QuizAnswer[];
  submittedAt: number;
}

export interface QuizQuestionGrade {
  questionId: string;
  correct: boolean;
  feedback: string;
  feedbackHtml?: string;
}

export interface QuizGrade {
  submissionId: string;
  classroom: string;
  lesson: string;
  quizId: string;
  score: number;
  feedbackMarkdown: string;
  feedbackHtml: string;
  questions: QuizQuestionGrade[];
  gradedAt: number;
}

// ── Small JSON helpers ────────────────────────────────────────────────────────

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// ── Lesson HTML resolution ────────────────────────────────────────────────────

/**
 * Pick the lesson document inside a lesson directory.
 *
 * `lesson.html` wins; otherwise the lexicographically first `lesson-*.html` (so a
 * literal `lesson-001.html` works); otherwise the first `.html` file present.
 */
export function resolveLessonHtml(dir: string): string | null {
  if (isFile(path.join(dir, "lesson.html"))) return path.join(dir, "lesson.html");

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const html = entries.filter((e) => e.toLowerCase().endsWith(".html")).sort();
  const numbered = html.filter((e) => /^lesson[-_]/i.test(e));
  const chosen = numbered[0] ?? html[0];
  return chosen ? path.join(dir, chosen) : null;
}

/** Leading numeric prefix on a directory name (`003-closures` → 3). */
export function orderPrefix(name: string): number | null {
  const m = /^(\d+)[-_]/.exec(name);
  return m ? Number(m[1]) : null;
}

// ── Classrooms ────────────────────────────────────────────────────────────────

export function listClassrooms(): Classroom[] {
  const root = classroomsRoot();
  if (!isDir(root)) return [];

  const out: Classroom[] = [];
  for (const name of fs.readdirSync(root)) {
    if (!isValidSlug(name) || !isDir(path.join(root, name))) continue;
    const classroom = readClassroom(name);
    if (classroom) out.push(classroom);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readClassroom(name: string): Classroom | null {
  if (!isValidSlug(name)) return null;
  const dir = classroomDir(name);
  if (!isDir(dir)) return null;

  const meta = readJson<ClassroomMeta>(path.join(dir, "classroom.json"));
  const missionPath = path.join(dir, "MISSION.md");
  const lessons = listLessonDirs(name);

  return {
    name,
    title: meta?.title ?? titleFromSlug(name),
    emoji: meta?.emoji ?? "📚",
    createdAt: meta?.createdAt ?? mtime(dir),
    updatedAt: Math.max(mtime(dir), ...lessons.map((l) => mtime(path.join(dir, l))), 0),
    mission: isFile(missionPath) ? fs.readFileSync(missionPath, "utf8") : null,
    lessonCount: lessons.length,
  };
}

export function writeClassroomMeta(name: string, meta: ClassroomMeta): void {
  writeJson(path.join(classroomDir(name), "classroom.json"), meta);
}

/** `rust-ownership` → `Rust Ownership`. Used when classroom.json is absent. */
export function titleFromSlug(slug: string): string {
  return slug
    .replace(/^\d+[-_]/, "")
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Lessons ───────────────────────────────────────────────────────────────────

/**
 * Directory names inside a classroom that actually hold a lesson document.
 *
 * Exported because the by-id lookups below scan every lesson and must not pay for
 * the full `readLesson` (which reads annotations, submissions, and grades per lesson).
 */
export function listLessonDirs(classroom: string): string[] {
  const dir = classroomDir(classroom);
  if (!isDir(dir)) return [];
  // Reason: these are classroom-level, never lessons — skip them before the (more
  // expensive) HTML lookup.
  const reserved = new Set(["reference", "assets", "learning-records", "notes", "quiz"]);
  return fs
    .readdirSync(dir)
    .filter(
      (name) =>
        isValidSlug(name) &&
        !reserved.has(name) &&
        isDir(path.join(dir, name)) &&
        resolveLessonHtml(path.join(dir, name)) !== null,
    );
}

export function listLessons(classroom: string): Lesson[] {
  if (!isValidSlug(classroom)) return [];
  const lessons = listLessonDirs(classroom)
    .map((name) => readLesson(classroom, name))
    .filter((l): l is Lesson => l !== null);

  return lessons.sort((a, b) => {
    // Numbered lessons lead, in order; unnumbered fall to the back by creation time.
    if (a.order !== null && b.order !== null && a.order !== b.order) return a.order - b.order;
    if (a.order !== null && b.order === null) return -1;
    if (a.order === null && b.order !== null) return 1;
    return a.createdAt - b.createdAt;
  });
}

export function readLesson(classroom: string, lesson: string): Lesson | null {
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) return null;
  const dir = lessonDir(classroom, lesson);
  const htmlPath = resolveLessonHtml(dir);
  if (!htmlPath) return null;

  const meta = readJson<LessonMeta>(path.join(dir, "lesson.json"));
  const grades = listGrades(classroom, lesson);
  const submissions = listSubmissions(classroom, lesson);
  const gradedIds = new Set(grades.map((g) => g.submissionId));

  // The score shown is the one for the most recent *graded* attempt — not simply the
  // most recent grade file, which could belong to an older submission. A pretest is
  // diagnostic, so it never sets the lesson's score.
  const lastGraded = [...submissions]
    .reverse()
    .find((s) => gradedIds.has(s.id) && kindOf(s) !== "pretest");
  const latestScore = lastGraded
    ? (grades.find((g) => g.submissionId === lastGraded.id)?.score ?? null)
    : null;

  return {
    name: lesson,
    classroom,
    title: meta?.title ?? titleFromHtml(htmlPath) ?? titleFromSlug(lesson),
    summary: meta?.summary ?? "",
    htmlPath,
    createdAt: meta?.createdAt ?? mtime(htmlPath),
    updatedAt: mtime(htmlPath),
    order: orderPrefix(lesson),
    kind: meta?.kind ?? "lesson",
    annotationCount: listAnnotations(classroom, lesson).length,
    latestScore,
    hasUngradedSubmission: submissions.some((s) => !gradedIds.has(s.id)),
  };
}

export function writeLessonMeta(classroom: string, lesson: string, meta: LessonMeta): void {
  writeJson(path.join(lessonDir(classroom, lesson), "lesson.json"), meta);
}

/** Read a `<title>` out of the lesson document, for lessons with no lesson.json. */
function titleFromHtml(htmlPath: string): string | null {
  try {
    const head = fs.readFileSync(htmlPath, "utf8").slice(0, 4096);
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
    const title = m?.[1]?.trim();
    return title ? title.replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}

// ── Annotations ───────────────────────────────────────────────────────────────

export function listAnnotations(classroom: string, lesson: string): Annotation[] {
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) return [];
  return readJson<Annotation[]>(annotationsFile(classroom, lesson)) ?? [];
}

function writeAnnotations(classroom: string, lesson: string, list: Annotation[]): void {
  writeJson(annotationsFile(classroom, lesson), list);
}

export function createAnnotation(
  input: Omit<
    Annotation,
    "id" | "status" | "answerMarkdown" | "answerHtml" | "createdAt" | "answeredAt"
  >,
): Annotation {
  const annotation: Annotation = {
    ...input,
    id: randomUUID(),
    status: "pending",
    answerMarkdown: null,
    answerHtml: null,
    createdAt: Date.now(),
    answeredAt: null,
    followUps: [],
  };
  const list = listAnnotations(input.classroom, input.lesson);
  list.push(annotation);
  writeAnnotations(input.classroom, input.lesson, list);
  return annotation;
}

/**
 * Find an annotation by id across every classroom and lesson.
 *
 * Reason: `answer_lesson_question` is called with just the id — the model should not
 * have to carry classroom/lesson round-trip, and getting either wrong would silently
 * drop the answer.
 */
export function findAnnotation(id: string): Annotation | null {
  for (const { classroom, lesson } of allLessonRefs()) {
    const hit = listAnnotations(classroom, lesson).find((a) => a.id === id);
    if (hit) return hit;
  }
  return null;
}

/** Every (classroom, lesson) pair on disk, without reading lesson contents. */
export function allLessonRefs(): Array<{ classroom: string; lesson: string }> {
  const refs: Array<{ classroom: string; lesson: string }> = [];
  const root = classroomsRoot();
  if (!isDir(root)) return refs;
  for (const classroom of fs.readdirSync(root)) {
    if (!isValidSlug(classroom) || !isDir(classroomDir(classroom))) continue;
    for (const lesson of listLessonDirs(classroom)) refs.push({ classroom, lesson });
  }
  return refs;
}

export function updateAnnotation(
  id: string,
  patch: Partial<Omit<Annotation, "id" | "classroom" | "lesson">>,
): Annotation | null {
  const existing = findAnnotation(id);
  if (!existing) return null;

  const list = listAnnotations(existing.classroom, existing.lesson);
  const idx = list.findIndex((a) => a.id === id);
  if (idx === -1) return null;

  const updated = { ...list[idx], ...patch };
  list[idx] = updated;
  writeAnnotations(existing.classroom, existing.lesson, list);
  return updated;
}

// ── Follow-ups ────────────────────────────────────────────────────────────────

/** Append a follow-up question to an existing card, as a pending turn. */
export function addFollowUp(
  annotationId: string,
  question: string,
): { annotation: Annotation; followUp: FollowUp } | null {
  const existing = findAnnotation(annotationId);
  if (!existing) return null;

  const followUp: FollowUp = {
    id: randomUUID(),
    status: "pending",
    question,
    answerMarkdown: null,
    answerHtml: null,
    askedAt: Date.now(),
    answeredAt: null,
  };

  const annotation = updateAnnotation(annotationId, {
    followUps: [...(existing.followUps ?? []), followUp],
  });
  return annotation ? { annotation, followUp } : null;
}

export function updateFollowUp(
  annotationId: string,
  followUpId: string,
  patch: Partial<Omit<FollowUp, "id">>,
): Annotation | null {
  const existing = findAnnotation(annotationId);
  if (!existing) return null;

  const followUps = existing.followUps ?? [];
  if (!followUps.some((f) => f.id === followUpId)) return null;

  return updateAnnotation(annotationId, {
    followUps: followUps.map((f) => (f.id === followUpId ? { ...f, ...patch } : f)),
  });
}

/** Is the given turn of a card still waiting on an answer? */
export function isTurnPending(annotation: Annotation, turn: TurnId): boolean {
  if (turn === null) return annotation.status === "pending";
  return (annotation.followUps ?? []).find((f) => f.id === turn)?.status === "pending";
}

/**
 * The turn an incoming answer belongs to.
 *
 * Reason: `answer_lesson_question` is called with only an annotation id, so the target
 * is inferred — the oldest turn still waiting, or (when nothing is pending and the model
 * is revising) the most recent turn.
 */
export function answerTarget(annotation: Annotation): TurnId {
  if (annotation.status === "pending") return null;
  const followUps = annotation.followUps ?? [];
  const pending = followUps.find((f) => f.status === "pending");
  if (pending) return pending.id;
  return followUps.length > 0 ? followUps[followUps.length - 1].id : null;
}

export function deleteAnnotation(classroom: string, lesson: string, id: string): boolean {
  const list = listAnnotations(classroom, lesson);
  const next = list.filter((a) => a.id !== id);
  if (next.length === list.length) return false;
  writeAnnotations(classroom, lesson, next);
  return true;
}

// ── Quiz submissions and grades ───────────────────────────────────────────────

function listJsonFiles<T>(dir: string): T[] {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readJson<T>(path.join(dir, f)))
    .filter((v): v is T => v !== null);
}

export function listSubmissions(classroom: string, lesson: string): QuizSubmission[] {
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) return [];
  return listJsonFiles<QuizSubmission>(submissionsDir(classroom, lesson)).sort(
    (a, b) => a.submittedAt - b.submittedAt,
  );
}

export function listGrades(classroom: string, lesson: string): QuizGrade[] {
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) return [];
  return listJsonFiles<QuizGrade>(gradesDir(classroom, lesson)).sort(
    (a, b) => a.gradedAt - b.gradedAt,
  );
}

export function createSubmission(
  input: Omit<QuizSubmission, "id" | "submittedAt" | "attempt"> & { kind: QuizKind },
): QuizSubmission {
  // Reason: "latest submission" is what the page rehydrates from, so the ordering has
  // to be total. Two submissions in the same millisecond would otherwise tie and
  // resolve by random UUID, so nudge past the previous one.
  const previous = listSubmissions(input.classroom, input.lesson);
  const last = previous.length > 0 ? previous[previous.length - 1].submittedAt : 0;
  const submittedAt = Math.max(Date.now(), last + 1);
  const attempt = previous.filter((s) => s.quizId === input.quizId).length + 1;

  const submission: QuizSubmission = { ...input, id: randomUUID(), attempt, submittedAt };
  // Timestamp-prefixed so the directory listing is chronological.
  const file = path.join(
    submissionsDir(input.classroom, input.lesson),
    `${submission.submittedAt}-${submission.id}.json`,
  );
  writeJson(file, submission);
  return submission;
}

export function findSubmission(id: string): QuizSubmission | null {
  for (const { classroom, lesson } of allLessonRefs()) {
    const hit = listSubmissions(classroom, lesson).find((s) => s.id === id);
    if (hit) return hit;
  }
  return null;
}

export function writeGrade(grade: QuizGrade): void {
  writeJson(
    path.join(
      gradesDir(grade.classroom, grade.lesson),
      `${grade.gradedAt}-${grade.submissionId}.json`,
    ),
    grade,
  );
}

/** The latest attempt at one quiz in a lesson, its grade if it has one, and the attempt count. */
export interface QuizState {
  quizId: string;
  submission: QuizSubmission;
  grade: QuizGrade | null;
  attempts: number;
}

/**
 * The latest attempt at each quiz in a lesson, oldest quiz first.
 *
 * Reason: a lesson can hold several quizzes (a pretest and a check), so the page
 * rehydrates each form from its own latest attempt, not from the lesson's latest one.
 */
export function latestQuizStates(classroom: string, lesson: string): QuizState[] {
  const submissions = listSubmissions(classroom, lesson);
  const grades = listGrades(classroom, lesson);
  const byQuiz = new Map<string, QuizSubmission[]>();
  for (const submission of submissions) {
    const list = byQuiz.get(submission.quizId);
    if (list) list.push(submission);
    else byQuiz.set(submission.quizId, [submission]);
  }
  return [...byQuiz.entries()].map(([quizId, list]) => {
    const submission = list[list.length - 1];
    return {
      quizId,
      submission,
      grade: grades.find((g) => g.submissionId === submission.id) ?? null,
      attempts: list.length,
    };
  });
}

/** The grade of the attempt before this one at the same quiz, when it was graded. */
export function previousGrade(submission: QuizSubmission): QuizGrade | null {
  const earlier = listSubmissions(submission.classroom, submission.lesson).filter(
    (s) => s.quizId === submission.quizId && s.submittedAt < submission.submittedAt,
  );
  const before = earlier[earlier.length - 1];
  if (!before) return null;
  return (
    listGrades(submission.classroom, submission.lesson).find((g) => g.submissionId === before.id) ??
    null
  );
}

// ── Spaced review ─────────────────────────────────────────────────────────────

/**
 * Every graded answer in a classroom, as review events.
 *
 * Pretests are left out: they come before teaching, so a wrong answer there says
 * nothing about memory.
 */
export function reviewEvents(classroom: string): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const lesson of listLessonDirs(classroom)) {
    const grades = new Map(listGrades(classroom, lesson).map((g) => [g.submissionId, g]));
    for (const submission of listSubmissions(classroom, lesson)) {
      const grade = grades.get(submission.id);
      if (!grade || kindOf(submission) === "pretest") continue;
      for (const [questionId, group] of answersByQuestion(submission.answers)) {
        const verdict = grade.questions.find((q) => q.questionId === questionId);
        if (!verdict) continue;
        events.push({
          key: group[0].reviewOf ?? reviewKey(lesson, submission.quizId, questionId),
          at: submission.submittedAt,
          correct: verdict.correct,
          prompt: group[0].prompt ?? "",
          answer: answerSummary(group),
          feedback: verdict.feedback,
        });
      }
    }
  }
  return events;
}

/** Every review item in a classroom, with its schedule, soonest due first. */
export function reviewItems(classroom: string): ReviewItem[] {
  return scheduleItems(reviewEvents(classroom));
}

// ── Reflections ───────────────────────────────────────────────────────────────

/** A self-explanation the learner wrote in a `form.cl-reflect`. It is never graded. */
export interface Reflection {
  id: string;
  classroom: string;
  lesson: string;
  reflectId: string;
  prompt: string;
  text: string;
  savedAt: number;
}

/** Every saved reflection in a lesson, oldest first. Each save is kept. */
export function listReflections(classroom: string, lesson: string): Reflection[] {
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) return [];
  return readJson<Reflection[]>(reflectionsFile(classroom, lesson)) ?? [];
}

export function createReflection(input: Omit<Reflection, "id" | "savedAt">): Reflection {
  const list = listReflections(input.classroom, input.lesson);
  const last = list.length > 0 ? list[list.length - 1].savedAt : 0;
  const reflection: Reflection = {
    ...input,
    id: randomUUID(),
    savedAt: Math.max(Date.now(), last + 1),
  };
  list.push(reflection);
  writeJson(reflectionsFile(input.classroom, input.lesson), list);
  return reflection;
}

/** The latest save of each reflection in a lesson. */
export function latestReflections(classroom: string, lesson: string): Reflection[] {
  const latest = new Map<string, Reflection>();
  for (const reflection of listReflections(classroom, lesson)) {
    latest.set(reflection.reflectId, reflection);
  }
  return [...latest.values()];
}

// ── Glossary ──────────────────────────────────────────────────────────────────

/** The classroom's GLOSSARY.md, parsed. A classroom with no glossary has no terms. */
export function readGlossary(classroom: string): Glossary {
  const file = path.join(classroomDir(classroom), "GLOSSARY.md");
  if (!isFile(file)) return { terms: [], errors: [] };
  return parseGlossary(fs.readFileSync(file, "utf8"));
}

// ── Classroom documents (MISSION.md and friends) ──────────────────────────────

/** Markdown documents a classroom may carry, in the order the UI shows them. */
export const CLASSROOM_DOCS = ["MISSION.md", "RESOURCES.md", "GLOSSARY.md", "NOTES.md"] as const;

export function listClassroomDocs(classroom: string): string[] {
  const dir = classroomDir(classroom);
  return CLASSROOM_DOCS.filter((doc) => isFile(path.join(dir, doc)));
}

export function listLearningRecords(classroom: string): string[] {
  const dir = path.join(classroomDir(classroom), "learning-records");
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** Every learning record with its contents, oldest first. */
export function readLearningRecords(classroom: string): Array<{ file: string; markdown: string }> {
  const dir = path.join(classroomDir(classroom), "learning-records");
  return listLearningRecords(classroom).map((file) => ({
    file,
    markdown: fs.readFileSync(path.join(dir, file), "utf8"),
  }));
}

export function listReferenceDocs(classroom: string): string[] {
  const dir = path.join(classroomDir(classroom), "reference");
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".html"))
    .sort();
}
