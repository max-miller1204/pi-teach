/** Check question cards through learner controls when answers race and deletes fail. */
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFixture, seedClassroom, lessonHtml } from "../test/helpers.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { applyAnswer } from "../src/bridge.ts";
import { highlightText } from "./browser-actions.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyCardBrowser(artifacts: string | null): Promise<void> {
  const fixture = makeFixture();
  const session = `pi-teach-cards-${process.pid}`;
  let opened = false;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  seedClassroom(fixture);
  fixture.write(
    "rust/001-ownership/lesson.html",
    lessonHtml("Ownership", "<h1>Ownership</h1><p>Every value has one owner.</p>"),
  );
  server.setHooks({
    // Answer before the ask response so the answer event can arrive first.
    onAsk: (annotation) => {
      applyAnswer(annotation.id, "The owner controls release.");
    },
    onFollowUp: () => {
      throw new Error("Unexpected follow-up in card drive.");
    },
    onQuizSubmit: () => {
      throw new Error("Unexpected quiz in card drive.");
    },
    onReflect: () => {
      throw new Error("Unexpected reflection in card drive.");
    },
  });
  try {
    const base = await server.start(0);
    await playwright(session, fixture.root, "open", base);
    opened = true;
    const result = await playwrightCode<Record<string, unknown>>(
      session,
      fixture.root,
      `async page => {
        await page.goto(new URL('/c/rust/001-ownership', page.url()).href);
        await (${highlightText.toString()})(page, 'main > p', 'one owner');
        await page.locator('.cl-ask-pill').click();
        await page.locator('[data-cl-question]').fill('Who releases the value?');
        const asked = page.waitForResponse(r => r.url().endsWith('/api/ask'));
        await page.getByRole('button', {name:'Ask your teacher',exact:true}).click();
        const response = await asked;
        if (response.status() !== 201) throw new Error(await response.text());
        const annotation = await response.json();
        await page.getByText('The owner controls release.', {exact:true}).waitFor();
        await page.getByRole('button', {name:'Minimise',exact:true}).click();
        await page.reload();
        await page.getByRole('button', {name:'Reopen your question',exact:true}).click();
        await page.getByRole('button', {name:'Delete',exact:true}).click();
        await page.getByRole('button', {name:'Cancel',exact:true}).click();
        if (!await page.locator('.cl-card-panel[data-annotation-id]').isVisible()) throw new Error('Cancel removed the card.');
        await page.route('**/api/annotations/**', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Deletion unavailable for verification.'})}), {times:1});
        await page.getByRole('button', {name:'Delete',exact:true}).click();
        const refusedDelete = page.waitForResponse(r => r.request().method() === 'DELETE');
        await page.getByRole('button', {name:'Delete question',exact:true}).click();
        if ((await refusedDelete).status() !== 503) throw new Error('The deletion error probe did not run.');
        ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "delete-error.png"))},fullPage:true});` : ""}
        if (!await page.locator('.cl-card-panel[data-annotation-id]').isVisible()) throw new Error('Failed deletion hid the saved card.');
        await page.getByRole('alert').getByText('Deletion unavailable for verification.', {exact:false}).waitFor();
        await page.getByRole('button', {name:'Delete',exact:true}).click();
        const deleted = page.waitForResponse(r => r.request().method() === 'DELETE');
        await page.getByRole('button', {name:'Delete question',exact:true}).click();
        if (!(await deleted).ok()) throw new Error('Card deletion failed.');
        await page.reload();
        await page.locator('[data-cl-content]').waitFor();
        const state = await (await page.request.get(new URL('/api/state?classroom=rust&lesson=001-ownership',page.url()).href)).json();
        if (state.annotations.length || await page.locator('.cl-card-panel[data-annotation-id]').count()) throw new Error('Deleted card returned.');
        ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "deleted.png"))},fullPage:true});` : ""}
        return {annotationId:annotation.id,state};
      }`,
    );
    if (store.listAnnotations("rust", "001-ownership").length)
      throw new Error("The deleted card remains on disk.");
    if (artifacts)
      fs.writeFileSync(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2));
    console.log("PASS: early answer, minimised reload, refused delete, retry, and saved deletion");
  } finally {
    if (artifacts)
      fs.cpSync(path.join(fixture.root, "rust"), path.join(artifacts, "classroom"), {
        recursive: true,
        dereference: false,
      });
    try {
      if (opened) await playwright(session, fixture.root, "close");
    } finally {
      await server.close();
      fixture.cleanup();
    }
  }
}
