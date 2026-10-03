import { describe, it, expect } from "vitest";

import {
  RECENT_RECORDS,
  classroomPage,
  documentPage,
  landingPage,
  learningRecordsPage,
  missionWhy,
  prettyFileName,
  summarizeRecord,
} from "../src/pages.js";
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

  it("lists only the newest learning records and links the rest", () => {
    const records = Array.from(
      { length: 12 },
      (_, i) => `${String(i + 1).padStart(4, "0")}-record.md`,
    );
    const html = classroomPage({ ...data, learningRecords: records });
    expect(html).toContain('href="/doc/rust/learning-records/0012-record.md"');
    expect(html).toContain(
      `href="/doc/rust/learning-records/${String(12 - RECENT_RECORDS + 1).padStart(4, "0")}-record.md"`,
    );
    expect(html).not.toContain('href="/doc/rust/learning-records/0001-record.md"');
    expect(html).toContain('href="/doc/rust/learning-records">All 12 records');
  });
});

describe("summarizeRecord", () => {
  it("takes the heading as the title and the first paragraph as the summary", () => {
    const record = summarizeRecord(
      "0003-closures.md",
      "# Closures capture by **reference**\n\nThey reasoned through `move` unprompted, see [the book](https://x).\n\n## Evidence\n\nQuiz 3.",
    );
    expect(record).toEqual({
      file: "0003-closures.md",
      number: 3,
      title: "Closures capture by reference",
      summary: "They reasoned through move unprompted, see the book.",
      superseded: false,
    });
  });

  it("reads superseded status from frontmatter", () => {
    const record = summarizeRecord(
      "0001-owns.md",
      "---\nstatus: superseded by LR-0004\n---\n# Owns\n\nOld view.",
    );
    expect(record.superseded).toBe(true);
    expect(record.title).toBe("Owns");
    expect(record.summary).toBe("Old view.");
  });

  it("falls back to the file name when there is no heading", () => {
    expect(summarizeRecord("0002-moves-are-cheap.md", "").title).toBe("Moves are cheap");
  });
});

describe("learningRecordsPage", () => {
  it("lists every record newest first, with its summary", () => {
    const html = learningRecordsPage(classroom, [
      { file: "0001-first.md", markdown: "# First\n\nThe floor." },
      { file: "0002-second.md", markdown: "# Second\n\nThe <b>next</b> step." },
    ]);
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("First"));
    expect(html).toContain('href="/doc/rust/learning-records/0001-first.md"');
    expect(html).toContain("The &lt;b&gt;next&lt;/b&gt; step.");
    expect(html).toContain('href="/c/rust"');
  });

  it("says so when there are none", () => {
    expect(learningRecordsPage(classroom, [])).toContain("No learning records yet");
  });
});

describe("documentPage", () => {
  it("adds a parent crumb for documents under an index", () => {
    const html = documentPage(classroom, "0001-owns.md", "# Owns", {
      label: "Learning records",
      href: "/doc/rust/learning-records",
    });
    expect(html).toContain('<a class="cl-crumb" href="/doc/rust/learning-records">');
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
