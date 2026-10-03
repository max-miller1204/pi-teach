/** Run the installed Playwright CLI in a separate test session. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function playwright(session: string, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("playwright-cli", [`-s=${session}`, "--raw", ...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (stdout.includes("### Error")) throw new Error(stdout);
  return stdout.trim();
}

export async function playwrightCode<T>(session: string, cwd: string, code: string): Promise<T> {
  return JSON.parse(await playwright(session, cwd, "run-code", code)) as T;
}
