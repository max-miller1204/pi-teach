import * as http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import * as config from "../src/config.ts";
import * as server from "../src/server.ts";

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

it("rejects an occupied configured port and preserves a fixed URL across restarts", async () => {
  const occupied = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  vi.spyOn(config, "readConfig").mockReturnValue({ port: address.port });
  try {
    await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
    expect(server.getPort()).toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((err) => (err ? reject(err) : resolve())),
    );
  }
  const first = await server.start();
  expect(server.getPort()).toBe(address.port);
  await server.close();
  expect(await server.start()).toBe(first);
});

it("shares one server for concurrent start requests", async () => {
  vi.spyOn(config, "readConfig").mockReturnValue({});
  const urls = await Promise.all([server.start(), server.start(), server.start()]);
  expect(new Set(urls).size).toBe(1);
  expect(urls[0]).toBe(server.getBaseUrl());
});
