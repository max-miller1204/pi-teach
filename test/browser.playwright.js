/** Playwright CLI function. Run with node scripts/e2e-browser.ts. */
async function browserRegression(page) {
  const control = `http://127.0.0.1:${new URL(page.url()).searchParams.get("control")}`;
  const artifacts = new URL(page.url()).searchParams.get("artifacts");
  const screenshot = async (name) => {
    if (artifacts) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
    }
  };
  const observer = await page.context().newPage();
  const errors = [];
  for (const tab of [page, observer]) tab.on("pageerror", (error) => errors.push(error.message));
  await observer.goto(page.url());
  await observer.evaluate(async () => {
    window.browserTestGrades = [];
    const source = new EventSource("/api/events?classroom=rust&lesson=001-ownership");
    source.addEventListener("grade", (event) =>
      window.browserTestGrades.push(JSON.parse(event.data).grade.feedbackMarkdown),
    );
    await new Promise((resolve) => source.addEventListener("open", resolve, { once: true }));
  });
  const form = (tab) => tab.locator('form[data-quiz-id="check-1"]');
  const grade = async (submissionId, feedback) => {
    const response = await page.request.post(control, { data: { submissionId, feedback } });
    if (!response.ok()) throw new Error(await response.text());
  };
  const answer = async (options, segment) => {
    for (const option of options) await form(page).locator(`input[value="${option}"]`).check();
    await form(page).locator(`[data-segment="${segment}"]`).click();
    for (const confidence of await form(page).locator('.cl-confidence input[value="sure"]').all())
      await confidence.check();
  };
  const submit = async () => {
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/quiz/submit") && r.request().method() === "POST",
    );
    await form(page).getByRole("button", { name: "Submit for grading", exact: true }).click();
    const result = await response;
    if (result.status() !== 201) throw new Error(await result.text());
    return await result.json();
  };
  const waitGrade = async (tab, feedback) => {
    await tab.waitForFunction(
      (text) => document.querySelector(".cl-grade-feedback")?.textContent.trim() === text,
      feedback,
    );
  };
  const selections = async (tab) =>
    await form(tab).evaluate((element) => ({
      multi: [...element.querySelectorAll('input[type="checkbox"]:checked')].map(
        (input) => input.value,
      ),
      locate: [...element.querySelectorAll('.cl-segment[aria-pressed="true"]')].map(
        (segment) => segment.dataset.segment,
      ),
      state: element.dataset.state,
      attempts: element.dataset.attempts,
    }));
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  await page.locator("section .cl-term").waitFor();
  assert(
    (await page.locator("section .cl-term").count()) === 1,
    "No usable glossary marker after the split first use",
  );
  await page.locator("section .cl-term").click();
  await page.getByRole("button", { name: "Show the definition", exact: true }).click();
  assert(
    (await page.locator("[data-cl-definition]").innerText()) === "Checks that borrows are valid.",
    "Wrong glossary definition",
  );
  await screenshot("glossary-definition");
  await page.keyboard.press("Escape");
  await screenshot("glossary-marker");

  await answer(["a", "b"], "s1");
  const first = await submit();
  await grade(first.id, "First grade");
  await waitGrade(page, "First grade");
  await waitGrade(observer, "First grade");
  await form(page).getByRole("button", { name: "Try again", exact: true }).click();

  await grade(first.id, "Revised first grade");
  await waitGrade(observer, "Revised first grade");
  let current = await selections(page);
  assert(
    current.state === "fresh" && current.multi.length === 0 && current.locate.length === 0,
    "An earlier grade replaced the retake draft",
  );

  await answer(["c"], "s3");
  const second = await submit();
  await grade(first.id, "Older grade during retake");
  await waitGrade(observer, "Older grade during retake");
  current = await selections(page);
  assert(
    current.state === "submitted" && current.multi.join() === "c" && current.locate.join() === "s3",
    "An earlier grade replaced the pending retake",
  );
  await screenshot("pending-retake");

  await grade(second.id, "Second grade");
  await waitGrade(page, "Second grade");
  await waitGrade(observer, "Second grade");
  for (const tab of [page, observer]) {
    current = await selections(tab);
    assert(
      current.multi.join() === "c" && current.locate.join() === "s3" && current.attempts === "2",
      "The second attempt retained selections from the first attempt",
    );
  }
  await grade(first.id, "Stale revision after retake");
  await observer.waitForFunction(() =>
    window.browserTestGrades.includes("Stale revision after retake"),
  );
  current = await selections(observer);
  assert(
    current.multi.join() === "c" && current.locate.join() === "s3" && current.attempts === "2",
    "A stale revision replaced the graded retake",
  );
  await screenshot("graded-retake");
  await page.reload();
  await waitGrade(page, "Second grade");
  current = await selections(page);
  assert(
    current.multi.join() === "c" && current.locate.join() === "s3",
    "Reload restored the wrong attempt",
  );
  // Delay the real HTTP response until the grade has arrived through the real SSE stream.
  await page.route("**/api/quiz/submit", async (route) => {
    const response = await route.fetch();
    await page.waitForFunction(
      () => document.querySelector('[data-quiz-id="instant"]')?.dataset.state === "graded",
    );
    await route.fulfill({ response });
  });
  const instant = page.locator('[data-quiz-id="instant"]');
  await instant.locator('input[type="text"]').fill("owner");
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/quiz/submit") && r.request().method() === "POST",
  );
  await instant.getByRole("button", { name: "Submit for grading", exact: true }).click();
  assert((await response).status() === 201, "The immediate quiz was refused");
  await (await response).finished();
  assert(
    await instant.getByRole("button", { name: "Try again", exact: true }).isVisible(),
    "The submit response replaced the grade",
  );
  await page.unroute("**/api/quiz/submit");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  await observer.close();
  return {
    passed: [
      "glossary",
      "retake draft",
      "pending retake",
      "cross-tab selections",
      "stale grade",
      "reload",
      "grade before response",
    ],
  };
}
