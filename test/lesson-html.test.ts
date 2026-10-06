import { describe, it, expect } from "vitest";

import { injectLessonRuntime, type LessonRuntimeConfig } from "../src/lesson-html.ts";

const config: LessonRuntimeConfig = {
  classroom: "rust",
  lesson: "001-ownership",
  classroomTitle: "Rust",
  lessonTitle: "Ownership",
  baseUrl: "http://127.0.0.1:4098",
};

describe("injectLessonRuntime", () => {
  it("replaces copied config so gate state cannot cause stale or repeated reloads", () => {
    const copied = injectLessonRuntime("<html><head></head><body></body></html>", {
      ...config,
      pendingPretests: ["old"],
    });
    const refreshed = injectLessonRuntime(copied, { ...config, pendingPretests: [] });
    expect(refreshed).not.toContain('"old"');
    expect(refreshed).toContain('"pendingPretests":[]');
    expect(refreshed.match(/id="cl-config"/g)).toHaveLength(1);
    expect(refreshed.match(/src="\/static\/classroom.js"/g)).toHaveLength(1);
  });
  it("adds the stylesheet in <head> and the runtime before </body>", () => {
    const html =
      "<!doctype html><html><head><title>Ownership</title></head><body><p>Hi</p></body></html>";
    const out = injectLessonRuntime(html, config);

    expect(out).toContain('<link rel="stylesheet" href="/static/classroom.css">');
    expect(out).toContain('<script type="module" src="/static/classroom.js"></script>');
    expect(out.indexOf("classroom.css")).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf("classroom.js")).toBeLessThan(out.indexOf("</body>"));
    // The lesson's own content is untouched.
    expect(out).toContain("<p>Hi</p>");
  });

  it("embeds the runtime config as parseable JSON", () => {
    const out = injectLessonRuntime("<html><head></head><body></body></html>", config);
    const match = /<script type="application\/json" id="cl-config">([\s\S]*?)<\/script>/.exec(out);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual(config);
  });

  it("escapes a title that would otherwise close the script tag early", () => {
    const out = injectLessonRuntime("<html><head></head><body></body></html>", {
      ...config,
      lessonTitle: "</script><script>alert(1)</script>",
    });

    // Exactly one script open tag for the config block, and no injected one.
    expect(out).not.toContain("<script>alert(1)</script>");
    const match = /<script type="application\/json" id="cl-config">([\s\S]*?)<\/script>/.exec(out);
    expect(JSON.parse(match![1]).lessonTitle).toBe("</script><script>alert(1)</script>");
  });

  it("handles a document with no </body>", () => {
    const out = injectLessonRuntime("<html><head></head><p>fragment</p>", config);
    expect(out).toContain("classroom.js");
    expect(out).toContain("<p>fragment</p>");
  });

  it("handles a bare fragment with no <head> or <body>", () => {
    const out = injectLessonRuntime("<h1>Just a heading</h1>", config);
    expect(out).toContain("classroom.css");
    expect(out).toContain("classroom.js");
    expect(out).toContain("<h1>Just a heading</h1>");
  });

  it("is idempotent, so a re-served page is not double-wired", () => {
    const once = injectLessonRuntime("<html><head></head><body></body></html>", config);
    const twice = injectLessonRuntime(once, config);
    expect(twice).toBe(once);
  });
  it("keeps replacement tokens literal when refreshing copied config", () => {
    const once = injectLessonRuntime("<html><head></head><body></body></html>", config);
    const updated = { ...config, lessonTitle: "JS $& $` $'", pendingPretests: ["before"] };
    const twice = injectLessonRuntime(once, updated);
    const match = /<script type="application\/json" id="cl-config">([\s\S]*?)<\/script>/.exec(
      twice,
    );
    expect(JSON.parse(match![1])).toEqual(updated);
    expect(twice.match(/id="cl-config"/g)).toHaveLength(1);
  });
});
