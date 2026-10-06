/** Explicit temporary tailnet route evaluation. Preserve the user's Serve config. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeFixture, seedClassroom } from "../test/helpers.ts";
import { control, ensureService, serviceStatus } from "../src/service-client.ts";
const exec = promisify(execFile);
const fixture = makeFixture();
seedClassroom(fixture);
const listener = net.createServer();
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
process.env.PI_CLASSROOM_SERVICE_PORT = String((listener.address() as net.AddressInfo).port);
await new Promise<void>((r) => listener.close(() => r()));
const before = JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout);
function unrelated(config: any): unknown {
  const copy = structuredClone(config);
  delete copy.TCP?.["8443"];
  for (const key of Object.keys(copy.Web ?? {})) if (key.endsWith(":8443")) delete copy.Web[key];
  return copy;
}
async function call(name: string, args: unknown): Promise<any> {
  const response = await control("/rpc", {
    client: "phone-evaluation",
    backend: "codex",
    message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  if (response.result.isError) throw new Error(response.result.content[0].text);
  return response.result.content[0].text;
}
try {
  await ensureService();
  await call("open_classroom", { classroom: "rust", teacher_backend: "codex" });
  const link = await call("classroom_phone", {
    action: "start",
    classroom: "rust",
    lesson: "001-ownership",
    https_port: 8443,
  });
  const match = /^\[Open lesson\]\((https:\/\/[^)]+)\)$/.exec(link);
  if (!match) throw new Error("Phone helper did not return a clickable lesson URL.");
  const url = match[1];
  if (!(await fetch(url)).ok) throw new Error("Phone lesson URL did not load.");
  const state = JSON.parse(await call("classroom_phone", { action: "status" }));
  if (!state.enabled) throw new Error("Phone status did not report the owned route.");
  await call("classroom_phone", { action: "stop" });
  const after = JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout);
  if (JSON.stringify(unrelated(before)) !== JSON.stringify(unrelated(after)))
    throw new Error("Unrelated Serve routes changed.");
  if (Object.keys(after.Web ?? {}).some((key) => key.endsWith(":8443")))
    throw new Error("Owned phone route remains.");
  console.log("PASS: checked tailnet lesson URL, status, cleanup, and unchanged unrelated routes.");
} finally {
  if ((await serviceStatus()).running) {
    await control("/stop", {});
    await new Promise((r) => setTimeout(r, 300));
  }
  fixture.cleanup();
}
