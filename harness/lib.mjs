import { chromium } from "playwright-core";
import fs from "node:fs";
export const BASE = "http://127.0.0.1:4199";
export const L = "/c/http-caching-headers/001-freshness-before-revalidation";
const results = "/tmp/pi-teach-e2e/results.md";
export function check(name, ok, detail = "") {
  const line = `- ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line); fs.appendFileSync(results, line + "\n");
  if (!ok) process.exitCode = 1;
}
export function section(title) { fs.appendFileSync(results, `\n### ${title}\n\n`); console.log("##", title); }
export async function open() {
  const ctx = await chromium.launchPersistentContext("/tmp/pi-teach-e2e/profile", {
    channel: "chrome", headless: true, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
  return { ctx, page };
}
export const shot = (page, name, opts = {}) => page.screenshot({ path: `/tmp/pi-teach-e2e/shots/${name}.png`, ...opts });
export async function pi(message) {
  await fetch("http://127.0.0.1:4299", { method: "POST", body: JSON.stringify({ type: "prompt", message }) });
}
export async function piState() { return (await fetch("http://127.0.0.1:4299")).json(); }
/** Drag-select `text` inside the first element matching `selector`, with the real mouse. */
export async function selectText(page, selector, text) {
  const box = await page.evaluate(([selector, text]) => {
    const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.includes(text));
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node; while ((node = walker.nextNode())) { const i = node.data.indexOf(text); if (i >= 0) {
      el.scrollIntoView({ block: "center" });
      const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + text.length);
      const rects = r.getClientRects(); const a = rects[0], b = rects[rects.length - 1];
      return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
    } }
    return null;
  }, [selector, text]);
  if (!box) throw new Error("text not found: " + text);
  await page.mouse.move(box.x1, box.y1); await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 8 }); await page.mouse.up();
}
