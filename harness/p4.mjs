import { open, shot, check, section, BASE, L } from "./lib.mjs";
section("Request guards (DNS rebinding, cross-site writes, quiz/ privacy, traversal)");
import http from "node:http";
function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((res) => {
    const r = http.request({ host: "127.0.0.1", port: 4199, path, method, headers }, (x) => { x.resume(); x.on("end", () => res(x.statusCode)); });
    if (body) r.write(body); r.end();
  });
}
const ask = JSON.stringify({ classroom: "http-caching-headers", lesson: "001-freshness-before-revalidation", question: "x", selection: "x", anchor: { exact: "Fresh" } });
check("Foreign Host header refused (DNS rebinding)", (await req("/", { headers: { Host: "evil.example:4199" } })) === 403);
check("Cross-site POST /api/ask refused", (await req("/api/ask", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: ask })) === 403);
check("Form-encoded POST refused (needs application/json)", (await req("/api/ask", { method: "POST", headers: { "Content-Type": "text/plain" }, body: ask })) === 403);
check("quiz/ (submissions + answer key) is not served", (await req(L + "/quiz/key.json")) === 404);
check("Path traversal refused", (await req("/c/http-caching-headers/..%2f..%2f..%2fetc%2fpasswd")) === 404 && (await req("/static/..%2f..%2fpackage.json")) === 404);

section("Deleting a card");
const { ctx, page } = await open();
await page.goto(BASE + L);
await page.locator(".cl-card-inline").first().waitFor();
const before = await page.locator(".cl-card-inline").count();
await page.locator(".cl-card-inline [data-cl-delete]").first().click();
await page.locator(".cl-confirm").waitFor();
await page.locator(".cl-confirm").screenshot({ path: "/tmp/pi-teach-e2e/shots/19-delete-confirm.png" });
await page.locator(".cl-confirm [data-cl-cancel]").click();
check("Delete asks for confirmation; cancel keeps the card", (await page.locator(".cl-card-inline").count()) === before);
await ctx.close();
