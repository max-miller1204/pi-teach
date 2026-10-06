import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Types come from the hand-written diagrams.d.mts sidecar; the .mjs itself is what the
// browser loads, so this is the same rule the runtime applies.
import { dedentSource } from "../assets/runtime/diagrams.mjs";

const vendor = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/runtime/vendor/mermaid",
);

describe("dedentSource", () => {
  it("removes the indent every line shares and the blank lines around the source", () => {
    expect(dedentSource("\n      flowchart LR\n        A --> B\n    ")).toBe(
      "flowchart LR\n  A --> B",
    );
  });

  it("keeps the relative indent that a mindmap reads as structure", () => {
    expect(dedentSource("    mindmap\n      root\n        Child\n      Sibling")).toBe(
      "mindmap\n  root\n    Child\n  Sibling",
    );
  });

  it("ignores blank lines when it finds the shared indent", () => {
    expect(dedentSource("  graph TD\n\n    A --> B")).toBe("graph TD\n\n  A --> B");
  });

  it("normalizes Windows line endings", () => {
    expect(dedentSource("  graph TD\r\n    A --> B\r\n")).toBe("graph TD\n  A --> B");
  });
});

describe("vendored Mermaid", () => {
  it("ships the browser build with its license and version", () => {
    const version = fs.readFileSync(path.join(vendor, "VERSION"), "utf8").trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.readFileSync(path.join(vendor, "LICENSE"), "utf8")).toContain("MIT License");
    const build = fs.readFileSync(path.join(vendor, "mermaid.min.js"), "utf8");
    expect(build).toContain('globalThis["mermaid"]');
  });
});
