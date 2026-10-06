import { describe, expect, it } from "vitest";
import { stageLesson } from "../src/pretest.ts";

describe("pretest staging", () => {
  const html =
    '<p>Diagnostic</p><form data-kind="pretest" data-quiz-id="before"></form><template data-cl-after-pretest="before"><p>Solution</p><script>window.taught = true;</script></template><footer>Ask</footer>';
  it("withholds teaching and scripts from source until grading", () => {
    const staged = stageLesson(html, new Set());
    expect(staged.pendingPretests).toEqual(["before"]);
    expect(staged.html).not.toContain("Solution");
    expect(staged.html).not.toContain("window.taught");
    expect(staged.html).toContain("Diagnostic");
    expect(staged.html).toContain("<footer>Ask</footer>");
    const released = stageLesson(html, new Set(["before"]));
    expect(released.pendingPretests).toEqual([]);
    expect(released.html).toContain("<p>Solution</p><script>window.taught = true;</script>");
    expect(released.html).not.toContain("<template");
  });
  it("does not release a gate for another pretest", () => {
    expect(stageLesson(html, new Set(["other"])).html).not.toContain("Solution");
  });
  it("reads gate and pretest tags with comparison characters in quoted attributes", () => {
    const source = `<form data-title="Predict x > 0" data-kind="pretest" data-quiz-id="before"></form><template title='x < 1' data-cl-after-pretest="before"><p>Solution</p><form title="x > 2" data-quiz-id="after"></form></template>`;
    const staged = stageLesson(source, new Set());
    expect(staged.pendingPretests).toEqual(["before"]);
    expect(staged.lockedQuizIds).toEqual(["after"]);
    expect(staged.html).not.toContain("Solution");
  });
  it("ignores template syntax in comments and scripts", () => {
    const source = '<!-- <template> --><script>const s = "<template>";</script>' + html;
    expect(stageLesson(source, new Set()).pendingPretests).toEqual(["before"]);
  });
  it("preserves ungated lessons and ordinary templates", () => {
    const source = '<template id="example"><template>ordinary</template></template><p>Lesson</p>';
    expect(stageLesson(source, new Set())).toEqual({
      html: source,
      pendingPretests: [],
      lockedQuizIds: [],
    });
  });
  it.each([
    '<template data-cl-after-pretest="before">unclosed',
    '<template data-cl-after-pretest="">empty</template>',
    "<template data-cl-after-pretest=before>unquoted</template>",
    '<template><template data-cl-after-pretest="before">nested</template></template>',
    "</template>",
    '<template data-cl-after-pretest="missing">content</template>',
  ])("rejects malformed gates: %s", (source) => {
    expect(() => stageLesson(source, new Set())).toThrow();
  });
});
