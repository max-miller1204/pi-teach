import { describe, it, expect } from "vitest";
import * as path from "node:path";

import { isValidSlug, safeJoin, slugify } from "../src/paths.ts";

describe("isValidSlug", () => {
  it("accepts the directory names classrooms and lessons actually use", () => {
    for (const slug of ["rust", "rust-ownership", "001-closures", "v1.2-notes"]) {
      expect(isValidSlug(slug)).toBe(true);
    }
  });

  it("rejects anything that could walk out of the classrooms root", () => {
    for (const slug of ["..", ".", "../etc", "a/b", "a\\b", "/abs", "", "A-Capital", "sp ace"]) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });

  it("rejects non-strings and absurd lengths", () => {
    expect(isValidSlug(undefined)).toBe(false);
    expect(isValidSlug(42)).toBe(false);
    expect(isValidSlug("a".repeat(129))).toBe(false);
  });
});

describe("slugify", () => {
  it("turns a topic into a directory name", () => {
    expect(slugify("Rust Ownership & Borrowing")).toBe("rust-ownership-borrowing");
  });

  it("strips accents rather than leaving a trailing separator", () => {
    expect(slugify("Café Culture")).toBe("cafe-culture");
  });

  it("never returns an empty name", () => {
    expect(slugify("!!!")).toBe("classroom");
    expect(slugify("")).toBe("classroom");
  });
});

describe("safeJoin", () => {
  const root = path.resolve("/tmp/classrooms-test");

  it("resolves a path beneath the root", () => {
    expect(safeJoin(root, "lesson/media/diagram.png")).toBe(
      path.join(root, "lesson/media/diagram.png"),
    );
  });

  it("rejects traversal, absolute paths, and null bytes", () => {
    expect(safeJoin(root, "../secrets")).toBeNull();
    expect(safeJoin(root, "a/../../secrets")).toBeNull();
    expect(safeJoin(root, "/etc/passwd")).toBeNull();
    expect(safeJoin(root, "a\0b")).toBeNull();
  });

  it("allows the root itself", () => {
    expect(safeJoin(root, "")).toBe(root);
  });
});
