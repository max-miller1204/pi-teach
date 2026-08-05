import { describe, it, expect } from "vitest";

// Types come from the hand-written anchor.d.mts sidecar; the .mjs itself is what the
// browser loads, so this is the same module the runtime uses.
import { createSelector, findSelector, normalizeText } from "../assets/runtime/anchor.mjs";

const TEXT =
  "Ownership is Rust's central idea. A value has one owner. When the owner goes out of scope, the value is dropped. Ownership can be moved, but never shared.";

describe("createSelector", () => {
  it("captures the quoted text with context on both sides", () => {
    const start = TEXT.indexOf("one owner");
    const selector = createSelector(TEXT, start, start + "one owner".length);

    expect(selector.exact).toBe("one owner");
    expect(TEXT.slice(0, start).endsWith(selector.prefix)).toBe(true);
    expect(TEXT.slice(start + selector.exact.length).startsWith(selector.suffix)).toBe(true);
    expect(selector.occurrence).toBe(0);
  });

  it("numbers repeated phrases by occurrence", () => {
    const text = "alpha beta alpha beta alpha";
    const third = text.lastIndexOf("alpha");
    expect(createSelector(text, third, third + 5).occurrence).toBe(2);
  });
});

describe("findSelector", () => {
  it("round-trips an unmodified document", () => {
    const start = TEXT.indexOf("goes out of scope");
    const selector = createSelector(TEXT, start, start + "goes out of scope".length);

    const match = findSelector(TEXT, selector);
    expect(match).not.toBeNull();
    expect(match!.start).toBe(start);
    expect(TEXT.slice(match!.start, match!.end)).toBe("goes out of scope");
    expect(match!.exact).toBe(true);
  });

  it("picks the right repeat using surrounding context", () => {
    const text = "Push the value. Drop the value. Move the value.";
    const second = text.indexOf("the value", text.indexOf("Drop"));
    const selector = createSelector(text, second, second + "the value".length);

    const match = findSelector(text, selector);
    expect(match!.start).toBe(second);
  });

  it("still resolves when the surrounding prose has been rewritten", () => {
    const start = TEXT.indexOf("the value is dropped");
    const selector = createSelector(TEXT, start, start + "the value is dropped".length);

    const edited = "Rust has one big idea, and this is it: the value is dropped. That is all.";
    const match = findSelector(edited, selector);

    expect(match).not.toBeNull();
    expect(edited.slice(match!.start, match!.end)).toBe("the value is dropped");
    // Context no longer matches, so the match is reported as inexact.
    expect(match!.exact).toBe(false);
  });

  it("returns null when the quoted text is gone, rather than throwing", () => {
    const start = TEXT.indexOf("one owner");
    const selector = createSelector(TEXT, start, start + "one owner".length);

    expect(findSelector("An entirely different lesson about something else.", selector)).toBeNull();
  });

  it("rejects an empty or malformed selector", () => {
    expect(findSelector(TEXT, { exact: "", prefix: "", suffix: "", occurrence: 0 })).toBeNull();
    expect(findSelector(TEXT, undefined as never)).toBeNull();
  });

  it("falls back to the recorded occurrence when there is no context at all", () => {
    const text = "one two one two one";
    const match = findSelector(text, { exact: "one", prefix: "", suffix: "", occurrence: 2 });
    expect(match!.start).toBe(text.lastIndexOf("one"));
  });
});

describe("normalizeText", () => {
  it("collapses the whitespace the DOM introduces between tags", () => {
    expect(normalizeText("  a\n   multi   line\tselection \n")).toBe("a multi line selection");
  });
});
