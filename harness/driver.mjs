// Spawns pi in RPC mode with only the branch's extension and exposes a tiny control port.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const log = fs.createWriteStream("/tmp/pi-teach-e2e/events.jsonl", { flags: "a" });
const ui = fs.createWriteStream("/tmp/pi-teach-e2e/ui.log", { flags: "a" });
const pi = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
  "-e", "/Users/maxmiller/pi-teach/index.ts"], {
  cwd: "/tmp/pi-teach-e2e/work",
  env: { ...process.env, PI_CLASSROOMS_DIR: "/tmp/pi-teach-e2e/classrooms",
    PI_CLASSROOM_PORT: "4199", PI_CLASSROOM_AUTO_OPEN: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
pi.stderr.pipe(fs.createWriteStream("/tmp/pi-teach-e2e/stderr.log", { flags: "a" }));
let state = { settled: 0, runs: 0, busy: false, tools: [] };
let buf = "";
pi.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "message_update") continue; // too noisy
    log.write(line + "\n");
    if (rec.type === "agent_start") { state.busy = true; state.runs++; }
    if (rec.type === "agent_settled") { state.busy = false; state.settled++; }
    if (rec.type === "tool_execution_start") state.tools.push(rec.toolName);
    if (rec.type === "extension_ui_request") {
      ui.write(JSON.stringify(rec) + "\n");
      if (["select", "confirm", "input", "editor"].includes(rec.method)) {
        pi.stdin.write(JSON.stringify({ type: "extension_ui_response", id: rec.id, cancelled: true }) + "\n");
      }
    }
  }
});
pi.on("exit", (code) => { fs.appendFileSync("/tmp/pi-teach-e2e/stderr.log", `\nEXIT ${code}\n`); process.exit(0); });

http.createServer((req, res) => {
  if (req.method === "GET") { res.end(JSON.stringify(state)); return; }
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    pi.stdin.write(body.trim() + "\n"); res.end("ok");
  });
}).listen(4299, "127.0.0.1");
