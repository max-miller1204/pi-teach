/**
 * server.ts — the in-process HTTP server behind /classroom.
 *
 * One singleton per Pi session, bound to loopback, started lazily and closed on
 * session_shutdown. It is in-process rather than a detached daemon on purpose: the
 * whole point is that a question asked in the browser reaches the agent running in
 * this session, which a separate process could not do.
 *
 * Routes:
 *   GET    /                                  landing page
 *   GET    /c/<classroom>                     classroom page
 *   GET    /c/<classroom>/<lesson>            lesson, with the runtime injected
 *   GET    /c/<classroom>/assets/<path>       classroom-local assets
 *   GET    /c/<classroom>/<lesson>/media/<p>  lesson-local media
 *   GET    /doc/<classroom>/<file>.md         markdown document
 *   GET    /doc/<classroom>/learning-records/<file>.md
 *   GET    /r/<classroom>/<file>.html         reference document
 *   GET    /static/<file>                     bundled runtime assets
 *   POST   /api/ask                           ask a question about a highlight
 *   POST   /api/annotations/<id>/follow-up    ask a follow-up inside an existing card
 *   POST   /api/quiz/submit                   submit quiz answers for grading
 *   GET    /api/state                         annotations + latest quiz state
 *   DELETE /api/annotations/<id>              remove a question
 *   GET    /api/events                        SSE: answer, grade, reload
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { readConfig, resolveConfiguredPort } from "./config.js";
import { injectLessonRuntime } from "./lesson-html.js";
import {
  classroomDir,
  isFile,
  isValidSlug,
  lessonDir,
  runtimeAssetsDir,
  safeJoin,
} from "./paths.js";
import { classroomPage, documentPage, landingPage, notFoundPage } from "./pages.js";
import * as store from "./store.js";

// ── Callbacks into the extension ──────────────────────────────────────────────

export interface ServerHooks {
  /** Called after a question is persisted, to wake the agent. */
  onAsk(annotation: store.Annotation): void;
  /** Called after a follow-up is appended to an existing card. */
  onFollowUp(annotation: store.Annotation, followUp: store.FollowUp): void;
  /** Called after a quiz submission is persisted, to ask for grading. */
  onQuizSubmit(submission: store.QuizSubmission): void;
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
  event: "answer" | "grade" | "reload",
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

  if (segments.length === 0) return sendHtml(res, landingPage(store.listClassrooms()));
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
  const file = safeJoin(runtimeAssetsDir(), rest.join("/"));
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
    return sendHtml(
      res,
      classroomPage({
        classroom,
        lessons: store.listLessons(name),
        docs: store.listClassroomDocs(name),
        learningRecords: store.listLearningRecords(name),
        referenceDocs: store.listReferenceDocs(name),
      }),
    );
  }

  // /c/<classroom>/assets/<path>
  if (second === "assets") {
    const file = safeJoin(path.join(classroomDir(name), "assets"), tail.join("/"));
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
    const file = safeJoin(path.join(lessonDir(name, second), "media"), tail.slice(1).join("/"));
    if (!file || !isFile(file)) return sendNotFound(res, "File not found");
    return sendFile(res, file);
  }

  // /c/<classroom>/<lesson>
  let html: string;
  try {
    html = fs.readFileSync(lesson.htmlPath, "utf8");
  } catch {
    return sendNotFound(res, `Could not read lesson: ${second}`);
  }

  sendHtml(
    res,
    injectLessonRuntime(html, {
      classroom: name,
      lesson: second,
      classroomTitle: classroom.title,
      lessonTitle: lesson.title,
      baseUrl: getBaseUrl() ?? "",
    }),
  );
}

function handleDoc(res: http.ServerResponse, rest: string[]): void {
  const [name, ...tail] = rest;
  if (!isValidSlug(name)) return sendNotFound(res, "Unknown classroom");
  const classroom = store.readClassroom(name);
  if (!classroom) return sendNotFound(res, `Unknown classroom: ${name}`);

  const relative = tail.join("/");
  // Only the classroom's own markdown is viewable — root-level docs and learning records.
  const allowed =
    (tail.length === 1 && (store.CLASSROOM_DOCS as readonly string[]).includes(tail[0])) ||
    (tail.length === 2 && tail[0] === "learning-records" && tail[1].endsWith(".md"));
  if (!allowed) return sendNotFound(res, "Not found");

  const file = safeJoin(classroomDir(name), relative);
  if (!file || !isFile(file)) return sendNotFound(res, `No such document: ${relative}`);
  sendHtml(res, documentPage(classroom, path.basename(file), fs.readFileSync(file, "utf8")));
}

function handleReference(res: http.ServerResponse, rest: string[]): void {
  const [name, ...tail] = rest;
  if (!isValidSlug(name)) return sendNotFound(res, "Unknown classroom");
  const classroom = store.readClassroom(name);
  if (!classroom) return sendNotFound(res, `Unknown classroom: ${name}`);

  const file = safeJoin(path.join(classroomDir(name), "reference"), tail.join("/"));
  if (!file || !file.endsWith(".html") || !isFile(file)) return sendNotFound(res, "Not found");

  // Reference docs get the stylesheet and the theme toggle, but not the lesson
  // runtime: there is no quiz to submit and nothing to anchor questions to.
  const html = fs.readFileSync(file, "utf8");
  const head = `<link rel="stylesheet" href="/static/classroom.css">
<script>try{var t=localStorage.getItem("pi-classroom-theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}</script>`;
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

  if (route === "events" && req.method === "GET") return handleEvents(req, res, url);
  if (route === "state" && req.method === "GET") return handleState(res, url);
  if (route === "ask" && req.method === "POST") return handleAsk(req, res);
  if (route === "quiz/submit" && req.method === "POST") return handleQuizSubmit(req, res);
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

  const { submission, grade } = store.latestQuizState(params.classroom, params.lesson);
  sendJson(res, {
    annotations: store.listAnnotations(params.classroom, params.lesson),
    submission,
    grade,
  });
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

  const rawAnswers = Array.isArray(body["answers"]) ? (body["answers"] as unknown[]) : [];
  const answers: store.QuizAnswer[] = rawAnswers
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => ({
      questionId: String(a["questionId"] ?? "").slice(0, 128),
      value: String(a["value"] ?? "").slice(0, 8000),
      label: typeof a["label"] === "string" ? a["label"].slice(0, 1000) : undefined,
      prompt: typeof a["prompt"] === "string" ? a["prompt"].slice(0, 2000) : undefined,
    }))
    .filter((a) => a.questionId.length > 0);

  if (answers.length === 0) return sendJson(res, { error: "No answers submitted" }, 400);

  const submission = store.createSubmission({
    classroom,
    lesson,
    quizId: String(body["quizId"] ?? "quiz").slice(0, 128),
    quizTitle: String(body["quizTitle"] ?? "Check on learning").slice(0, 200),
    answers,
  });

  hooks?.onQuizSubmit(submission);
  sendJson(res, submission, 201);
}

function handleDeleteAnnotation(res: http.ServerResponse, id: string, url: URL): void {
  const params = lessonParams(url);
  if (!params) return sendJson(res, { error: "classroom and lesson are required" }, 400);
  const removed = store.deleteAnnotation(params.classroom, params.lesson, id);
  sendJson(res, { removed });
}

// ── Singleton lifecycle ───────────────────────────────────────────────────────

let server: http.Server | null = null;
let serverPort: number | null = null;

/**
 * Start the server if it is not already running, returning the base URL.
 *
 * A configured port that is already taken (a second Pi session, most likely) falls
 * back to an ephemeral one rather than failing — /classroom should always work.
 */
export function start(): Promise<string> {
  if (server && serverPort) return Promise.resolve(`http://127.0.0.1:${serverPort}`);

  const preferredPort = resolveConfiguredPort(readConfig().port);

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        console.error("[classroom] request failed", err);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      });
    });
    let attemptPort = preferredPort;

    s.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attemptPort !== 0) {
        attemptPort = 0;
        s.listen(0, "127.0.0.1");
        return;
      }
      reject(err);
    });

    s.listen(attemptPort, "127.0.0.1", () => {
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
}

export function close(): Promise<void> {
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
