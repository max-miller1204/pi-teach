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
const writeConfig = (config: unknown) =>
  fs.writeFileSync(process.env.PI_CLASSROOM_CONFIG!, JSON.stringify(config));
const routed = async () =>
  Object.keys(
    JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout).Web ?? {},
  ).some((key) => key.endsWith(`:${httpsPort}`));
const openTailnet = async () => {
  const opened = await call("open_classroom", { classroom: "rust", teacher_backend: "codex" });
  const link = /^\[Open classroom\]\((https:\/\/[^)]+\.ts\.net:(\d+)\/c\/rust)\)$/.exec(opened);
  if (!link || Number(link[2]) !== httpsPort)
    throw new Error(`open_classroom did not return the tailnet link: ${opened}`);
  return link[1];
};
try {
  await ensureService();
  const classroom = await openTailnet();
  for (const url of [classroom, `${classroom}/001-ownership`])
    if (!(await fetch(url)).ok) throw new Error(`Tailnet URL did not load: ${url}`);
  const state = JSON.parse(await call("classroom_service", { action: "status" }));
  if (!state.tailnet?.enabled) throw new Error("Service status did not report the owned route.");
  writeConfig({ tailscale: false, tailscalePort: httpsPort });
  const local = await call("open_classroom", { classroom: "rust" });
  if (!local.includes("http://127.0.0.1:")) throw new Error(`Disabled links stayed: ${local}`);
  if (await routed()) throw new Error("Disabling tailnet links kept the owned route.");
  writeConfig({ tailscalePort: httpsPort });
  await openTailnet();
  const stopped = JSON.parse(await call("classroom_service", { action: "stop" }));
  if (!stopped.tailnet?.removed) throw new Error("Service stop did not remove the owned route.");
  await new Promise((r) => setTimeout(r, 300));
  const after = JSON.parse((await exec("tailscale", ["serve", "status", "--json"])).stdout);
  if (JSON.stringify(unrelated(before)) !== JSON.stringify(unrelated(after)))
    throw new Error("Unrelated Serve routes changed.");
  if (await routed()) throw new Error("Owned tailnet route remains.");
  console.log(
    "PASS: automatic tailnet classroom and lesson links, service status, config disable, service stop cleanup, and unchanged unrelated routes.",
  );
} finally {
  if ((await serviceStatus()).running) {
    await control("/stop", {});
    await new Promise((r) => setTimeout(r, 300));
  }
  fixture.cleanup();
}
