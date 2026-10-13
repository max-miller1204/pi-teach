/** Handle shell navigation, theme controls, and classroom review requests. */

import { initLinks } from "./links.mjs";
import { initTheme } from "./theme.mjs";

initTheme();
initLinks();

const reviewControl = document.querySelector("[data-cl-review]");
if (reviewControl) initReview(reviewControl);

function initReview(control) {
  const classroom = control.dataset.clReview;
  const button = control.querySelector("[data-cl-review-start]");
  const status = control.querySelector("[data-cl-review-status]");
  const link = control.querySelector("[data-cl-review-open]");
  const key = `pi-classroom-review:${classroom}`;
  let session = null;
  let action = "start";
  let busy = false;
  let openWhenReady = false;
  let timer;

  async function request(url, body) {
    const response = await fetch(
      url,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    );
    const result = await response.json();
    if (!response.ok) {
      if (typeof result.error !== "string")
        throw new Error("Review response has no error description.");
      throw new Error(result.error);
    }
    if (!Object.hasOwn(result, "review")) throw new Error("Review response has no review status.");
    return result.review;
  }
  function show(next) {
    session = next;
    link.hidden = !next || next.status !== "done" || next.resumable;
    if (!link.hidden) link.href = next.url;
    if (next?.status === "queued" || next?.status === "running") {
      openWhenReady = true;
      button.disabled = true;
      button.textContent = "Creating review…";
      status.textContent = `Your teacher is creating a review of ${next.count} due questions. You can leave this page and return.`;
      timer = setTimeout(check, 1000);
    } else if (next?.status === "failed") {
      action = "retry";
      button.disabled = false;
      button.textContent = "Retry review";
      status.textContent = next.error;
    } else if (next?.status === "done" && next.resumable) {
      action = "open";
      button.disabled = false;
      button.textContent = "Continue review";
      status.textContent = "Your review is ready.";
      if (openWhenReady) {
        openWhenReady = false;
        window.location.assign(next.url);
      }
    } else {
      action = "start";
      button.textContent = "Start review";
      button.disabled = Number(control.dataset.due) === 0;
      status.textContent = button.disabled
        ? "No questions are due for review."
        : `Review up to ${control.dataset.reviewSize} due questions with new examples.`;
    }
  }
  function failed(error) {
    clearTimeout(timer);
    action = "check";
    button.disabled = false;
    button.textContent = "Check review status";
    status.textContent = error.message;
  }
  async function check() {
    clearTimeout(timer);
    try {
      show(await request(`/api/review?classroom=${encodeURIComponent(classroom)}`));
    } catch (error) {
      failed(error);
    }
  }
  button.addEventListener("click", async () => {
    if (busy) return;
    if (action === "open") return window.location.assign(session.url);
    busy = true;
    button.disabled = true;
    try {
      if (action === "check") {
        const next = await request(`/api/review?classroom=${encodeURIComponent(classroom)}`);
        // Reuse the same browser request if its response was lost before it was saved.
        show(next);
      } else {
        let id;
        if (action === "retry") id = session.id;
        else {
          id = sessionStorage.getItem(key) || crypto.randomUUID();
          sessionStorage.setItem(key, id);
        }
        const next = await request(action === "retry" ? "/api/review/retry" : "/api/review", {
          classroom,
          id,
        });
        sessionStorage.removeItem(key);
        openWhenReady = true;
        show(next);
      }
    } catch (error) {
      failed(error);
    } finally {
      busy = false;
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    openWhenReady = false;
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) check();
  });
  check();
}
