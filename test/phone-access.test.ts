import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PhoneAccess } from "../src/phone-access.ts";

function fixture(config: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-phone-test-")),
    calls: string[][] = [];
  const phone = new PhoneAccess(
    async (args) => {
      calls.push(args);
      if (args[0] === "status")
        return JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "test.tailnet.ts.net." },
        });
      if (args[1] === "status") return JSON.stringify(config);
      const port = args.find((a) => a.startsWith("--https="))!.split("=")[1],
        key = `test.tailnet.ts.net:${port}`;
      if (args.at(-1) === "off") {
        delete config.Web[key].Handlers["/"];
      } else {
        config.Web ??= {};
        config.TCP ??= {};
        config.TCP[port] = { HTTPS: true };
        config.Web[key] = { Handlers: { "/": { Proxy: args.at(-1) } } };
      }
      return "";
    },
    path.join(dir, "phone.json"),
  );
  return { phone, config, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
describe("phone routes", () => {
  it("starts and stops only its own route and preserves unrelated routes", async () => {
    const f = fixture({
      TCP: { "443": { HTTPS: true } },
      Web: { "test.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } } },
    });
    try {
      const original = JSON.stringify(f.config.Web["test.tailnet.ts.net:443"]);
      expect(await f.phone.start("http://127.0.0.1:43123")).toBe(
        "https://test.tailnet.ts.net:8443",
      );
      expect(await f.phone.status()).toMatchObject({ enabled: true });
      await f.phone.start("http://127.0.0.1:43123");
      await f.phone.stop();
      expect(JSON.stringify(f.config.Web["test.tailnet.ts.net:443"])).toBe(original);
      expect(f.calls.filter((c) => c.includes("--bg"))).toHaveLength(1);
      expect(f.calls.flat()).not.toContain("reset");
      expect(f.calls.flat()).not.toContain("funnel");
    } finally {
      f.cleanup();
    }
  });
  it("rejects conflicts and Funnel before a mutation", async () => {
    for (const config of [
      {
        Web: {
          "test.tailnet.ts.net:8443": { Handlers: { "/other": { Proxy: "http://127.0.0.1:9" } } },
        },
      },
      { AllowFunnel: { "test.tailnet.ts.net:8443": true } },
      { TCP: { "8443": { TCPForward: "localhost:9" } } },
    ]) {
      const f = fixture(config);
      try {
        await expect(f.phone.start("http://127.0.0.1:43123")).rejects.toThrow();
        expect(f.calls).toHaveLength(2);
      } finally {
        f.cleanup();
      }
    }
  });
  it("refuses cleanup when a route changed ownership", async () => {
    const f = fixture();
    try {
      await f.phone.start("http://127.0.0.1:43123");
      f.config.Web["test.tailnet.ts.net:8443"].Handlers["/"].Proxy = "http://127.0.0.1:8";
      await expect(f.phone.stop()).rejects.toThrow("Refusing");
    } finally {
      f.cleanup();
    }
  });
  it("reports availability only for a connected node", async () => {
    const reply = (status: unknown) => new PhoneAccess(async () => JSON.stringify(status));
    expect(
      await reply({ BackendState: "Running", Self: { DNSName: "a.b.ts.net." } }).available(),
    ).toBe(true);
    expect(
      await reply({ BackendState: "Stopped", Self: { DNSName: "a.b.ts.net." } }).available(),
    ).toBe(false);
    expect(await reply({ BackendState: "NeedsLogin", Self: {} }).available()).toBe(false);
    const missing = new PhoneAccess(async () => {
      throw new Error("tailscale: ENOENT");
    });
    expect(await missing.available()).toBe(false);
  });
  it("moves the owned route when the configured port changes", async () => {
    const f = fixture();
    try {
      await f.phone.start("http://127.0.0.1:43123");
      expect(await f.phone.start("http://127.0.0.1:43123", 8445)).toBe(
        "https://test.tailnet.ts.net:8445",
      );
      expect(f.config.Web["test.tailnet.ts.net:8443"]?.Handlers["/"]).toBeUndefined();
      expect(f.config.Web["test.tailnet.ts.net:8445"].Handlers["/"].Proxy).toBe(
        "http://127.0.0.1:43123",
      );
    } finally {
      f.cleanup();
    }
  });
  it("keeps the route record while Tailscale is disconnected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-phone-test-"));
    const file = path.join(dir, "phone.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ host: "test.tailnet.ts.net", port: 8443, target: "http://127.0.0.1:43123" }),
    );
    try {
      const phone = new PhoneAccess(async () => JSON.stringify({ BackendState: "Stopped" }), file);
      expect(await phone.stop()).toMatchObject({ removed: false, kept: expect.any(String) });
      expect(await phone.status()).toMatchObject({ connected: false, owned: { port: 8443 } });
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("fails clearly when Tailscale is unavailable", async () => {
    const phone = new PhoneAccess(async () => {
      throw new Error("tailscale: ENOENT");
    });
    await expect(phone.start("http://127.0.0.1:43123")).rejects.toThrow("ENOENT");
  });
});
