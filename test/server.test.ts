/**
 * Integration coverage: boot the real server against a temp classrooms root and
 * drive it over HTTP, the way a browser does.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

import { applyAnswer, applyGrade } from "../src/bridge.js";
import * as server from "../src/server.js";
import * as store from "../src/store.js";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.js";

let fixture: Fixture;
let baseUrl: string;
const asked: store.Annotation[] = [];
const followedUp: Array<{ annotation: store.Annotation; followUp: store.FollowUp }> = [];
const submitted: store.QuizSubmission[] = [];

beforeAll(async () => {
  fixture = makeFixture();
  seedClassroom(fixture);
  server.setHooks({
    onAsk: (annotation) => asked.push(annotation),
    onFollowUp: (annotation, followUp) => followedUp.push({ annotation, followUp }),
    onQuizSubmit: (submission) => submitted.push(submission),
  });
  baseUrl = await server.start();
});

afterAll(async () => {
  await server.close();
  fixture.cleanup();
});

beforeEach(() => {
  asked.length = 0;
  followedUp.length = 0;
  submitted.length = 0;
});

const get = (path: string) => fetch(`${baseUrl}${path}`);
const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Read Server-Sent Events until `predicate` matches or the deadline passes. */
async function nextEvent(
  url: string,
  trigger: () => void,
  predicate: (frame: string) => boolean,
): Promise<string> {
  const controller = new AbortController();
  const res = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  // The stream is open now, so anything pushed from here on is observable.
  trigger();

  let buffer = "";
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (predicate(buffer)) return buffer;
    }
  } finally {
    controller.abort();
  }
  throw new Error(`Timed out waiting for event. Received: ${JSON.stringify(buffer)}`);
}

describe("pages", () => {
  it("serves a landing page listing the classroom", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('href="/c/rust"');
  });

  it("serves the classroom page", async () => {
    const html = await (await get("/c/rust")).text();
    expect(html).toContain('href="/c/rust/001-ownership"');
    expect(html).toContain('href="/doc/rust/MISSION.md"');
  });

  it("serves a lesson with the runtime injected", async () => {
    const res = await get("/c/rust/001-ownership");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="cl-config"');
    expect(html).toContain("/static/classroom.js");
    expect(html).toContain("Some lesson prose to highlight.");
  });

  it("resolves the lesson template footer to the classroom page", async () => {
    const template = readFileSync(
      new URL("../assets/templates/lesson.html", import.meta.url),
      "utf8",
    );
    fixture.write("rust/002-template/lesson.html", template);
    const lessonUrl = `${baseUrl}/c/rust/002-template`;
    const html = await (await fetch(lessonUrl)).text();
    const href = html.match(/href="([^"]+)">Back to the classroom<\/a>/)?.[1];
    expect(href).toBeDefined();
    const target = new URL(href!, lessonUrl);
    expect(target.pathname).toBe("/c/rust/");
    const res = await fetch(target);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/c/rust/001-ownership"');
  });

  it("resolves documented shared asset links from a lesson URL", async () => {
    fixture.write("rust/assets/source.txt", "Course source");
    const target = new URL("assets/source.txt", `${baseUrl}/c/rust/001-ownership`);
    expect(target.pathname).toBe("/c/rust/assets/source.txt");
    const res = await fetch(target);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Course source");
  });

  it("resolves the reference template link to a served lesson", async () => {
    const template = readFileSync(
      new URL("../assets/templates/reference.html", import.meta.url),
      "utf8",
    )
      .replace(/\{\{CLASSROOM_NAME\}\}/g, "rust")
      .replace(/001-some-lesson/g, "001-ownership");
    fixture.write("rust/reference/summary.html", template);
    const referenceUrl = `${baseUrl}/r/rust/summary.html`;
    const res = await fetch(referenceUrl);
    expect(res.status).toBe(200);
    const html = await res.text();
    const href = html.match(/href="([^"]+)">Where this was taught<\/a>/)?.[1];
    expect(href).toBeDefined();
    const target = new URL(href!, referenceUrl);
    expect(target.pathname).toBe("/c/rust/001-ownership");
    const lesson = await fetch(target);
    expect(lesson.status).toBe(200);
    expect(await lesson.text()).toContain('id="cl-config"');
  });

  it("renders MISSION.md as HTML", async () => {
    const html = await (await get("/doc/rust/MISSION.md")).text();
    expect(html).toContain("Ship a CLI to my team by October.");
    expect(html).toContain("<h1");
  });

  it("serves the bundled runtime assets", async () => {
    const css = await get("/static/classroom.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);

    const js = await get("/static/classroom.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);

    // The runtime imports these as modules, so they must be reachable too.
    expect((await get("/static/anchor.mjs")).status).toBe(200);
    expect((await get("/static/theme.mjs")).status).toBe(200);
  });
});

describe("refusals", () => {
  it("404s unknown classrooms and lessons", async () => {
    expect((await get("/c/nope")).status).toBe(404);
    expect((await get("/c/rust/nope")).status).toBe(404);
    expect((await get("/nope")).status).toBe(404);
  });

  it("refuses path traversal out of the classrooms root", async () => {
    for (const path of [
      "/static/../../package.json",
      "/static/%2e%2e%2f%2e%2e%2fpackage.json",
      "/c/rust/assets/../../../package.json",
      "/c/rust/001-ownership/media/../../lesson.json",
      "/r/rust/../MISSION.md",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("never serves quiz submissions or an answer key as files", async () => {
    fixture.write("rust/001-ownership/quiz/key.json", JSON.stringify({ q1: "a" }));
    expect((await get("/c/rust/001-ownership/quiz/key.json")).status).toBe(404);
    expect((await get("/c/rust/001-ownership/media/../quiz/key.json")).status).toBe(404);
  });

  it("only serves the classroom's own markdown documents", async () => {
    fixture.write("rust/SECRETS.md", "# nope");
    expect((await get("/doc/rust/SECRETS.md")).status).toBe(404);
    expect((await get("/doc/rust/NOTES.md")).status).toBe(404); // not present on disk
  });

  it("rejects non-GET on page routes", async () => {
    const res = await fetch(`${baseUrl}/c/rust`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("asking a question", () => {
  const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };

  it("persists a pending annotation and wakes the agent", async () => {
    const res = await post("/api/ask", {
      classroom: "rust",
      lesson: "001-ownership",
      question: "Why only one owner?",
      selection: "one owner",
      anchor,
    });

    expect(res.status).toBe(201);
    const annotation = (await res.json()) as store.Annotation;
    expect(annotation.status).toBe("pending");
    expect(asked).toHaveLength(1);
    expect(asked[0].id).toBe(annotation.id);
    expect(store.listAnnotations("rust", "001-ownership").some((a) => a.id === annotation.id)).toBe(
      true,
    );
  });

  it("returns it from /api/state so a reload restores the card", async () => {
    const created = (await (
      await post("/api/ask", {
        classroom: "rust",
        lesson: "001-ownership",
        question: "And this?",
        selection: "one owner",
        anchor,
      })
    ).json()) as store.Annotation;

    const state = (await (await get("/api/state?classroom=rust&lesson=001-ownership")).json()) as {
      annotations: store.Annotation[];
    };
    expect(state.annotations.some((a) => a.id === created.id)).toBe(true);
  });

  it("rejects a request with no question, no anchor, or an unknown lesson", async () => {
    const base = { classroom: "rust", lesson: "001-ownership", anchor };
    expect((await post("/api/ask", { ...base, question: "  " })).status).toBe(400);
    expect((await post("/api/ask", { ...base, question: "q", anchor: {} })).status).toBe(400);
    expect((await post("/api/ask", { ...base, lesson: "../etc", question: "q" })).status).toBe(400);
    expect((await post("/api/ask", { ...base, lesson: "999-nope", question: "q" })).status).toBe(
      404,
    );
    expect(asked).toHaveLength(0);
  });

  it("deletes an annotation on request", async () => {
    const created = (await (
      await post("/api/ask", {
        classroom: "rust",
        lesson: "001-ownership",
        question: "Delete me",
        selection: "one owner",
        anchor,
      })
    ).json()) as store.Annotation;

    const res = await fetch(
      `${baseUrl}/api/annotations/${created.id}?classroom=rust&lesson=001-ownership`,
      { method: "DELETE" },
    );
    expect(await res.json()).toEqual({ removed: true });
    expect(store.findAnnotation(created.id)).toBeNull();
  });
});

describe("asking a follow-up", () => {
  const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };

  /** Ask over HTTP and answer it, so the card is ready to be followed up. */
  async function answeredCard(question = "Why only one owner?"): Promise<store.Annotation> {
    const created = (await (
      await post("/api/ask", {
        classroom: "rust",
        lesson: "001-ownership",
        question,
        selection: "one owner",
        anchor,
      })
    ).json()) as store.Annotation;
    applyAnswer(created.id, "Because aliasing.");
    return store.findAnnotation(created.id)!;
  }

  it("appends the follow-up to the card and wakes the agent with the thread", async () => {
    const card = await answeredCard();

    const res = await post(`/api/annotations/${card.id}/follow-up`, {
      classroom: "rust",
      lesson: "001-ownership",
      question: "What about borrows?",
    });

    expect(res.status).toBe(201);
    const annotation = (await res.json()) as store.Annotation;
    expect(annotation.followUps).toHaveLength(1);
    expect(annotation.followUps![0]).toMatchObject({
      question: "What about borrows?",
      status: "pending",
    });

    expect(followedUp).toHaveLength(1);
    expect(followedUp[0].annotation.id).toBe(card.id);
    expect(followedUp[0].followUp.question).toBe("What about borrows?");
  });

  it("returns the thread from /api/state so a reload restores every turn", async () => {
    const card = await answeredCard("Restored?");
    await post(`/api/annotations/${card.id}/follow-up`, { question: "And this turn?" });

    const state = (await (await get("/api/state?classroom=rust&lesson=001-ownership")).json()) as {
      annotations: store.Annotation[];
    };
    const restored = state.annotations.find((a) => a.id === card.id)!;
    expect(restored.followUps!.map((f) => f.question)).toEqual(["And this turn?"]);
  });

  it("refuses an empty follow-up, an unknown card, and a card still waiting on its first answer", async () => {
    const card = await answeredCard("Refusals");
    expect((await post(`/api/annotations/${card.id}/follow-up`, { question: "   " })).status).toBe(
      400,
    );
    expect((await post("/api/annotations/nope/follow-up", { question: "q" })).status).toBe(404);

    const pending = (await (
      await post("/api/ask", {
        classroom: "rust",
        lesson: "001-ownership",
        question: "Still spinning",
        selection: "one owner",
        anchor,
      })
    ).json()) as store.Annotation;
    expect((await post(`/api/annotations/${pending.id}/follow-up`, { question: "q" })).status).toBe(
      409,
    );

    expect(followedUp).toHaveLength(0);
  });

  it("pushes a follow-up answer to the page as the whole card", async () => {
    const card = await answeredCard("Live follow-up?");
    const annotation = (await (
      await post(`/api/annotations/${card.id}/follow-up`, { question: "And live?" })
    ).json()) as store.Annotation;
    const followUpId = annotation.followUps![0].id;

    const frames = await nextEvent(
      `${baseUrl}/api/events?classroom=rust&lesson=001-ownership`,
      () => applyAnswer(card.id, "Borrows are **temporary**."),
      (buffer) => buffer.includes("event: answer"),
    );

    const payload = JSON.parse(/data: (.*)/.exec(frames)![1]) as store.Annotation;
    expect(payload.id).toBe(card.id);
    expect(payload.answerMarkdown).toBe("Because aliasing."); // the first turn is untouched
    const answered = payload.followUps!.find((f) => f.id === followUpId)!;
    expect(answered.status).toBe("answered");
    expect(answered.answerHtml).toContain("<strong>temporary</strong>");
  });
});

describe("submitting a quiz", () => {
  it("persists the submission and asks for grading", async () => {
    const res = await post("/api/quiz/submit", {
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      quizTitle: "Check on learning",
      answers: [{ questionId: "q1", value: "a", label: "First answer", prompt: "Who owns it?" }],
    });

    expect(res.status).toBe(201);
    const submission = (await res.json()) as store.QuizSubmission;
    expect(submitted).toHaveLength(1);
    expect(store.findSubmission(submission.id)).not.toBeNull();
    expect(store.readLesson("rust", "001-ownership")!.hasUngradedSubmission).toBe(true);
  });

  it("rejects an empty submission", async () => {
    const res = await post("/api/quiz/submit", {
      classroom: "rust",
      lesson: "001-ownership",
      answers: [],
    });
    expect(res.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });
});

describe("live updates", () => {
  it("pushes an answer to the page the question came from", async () => {
    const annotation = (await (
      await post("/api/ask", {
        classroom: "rust",
        lesson: "001-ownership",
        question: "Live?",
        selection: "one owner",
        anchor: { exact: "one owner", prefix: "", suffix: "", occurrence: 0 },
      })
    ).json()) as store.Annotation;

    const frames = await nextEvent(
      `${baseUrl}/api/events?classroom=rust&lesson=001-ownership`,
      () => applyAnswer(annotation.id, "Because **aliasing**."),
      (buffer) => buffer.includes("event: answer"),
    );

    const payload = JSON.parse(/data: (.*)/.exec(frames)![1]) as store.Annotation;
    expect(payload.id).toBe(annotation.id);
    expect(payload.status).toBe("answered");
    // Markdown is rendered server-side so the browser needs no parser.
    expect(payload.answerHtml).toContain("<strong>aliasing</strong>");
  });

  it("pushes a grade to the page the quiz was submitted from", async () => {
    const submission = (await (
      await post("/api/quiz/submit", {
        classroom: "rust",
        lesson: "001-ownership",
        quizId: "check-1",
        quizTitle: "Check on learning",
        answers: [{ questionId: "q1", value: "a", prompt: "Who owns it?" }],
      })
    ).json()) as store.QuizSubmission;

    const frames = await nextEvent(
      `${baseUrl}/api/events?classroom=rust&lesson=001-ownership`,
      () =>
        applyGrade(submission, {
          score: 100,
          feedbackMarkdown: "Nailed it.",
          questions: [{ questionId: "q1", correct: true, feedback: "Right." }],
        }),
      (buffer) => buffer.includes("event: grade"),
    );

    const payload = JSON.parse(/data: (.*)/.exec(frames)![1]) as { grade: store.QuizGrade };
    expect(payload.grade.score).toBe(100);

    // The grade is on disk and is the one the classroom page reports.
    const state = store.latestQuizState("rust", "001-ownership");
    expect(state.submission!.id).toBe(submission.id);
    expect(state.grade!.score).toBe(100);
    expect(store.readLesson("rust", "001-ownership")!.latestScore).toBe(100);
  });

  it("requires a classroom and lesson to subscribe", async () => {
    expect((await get("/api/events")).status).toBe(400);
    expect((await get("/api/state")).status).toBe(400);
  });
});
