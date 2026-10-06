#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const action = process.argv[2];
if (!["launch", "doctor", "drive", "cleanup"].includes(action))
  throw new Error("Usage: control.mjs <launch|doctor|drive|cleanup>");
if (!process.env.PI_VERIFY_RUN) throw new Error("Set PI_VERIFY_RUN to a new scratch directory.");
const run = path.resolve(process.env.PI_VERIFY_RUN);
const marker = path.join(run, "run.json");
const evidence = path.join(run, "evidence");
const data = path.join(run, "data");
const write = (name, value) =>
  fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2));
let config;
if (action === "launch") {
  if (!fs.existsSync(run) || fs.readdirSync(run).length)
    throw new Error("Launch requires an existing empty directory.");
  config = {
    repo,
    run,
    data,
    port: Number(process.env.PI_VERIFY_PORT ?? "43124"),
    session: `pi-teach-verify-${process.pid}`,
  };
  fs.mkdirSync(evidence);
  fs.mkdirSync(data);
  fs.writeFileSync(marker, JSON.stringify(config, null, 2));
} else {
  config = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (config.repo !== repo || config.run !== run || config.data !== data)
    throw new Error("The verification marker does not belong to this checkout and run.");
}
process.env.PI_CLASSROOMS_DIR = data;
process.env.PI_CLASSROOM_SERVICE_PORT = String(config.port);
process.env.PI_CLASSROOM_AUTO_OPEN = "0";
const { ensureService, serviceStatus, control, servicePaths } =
  await import("../../../src/service-client.ts");
const { playwright, playwrightCode } = await import("../../../scripts/playwright.ts");
const saveConfig = () => fs.writeFileSync(marker, JSON.stringify(config, null, 2));

async function doctor() {
  const status = await serviceStatus();
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  if (
    !status.running ||
    status.root !== data ||
    status.packageRoot !== repo ||
    status.version !== pkg.version ||
    status.port !== config.port
  )
    throw new Error(`Unexpected service identity: ${JSON.stringify(status)}`);
  if (config.pid && status.pid !== config.pid) throw new Error("The service PID changed.");
  process.kill(status.pid, 0);
  const processInfo = await exec("ps", ["-p", String(status.pid), "-o", "args="]);
  if (!processInfo.stdout.includes(path.join(repo, "src/service-main.ts")))
    throw new Error("Unexpected service process command.");
  const listener = await exec("lsof", [
    "-nP",
    `-a`,
    `-p`,
    String(status.pid),
    `-iTCP:${config.port}`,
    "-sTCP:LISTEN",
  ]);
  if (!listener.stdout.includes(`127.0.0.1:${config.port}`))
    throw new Error("The service does not own the loopback port.");
  for (const route of ["/", "/c/verify", "/c/verify/001-reading", "/static/classroom.js"]) {
    const response = await fetch(`${status.url}${route}`);
    if (response.status !== 200) throw new Error(`${route} returned ${response.status}`);
    await response.body.cancel();
  }
  const cli = await exec("playwright-cli", ["--version"]);
  write("doctor.json", {
    status,
    process: processInfo.stdout,
    listener: listener.stdout,
    browserCLI: cli.stdout,
    authentication: "Reading and theme verification require no model login.",
  });
  return status;
}

try {
  if (action === "launch") {
    const lesson = path.join(data, "verify", "001-reading");
    fs.mkdirSync(path.join(lesson, "quiz"), { recursive: true });
    fs.writeFileSync(
      path.join(data, "verify", "classroom.json"),
      JSON.stringify({ title: "Verification classroom", emoji: "📚", createdAt: Date.now() }),
    );
    fs.writeFileSync(
      path.join(lesson, "lesson.json"),
      JSON.stringify({
        title: "Reading lesson",
        summary: "Read a short lesson.",
        createdAt: Date.now(),
      }),
    );
    fs.writeFileSync(
      path.join(lesson, "lesson.html"),
      "<!doctype html><html><head><title>Reading lesson</title></head><body><main data-cl-content><h1>Reading lesson</h1><p>A value has one owner.</p></main></body></html>",
    );
    fs.writeFileSync(path.join(lesson, "quiz", "key.json"), '{"secret":"private rubric sentinel"}');
    const status = await ensureService();
    config.pid = status.pid;
    saveConfig();
    write("launch.json", status);
    console.log(JSON.stringify(status, null, 2));
  } else if (action === "doctor") {
    console.log(JSON.stringify(await doctor(), null, 2));
  } else if (action === "drive") {
    const status = await doctor();
    config.browserAttempted = true;
    saveConfig();
    write("browser-open.json", {
      command: "playwright-cli open",
      output: await playwright(config.session, run, "open", status.url),
    });
    const proof = await playwrightCode(
      config.session,
      run,
      `async page => {
      const actions = [];
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const capture = async name => {
        await page.screenshot({path: ${JSON.stringify(evidence)} + '/' + name + '.png', fullPage:true});
        return await page.locator('body').ariaSnapshot();
      };
      const before = await capture('landing');
      await page.locator('a[href="/c/verify"]').click();
      actions.push('Click the Verification classroom card.');
      await page.locator('a[href="/c/verify/001-reading"]').click();
      actions.push('Click Reading lesson.');
      await page.locator('[data-cl-content]').waitFor();
      if (!(await page.locator('[data-cl-content]').innerText()).includes('A value has one owner.')) throw new Error('Lesson text is missing.');
      const lesson = await capture('lesson');
      await page.getByRole('button', {name:'Toggle colour theme', exact:true}).click();
      actions.push('Toggle colour theme.');
      const selected = await page.locator('html').getAttribute('data-theme');
      await page.reload();
      actions.push('Reload the lesson.');
      await page.locator('[data-cl-content]').waitFor();
      const reloaded = await page.locator('html').getAttribute('data-theme');
      const stored = await page.evaluate(() => localStorage.getItem('pi-classroom-theme'));
      if (!selected || selected !== reloaded || selected !== stored) throw new Error('Theme did not persist.');
      const after = await capture('theme-reloaded');
      const privateResponse = await page.request.get(${JSON.stringify(status.url)} + '/c/verify/001-reading/quiz/key.json');
      const privateBody = await privateResponse.text();
      if (privateResponse.status() !== 404 || privateBody.includes('private rubric sentinel')) throw new Error('Private rubric route is exposed.');
      if (errors.length) throw new Error(JSON.stringify(errors));
      return {feature:'reading', entryPoint:'landing card then lesson link', actions, before, lesson, after, selected, reloaded, stored, privateStatus:privateResponse.status(), privateBody, errors};
    }`,
    );
    write("reading.json", proof);
    fs.copyFileSync(
      path.join(data, "verify", "001-reading", "lesson.html"),
      path.join(evidence, "seed-lesson.html"),
    );
    console.log("Reading and theme verification passed.");
  } else {
    if (config.browserAttempted && !config.browserClosed) {
      await playwright(config.session, run, "close");
      config.browserClosed = true;
      saveConfig();
    }
    const status = await serviceStatus();
    if (status.running) {
      if (
        !config.pid ||
        status.pid !== config.pid ||
        status.root !== data ||
        status.packageRoot !== repo
      )
        throw new Error("Refuse to stop a service not owned by this run.");
      await control("/stop", {});
      const deadline = Date.now() + 10000;
      while ((await serviceStatus()).running) {
        if (Date.now() > deadline) throw new Error("Service did not stop.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const log = servicePaths().log;
    if (fs.existsSync(log)) fs.copyFileSync(log, path.join(evidence, "service.log"));
    fs.rmSync(data, { recursive: true, force: true });
    write("cleanup.json", {
      running: false,
      dataRemoved: !fs.existsSync(data),
      evidence: fs.readdirSync(evidence),
    });
    console.log(`Stopped the owned service. Retained evidence at ${evidence}`);
  }
} catch (error) {
  write(`${action}-failure.json`, { action, error: String(error), stack: error.stack });
  throw error;
}
