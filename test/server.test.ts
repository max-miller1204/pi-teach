/**
 * Integration coverage: boot the real server against a temp classrooms root and
 * drive it over HTTP, the way a browser does.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { applyAnswer, applyGrade } from "../src/bridge.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { DAY_MS } from "../src/review.ts";
import {
  lessonHtml,
  makeFixture,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";

let fixture: Fixture;
let baseUrl: string;
const asked: store.Annotation[] = [];
const followedUp: Array<{ annotation: store.Annotation; followUp: store.FollowUp }> = [];
const submitted: store.QuizSubmission[] = [];
const reflected: store.Reflection[] = [];

beforeAll(async () => {
  fixture = makeFixture();
  seedClassroom(fixture);
  server.setHooks({
    onAsk: (annotation) => asked.push(annotation),
    onFollowUp: (annotation, followUp) => followedUp.push({ annotation, followUp }),
    onQuizSubmit: (submission) => submitted.push(submission),
    onReflect: (reflection) => reflected.push(reflection),
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
  reflected.length = 0;
});

const get = (path: string) => fetch(`${baseUrl}${path}`);

it("rejects public file and directory symlinks to private quiz files", async () => {
  fixture.write("rust/001-ownership/quiz/private-key.json", '{"secret":"answer"}');
  fixture.write("rust/001-ownership/media/plain.txt", "Public media");
  fixture.write("rust/assets/plain.txt", "Public asset");
  fixture.write("rust/reference/plain.html", "Public reference");
  const privatePath = path.join(fixture.root, "rust/001-ownership/quiz/private-key.json");
  for (const [dir, route] of [
    ["rust/001-ownership/media", "/c/rust/001-ownership/media"],
    ["rust/assets", "/c/rust/assets"],
    ["rust/reference", "/r/rust"],
  ]) {
    fs.symlinkSync(privatePath, path.join(fixture.root, dir, "leaked.html"));
    fs.symlinkSync(path.dirname(privatePath), path.join(fixture.root, dir, "linked-dir"));
    expect((await get(`${route}/leaked.html`)).status).toBe(404);
    expect((await get(`${route}/linked-dir/private-key.json`)).status).toBe(404);
  }
  expect((await get("/c/rust/001-ownership/media/plain.txt")).status).toBe(200);
});

it("rejects a private answer key linked from the learning records index", async () => {
  const sentinel = "PRIVATE RECORD ANSWER SENTINEL";
  fixture.write("rust/001-ownership/quiz/key.json", `# Private key\n\n${sentinel}`);
  fixture.write("rust/learning-records/0001-public.md", "# Public record\n\nPublic evidence.");
  fs.symlinkSync(
    path.join(fixture.root, "rust/001-ownership/quiz/key.json"),
    path.join(fixture.root, "rust/learning-records/0002-secret.md"),
  );
  const index = await get("/doc/rust/learning-records");
  expect(index.status).toBe(500);
  expect(await index.text()).not.toContain(sentinel);
  expect((await get("/doc/rust/learning-records/0002-secret.md")).status).toBe(404);
  fs.unlinkSync(path.join(fixture.root, "rust/learning-records/0002-secret.md"));
});

it("withholds lesson content until its pretest is graded, including from page source", async () => {
  const lesson = "099-staged";
  fixture.write(
    `rust/${lesson}/lesson.html`,
    '<html><head></head><body><main data-cl-content><form class="cl-quiz" data-kind="pretest" data-quiz-id="before"></form><template data-cl-after-pretest="before"><p>PRIVATE TEACHING EXAMPLE</p><form class="cl-quiz" data-quiz-id="check"></form></template></main></body></html>',
  );
  const url = `/c/rust/${lesson}`;
  expect(await (await get(url)).text()).not.toContain("PRIVATE TEACHING EXAMPLE");
  const blocked = await post("/api/quiz/submit", {
    classroom: "rust",
    lesson,
    quizId: "check",
    kind: "check",
    answers: [termAnswer("q1", "answer")],
  });
  expect(blocked.status).toBe(409);
  expect(store.listSubmissions("rust", lesson)).toHaveLength(0);
  const s = store.createSubmission({
    classroom: "rust",
    lesson,
    quizId: "before",
    quizTitle: "Before",
    kind: "pretest",
    answers: [termAnswer("q1", "wrong")],
  });
  expect(await (await get(url)).text()).not.toContain("PRIVATE TEACHING EXAMPLE");
  applyGrade(s, {
    score: 0,
    feedbackMarkdown: "Diagnostic only.",
    questions: [{ questionId: "q1", correct: false, feedback: "Not known yet." }],
  });
  const released = await (await get(url)).text();
  expect(released).toContain("PRIVATE TEACHING EXAMPLE");
  expect(released).toContain('data-quiz-id="check"');
  expect(released).not.toContain("<template");
  expect(store.readLesson("rust", lesson)?.latestScore).toBeNull();
  expect(store.reviewItems("rust").some((item) => item.lesson === lesson)).toBe(false);
});
const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

it("binds a new review answer to its authored original item", async () => {
  const classroom = "review-contract";
  fixture.write(`${classroom}/classroom.json`, JSON.stringify({ title: "Review", createdAt: 1 }));
  fixture.write(`${classroom}/001-original/lesson.html`, lessonHtml("Original", "Original items."));
  writeGradedAttempt({
    classroom,
    lesson: "001-original",
    quizId: "check",
    at: 1,
    answers: [termAnswer("a", "wrong"), termAnswer("b", "wrong")],
    correct: { a: false, b: false },
  });
  const lesson = "002-review";
  fixture.write(
    `${classroom}/${lesson}/lesson.json`,
    JSON.stringify({ title: "Review", assessmentContract: 1 }),
  );
  fixture.write(
    `${classroom}/${lesson}/lesson.html`,
    '<form class="cl-quiz" data-quiz-id="review" data-kind="review"><li class="cl-q" data-question-id="r1" data-type="term" data-review-of="001-original/check/a"></li></form>',
  );
  fixture.write(
    `${classroom}/${lesson}/quiz/key.json`,
    JSON.stringify({
      review: {
        r1: {
          expected: "owner",
          points: 1,
          full: "Names the owner.",
          partial: "No partial credit.",
        },
      },
    }),
  );
  const body = {
    classroom,
    lesson,
    quizId: "review",
    kind: "review",
    answers: [termAnswer("r1", "owner", { reviewOf: "001-original/check/b" })],
  };
  expect((await post("/api/quiz/submit", body)).status).toBe(400);
  expect(store.listSubmissions(classroom, lesson)).toHaveLength(0);
  body.answers[0].reviewOf = "001-original/check/a";
  expect((await post("/api/quiz/submit", body)).status).toBe(201);
  expect(store.listSubmissions(classroom, lesson)[0].answers[0].reviewOf).toBe(
    "001-original/check/a",
  );
});

it("validates newly authored assessment identities, kinds, types, and rubric coverage", async () => {
  const lesson = "097-contract";
  fixture.write(
    `rust/${lesson}/lesson.json`,
    JSON.stringify({ title: "Contract", summary: "", createdAt: 1, assessmentContract: 1 }),
  );
  fixture.write(
    `rust/${lesson}/lesson.html`,
    '<form class="cl-quiz" data-quiz-id="quiz" data-kind="check"><li class="cl-q" data-question-id="q1" data-type="term"></li></form>',
  );
  const key = JSON.stringify({
    quiz: {
      q1: { expected: "owner", points: 2, full: "Names the owner.", partial: "No partial credit." },
    },
  });
  fixture.write(`rust/${lesson}/quiz/key.json`, key);
  const body = {
    classroom: "rust",
    lesson,
    quizId: "quiz",
    kind: "check",
    answers: [termAnswer("q1", "owner")],
  };
  for (const invalid of [
    { ...body, quizId: "unknown" },
    { ...body, kind: "pretest" },
    { ...body, answers: [] },
    { ...body, answers: [{ ...termAnswer("q1", "owner"), type: "short" }] },
  ])
    expect((await post("/api/quiz/submit", invalid)).status).toBe(400);
  fixture.write(`rust/${lesson}/quiz/key.json`, "{}");
  expect((await post("/api/quiz/submit", body)).status).toBe(400);
  expect(store.listSubmissions("rust", lesson)).toHaveLength(0);
  fixture.write(`rust/${lesson}/quiz/key.json`, key);
  const accepted = await post("/api/quiz/submit", body);
  expect(accepted.status).toBe(201);
  const s = await accepted.json();
  expect(s.assessmentContract).toBe(1);
  expect(s.rubricDigest).toMatch(/^[a-f0-9]{64}$/);
});

it("binds private objective evidence to an attempt and excludes it from learner responses", async () => {
  const lesson = "095-evidence";
  fixture.write(
    `rust/${lesson}/lesson.json`,
    JSON.stringify({ title: "Evidence", assessmentContract: 1, instructionalContract: 1 }),
  );
  fixture.write(
    `rust/${lesson}/lesson.html`,
    '<form class="cl-quiz" data-quiz-id="check"><li class="cl-q" data-question-id="q1" data-type="term"></li></form>',
  );
  fixture.write(
    `rust/${lesson}/quiz/key.json`,
    JSON.stringify({
      check: {
        q1: { expected: "owner", points: 1, full: "Names owner", partial: "No partial credit" },
      },
    }),
  );
  const plan = {
    version: 1,
    objectives: {
      o: {
        statement: "Apply ownership",
        application: true,
        interleaveGroup: "PRIVATE GROUP",
        strategy: "PRIVATE STRATEGY",
      },
    },
    quizzes: {
      check: {
        purpose: "assessment",
        questions: { q1: { objective: "o", task: "transfer", support: "assisted" } },
      },
    },
  };
  const body = {
    classroom: "rust",
    lesson,
    quizId: "check",
    kind: "check",
    answers: [
      {
        ...termAnswer("q1", "owner"),
        confidence: "unsure",
        assistance: "none",
        learning: { support: "independent" },
      },
    ],
  };
  expect((await post("/api/quiz/submit", body)).status).toBe(400);
  fixture.write(`rust/${lesson}/quiz/plan.json`, JSON.stringify(plan));
  const response = await post("/api/quiz/submit", body);
  expect(response.status).toBe(201);
  const publicAttempt = await response.json();
  expect(publicAttempt.teachingPlan).toBeUndefined();
  expect(publicAttempt.answers[0].learning).toBeUndefined();
  expect(publicAttempt.answers[0]).toMatchObject({ confidence: "unsure", assistance: "none" });
  const saved = store.findSubmission(publicAttempt.id)!;
  expect(saved.answers[0].learning).toMatchObject({
    support: "assisted",
    assistance: "none",
    task: "transfer",
  });
  expect(saved.teachingPlan).toEqual(plan);
  plan.objectives.o.application = false;
  plan.quizzes.check.questions.q1.support = "independent";
  fixture.write(`rust/${lesson}/quiz/plan.json`, JSON.stringify(plan));
  applyGrade(saved, {
    score: 100,
    feedbackMarkdown: "Correct. This was supported work.",
    questions: [
      { questionId: "q1", correct: true, pointsEarned: 1, pointsPossible: 1, feedback: "Correct" },
    ],
  });
  expect(store.reviewItems("rust").find((i) => i.key === `${lesson}/check/q1`)).toMatchObject({
    context: "assisted",
    objective: { application: true },
    delayedSuccesses: 0,
  });
  const state = await (await get(`/api/state?classroom=rust&lesson=${lesson}`)).text();
  expect(state).not.toContain("PRIVATE STRATEGY");
  expect(state).not.toContain("PRIVATE GROUP");
  expect((await get(`/c/rust/${lesson}/quiz/plan.json`)).status).toBe(404);
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

  it("renders MISSION.md as HTML", async () => {
    const html = await (await get("/doc/rust/MISSION.md")).text();
    expect(html).toContain("Ship a CLI to my team by October.");
    expect(html).toContain("<h1");
  });

  it("serves the learning records index, and records under it", async () => {
    fixture.write("rust/learning-records/0001-owns.md", "# One owner\n\nThey can say why.");
    const index = await (await get("/doc/rust/learning-records")).text();
    expect(index).toContain("One owner");
    expect(index).toContain("They can say why.");

    const record = await (await get("/doc/rust/learning-records/0001-owns.md")).text();
    expect(record).toContain('href="/doc/rust/learning-records"');
  });

  it("serves the topic files NOTES.md indexes", async () => {
    fixture.write("rust/notes/debugging.md", "# Debugging\n\nReaches for println first.");
    const res = await get("/doc/rust/notes/debugging.md");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Reaches for println first.");
    expect(html).toContain('href="/doc/rust/NOTES.md"');
  });

  it("gives reference documents the link behaviour and the diagrams", async () => {
    fixture.write("rust/reference/syntax.html", "<html><head></head><body>Ref</body></html>");
    const html = await (await get("/r/rust/syntax.html")).text();
    expect(html).toContain("/static/links.mjs");
    expect(html).toContain("/static/diagrams.mjs");
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
    expect((await get("/static/links.mjs")).status).toBe(200);
    expect((await get("/static/draft.mjs")).status).toBe(200);
    expect((await get("/static/diagrams.mjs")).status).toBe(200);
  });

  it("serves the vendored Mermaid build that diagrams.mjs loads", async () => {
    const res = await get("/static/vendor/mermaid/mermaid.min.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toContain('globalThis["mermaid"]');
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
      "/doc/rust/notes/../../../package.json",
      "/doc/rust/notes/%2e%2e%2fMISSION.md",
      "/doc/rust/learning-records/%2e%2e%2fMISSION.md",
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

  it("never serves drafts as files", async () => {
    fixture.write("rust/001-ownership/drafts.json", JSON.stringify({ teacher: "secret" }));
    expect((await get("/c/rust/001-ownership/drafts.json")).status).toBe(404);
    expect((await get("/c/rust/001-ownership/media/../drafts.json")).status).toBe(404);
  });

  it("only serves the classroom's own markdown documents", async () => {
    fixture.write("rust/SECRETS.md", "# nope");
    expect((await get("/doc/rust/SECRETS.md")).status).toBe(404);
    expect((await get("/doc/rust/NOTES.md")).status).toBe(404); // not present on disk
    fixture.write("rust/notes/raw.txt", "nope");
    expect((await get("/doc/rust/notes/raw.txt")).status).toBe(404);
    fixture.write("rust/elsewhere/x.md", "# nope");
    expect((await get("/doc/rust/elsewhere/x.md")).status).toBe(404);
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
      kind: "check",
      answers: [
        {
          questionId: "q1",
          type: "choice",
          value: "a",
          label: "First answer",
          prompt: "Who owns it?",
        },
      ],
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
        quizId: "live-1",
        quizTitle: "Check on learning",
        kind: "check",
        answers: [{ questionId: "q1", type: "term", value: "a", prompt: "Who owns it?" }],
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
    const state = store
      .latestQuizStates("rust", "001-ownership")
      .find((quiz) => quiz.quizId === "live-1")!;
    expect(state.submission.id).toBe(submission.id);
    expect(state.grade!.score).toBe(100);
    expect(store.readLesson("rust", "001-ownership")!.latestScore).toBe(100);
  });

  it("requires a classroom and lesson to subscribe", async () => {
    expect((await get("/api/events")).status).toBe(400);
    expect((await get("/api/state")).status).toBe(400);
  });
});

describe("the quiz contract on the server", () => {
  const typed = (quizId: string, answers: unknown[], kind = "check") =>
    post("/api/quiz/submit", {
      classroom: "rust",
      lesson: "002-typed",
      quizId,
      quizTitle: "Typed",
      kind,
      answers,
    });

  beforeAll(() => {
    fixture.write("rust/002-typed/lesson.html", lessonHtml("Typed"));
  });

  it("refuses a missing kind, an unknown type, and an answer with no type", async () => {
    const missingKind = await post("/api/quiz/submit", {
      classroom: "rust",
      lesson: "002-typed",
      quizId: "check-1",
      answers: [{ questionId: "q1", type: "term", value: "x" }],
    });
    expect(missingKind.status).toBe(400);
    expect(((await missingKind.json()) as { error: string }).error).toContain("quiz kind");

    const unknownType = await typed("check-1", [{ questionId: "q1", type: "essay", value: "x" }]);
    expect(unknownType.status).toBe(400);
    const untyped = await typed("check-1", [{ questionId: "q1", value: "x" }]);
    expect(((await untyped.json()) as { error: string }).error).toContain("unknown type");
    expect(submitted).toHaveLength(0);
  });

  it("accepts a retake only after the last attempt is graded, and numbers it", async () => {
    const first = (await (
      await typed("retake", [termAnswer("q1", "owner")])
    ).json()) as store.QuizSubmission;
    expect(first.attempt).toBe(1);

    const early = await typed("retake", [termAnswer("q1", "again")]);
    expect(early.status).toBe(409);

    applyGrade(first, {
      score: 0,
      feedbackMarkdown: "No.",
      questions: [{ questionId: "q1", correct: false, feedback: "No." }],
    });
    const second = await typed("retake", [termAnswer("q1", "again")]);
    expect(second.status).toBe(201);
    expect(((await second.json()) as store.QuizSubmission).attempt).toBe(2);
  });

  it("accepts a review question only for an item that was graded before", async () => {
    const unknown = await typed(
      "review",
      [termAnswer("r1", "x", { reviewOf: "002-typed/nope/q9" })],
      "review",
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("002-typed/nope/q9");

    const known = await typed(
      "review",
      [termAnswer("r1", "x", { reviewOf: "002-typed/retake/q1" })],
      "review",
    );
    expect(known.status).toBe(201);
  });

  it("returns the latest attempt at each quiz from /api/state", async () => {
    const state = (await (await get("/api/state?classroom=rust&lesson=002-typed")).json()) as {
      quizzes: store.QuizState[];
      reflections: store.Reflection[];
    };
    expect(state.quizzes.map((q) => [q.quizId, q.attempts])).toEqual([
      ["retake", 2],
      ["review", 1],
    ]);
    expect(state.reflections).toEqual([]);
  });
});

describe("self-explanations", () => {
  it("saves a reflection, tells the teacher, and returns it from /api/state", async () => {
    const res = await post("/api/reflect", {
      classroom: "rust",
      lesson: "001-ownership",
      reflectId: "explain-1",
      prompt: "Explain ownership.",
      text: "  Each value has one owner.  ",
    });
    expect(res.status).toBe(201);
    expect(reflected).toHaveLength(1);
    expect(reflected[0].text).toBe("Each value has one owner.");

    const state = (await (await get("/api/state?classroom=rust&lesson=001-ownership")).json()) as {
      reflections: store.Reflection[];
    };
    expect(state.reflections.map((r) => r.reflectId)).toEqual(["explain-1"]);
  });

  it("refuses a reflection with no id or no text", async () => {
    const base = { classroom: "rust", lesson: "001-ownership", prompt: "Explain." };
    expect((await post("/api/reflect", { ...base, text: "x" })).status).toBe(400);
    expect((await post("/api/reflect", { ...base, reflectId: "a", text: " " })).status).toBe(400);
    expect(reflected).toHaveLength(0);
  });
});

describe("glossary and progress", () => {
  it("serves the parsed glossary, errors included", async () => {
    fixture.write(
      "rust/GLOSSARY.md",
      "**Owner**:\nThe variable a value belongs to.\n_Avoid_: holder\n\n**Empty**:\n",
    );
    const glossary = (await (await get("/api/glossary?classroom=rust")).json()) as {
      terms: Array<{ term: string; avoid: string[] }>;
      errors: string[];
    };
    expect(glossary.terms).toMatchObject([{ term: "Owner", avoid: ["holder"] }]);
    expect(glossary.errors).toHaveLength(1);
    expect((await get("/api/glossary?classroom=nope")).status).toBe(404);
  });

  it("shows what is due on the classroom and landing pages", async () => {
    writeGradedAttempt({
      lesson: "001-ownership",
      quizId: "old",
      at: Date.now() - 10 * DAY_MS,
      answers: [termAnswer("q1", "x")],
      correct: { q1: true },
    });
    const page = await (await get("/c/rust")).text();
    expect(page).toContain("Progress");
    expect(page).toContain("cl-badge-due");
    expect(page).toContain(
      '<span class="cl-stat-value">1</span><span class="cl-stat-label">glossary term</span>',
    );
    expect(await (await get("/")).text()).toContain("due for review");
  });
});

describe("drafts", () => {
  const lesson = "003-drafts";
  const anchor = { exact: "one owner", prefix: "has ", suffix: ".", occurrence: 0 };
  const put = (body: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classroom: "rust", lesson, ...body }),
    });
  const drafts = async () =>
    (
      (await (await get(`/api/state?classroom=rust&lesson=${lesson}`)).json()) as {
        drafts: Record<string, unknown>;
      }
    ).drafts;

  beforeAll(() => {
    fixture.write(`rust/${lesson}/lesson.html`, lessonHtml("Drafts"));
  });

  it("saves each draft under its key and returns them from /api/state", async () => {
    const quiz = { q1: { checked: ["a"] }, q2: { text: "half an ans" }, q3: { order: ["b", "a"] } };
    expect((await put({ key: "quiz:check-1", value: quiz })).status).toBe(200);
    expect((await put({ key: "reflect:explain-1", value: "I think" })).status).toBe(200);
    expect((await put({ key: "ask", value: { anchor, text: "Why" } })).status).toBe(200);
    expect(await drafts()).toEqual({
      "quiz:check-1": quiz,
      "reflect:explain-1": "I think",
      ask: { anchor, text: "Why" },
    });

    expect((await put({ key: "reflect:explain-1", value: null })).status).toBe(200);
    expect(Object.keys(await drafts())).toEqual(["quiz:check-1", "ask"]);
  });

  it("refuses an unknown key, a bad value, and an unknown lesson", async () => {
    const refused = async (body: Record<string, unknown>) => {
      const res = await put(body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      return ((await res.json()) as { error: string }).error;
    };
    expect(await refused({ key: "notes", value: "x" })).toContain("Unknown draft key");
    expect(await refused({ key: "followup:not-a-uuid", value: "x" })).toContain(
      "Unknown draft key",
    );
    expect(await refused({ key: "teacher", value: 3 })).toContain("must be text");
    expect(await refused({ key: "quiz:check-1", value: { q1: { guess: "a" } } })).toContain(
      "unknown field guess",
    );
    expect(await refused({ key: "ask", value: { text: "Why" } })).toContain("needs an anchor");
    expect(await refused({ lesson: "nope", key: "teacher", value: "x" })).toBe("Unknown lesson");
    expect(Object.keys(await drafts())).not.toContain("teacher");
  });

  it("removes a draft when the server accepts the text it held", async () => {
    const card = (await (
      await post("/api/ask", { classroom: "rust", lesson, question: "Why?", anchor })
    ).json()) as store.Annotation;
    applyAnswer(card.id, "Because.");
    await put({ key: `followup:${card.id}`, value: "And then?" });
    await put({ key: "reflect:explain-1", value: "Each value" });
    await put({ key: "quiz:check-1", value: { q1: { text: "own" } } });
    expect(Object.keys(await drafts()).sort()).toEqual([
      `followup:${card.id}`,
      "quiz:check-1",
      "reflect:explain-1",
    ]);

    await post(`/api/annotations/${card.id}/follow-up`, {
      classroom: "rust",
      lesson,
      question: "And then?",
    });
    await post("/api/reflect", {
      classroom: "rust",
      lesson,
      reflectId: "explain-1",
      prompt: "Explain.",
      text: "Each value has one owner.",
    });
    await post("/api/quiz/submit", {
      classroom: "rust",
      lesson,
      quizId: "check-1",
      kind: "check",
      answers: [termAnswer("q1", "owner")],
    });
    expect(await drafts()).toEqual({});
  });

  it("saves nothing when the draft file cannot be read", async () => {
    fixture.write(`rust/${lesson}/drafts.json`, "{");
    const before = store.listReflections("rust", lesson).length;
    const res = await post("/api/reflect", {
      classroom: "rust",
      lesson,
      reflectId: "explain-2",
      prompt: "Explain.",
      text: "Each value has one owner.",
    });
    expect(res.status).toBe(500);
    expect(store.listReflections("rust", lesson)).toHaveLength(before);
    expect(reflected).toHaveLength(0);
    fixture.write(`rust/${lesson}/drafts.json`, "{}");
  });

  it("removes a card's follow-up draft with the card", async () => {
    const card = (await (
      await post("/api/ask", { classroom: "rust", lesson, question: "Why?", anchor })
    ).json()) as store.Annotation;
    await put({ key: `followup:${card.id}`, value: "And then?" });
    await fetch(`${baseUrl}/api/annotations/${card.id}?classroom=rust&lesson=${lesson}`, {
      method: "DELETE",
    });
    expect(await drafts()).toEqual({});
  });
});
