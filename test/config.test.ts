import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  _overrideConfigPath,
  configPath,
  readConfig,
  resolveConfiguredPort,
  tailscaleLinks,
} from "../src/config.ts";
import { makeFixture, type Fixture } from "./helpers.ts";
let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

describe("classroom configuration", () => {
  it("allows an absent optional config and an unset port", () => {
    expect(readConfig(path.join(fixture.root, "absent.json"))).toEqual({});
    expect(resolveConfiguredPort(undefined)).toBe(0);
  });
  it("reports corrupt settings with the file path", () => {
    for (const source of ["{", "null", "[]", '{"port":0}', '{"port":"4098"}']) {
      const file = fixture.write("config.json", source);
      expect(() => readConfig(file)).toThrow(/config.json/);
    }
  });
  it("reads the file PI_CLASSROOM_CONFIG names", () => {
    const file = fixture.write("other.json", '{"port":4098}');
    _overrideConfigPath(undefined);
    process.env["PI_CLASSROOM_CONFIG"] = file;
    try {
      expect(configPath()).toBe(file);
      expect(readConfig()).toEqual({ port: 4098 });
    } finally {
      delete process.env["PI_CLASSROOM_CONFIG"];
    }
  });
  it("rejects an invalid configured port", () => {
    for (const port of [0, -1, 65536, 1.5, "4098", null])
      expect(() => resolveConfiguredPort(port)).toThrow();
    expect(resolveConfiguredPort(4098)).toBe(4098);
  });
  it("enables tailnet links unless the config or environment disables them", () => {
    expect(tailscaleLinks("service", {})).toEqual({ enabled: true, port: undefined });
    expect(tailscaleLinks("service", { tailscale: false })).toMatchObject({ enabled: false });
    expect(tailscaleLinks("service", { tailscalePort: 8445 })).toEqual({
      enabled: true,
      port: 8445,
    });
    expect(tailscaleLinks("pi", { tailscalePort: 8445 })).toEqual({ enabled: true, port: 8444 });
    expect(tailscaleLinks("pi", { piTailscalePort: 8446 })).toEqual({ enabled: true, port: 8446 });
    process.env["PI_CLASSROOM_TAILSCALE"] = "0";
    try {
      expect(tailscaleLinks("pi", { tailscale: true })).toMatchObject({ enabled: false });
    } finally {
      delete process.env["PI_CLASSROOM_TAILSCALE"];
    }
  });
});
