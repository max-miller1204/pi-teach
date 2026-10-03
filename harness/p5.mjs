import { open, shot, check, section, selectText, pi, piState, BASE, L } from "./lib.mjs";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
section("Leftover work survives an aborted run and a Pi restart");
const { ctx, page } = await open();
await page.goto(BASE + L);
await page.locator(".cl-card-inline").first().waitFor();
await selectText(page, "p", "new origin headers cannot retroactively fix a fresh response already stored downstream");
await page.locator(".cl-ask-pill").click();
await page.locator("[data-cl-question]").fill("How do I make a CDN drop the old CSS right after a deploy?");
await page.locator("[data-cl-ask-form] button[type=submit]").click();
for (let i = 0; i < 100 && !(await piState()).busy; i++) await sleep(100);
await fetch("http://127.0.0.1:4299", { method: "POST", body: JSON.stringify({ type: "abort" }) });
await sleep(3000);
const ann = JSON.parse(fs.readFileSync("/tmp/pi-teach-e2e/classrooms/http-caching-headers/001-freshness-before-revalidation/annotations.json", "utf8"));
const list = Array.isArray(ann) ? ann : ann.annotations;
const pending = list.filter((a) => a.status === "pending");
check("Aborted run leaves the question pending on disk", pending.length === 1, pending[0]?.question);

// Restart Pi: kill the driver (closing pi's stdin = orderly shutdown), start a fresh session.
execSync("pkill -f 'node driver.mjs' || true");
for (let i = 0; i < 100; i++) { try { await piState(); await sleep(200); } catch { break; } }
await sleep(1500);
const uiBefore = fs.readFileSync("/tmp/pi-teach-e2e/ui.log", "utf8").length;
spawn("node", ["driver.mjs"], { cwd: "/tmp/pi-teach-e2e", detached: true, stdio: "ignore" }).unref();
for (let i = 0; i < 100; i++) { try { await piState(); break; } catch { await sleep(200); } }
await sleep(4000);
await pi("/classroom");
await sleep(2500);
const ui = fs.readFileSync("/tmp/pi-teach-e2e/ui.log", "utf8").slice(uiBefore);
const notice = ui.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.method === "notify").map((r) => r.message);
check("New session's /classroom mentions the waiting question", notice.some((m) => /question/i.test(m) && /teach/i.test(m)), notice.find((m) => /question/i.test(m))?.replace(/\n/g, " "));
await page.waitForTimeout(3000);
check("Open lesson tab reconnects to the restarted server (same port)", (await page.locator(".cl-offline:not([hidden])").count()) === 0);
const settled = (await piState()).settled;
await pi("/teach http-caching-headers");
console.log("waiting for /teach to pick up the leftover question…");
await page.waitForFunction(() => [...document.querySelectorAll(".cl-card-answer")].every((a) => !a.querySelector(".cl-spinner")), null, { timeout: 600000 });
const cards = page.locator(".cl-card-inline");
const last = (await cards.nth((await cards.count()) - 1).locator(".cl-card-answer").innerText()).trim();
check("/teach in the new session claimed and answered it; card updated live", last.length > 40, `${last.slice(0, 90).replace(/\n/g, " ")}…`);
await cards.nth((await cards.count()) - 1).scrollIntoViewIfNeeded();
await shot(page, "20-recovered-answer");
for (let i = 0; i < 600 && (await piState()).settled === settled; i++) await sleep(1000);
await ctx.close();
