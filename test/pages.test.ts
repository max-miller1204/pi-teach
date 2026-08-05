import { describe, it, expect } from "vitest";

import { classroomPage, landingPage, missionWhy, prettyFileName } from "../src/pages.js";
import type { Classroom, Lesson } from "../src/store.js";

const classroom: Classroom = {
  name: "rust",
  title: "Rust",
  emoji: "🦀",
  createdAt: 1,
  updatedAt: 2,
  mission:
    "# Mission: Rust\n\n## Why\n\nShip a CLI to my team by October.\n\n## Success looks like\n\n- Ships\n",
  lessonCount: 1,
};

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    name: "001-ownership",
    classroom: "rust",
    title: "Ownership",
    summary: "One owner at a time.",
    htmlPath: "/tmp/lesson.html",
    createdAt: 1,
    updatedAt: 2,
    order: 1,
    annotationCount: 0,
    latestScore: null,
    hasUngradedSubmission: false,
    ...overrides,
  };
}

describe("landingPage", () => {
  it("lists each classroom with a link, and its mission's why", () => {
    const html = landingPage([classroom]);
    expect(html).toContain('href="/c/rust"');
    expect(html).toContain("Rust");
    expect(html).toContain("Ship a CLI to my team by October.");
  });

  it("points a first-time user at /teach when there is nothing yet", () => {
    const html = landingPage([]);
    expect(html).toContain("No classrooms yet");
    expect(html).toContain("/teach");
  });

  it("escapes classroom titles rather than rendering them as markup", () => {
    const html = landingPage([{ ...classroom, title: "<img src=x onerror=alert(1)>" }]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("declares both themes so the page follows the system preference", () => {
    const html = landingPage([classroom]);
    expect(html).toContain("pi-classroom-theme");
    expect(html).toContain("data-cl-theme-toggle");
  });
});

describe("classroomPage", () => {
  const data = {
    classroom,
    lessons: [lesson()],
    docs: ["MISSION.md"],
    learningRecords: ["0001-owns-are-unique.md"],
    referenceDocs: ["syntax.html"],
  };

  it("links lessons, documents, records, and reference material", () => {
    const html = classroomPage(data);
    expect(html).toContain('href="/c/rust/001-ownership"');
    expect(html).toContain('href="/doc/rust/MISSION.md"');
    expect(html).toContain('href="/doc/rust/learning-records/0001-owns-are-unique.md"');
    expect(html).toContain('href="/r/rust/syntax.html"');
    expect(html).toContain('href="/"');
  });

  it("badges a graded lesson with its score and an ungraded one as pending", () => {
    expect(classroomPage({ ...data, lessons: [lesson({ latestScore: 80 })] })).toContain("80%");
    expect(
      classroomPage({ ...data, lessons: [lesson({ hasUngradedSubmission: true })] }),
    ).toContain("grading…");
  });

  it("omits the side panels entirely when there is nothing to put in them", () => {
    const html = classroomPage({ ...data, docs: [], learningRecords: [], referenceDocs: [] });
    expect(html).not.toContain("cl-panels");
  });

  it("says so when a classroom has no lessons yet", () => {
    expect(classroomPage({ ...data, lessons: [] })).toContain("No lessons yet");
  });
});

describe("missionWhy", () => {
  it("extracts the first paragraph of the Why section", () => {
    expect(missionWhy(classroom.mission)).toBe("Ship a CLI to my team by October.");
  });

  it("stops at the next heading", () => {
    expect(missionWhy("## Why\n\nFirst.\n\n## Success\n\nSecond.")).toBe("First.");
  });

  it("returns null when there is no mission or no Why section", () => {
    expect(missionWhy(null)).toBeNull();
    expect(missionWhy("# Mission\n\nNo sections here.")).toBeNull();
    expect(missionWhy("## Why\n\n")).toBeNull();
  });

  it("truncates a long why so it fits a card", () => {
    const why = missionWhy(`## Why\n\n${"word ".repeat(100)}`);
    expect(why!.length).toBeLessThanOrEqual(220);
    expect(why!.endsWith("…")).toBe(true);
  });
});

describe("prettyFileName", () => {
  it("drops the numeric prefix and extension", () => {
    expect(prettyFileName("0003-closures-capture-by-value.md")).toBe("Closures capture by value");
    expect(prettyFileName("syntax.html")).toBe("Syntax");
  });
});
