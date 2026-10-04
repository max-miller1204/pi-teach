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
  const grade = async (submissionId, feedback, correct) => {
    const response = await page.request.post(control, {
      data: { submissionId, feedback, correct },
    });
    if (!response.ok()) throw new Error(await response.text());
  };
  const answer = async (options, segment) => {
    for (const option of options) await form(page).locator(`input[value="${option}"]`).check();
    await form(page).locator(`[data-segment="${segment}"]`).click();
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

  assert((await page.locator(".cl-confidence").count()) === 0, "The page has confidence controls");
  assert(
    !(await page.locator("body").innerText()).includes("How sure are you?"),
    "The page asks for confidence",
  );
  await screenshot("fresh-quizzes");
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
  assert(
    first.answers.every((answer) => !Object.hasOwn(answer, "confidence")),
    "The browser sent confidence metadata",
  );
  await screenshot("submitted-quiz");
  await grade(first.id, "First grade", false);
  await waitGrade(page, "First grade");
  await waitGrade(observer, "First grade");
  const assertLocked = async (tab) => {
    assert(
      (await tab.getByRole("button", { name: "Try again", exact: true }).count()) === 0,
      "The page has a retry button",
    );
    assert(
      await form(tab).getByRole("button", { name: "Graded", exact: true }).isDisabled(),
      "The graded quiz is unlocked",
    );
  };
  await assertLocked(page);
  await screenshot("graded-wrong-answer");
  await page.reload();
  await waitGrade(page, "First grade");
  await assertLocked(page);
  await grade(first.id, "Revised first grade", false);
  await waitGrade(page, "Revised first grade");
  await waitGrade(observer, "Revised first grade");
  let current = await selections(page);
  assert(
    current.multi.join() === "a,b" && current.locate.join() === "s1",
    "A grade revision changed saved selections",
  );

  // The API still accepts additional attempts from older clients. Test their history.
  const response2 = await page.request.post(new URL("/api/quiz/submit", page.url()).href, {
    data: {
      classroom: "rust",
      lesson: "001-ownership",
      quizId: "check-1",
      kind: "check",
      answers: [
        {
          questionId: "q1",
          type: "multi",
          parts: [{ id: "c", value: "Third statement" }],
          confidence: "guess",
        },
        {
          questionId: "q2",
          type: "locate",
          parts: [{ id: "s3", value: "Third line" }],
          confidence: "sure",
        },
      ],
    },
  });
  assert(response2.status() === 201, await response2.text());
  const second = await response2.json();
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('[data-quiz-id="check-1"]').dataset.state === "submitted",
  );
  await grade(first.id, "Older grade during saved attempt", false);
  await observer.waitForFunction(() =>
    window.browserTestGrades.includes("Older grade during saved attempt"),
  );
  current = await selections(page);
  assert(
    current.state === "submitted" && current.multi.join() === "c" && current.locate.join() === "s3",
    "An earlier grade replaced the pending saved attempt",
  );
  await grade(second.id, "Second grade", true);
  await waitGrade(page, "Second grade");
  await waitGrade(observer, "Second grade");
  for (const tab of [page, observer]) {
    current = await selections(tab);
    assert(
      current.multi.join() === "c" && current.locate.join() === "s3" && current.attempts === "2",
      "The second attempt retained selections from the first attempt",
    );
  }
  await grade(first.id, "Stale revision after saved attempt", false);
  await observer.waitForFunction(() =>
    window.browserTestGrades.includes("Stale revision after saved attempt"),
  );
  current = await selections(observer);
  assert(
    current.multi.join() === "c" && current.locate.join() === "s3" && current.attempts === "2",
    "A stale revision replaced the graded saved attempt",
  );
  await assertLocked(page);
  await assertLocked(observer);
  await screenshot("saved-attempt-history");
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
    await instant.getByRole("button", { name: "Graded", exact: true }).isDisabled(),
    "The submit response replaced the grade",
  );
  assert(
    (await instant.getByRole("button", { name: "Try again", exact: true }).count()) === 0,
    "The immediate grade has a retry button",
  );
  await screenshot("all-graded-quizzes");
  await page.unroute("**/api/quiz/submit");
  const allTypes = page.locator('[data-quiz-id="all-types"]');
  await allTypes.locator('[data-type="choice"] input[value="a"]').check();
  await allTypes.locator('[data-type="multi"] input[value="b"]').check();
  await allTypes.locator('[data-type="term"] input').fill("lifetime");
  for (const field of await allTypes.locator('[data-type="short"] textarea').all())
    await field.fill("An explanation.");
  await allTypes.locator(".cl-number").fill("4");
  await allTypes.locator(".cl-unit").fill("bytes");
  await allTypes.locator('[data-blank="b1"]').fill("owner");
  await allTypes.locator('[data-blank="b2"]').fill("scope");
  await allTypes.locator('[data-item="bind"] button[data-cl-move="-1"]').click();
  for (const select of await allTypes.locator('[data-type="match"] select').all())
    await select.selectOption("r2");
  await allTypes.locator('[data-segment="s3"]').click();
  const typesResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/quiz/submit") && r.request().method() === "POST",
  );
  await allTypes.getByRole("button", { name: "Submit for grading", exact: true }).click();
  const typesResult = await typesResponse;
  assert(typesResult.status() === 201, await typesResult.text());
  const typedSubmission = await typesResult.json();
  assert(
    new Set(typedSubmission.answers.map((a) => a.type)).size === 9,
    "The runtime lost a supported response type",
  );
  const saved = await allTypes.evaluate((form) => ({
    text: [...form.querySelectorAll('input[type="text"], textarea')].map((field) => field.value),
    order: [...form.querySelectorAll(".cl-order > li")].map((li) => li.dataset.item),
    pairs: [...form.querySelectorAll("select")].map((field) => field.value),
  }));
  await grade(typedSubmission.id, "All types grade", true);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('[data-quiz-id="all-types"]').dataset.state === "graded",
  );
  const restored = await allTypes.evaluate((form) => ({
    text: [...form.querySelectorAll('input[type="text"], textarea')].map((field) => field.value),
    order: [...form.querySelectorAll(".cl-order > li")].map((li) => li.dataset.item),
    pairs: [...form.querySelectorAll("select")].map((field) => field.value),
  }));
  assert(JSON.stringify(saved) === JSON.stringify(restored), "Reload changed a structured answer");
  assert(
    await allTypes.locator('[data-type="choice"] input[value="a"]').isChecked(),
    "Choice answer was lost",
  );
  assert(
    await allTypes.locator('[data-type="multi"] input[value="b"]').isChecked(),
    "Multi answer was lost",
  );
  assert(
    (await allTypes.locator('[data-segment="s3"]').getAttribute("aria-pressed")) === "true",
    "Locate answer was lost",
  );
  const partialForm = page.locator('[data-quiz-id="partial"]');
  for (const field of await partialForm.locator("textarea").all())
    await field.fill("A partly complete answer.");
  const partialResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/quiz/submit") && r.request().method() === "POST",
  );
  await partialForm.getByRole("button", { name: "Submit for grading", exact: true }).click();
  const partialSubmission = await (await partialResponse).json();
  assert(
    (await partialForm.innerText()).includes("Your teacher receives page requests while listening"),
    "The pending quiz does not explain MCP delivery",
  );
  const gradedPartial = await page.request.post(control, {
    data: {
      submissionId: partialSubmission.id,
      feedback: "Partial grade",
      partial: true,
      correct: false,
    },
  });
  assert(gradedPartial.ok(), await gradedPartial.text());
  await page.waitForFunction(
    () => document.querySelector('[data-quiz-id="partial"]').dataset.state === "graded",
  );
  assert((await partialForm.innerText()).includes("78%"), "Partial score is wrong");
  assert(
    (await partialForm.innerText()).includes("1 of 3 fully correct · 2 partial credit"),
    "Partial summary is wrong",
  );
  assert(
    (await partialForm.locator('[data-outcome="partial"]').count()) === 2,
    "Partial answers have the wrong verdict",
  );
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector('[data-quiz-id="partial"]').dataset.state === "graded",
  );
  assert(
    (await partialForm.locator('[data-outcome="partial"]').count()) === 2,
    "Reload lost partial points",
  );
  await screenshot("partial-credit-and-all-types");
  assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  await observer.close();
  return {
    passed: [
      "no confidence controls or submitted metadata",
      "glossary",
      "locked graded quiz",
      "pending saved attempt",
      "cross-tab selections",
      "stale grade",
      "reload",
      "grade before response",
      "all nine response types submit and restore",
      "partial credit display and reload",
      "MCP delivery explanation",
    ],
  };
}
