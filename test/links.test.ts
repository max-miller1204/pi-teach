import { describe, it, expect } from "vitest";

// Types come from the hand-written links.d.mts sidecar; the .mjs itself is what the
// browser loads, so this is the same rule the runtime applies.
import { opensInNewTab } from "../assets/runtime/links.mjs";

const ORIGIN = "http://127.0.0.1:4321";

describe("opensInNewTab", () => {
  it("opens links to other sites in a new tab", () => {
    expect(opensInNewTab("https://doc.rust-lang.org/book/ch04-01.html", ORIGIN)).toBe(true);
    expect(opensInNewTab("http://example.com/", ORIGIN)).toBe(true);
  });

  it("keeps classroom navigation in the current tab", () => {
    expect(opensInNewTab(`${ORIGIN}/c/rust/002-borrowing`, ORIGIN)).toBe(false);
    expect(opensInNewTab("/r/rust/syntax.html", ORIGIN)).toBe(false);
    expect(opensInNewTab("#quiz", ORIGIN)).toBe(false);
  });

  it("opens PDFs in a new tab wherever they are hosted", () => {
    expect(opensInNewTab(`${ORIGIN}/c/rust/assets/paper.PDF`, ORIGIN)).toBe(true);
    expect(opensInNewTab("https://example.com/paper.pdf?page=3", ORIGIN)).toBe(true);
  });

  it("leaves non-web links alone", () => {
    expect(opensInNewTab("mailto:teacher@example.com", ORIGIN)).toBe(false);
    expect(opensInNewTab("javascript:void(0)", ORIGIN)).toBe(false);
  });
});
