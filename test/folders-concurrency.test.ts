import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFixture } from "./helpers.ts";

it("keeps every accepted folder edit across two HTTP servers", async () => {
  const fixture = makeFixture();
  const children: ReturnType<typeof spawn>[] = [];
  async function launch(): Promise<string> {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { _overrideClassroomsDir } from ${JSON.stringify(new URL("../src/paths.ts", import.meta.url).href)};
       import { _overrideConfigPath } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
       import * as server from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
       _overrideClassroomsDir(${JSON.stringify(fixture.root)});
       _overrideConfigPath(${JSON.stringify(path.join(fixture.root, "config.json"))});
       console.log(await server.start(0));
       process.on('SIGTERM', async () => { await server.close(); process.exit(0); });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    return new Promise((resolve, reject) => {
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout!.once("data", (chunk) => resolve(chunk.toString().trim()));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Folder server exited (${code}): ${stderr}`)));
    });
  }
  try {
    const urls = await Promise.all([launch(), launch()]);
    async function create(index: number) {
      const response = await fetch(`${urls[index % 2]}/api/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: `Folder ${index}` }),
      });
      return { index, status: response.status, body: await response.json() };
    }
    const results = await Promise.all(Array.from({ length: 80 }, (_, i) => create(i)));
    expect(results.every((result) => result.status === 200 || result.status === 409)).toBe(true);
    const saved = () =>
      JSON.parse(fs.readFileSync(path.join(fixture.root, ".folders.json"), "utf8")).folders;
    const accepted = results.filter((result) => result.status === 200);
    expect(
      saved()
        .map((folder: { name: string }) => folder.name)
        .sort(),
    ).toEqual(accepted.map((result) => `Folder ${result.index}`).sort());
    for (const result of results.filter((result) => result.status === 409)) {
      expect(result.body.error).toContain("locked folder edits");
      expect((await create(result.index)).status).toBe(200);
    }
    expect(saved()).toHaveLength(80);
    expect(fs.existsSync(path.join(fixture.root, ".folders.lock"))).toBe(false);
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }),
    );
    fixture.cleanup();
  }
});
