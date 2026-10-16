import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Types come from the hand-written math.d.mts sidecar; the .mjs itself is what the
// browser loads.
import { splitMath } from "../assets/runtime/math.mjs";
import { renderMarkdown } from "../src/markdown.ts";

const vendor = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/runtime/vendor/temml",
);

describe("splitMath", () => {
  it("splits inline and display formulas from the text around them", () => {
    expect(splitMath("Area \\(\\pi r^2\\) and \\[ e^{i\\pi} = -1 \\] done")).toEqual([
      { text: "Area " },
      { tex: "\\pi r^2", display: false },
      { text: " and " },
      { tex: " e^{i\\pi} = -1 ", display: true },
      { text: " done" },
    ]);
  });

  it("leaves text without delimiters whole", () => {
    expect(splitMath("No math (here) [or here] \\alpha.")).toEqual([
      { text: "No math (here) [or here] \\alpha." },
    ]);
  });

  it("reads a delimiter after a backslash as literal", () => {
    expect(splitMath("A line break \\\\(not math)")).toEqual([
      { text: "A line break \\\\(not math)" },
    ]);
  });

  it("reports an opening delimiter with no closing one", () => {
    const parts = splitMath("Before \\(a ");
    expect(parts[0]).toEqual({ text: "Before " });
    expect(parts[1]).toMatchObject({ source: "\\(a " });
    expect((parts[1] as { error: string }).error).toContain("No closing \\)");
  });
});

describe("Markdown math", () => {
  it("renders inline and display formulas as MathML", () => {
    const html = renderMarkdown("Area $\\pi r^2$ and \\(x\\).\n\n$$\n\\frac{a}{b}\n$$\n");
    expect(html).toContain('<span class="cl-math"><math>');
    expect(html).toContain('<span class="cl-math cl-math-display"><math display="block"');
    expect(html).toContain("<mfrac>");
  });

  it("leaves dollar amounts and code alone", () => {
    const html = renderMarkdown("It costs $5 and $10. Run `echo $x$`.");
    expect(html).not.toContain("<math");
    expect(html).toContain("<code>echo $x$</code>");
  });

  it("shows the parse error and the source of TeX that does not parse", () => {
    const html = renderMarkdown("Bad: $\\frac{a$.");
    expect(html).toContain("Math did not render");
    expect(html).toContain("<code>\\frac{a</code>");
    expect(html).not.toContain("<math");
  });

  it("escapes HTML in a formula", () => {
    const html = renderMarkdown("$a <b> c$");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;");
  });
});

describe("vendored Temml", () => {
  it("ships the module with its types, stylesheet, font, license, and version", () => {
    const version = fs.readFileSync(path.join(vendor, "VERSION"), "utf8").trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.readFileSync(path.join(vendor, "LICENSE"), "utf8")).toContain("MIT License");
    for (const file of ["temml.mjs", "temml.d.mts", "Temml-Local.css", "Temml.woff2"]) {
      expect(fs.existsSync(path.join(vendor, file))).toBe(true);
    }
  });
});
