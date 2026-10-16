/** Check folder controls, persistence, errors, and stable classroom links. */
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFixture, seedClassroom } from "../test/helpers.ts";
import * as server from "../src/server.ts";
import * as store from "../src/store.ts";
import { playwright, playwrightCode } from "./playwright.ts";

export async function verifyFoldersBrowser(artifacts: string | null): Promise<void> {
  const fixture = makeFixture();
  const session = `pi-teach-folders-${process.pid}`;
  let opened = false;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  seedClassroom(fixture);
  fixture.write(
    "algebra/classroom.json",
    JSON.stringify({ title: "Algebra", emoji: "📐", createdAt: 1 }),
  );
  const lessonPath = path.join(fixture.root, "rust/001-ownership/lesson.html");
  const original = fs.readFileSync(lessonPath, "utf8");
  try {
    const base = await server.start(0);
    await playwright(session, fixture.root, "open", base);
    opened = true;
    const result = await playwrightCode<Record<string, unknown>>(
      session,
      fixture.root,
      `async page => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const dialog = page.getByRole('dialog');
        const create = async name => {
          await page.getByRole('button', {name:'New folder',exact:true}).click();
          await dialog.getByLabel('Folder name', {exact:true}).fill(name);
          await dialog.getByRole('button', {name:'Create folder',exact:true}).click();
          await dialog.waitFor({state:'hidden'});
          await page.getByRole('link').filter({hasText:name}).waitFor();
        };
        const move = async (classroom, target) => {
          await page.getByRole('button', {name:'Move '+classroom+' to folder',exact:true}).click();
          await dialog.getByLabel('Folder', {exact:true}).selectOption({label:target});
          await dialog.getByRole('button', {name:'Move classroom',exact:true}).click();
          await dialog.waitFor({state:'hidden'});
          await page.getByRole('heading', {level:1}).waitFor();
        };
        await create('Programming');
        await create('Science');
        await page.getByRole('button', {name:'New folder',exact:true}).click();
        await dialog.getByLabel('Folder name', {exact:true}).fill('programming');
        await dialog.getByRole('button', {name:'Create folder',exact:true}).click();
        await dialog.getByRole('alert').filter({hasText:'already exists'}).waitFor();
        await dialog.getByRole('button', {name:'Cancel',exact:true}).click();
        await move('Rust', 'Programming');
        if (await page.locator('a[href="/c/rust"]').count()) throw new Error('Filed classroom remains at root.');
        await page.getByRole('link').filter({hasText:'Programming'}).click();
        await page.getByRole('heading', {name:'Programming',exact:true}).waitFor();
        const programmingUrl = page.url();
        await page.reload();
        await page.locator('a[href="/c/rust"]').waitFor();
        await page.getByRole('button', {name:'Rename folder',exact:true}).click();
        await dialog.getByLabel('Folder name', {exact:true}).fill('Languages');
        await dialog.getByRole('button', {name:'Save name',exact:true}).click();
        await page.getByRole('heading', {name:'Languages',exact:true}).waitFor();
        if (page.url() !== programmingUrl) throw new Error('Rename changed folder identity.');
        await page.locator('a[href="/c/rust"]').click();
        await page.locator('a[href="/c/rust/001-ownership"]').waitFor();
        await page.goto(programmingUrl);
        await page.route('**/api/folders', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Folder storage unavailable for verification.'})}), {times:1});
        await page.getByRole('button', {name:'Move Rust to folder',exact:true}).click();
        await dialog.getByLabel('Folder', {exact:true}).selectOption({label:'Science'});
        await dialog.getByRole('button', {name:'Move classroom',exact:true}).click();
        await dialog.getByRole('alert').getByText('Folder storage unavailable for verification.', {exact:true}).waitFor();
        if (!await dialog.isVisible()) throw new Error('Failed move closed the dialog.');
        await dialog.getByRole('button', {name:'Cancel',exact:true}).click();
        await page.reload();
        await page.locator('a[href="/c/rust"]').waitFor();
        await move('Rust', 'Science');
        if (await page.locator('a[href="/c/rust"]').count()) throw new Error('Move kept old membership.');
        await page.getByRole('link', {name:'Classrooms',exact:true}).click();
        await page.getByRole('link').filter({hasText:'Science'}).click();
        await page.locator('a[href="/c/rust"]').waitFor();
        await move('Rust', 'Unfiled');
        if (await page.locator('a[href="/c/rust"]').count()) throw new Error('Unfiled move kept membership.');
        await page.getByRole('link', {name:'Classrooms',exact:true}).click();
        await page.locator('a[href="/c/rust"]').waitFor();
        await move('Rust', 'Science');
        await page.setViewportSize({width:390,height:844});
        await page.evaluate(() => document.documentElement.setAttribute('data-theme','dark'));
        ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "folders-mobile-dark.png"))},fullPage:true});` : ""}
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile folders overflow.');
        await page.getByRole('link').filter({hasText:'Science'}).click();
        await page.getByRole('button', {name:'Delete folder',exact:true}).click();
        await dialog.getByRole('button', {name:'Cancel',exact:true}).click();
        await page.locator('a[href="/c/rust"]').waitFor();
        await page.getByRole('button', {name:'Delete folder',exact:true}).click();
        await dialog.getByRole('button', {name:'Delete folder',exact:true}).click();
        await page.getByRole('heading', {name:'Classrooms',exact:true}).waitFor();
        await page.reload();
        await page.locator('a[href="/c/rust"]').waitFor();
        if (await page.getByRole('link').filter({hasText:'Science'}).count()) throw new Error('Deleted folder returned.');
        await page.setViewportSize({width:1280,height:800});
        await page.evaluate(() => document.documentElement.setAttribute('data-theme','light'));
        ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "folders-desktop-light.png"))},fullPage:true});` : ""}
        if (errors.length) throw new Error(errors.join('; '));
        return {programmingUrl,errors};
      }`,
    );
    const folderFile = path.join(fixture.root, ".folders.json");
    const saved = fs.readFileSync(folderFile, "utf8");
    fixture.write(".folders.json", "{");
    try {
      await playwrightCode(
        session,
        fixture.root,
        `async page => {
        const response = await page.goto(${JSON.stringify(base)});
        if (response.status() !== 500) throw new Error('Corrupt folder state did not fail.');
        await page.getByRole('heading', {name:'Cannot load classroom folders',exact:true}).waitFor();
        await page.getByRole('alert').filter({hasText:'Cannot read JSON state'}).waitFor();
        ${artifacts ? `await page.screenshot({path:${JSON.stringify(path.join(artifacts, "folder-load-error.png"))},fullPage:true});` : ""}
        return {status:response.status()};
      }`,
      );
    } finally {
      fixture.write(".folders.json", saved);
    }
    await playwrightCode(
      session,
      fixture.root,
      `async page => {
      await page.getByRole('link', {name:'Retry loading',exact:true}).click();
      await page.getByRole('heading', {name:'Classrooms',exact:true}).waitFor();
      await page.locator('a[href="/c/rust"]').waitFor();
      return {recovered:true};
    }`,
    );
    const folders = store.readClassroomFolders();
    if (folders.length !== 1 || folders[0].name !== "Languages" || folders[0].classrooms.length)
      throw new Error("Folder edits did not persist on disk.");
    if (fs.readFileSync(lessonPath, "utf8") !== original)
      throw new Error("Folder edits changed lesson content.");
    if (artifacts)
      fs.writeFileSync(
        path.join(artifacts, "result.json"),
        JSON.stringify({ ...result, folders }, null, 2),
      );
    console.log(
      "PASS: folder creation, moves, rename, reload, explicit retry, deletion, folder load errors, and mobile layout",
    );
  } catch (error) {
    if (artifacts && opened) {
      fs.writeFileSync(
        path.join(artifacts, "failure-snapshot.txt"),
        await playwright(session, fixture.root, "snapshot"),
      );
      await playwright(
        session,
        fixture.root,
        "screenshot",
        `--filename=${path.join(artifacts, "failure.png")}`,
      );
    }
    throw error;
  } finally {
    if (artifacts && fs.existsSync(path.join(fixture.root, ".folders.json")))
      fs.copyFileSync(
        path.join(fixture.root, ".folders.json"),
        path.join(artifacts, "stored-folders.json"),
      );
    try {
      if (opened) await playwright(session, fixture.root, "close");
    } finally {
      await server.close();
      fixture.cleanup();
    }
  }
}
