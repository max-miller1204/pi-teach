import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ClassroomBridge } from "../src/bridge.ts";
import { currentReview, reviewSessions, startReview, updateReview } from "../src/review-session.ts";
import { DAY_MS } from "../src/review.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { readTeacherState, saveTeacherState } from "../src/service-state.ts";
import { TeacherService } from "../src/teacher-service.ts";
import {
  makeFixture,
  reviewDocument,
  seedClassroom,
  termAnswer,
  writeGradedAttempt,
  type Fixture,
} from "./helpers.ts";

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
  seedClassroom(f);
  writeGradedAttempt({
    at: Date.now() - 2 * DAY_MS,
    answers: [termAnswer("q1", "owner")],
    correct: { q1: true },
  });
});
afterEach(async () => {
  await server.close();
  f.cleanup();
});
const reviewPlan = () => ({
  calls: [
    {
      name: "publish_review",
      arguments_json: JSON.stringify(reviewDocument(currentReview("rust")!.items)),
    },
  ],
  message: "Your review is ready.",
  learning_record: "",
  notes_markdown: "",
});
const post = (base: string, route: string, body: unknown) =>
  fetch(`${base}/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("browser review hosts", () => {
  it("rejects unknown classrooms, missing teachers, and requests with no due items", async () => {
    const teacher = new TeacherService(async () => reviewPlan());
    teacher.connect();
    teacher.attach("rust", "codex");
    const base = await server.start(0);
    expect((await post(base, "review", { classroom: "../rust", id: randomUUID() })).status).toBe(
      400,
    );
    expect((await post(base, "review", { classroom: "missing", id: randomUUID() })).status).toBe(
      404,
    );
    seedClassroom(f, { classroom: "empty" });
    expect((await post(base, "review", { classroom: "empty", id: randomUUID() })).status).toBe(409);
    teacher.attach("empty", "codex");
    const noDue = await post(base, "review", { classroom: "empty", id: randomUUID() });
    expect(noDue.status).toBe(409);
    expect(await noDue.json()).toEqual({ error: "No graded questions are due for review." });
    expect(reviewSessions("empty")).toHaveLength(0);
    await teacher.stop();
  });
  it("uses the service queue, keeps request identities, and hides private context over HTTP", async () => {
    let calls = 0;
    const teacher = new TeacherService(async (_identity, prompt) => {
      calls++;
      expect(prompt).toContain("publish_review");
      expect(prompt).toContain("Private selected items");
      return reviewPlan();
    });
    teacher.connect();
    teacher.attach("rust", "codex");
    const base = await server.start(0),
      id = randomUUID();
    expect((await post(base, "review", { classroom: "rust", id })).status).toBe(202);
    await teacher.idle();
    expect((await post(base, "review", { classroom: "rust", id: randomUUID() })).status).toBe(202);
    await teacher.idle();
    expect(calls).toBe(1);
    const s = currentReview("rust")!;
    expect(s.status).toBe("done");
    const state = readTeacherState("rust")!;
    expect(state.requests[0].plan?.calls[0].name).toBe("publish_review");
    const publicState = await (await fetch(`${base}/api/review?classroom=rust`)).text();
    expect(publicState).not.toContain("expected");
    expect(publicState).not.toContain("lastFeedback");
    for (const route of [
      `/c/rust/${s.lesson}/quiz/key.json`,
      `/c/rust/${s.lesson}/quiz/plan.json`,
      "/c/rust/.reviews.json",
    ])
      expect((await fetch(base + route)).status).toBe(404);
    expect((await fetch(`${base}/c/rust/${s.lesson}`)).status).toBe(200);
    await teacher.stop();
  });
  it("requires explicit retry after a failed service request and retains its selected items", async () => {
    let runs = 0;
    const teacher = new TeacherService(async () => {
      if (++runs === 1) throw new Error("Provider unavailable.");
      return reviewPlan();
    });
    teacher.connect();
    teacher.attach("rust", "codex");
    const base = await server.start(0),
      id = randomUUID();
    await post(base, "review", { classroom: "rust", id });
    await teacher.idle();
    expect(currentReview("rust")?.status).toBe("failed");
    expect(currentReview("rust")?.error).toContain("Provider unavailable.");
    await post(base, "review", { classroom: "rust", id: randomUUID() });
    await teacher.idle();
    expect(runs).toBe(1);
    expect((await post(base, "review/retry", { classroom: "rust", id })).status).toBe(202);
    await teacher.idle();
    expect(runs).toBe(2);
    expect(currentReview("rust")?.id).toBe(id);
    expect(currentReview("rust")?.status).toBe("done");
    await teacher.stop();
  });
  it("requests a new authoring plan on explicit retry after invalid model output", async () => {
    let runs = 0;
    const teacher = new TeacherService(async () => {
      const p = reviewPlan();
      if (++runs === 1) {
        const doc = JSON.parse(p.calls[0].arguments_json);
        doc.rubric_json = "{}";
        p.calls[0].arguments_json = JSON.stringify(doc);
      }
      return p;
    });
    teacher.attach("rust", "codex");
    const session = startReview("rust", randomUUID(), "service").session;
    teacher.review(session);
    await teacher.idle();
    expect(currentReview("rust")?.status).toBe("failed");
    expect(store.listLessons("rust")).toHaveLength(1);
    teacher.retry("rust", `review:${session.id}`);
    await teacher.idle();
    expect(runs).toBe(2);
    expect(currentReview("rust")?.status).toBe("done");
    await teacher.stop();
  });
  it("keeps an interrupted service review failed after restart until explicit retry", async () => {
    const teacher = new TeacherService(async () => reviewPlan());
    teacher.attach("rust", "codex");
    const session = startReview("rust", randomUUID(), "service").session;
    updateReview(session, "running");
    const state = readTeacherState("rust")!;
    state.requests.push({
      id: `review:${session.id}`,
      classroom: "rust",
      lesson: session.lesson,
      kind: "review",
      target: session.id,
      prompt: "saved request",
      at: session.at,
      status: "running",
    });
    saveTeacherState("rust", state);
    let runs = 0;
    const restored = new TeacherService(async () => {
      runs++;
      return reviewPlan();
    });
    restored.restore();
    await restored.idle();
    expect(runs).toBe(0);
    expect(currentReview("rust")?.status).toBe("failed");
    restored.retry("rust", `review:${session.id}`);
    await restored.idle();
    expect(runs).toBe(1);
    expect(currentReview("rust")?.status).toBe("done");
    await teacher.stop();
    await restored.stop();
  });
  it("keeps review authoring sequential with learner replies in the same classroom", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const teacher = new TeacherService(async (_id, prompt) => {
      if (prompt.includes("publish_review")) {
        order.push("review start");
        await gate;
        order.push("review end");
        return reviewPlan();
      }
      order.push("chat");
      return { calls: [], message: "Keep practising.", learning_record: "", notes_markdown: "" };
    });
    teacher.attach("rust", "codex");
    teacher.review(startReview("rust", randomUUID(), "service").session);
    teacher.chat("rust", "001-ownership", "Explain the previous feedback.", randomUUID());
    await Promise.resolve();
    expect(order).toEqual(["review start"]);
    release();
    await teacher.idle();
    expect(order).toEqual(["review start", "review end", "chat"]);
    await teacher.stop();
  });
  it("recovers a saved service plan without another model turn", async () => {
    const teacher = new TeacherService(async () => reviewPlan());
    teacher.attach("rust", "codex");
    const s = startReview("rust", randomUUID(), "service").session;
    const state = readTeacherState("rust")!;
    state.requests.push({
      id: `review:${s.id}`,
      classroom: "rust",
      lesson: s.lesson,
      kind: "review",
      target: s.id,
      prompt: "saved review",
      at: s.at,
      status: "planned",
      plan: reviewPlan(),
    });
    saveTeacherState("rust", state);
    let runs = 0;
    const restored = new TeacherService(async () => {
      runs++;
      return reviewPlan();
    });
    restored.restore();
    await restored.idle();
    expect(runs).toBe(0);
    expect(currentReview("rust")?.status).toBe("done");
    await teacher.stop();
    await restored.stop();
  });
  it("recovers a queued request saved before its service enqueue", async () => {
    const teacher = new TeacherService(async () => reviewPlan());
    teacher.attach("rust", "codex");
    startReview("rust", randomUUID(), "service");
    await teacher.stop();
    const restored = new TeacherService(async () => reviewPlan());
    restored.restore();
    await restored.idle();
    expect(currentReview("rust")?.status).toBe("done");
    await restored.stop();
  });
  it("rejects review publication from an ordinary learner reply", async () => {
    const teacher = new TeacherService(async () => reviewPlan());
    teacher.attach("rust", "codex");
    startReview("rust", randomUUID(), "service");
    teacher.chat("rust", "001-ownership", "Start new authoring", randomUUID());
    await teacher.idle();
    expect(readTeacherState("rust")!.requests[0].error).toContain("not allowed: publish_review");
    expect(store.listLessons("rust")).toHaveLength(1);
    await teacher.stop();
  });
  it("Pi keeps foreign turns separate and fails a prose-only review until an explicit retry", async () => {
    const sent: string[] = [],
      bridge = new ClassroomBridge({ sendUserMessage: (text) => sent.push(text) });
    const s = startReview("rust", randomUUID(), "pi").session;
    bridge.noteForeignTurn();
    bridge.review(s);
    bridge.onAgentEnd([]);
    expect(currentReview("rust")?.status).toBe("running");
    bridge.onAgentEnd([
      { role: "assistant", content: [{ type: "text", text: "Review is ready." }] },
    ]);
    expect(currentReview("rust")?.status).toBe("failed");
    expect(sent).toHaveLength(1);
    bridge.retryReview(currentReview("rust")!);
    const document = reviewDocument(s.items);
    f.write(`rust/${s.lesson}/lesson.html`, document.lesson_html);
    f.write(`rust/${s.lesson}/quiz/key.json`, document.rubric_json);
    f.write(`rust/${s.lesson}/quiz/plan.json`, document.teaching_plan_json);
    bridge.onAgentEnd([]);
    expect(currentReview("rust")?.status).toBe("done");
    expect(sent).toHaveLength(2);
  });
  it("does not let Pi startup fail a running service review", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const teacher = new TeacherService(async () => {
      await gate;
      return reviewPlan();
    });
    teacher.connect();
    teacher.attach("rust", "codex");
    const base = await server.start(0);
    await post(base, "review", { classroom: "rust", id: randomUUID() });
    const bridge = new ClassroomBridge({
      sendUserMessage: () => {
        throw new Error("Do not run service work in Pi.");
      },
    });
    try {
      expect(currentReview("rust")?.status).toBe("running");
      bridge.restoreReviews();
      expect(currentReview("rust")?.status).toBe("running");
    } finally {
      release();
      await teacher.stop();
    }
  });
  it("does not let a second Pi session fail work owned by a live Pi process", () => {
    const bridge = new ClassroomBridge({ sendUserMessage: () => {} });
    bridge.review(startReview("rust", randomUUID(), "pi").session);
    const another = new ClassroomBridge({ sendUserMessage: () => {} });
    another.restoreReviews();
    expect(currentReview("rust")?.status).toBe("running");
    bridge.reset();
  });
  it("does not let the service recover or retry Pi-owned review work", async () => {
    let runs = 0;
    const teacher = new TeacherService(async () => {
      runs++;
      return reviewPlan();
    });
    teacher.attach("rust", "codex");
    const session = startReview("rust", randomUUID(), "pi").session;
    updateReview(session, "failed", "Pi was stopped.");
    await teacher.stop();
    const restored = new TeacherService(async () => {
      runs++;
      return reviewPlan();
    });
    restored.restore();
    restored.connect();
    await restored.idle();
    expect(runs).toBe(0);
    const base = await server.start(0);
    const response = await post(base, "review/retry", { classroom: "rust", id: session.id });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("belongs to pi");
    expect(currentReview("rust")?.status).toBe("failed");
    expect(currentReview("rust")?.error).toBe("Pi was stopped.");
    await restored.stop();
  });
  it("Pi restores interrupted creation as a visible failure", () => {
    const s = startReview("rust", randomUUID(), "pi").session;
    updateReview(s, "running");
    const saved = reviewSessions("rust");
    saved[0].ownerPid = 999999999;
    f.write("rust/.reviews.json", JSON.stringify({ version: 1, requests: saved }));
    const bridge = new ClassroomBridge({
      sendUserMessage: () => {
        throw new Error("Do not retry automatically.");
      },
    });
    bridge.restoreReviews();
    expect(currentReview("rust")?.status).toBe("failed");
  });
});
