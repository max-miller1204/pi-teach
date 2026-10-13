import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { packageRoot } from "../src/paths.ts";

const root = packageRoot();
const usage =
  "Usage: npm run verify -- [local|checks|browser|pi|claude|codex|authoring <claude|codex>|feedback <claude|codex>|quality <claude|codex>|phone|doctor [browser|pi|claude|codex]] [--artifacts <directory>]";
const args = process.argv.slice(2);
const artifactFlag = args.indexOf("--artifacts");
let requestedArtifacts: string | undefined;
if (artifactFlag >= 0) {
  if (artifactFlag !== args.length - 2 || !args[artifactFlag + 1]) throw new Error(usage);
  requestedArtifacts = path.resolve(args[artifactFlag + 1]);
  args.splice(artifactFlag, 2);
}
const target = args[0] ?? "local";
const host = args[1];
const evaluations = ["authoring", "feedback", "quality"];
const targets = [
  "local",
  "checks",
  "browser",
  "pi",
  "claude",
  "codex",
  "phone",
  "doctor",
  ...evaluations,
];
if (!targets.includes(target) || args.length > 2) throw new Error(usage);
if (evaluations.includes(target)) {
  if (host !== "claude" && host !== "codex") throw new Error(usage);
} else if (target === "doctor") {
  if (host && !["browser", "pi", "claude", "codex"].includes(host)) throw new Error(usage);
} else if (host) throw new Error(usage);

const artifacts = requestedArtifacts ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-teach-verify-"));

function doctor(surface: string): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18))
    throw new Error("Node 22.18 or later is required.");
  if (!fs.existsSync(path.join(root, "node_modules/typescript")))
    throw new Error("Dependencies are missing. Run npm ci.");
  if (surface === "checks") return;
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "assets/playwright-headless.json"), "utf8"),
  );
  if (config.browser.launchOptions.headless !== true)
    throw new Error("Browser checks require headless mode.");
  const commands = ["playwright-cli"];
  if (["pi", "claude", "codex"].includes(surface)) commands.push(surface);
  if (surface === "phone") commands.push("tailscale");
  for (const command of commands) {
    const result = spawnSync(command, ["--version"], { cwd: root, encoding: "utf8" });
    if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${command} --version failed: ${result.stderr}`);
    console.log(`${command}: ${result.stdout.trim()}`);
  }
  if (surface === "codex") {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    if (!fs.existsSync(path.join(home, "auth.json")))
      throw new Error("Codex auth.json is missing. Sign in with codex.");
  }
}

fs.mkdirSync(artifacts, { recursive: true });
const results: Array<{ command: string[]; exitCode: number | null }> = [];
let failure: string | undefined;
console.log(`Evidence: ${artifacts}`);
async function run(command: string, commandArgs: string[], name: string): Promise<void> {
  const stdout = fs.createWriteStream(path.join(artifacts, `${name}.stdout.log`));
  const stderr = fs.createWriteStream(path.join(artifacts, `${name}.stderr.log`));
  const child = spawn(command, commandArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderr.write(chunk);
  });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    results.push({ command: [command, ...commandArgs], exitCode });
    if (exitCode !== 0)
      throw new Error(`${name} failed with exit code ${exitCode}. See ${artifacts}.`);
  } finally {
    await Promise.all(
      [stdout, stderr].map((stream) => new Promise<void>((resolve) => stream.end(resolve))),
    );
  }
}

try {
  doctor(
    target === "doctor" ? (host ?? "browser") : (host ?? (target === "local" ? "browser" : target)),
  );
  if (target === "checks" || target === "local") {
    for (const script of ["format:check", "check", "test"])
      await run("npm", ["run", script], script.replace(":", "-"));
  }
  if (target === "local" || target === "browser")
    await run(
      process.execPath,
      ["scripts/e2e-browser.ts", path.join(artifacts, "browser")],
      "browser",
    );
  if (["pi", "phone"].includes(target))
    await run(process.execPath, [`scripts/e2e-${target}.ts`, path.join(artifacts, target)], target);
  if (["claude", "codex"].includes(target))
    await run(process.execPath, ["scripts/e2e.ts", target, path.join(artifacts, target)], target);
  if (evaluations.includes(target))
    await run(
      process.execPath,
      [`scripts/e2e-${target}.ts`, host!, path.join(artifacts, `${target}-${host}`)],
      `${target}-${host}`,
    );
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  fs.writeFileSync(
    path.join(artifacts, "run.json"),
    JSON.stringify(
      {
        target,
        host,
        verdict: failure ? "FAIL" : "PASS",
        error: failure,
        revision: spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).stdout.trim(),
        changes: spawnSync("git", ["status", "--short"], {
          cwd: root,
          encoding: "utf8",
        }).stdout.trim(),
        results,
      },
      null,
      2,
    ),
  );
}
