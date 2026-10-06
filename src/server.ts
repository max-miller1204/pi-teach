/**
 * server.ts — the in-process HTTP server behind /classroom.
 *
 * One loopback singleton per process. Pi starts it lazily and closes it on
 * session_shutdown. Claude Code and Codex run it in the persistent service.
 * Hooks route browser requests to the owner for each host.
 *
 * Routes:
 *   GET    /                                  landing page
 *   GET    /c/<classroom>                     classroom page
 *   GET    /c/<classroom>/<lesson>            lesson, with the runtime injected
 *   GET    /c/<classroom>/assets/<path>       classroom-local assets
 *   GET    /c/<classroom>/<lesson>/media/<p>  lesson-local media
 *   GET    /doc/<classroom>/<file>.md         markdown document
 *   GET    /doc/<classroom>/learning-records       every learning record, summarised
 *   GET    /doc/<classroom>/learning-records/<file>.md
 *   GET    /doc/<classroom>/notes/<file>.md        a topic file indexed by NOTES.md
 *   GET    /r/<classroom>/<file>.html         reference document
 *   GET    /static/<file>                     bundled runtime assets
 *   POST   /api/ask                           ask a question about a highlight
 *   POST   /api/annotations/<id>/follow-up    ask a follow-up inside an existing card
 *   POST   /api/quiz/submit                   submit quiz answers for grading
 *   POST   /api/reflect                       save a self-explanation (never graded)
 *   PUT    /api/draft                         save or remove one unsent draft
 *   GET    /api/state                         annotations, quiz attempts, reflections, drafts
 *   GET    /api/glossary                      the classroom's GLOSSARY.md, parsed
 *   DELETE /api/annotations/<id>              remove a question
 *   GET    /api/events                        SSE: answer, grade, reload
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { readConfig, resolveConfiguredPort } from "./config.ts";
import { injectLessonRuntime } from "./lesson-html.ts";
import { stageLesson } from "./pretest.ts";
import { authoredQuizzes } from "./quiz-authoring.ts";
import { parseTeachingPlan } from "./teaching-plan.ts";
import { parseRubric } from "./rubric.ts";
import {
  classroomDir,
  isFile,
  isValidSlug,
  lessonDir,
  runtimeAssetsDir,
  safeStaticFile,
} from "./paths.ts";
import {
  classroomPage,
  documentPage,
  landingPage,
  learningRecordsPage,
  notFoundPage,
} from "./pages.ts";
import { AnswerError, parseAnswers } from "./quiz.ts";
import { isDue, summarize } from "./review.ts";
import { isContractId, isQuizKind } from "../assets/runtime/quiz.mjs";
import { draftErrors, isDraftKey } from "../assets/runtime/draft.mjs";
import * as store from "./store.ts";

// ── Callbacks into the extension ──────────────────────────────────────────────

export interface ServerHooks {
  delivery?: "push" | "wait" | "service";
  canAccept?(classroom: string): void;
  teacherState?(classroom: string, lesson: string): unknown;
  onTeacherChat?(classroom: string, lesson: string, text: string, id: string): void;
  onTeacherRetry?(classroom: string, id: string): void;
  /** Called after a question is persisted, to wake the agent. */
  onAsk(annotation: store.Annotation): void;
  /** Called after a follow-up is appended to an existing card. */
  onFollowUp(annotation: store.Annotation, followUp: store.FollowUp): void;
  /** Called after a quiz submission is persisted, to ask for grading. */
  onQuizSubmit(submission: store.QuizSubmission): void;
  /** Called after a reflection is saved, so the teacher sees it. */
  onReflect(reflection: store.Reflection): void;
}

let hooks: ServerHooks | null = null;

export function setHooks(next: ServerHooks): void {
  hooks = next;
}

// ── SSE registry ──────────────────────────────────────────────────────────────

/** Keyed by `<classroom>/<lesson>` so an event only reaches the page it concerns. */
const sseClients = new Map<string, Set<http.ServerResponse>>();

function lessonKey(classroom: string, lesson: string): string {
  return `${classroom}/${lesson}`;
}

function addClient(key: string, res: http.ServerResponse): void {
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key)!.add(res);
}

function removeClient(key: string, res: http.ServerResponse): void {
  const set = sseClients.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(key);
}

/** Push an event to every browser currently viewing a lesson. */
export function pushEvent(
  classroom: string,
  lesson: string,
  event: "answer" | "grade" | "reload" | "teacher",
  data: unknown,
): void {
  const clients = sseClients.get(lessonKey(classroom, lesson));
  if (!clients || clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

// ── Responses ─────────────────────────────────────────────────────────────────

function sendHtml(res: http.ServerResponse, html: string, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendJson(res: http.ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function sendNotFound(res: http.ServerResponse, message: string, wantsJson = false): void {
  if (wantsJson) return sendJson(res, { error: message }, 404);
  sendHtml(res, notFoundPage(message), 404);
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendFile(res: http.ServerResponse, file: string): void {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch {
    return sendNotFound(res, `File not found: ${path.basename(file)}`);
  }
  res.writeHead(200, { "Content-Type": contentTypeFor(file), "Cache-Control": "no-store" });
  res.end(body);
}

/** Read and JSON-parse a request body, with a cap so a stray client cannot exhaust memory. */
function readJsonBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ── Routing ───────────────────────────────────────────────────────────────────

/** Decoded, non-empty path segments; null when the path is malformed. */
export function splitPath(pathname: string): string[] | null {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const segments = splitPath(url.pathname);
  if (!segments) return sendNotFound(res, "Malformed URL");

  if (segments[0] === "api") return handleApi(req, res, segments.slice(1), url);
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end("Method not allowed");
    return;
  }

  if (segments.length === 0) {
    const classrooms = store.listClassrooms();
    const now = Date.now();
    const due = Object.fromEntries(
      classrooms.map((c) => [c.name, summarize(store.reviewItems(c.name), now).due]),
    );
    return sendHtml(res, landingPage(classrooms, due));
  }
  // Reason: lessons are plain documents with no <link rel="icon">, so the browser asks
  // for /favicon.ico and logs a 404 in the console on every lesson view.
  if (segments.length === 1 && segments[0] === "favicon.ico") return sendFavicon(res);
  if (segments[0] === "static") return handleStatic(res, segments.slice(1));
  if (segments[0] === "c") return handleClassroomRoute(res, segments.slice(1));
  if (segments[0] === "doc") return handleDoc(res, segments.slice(1));
  if (segments[0] === "r") return handleReference(res, segments.slice(1));

  sendNotFound(res, `No such page: ${url.pathname}`);
}

const FAVICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📚</text></svg>';

function sendFavicon(res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
  res.end(FAVICON);
}

function handleStatic(res: http.ServerResponse, rest: string[]): void {
  const file = safeStaticFile(runtimeAssetsDir(), rest.join("/"));
  if (!file || !isFile(file)) return sendNotFound(res, "Asset not found");
  sendFile(res, file);
}

function handleClassroomRoute(res: http.ServerResponse, rest: string[]): void {
  const [name, second, ...tail] = rest;
  if (!isValidSlug(name)) return sendNotFound(res, "Unknown classroom");

  const classroom = store.readClassroom(name);
  if (!classroom) return sendNotFound(res, `Unknown classroom: ${name}`);

  // /c/<classroom>
  if (second === undefined) {
    const now = Date.now();
    const items = store.reviewItems(name);
    const dueByLesson: Record<string, number> = {};
    for (const item of items) {
      if (isDue(item, now)) dueByLesson[item.lesson] = (dueByLesson[item.lesson] ?? 0) + 1;
    }
    return sendHtml(
      res,
      classroomPage({
        classroom,
        lessons: store.listLessons(name),
        docs: store.listClassroomDocs(name),
        learningRecords: store.listLearningRecords(name),
        referenceDocs: store.listReferenceDocs(name),
        progress: {
          review: summarize(items, now),
          dueByLesson,
          glossaryTerms: store.readGlossary(name).terms.length,
          now,
        },
      }),
    );
  }

  // /c/<classroom>/assets/<path>
  if (second === "assets") {
    const file = safeStaticFile(path.join(classroomDir(name), "assets"), tail.join("/"));
    if (!file || !isFile(file)) return sendNotFound(res, "Asset not found");
    return sendFile(res, file);
  }

  if (!isValidSlug(second)) return sendNotFound(res, "Unknown lesson");
  const lesson = store.readLesson(name, second);
  if (!lesson) return sendNotFound(res, `Unknown lesson: ${second}`);

  // /c/<classroom>/<lesson>/media/<path> — anything else under the lesson directory
  // is deliberately not served: quiz/ holds submissions and any answer key.
  if (tail.length > 0) {
    if (tail[0] !== "media") return sendNotFound(res, "Not found");
    const file = safeStaticFile(
      path.join(lessonDir(name, second), "media"),
      tail.slice(1).join("/"),
    );
    if (!file || !isFile(file)) return sendNotFound(res, "File not found");
    return sendFile(res, file);
  }

  // /c/<classroom>/<lesson>
  const publicLesson = safeStaticFile(lessonDir(name, second), path.basename(lesson.htmlPath));
  if (!publicLesson) return sendNotFound(res, "Lesson document cannot be a symlink");
  let html: string;
  try {
    html = fs.readFileSync(lesson.htmlPath, "utf8");
  } catch {
    return sendNotFound(res, `Could not read lesson: ${second}`);
  }

  const staged = stageLesson(
    html,
    new Set(
      store
        .latestQuizStates(name, second)
        .filter((state) => state.submission.kind === "pretest" && state.grade)
        .map((state) => state.quizId),
    ),
  );
  sendHtml(
    res,
    injectLessonRuntime(staged.html, {
      classroom: name,
      lesson: second,
      classroomTitle: classroom.title,
      lessonTitle: lesson.title,
      baseUrl: getBaseUrl() ?? "",
      delivery: hooks?.delivery ?? "push",
      pendingPretests: staged.pendingPretests,
    }),
  );
}

function handleDoc(res: http.ServerResponse, rest: string[]): void {
  const [name, ...tail] = rest;
  if (!isValidSlug(name)) return sendNotFound(res, "Unknown classroom");
  const classroom = store.readClassroom(name);
  if (!classroom) return sendNotFound(res, `Unknown classroom: ${name}`);

  // /doc/<classroom>/learning-records — the index of every record.
  if (tail.length === 1 && tail[0] === "learning-records") {
    return sendHtml(res, learningRecordsPage(classroom, store.readLearningRecords(name)));
  }

  // Only the classroom's own markdown is viewable — root-level docs, learning records,
  // and the topic files NOTES.md indexes.
  const relative = tail.join("/");
  // Reason: segments are decoded, so `..%2fMISSION.md` arrives as one segment holding a
  // slash — insist on a plain file name, or it climbs out of the subdirectory.
  const nested =
    tail.length === 2 && tail[1].endsWith(".md") && !/[\\/]/.test(tail[1])
      ? DOC_DIRS[tail[0]]
      : undefined;
  const allowed =
    (tail.length === 1 && (store.CLASSROOM_DOCS as readonly string[]).includes(tail[0])) ||
    nested !== undefined;
  if (!allowed) return sendNotFound(res, "Not found");

  const file = safeStaticFile(classroomDir(name), relative);
  if (!file || !isFile(file)) return sendNotFound(res, `No such document: ${relative}`);
  const parent = nested && {
    label: nested.label,
    href: `/doc/${encodeURIComponent(name)}/${nested.href}`,
  };
  sendHtml(
    res,
    documentPage(classroom, path.basename(file), fs.readFileSync(file, "utf8"), parent),
  );
}

/** Classroom subdirectories of markdown, and the index page each one sits under. */
const DOC_DIRS: Record<string, { label: string; href: string } | undefined> = {
  "learning-records": { label: "Learning records", href: "learning-records" },
  notes: { label: "Notes", href: "NOTES.md" },
};

function handleReference(res: http.ServerResponse, rest: string[]): void {
  const [name, ...tail] = rest;
  if (!isValidSlug(name)) return sendNotFound(res, "Unknown classroom");
  const classroom = store.readClassroom(name);
  if (!classroom) return sendNotFound(res, `Unknown classroom: ${name}`);

  const file = safeStaticFile(path.join(classroomDir(name), "reference"), tail.join("/"));
  if (!file || !file.endsWith(".html") || !isFile(file)) return sendNotFound(res, "Not found");

  // Reference docs get the stylesheet, the theme bootstrap, the link behaviour, and
  // the diagrams, but not the lesson runtime: there is no quiz to submit and nothing to anchor
  // questions to.
  const html = fs.readFileSync(file, "utf8");
  const head = `<link rel="stylesheet" href="/static/classroom.css">
<script>try{var t=localStorage.getItem("pi-classroom-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}</script>
<script type="module">import{initLinks}from"/static/links.mjs";initLinks();</script>
<script type="module">import{initDiagrams}from"/static/diagrams.mjs";initDiagrams(document.body);</script>`;
  const idx = html.search(/<\/head\s*>/i);
  sendHtml(res, idx === -1 ? head + html : html.slice(0, idx) + head + html.slice(idx));
}

// ── API ───────────────────────────────────────────────────────────────────────

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rest: string[],
  url: URL,
): Promise<void> {
  const route = rest.join("/");
  if (route === "teacher/chat" && req.method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    const { classroom, lesson, text, id } = body;
    if (
      !isValidSlug(classroom) ||
      !isValidSlug(lesson) ||
      !store.readLesson(classroom, lesson) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 8000 ||
      typeof id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(id)
    )
      return sendJson(res, { error: "Invalid teacher reply." }, 400);
    if (!hooks?.onTeacherChat) return sendJson(res, { error: "No dedicated teacher." }, 409);
    store.clearDraft(classroom, lesson, "teacher");
    hooks.onTeacherChat(classroom, lesson, text.trim(), id);
    return sendJson(res, { saved: true }, 201);
  }
  if (route === "teacher/retry" && req.method === "POST") {
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (!isValidSlug(body.classroom) || typeof body.id !== "string")
      return sendJson(res, { error: "Invalid request." }, 400);
    if (!hooks?.onTeacherRetry) return sendJson(res, { error: "No dedicated teacher." }, 409);
    hooks.onTeacherRetry(body.classroom, body.id);
    return sendJson(res, { queued: true });
  }

  if (route === "events" && req.method === "GET") return handleEvents(req, res, url);
  if (route === "state" && req.method === "GET") return handleState(res, url);
  if (route === "ask" && req.method === "POST") return handleAsk(req, res);
  if (route === "quiz/submit" && req.method === "POST") return handleQuizSubmit(req, res);
  if (route === "reflect" && req.method === "POST") return handleReflect(req, res);
  if (route === "draft" && req.method === "PUT") return handleDraft(req, res);
  if (route === "glossary" && req.method === "GET") return handleGlossary(res, url);
  if (rest[0] === "annotations" && rest.length === 2 && req.method === "DELETE") {
    return handleDeleteAnnotation(res, rest[1], url);
  }
  if (
    rest[0] === "annotations" &&
    rest.length === 3 &&
    rest[2] === "follow-up" &&
    req.method === "POST"
  ) {
    return handleFollowUp(req, res, rest[1]);
  }

  sendJson(res, { error: `No such endpoint: /api/${route}` }, 404);
}

function lessonParams(url: URL): { classroom: string; lesson: string } | null {
  const classroom = url.searchParams.get("classroom") ?? "";
  const lesson = url.searchParams.get("lesson") ?? "";
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) return null;
  return { classroom, lesson };
}

function handleEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const params = lessonParams(url);
  if (!params) return sendJson(res, { error: "classroom and lesson are required" }, 400);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");

  const key = lessonKey(params.classroom, params.lesson);
  addClient(key, res);
  req.on("close", () => removeClient(key, res));
}

function handleState(res: http.ServerResponse, url: URL): void {
  const params = lessonParams(url);
  if (!params) return sendJson(res, { error: "classroom and lesson are required" }, 400);

  sendJson(res, {
    annotations: store.listAnnotations(params.classroom, params.lesson),
    quizzes: store.latestQuizStates(params.classroom, params.lesson),
    reflections: store.latestReflections(params.classroom, params.lesson),
    drafts: store.readDrafts(params.classroom, params.lesson),
    teacher: hooks?.teacherState?.(params.classroom, params.lesson),
  });
}

function handleGlossary(res: http.ServerResponse, url: URL): void {
  const classroom = url.searchParams.get("classroom") ?? "";
  if (!isValidSlug(classroom) || !store.readClassroom(classroom)) {
    return sendJson(res, { error: "Unknown classroom" }, 404);
  }
  sendJson(res, store.readGlossary(classroom));
}

/** Validate the anchor an untrusted browser sent us before persisting it. */
function parseAnchor(value: unknown): store.Annotation["anchor"] | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (typeof a["exact"] !== "string" || a["exact"].length === 0) return null;
  return {
    exact: a["exact"].slice(0, 2000),
    prefix: typeof a["prefix"] === "string" ? a["prefix"].slice(0, 500) : "",
    suffix: typeof a["suffix"] === "string" ? a["suffix"].slice(0, 500) : "",
    occurrence: typeof a["occurrence"] === "number" && a["occurrence"] >= 0 ? a["occurrence"] : 0,
  };
}

async function handleAsk(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    return sendJson(res, { error: (err as Error).message }, 400);
  }

  const classroom = String(body["classroom"] ?? "");
  const lesson = String(body["lesson"] ?? "");
  const question = String(body["question"] ?? "").trim();
  const anchor = parseAnchor(body["anchor"]);

  if (!isValidSlug(classroom) || !isValidSlug(lesson)) {
    return sendJson(res, { error: "Unknown classroom or lesson" }, 400);
  }
  if (!question) return sendJson(res, { error: "A question is required" }, 400);
  if (!anchor) return sendJson(res, { error: "A valid anchor is required" }, 400);
  if (!store.readLesson(classroom, lesson)) return sendJson(res, { error: "Unknown lesson" }, 404);

  hooks?.canAccept?.(classroom);
  // Before the save: a draft file that cannot be read must stop the request, not
  // leave a saved question that the teacher never hears about.
  store.clearDraft(classroom, lesson, "ask");
  const annotation = store.createAnnotation({
    classroom,
    lesson,
    question: question.slice(0, 4000),
    selection:
      typeof body["selection"] === "string" ? body["selection"].slice(0, 2000) : anchor.exact,
    anchor,
  });

  hooks?.onAsk(annotation);
  sendJson(res, annotation, 201);
}

async function handleFollowUp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  annotationId: string,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    return sendJson(res, { error: (err as Error).message }, 400);
  }

  const question = String(body["question"] ?? "").trim();
  if (!question) return sendJson(res, { error: "A question is required" }, 400);

  const existing = store.findAnnotation(annotationId);
  if (!existing) return sendJson(res, { error: "Unknown question" }, 404);
  // Reason: a card whose first question is still spinning has no answer to follow up on,
  // and the thread prompt would have nothing to build from.
  if (existing.status === "pending") {
    return sendJson(res, { error: "That question has not been answered yet" }, 409);
  }

  hooks?.canAccept?.(existing.classroom);
  store.clearDraft(existing.classroom, existing.lesson, `followup:${annotationId}`);
  const added = store.addFollowUp(annotationId, question.slice(0, 4000));
  if (!added) return sendJson(res, { error: "Could not save the follow-up" }, 500);

  hooks?.onFollowUp(added.annotation, added.followUp);
  sendJson(res, added.annotation, 201);
}

async function handleQuizSubmit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    return sendJson(res, { error: (err as Error).message }, 400);
  }

  const classroom = String(body["classroom"] ?? "");
  const lesson = String(body["lesson"] ?? "");
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) {
    return sendJson(res, { error: "Unknown classroom or lesson" }, 400);
  }
  if (!store.readLesson(classroom, lesson)) return sendJson(res, { error: "Unknown lesson" }, 404);

  const quizId = body["quizId"];
  if (!isContractId(quizId)) return sendJson(res, { error: "A valid quizId is required" }, 400);
  const page = store.readLesson(classroom, lesson)!;
  const staged = stageLesson(
    fs.readFileSync(page.htmlPath, "utf8"),
    new Set(
      store
        .latestQuizStates(classroom, lesson)
        .filter((s) => s.submission.kind === "pretest" && s.grade)
        .map((s) => s.quizId),
    ),
  );
  if (staged.lockedQuizIds.includes(quizId))
    return sendJson(res, { error: "Complete the pretest before submitting this quiz" }, 409);
  const kind = body["kind"];
  if (!isQuizKind(kind)) {
    return sendJson(res, { error: `Unknown quiz kind: ${JSON.stringify(kind)}` }, 400);
  }

  let answers: store.QuizAnswer[];
  try {
    answers = parseAnswers(body["answers"], kind);
  } catch (err) {
    if (err instanceof AnswerError) return sendJson(res, { error: err.message }, 400);
    throw err;
  }

  if (page.assessmentContract === 1) {
    try {
      const html = fs.readFileSync(page.htmlPath, "utf8");
      const quizzes = authoredQuizzes(html).filter((q) => q.id === quizId);
      if (quizzes.length !== 1) throw new Error("Submit an authored quiz id exactly once.");
      const authored = quizzes[0];
      if (kind !== authored.kind)
        throw new Error("Quiz kind does not match the authored assessment.");
      if (
        answers.length !== authored.questions.length ||
        new Set(authored.questions.map((q) => q.id)).size !== authored.questions.length
      )
        throw new Error("Answer every authored question exactly once.");
      for (const question of authored.questions) {
        const answer = answers.find((a) => a.questionId === question.id);
        if (!answer || answer.type !== question.type)
          throw new Error(`Answer type or id does not match authored question ${question.id}.`);
        if (kind === "review" && answer.reviewOf !== question.reviewOf)
          throw new Error(`Review identity does not match authored question ${question.id}.`);
      }
      if (page.instructionalContract === 1)
        parseTeachingPlan(
          fs.readFileSync(path.join(lessonDir(classroom, lesson), "quiz", "plan.json"), "utf8"),
          html,
        );
      parseRubric(
        fs.readFileSync(path.join(lessonDir(classroom, lesson), "quiz", "key.json"), "utf8"),
        html,
      );
    } catch (err) {
      return sendJson(
        res,
        { error: `Invalid assessment contract: ${(err as Error).message}` },
        400,
      );
    }
  }

  // A review question must name an item the learner was graded on before. Otherwise
  // its grade would start a schedule for an item that does not exist.
  if (kind === "review") {
    const known = new Set(store.reviewItems(classroom).map((item) => item.key));
    const unknown = answers.filter((a) => !known.has(a.reviewOf!)).map((a) => a.reviewOf);
    if (unknown.length > 0) {
      return sendJson(
        res,
        { error: `data-review-of names no graded question: ${unknown.join(", ")}` },
        400,
      );
    }
  }

  // Reason: a retake is a new attempt at a graded quiz. While the last attempt waits on
  // the teacher, a second one would only reach them as a duplicate.
  const latest = store.latestQuizStates(classroom, lesson).find((q) => q.quizId === quizId);
  if (latest && !latest.grade) {
    return sendJson(res, { error: "The last attempt at this quiz is not graded yet" }, 409);
  }

  hooks?.canAccept?.(classroom);
  store.clearDraft(classroom, lesson, `quiz:${quizId}`);
  const submission = store.createSubmission({
    classroom,
    lesson,
    quizId,
    quizTitle: String(body["quizTitle"] ?? "Check on learning").slice(0, 200),
    kind,
    answers,
  });

  hooks?.onQuizSubmit(submission);
  sendJson(res, submission, 201);
}

async function handleReflect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    return sendJson(res, { error: (err as Error).message }, 400);
  }

  const classroom = String(body["classroom"] ?? "");
  const lesson = String(body["lesson"] ?? "");
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) {
    return sendJson(res, { error: "Unknown classroom or lesson" }, 400);
  }
  if (!store.readLesson(classroom, lesson)) return sendJson(res, { error: "Unknown lesson" }, 404);

  const reflectId = body["reflectId"];
  if (!isContractId(reflectId)) {
    return sendJson(res, { error: "A valid reflectId is required" }, 400);
  }
  const text = typeof body["text"] === "string" ? body["text"].trim() : "";
  if (!text) return sendJson(res, { error: "A reflection needs some text" }, 400);

  hooks?.canAccept?.(classroom);
  store.clearDraft(classroom, lesson, `reflect:${reflectId}`);
  const reflection = store.createReflection({
    classroom,
    lesson,
    reflectId,
    prompt: typeof body["prompt"] === "string" ? body["prompt"].slice(0, 2000) : "",
    text: text.slice(0, 8000),
  });

  hooks?.onReflect(reflection);
  sendJson(res, reflection, 201);
}

/**
 * Save one draft, or remove it when `value` is null.
 *
 * Drafts never reach the teacher. They exist so a reload does not lose what the
 * learner typed. The handlers that send text remove the matching draft.
 */
async function handleDraft(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(req)) as Record<string, unknown>;
  } catch (err) {
    return sendJson(res, { error: (err as Error).message }, 400);
  }

  const { classroom, lesson, key, value } = body;
  if (!isValidSlug(classroom) || !isValidSlug(lesson)) {
    return sendJson(res, { error: "Unknown classroom or lesson" }, 400);
  }
  if (!store.readLesson(classroom, lesson)) return sendJson(res, { error: "Unknown lesson" }, 404);
  if (!isDraftKey(key))
    return sendJson(res, { error: `Unknown draft key ${JSON.stringify(key)}.` }, 400);
  if (value === null) {
    store.clearDraft(classroom, lesson, key);
    return sendJson(res, { saved: false });
  }
  const errors = draftErrors(key, value);
  if (errors.length > 0) return sendJson(res, { error: errors.join(" ") }, 400);
  store.saveDraft(classroom, lesson, key, value);
  sendJson(res, { saved: true });
}

function handleDeleteAnnotation(res: http.ServerResponse, id: string, url: URL): void {
  const params = lessonParams(url);
  if (!params) return sendJson(res, { error: "classroom and lesson are required" }, 400);
  store.clearDraft(params.classroom, params.lesson, `followup:${id}`);
  const removed = store.deleteAnnotation(params.classroom, params.lesson, id);
  sendJson(res, { removed });
}

// ── Singleton lifecycle ───────────────────────────────────────────────────────

let server: http.Server | null = null;
let serverPort: number | null = null;
let starting: Promise<string> | null = null;

/** Start the session server. Reject an occupied configured port. */
export async function start(port?: number): Promise<string> {
  if (server && serverPort) return Promise.resolve(`http://127.0.0.1:${serverPort}`);

  if (starting) return starting;
  const preferredPort = port === undefined ? resolveConfiguredPort(readConfig().port) : port;

  starting = new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        console.error("[classroom] request failed", err);
        if (hooks?.delivery === "service" && req.url?.startsWith("/api/") && !res.headersSent) {
          sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
          return;
        }
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
    });

    s.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(`Cannot start classroom server on port ${preferredPort}: ${err.message}`, {
          cause: err,
        }),
      );
    });

    s.listen(preferredPort, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("Failed to determine server port"));
        return;
      }
      server = s;
      serverPort = addr.port;
      resolve(`http://127.0.0.1:${serverPort}`);
    });
  });
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

export async function close(): Promise<void> {
  if (starting) await starting;
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server;
    server = null;
    serverPort = null;
    // End the SSE streams first: an open event-stream keeps close() pending forever.
    for (const clients of sseClients.values()) {
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
    }
    sseClients.clear();
    s.close(() => resolve());
  });
}

export function getBaseUrl(): string | null {
  return server && serverPort ? `http://127.0.0.1:${serverPort}` : null;
}

export function getPort(): number | null {
  return serverPort;
}

export function isRunning(): boolean {
  return server !== null;
}

/** URL for a classroom, or the landing page when no name is given. */
export function urlFor(classroom?: string, lesson?: string): string | null {
  const base = getBaseUrl();
  if (!base) return null;
  if (!classroom) return base;
  if (!lesson) return `${base}/c/${encodeURIComponent(classroom)}`;
  return `${base}/c/${encodeURIComponent(classroom)}/${encodeURIComponent(lesson)}`;
}
