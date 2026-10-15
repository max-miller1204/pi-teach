/** Temporary automatic tailnet route evaluation. Preserve the user's Serve config.
 * Set PI_TEACH_PHONE_PORT when 8443 holds another route. */
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
const httpsPort = Number(process.env.PI_TEACH_PHONE_PORT ?? 8443);
process.env.PI_CLASSROOM_CONFIG = fixture.write(
  "config.json",
  JSON.stringify({ tailscalePort: httpsPort }),
);
delete process.env.PI_CLASSROOM_TAILSCALE;
const before = JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout);
function unrelated(config: any): unknown {
  const copy = structuredClone(config);
  delete copy.TCP?.[String(httpsPort)];
  for (const key of Object.keys(copy.Web ?? {}))
    if (key.endsWith(`:${httpsPort}`)) delete copy.Web[key];
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
  const opened = await call("open_classroom", { classroom: "rust", teacher_backend: "codex" });
  const classroom = /^\[Open classroom\]\((https:\/\/[^)]+\.ts\.net:(\d+)\/c\/rust)\)$/.exec(
    opened,
  );
  if (!classroom || Number(classroom[2]) !== httpsPort)
    throw new Error(`open_classroom did not return the tailnet link: ${opened}`);
  if (!(await fetch(classroom[1])).ok) throw new Error("Tailnet classroom URL did not load.");
  const link = await call("classroom_phone", {
    action: "start",
    classroom: "rust",
    lesson: "001-ownership",
  });
  const match = /^\[Open lesson\]\((https:\/\/[^)]+)\)$/.exec(link);
  if (!match || !match[1].startsWith(classroom[1].replace(/\/c\/rust$/, "")))
    throw new Error(`Phone helper did not return the same tailnet lesson URL: ${link}`);
  const url = match[1];
  if (!(await fetch(url)).ok) throw new Error("Phone lesson URL did not load.");
  const state = JSON.parse(await call("classroom_phone", { action: "status" }));
  if (!state.enabled) throw new Error("Phone status did not report the owned route.");
  await call("classroom_phone", { action: "stop" });
  const after = JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout);
  if (JSON.stringify(unrelated(before)) !== JSON.stringify(unrelated(after)))
    throw new Error("Unrelated Serve routes changed.");
  if (Object.keys(after.Web ?? {}).some((key) => key.endsWith(`:${httpsPort}`)))
    throw new Error("Owned phone route remains.");
  console.log(
    "PASS: automatic tailnet classroom link, lesson URL, status, cleanup, and unchanged unrelated routes.",
  );
} finally {
  if ((await serviceStatus()).running) {
    await control("/stop", {});
    await new Promise((r) => setTimeout(r, 300));
  }
  fixture.cleanup();
}
