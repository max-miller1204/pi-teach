/**
 * pages.ts — the shell pages: landing (all classrooms), classroom (its lessons and
 * documents), and the markdown document view.
 *
 * Pure string builders — they take already-read data and return HTML, so they are
 * testable without a server or a filesystem.
 */

import { escapeHtml, renderMarkdown } from "./markdown.ts";
import type { Classroom, Lesson } from "./store.ts";

// ── Shell ─────────────────────────────────────────────────────────────────────

interface ShellOptions {
  title: string;
  /** Rendered into the sticky header, left of the theme toggle. */
  breadcrumb: string;
  body: string;
  /** Page-level class applied to <body>, for layout variants. */
  bodyClass?: string;
}

/**
 * Wrap page content in the common document shell.
 *
 * The theme bootstrap runs inline in <head> deliberately: reading localStorage after
 * the stylesheet has painted would flash the light theme at dark-mode readers.
 */
export function shell(options: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📚</text></svg>">
<link rel="stylesheet" href="/static/classroom.css">
<script>
(function () {
  try {
    var stored = localStorage.getItem("pi-classroom-theme");
    if (stored === "dark" || stored === "light") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {}
})();
</script>
</head>
<body class="${escapeHtml(options.bodyClass ?? "cl-shell")}">
<header class="cl-header">
  <nav class="cl-breadcrumb">${options.breadcrumb}</nav>
  <button type="button" class="cl-theme-toggle" data-cl-theme-toggle aria-label="Toggle colour theme">
    <span class="cl-theme-icon cl-theme-icon-light" aria-hidden="true">☀</span>
    <span class="cl-theme-icon cl-theme-icon-dark" aria-hidden="true">☾</span>
  </button>
</header>
<main class="cl-main">
${options.body}
</main>
<script type="module" src="/static/shell.js"></script>
</body>
</html>`;
}

// ── Landing page ──────────────────────────────────────────────────────────────

export function landingPage(classrooms: Classroom[]): string {
  const body =
    classrooms.length === 0
      ? emptyState(
          "No classrooms yet",
          "Ask your agent to teach you a topic (<code>/teach &lt;topic&gt;</code> in Pi) and your first classroom will appear here.",
        )
      : `<div class="cl-hero">
  <h1>Classrooms</h1>
  <p class="cl-lede">Pick up where you left off, or start something new with <code>/teach</code>.</p>
</div>
<ul class="cl-grid">
${classrooms.map(classroomCard).join("\n")}
</ul>`;

  return shell({
    title: "Classrooms",
    breadcrumb: `<span class="cl-crumb cl-crumb-current">Classrooms</span>`,
    body,
  });
}

function classroomCard(classroom: Classroom): string {
  const why = missionWhy(classroom.mission);
  return `<li class="cl-card">
  <a class="cl-card-link" href="/c/${encodeURIComponent(classroom.name)}">
    <span class="cl-card-emoji" aria-hidden="true">${escapeHtml(classroom.emoji)}</span>
    <span class="cl-card-body">
      <span class="cl-card-title">${escapeHtml(classroom.title)}</span>
      ${why ? `<span class="cl-card-why">${escapeHtml(why)}</span>` : ""}
      <span class="cl-card-meta">${plural(classroom.lessonCount, "lesson")}</span>
    </span>
  </a>
</li>`;
}

/**
 * Pull the "## Why" paragraph out of MISSION.md for the card subtitle.
 *
 * The mission is the reason the learner cares about the topic, so it is the single
 * most useful line to show on a card — far better than a truncated lesson title.
 */
export function missionWhy(mission: string | null): string | null {
  if (!mission) return null;

  const lines = mission.split("\n");
  const start = lines.findIndex((line) => /^##\s+why\s*$/i.test(line.trim()));
  if (start === -1) return null;

  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }

  const firstParagraph = body
    .join("\n")
    .trim()
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  if (!firstParagraph) return null;
  return firstParagraph.length > 220
    ? firstParagraph.slice(0, 217).trimEnd() + "…"
    : firstParagraph;
}

// ── Classroom page ────────────────────────────────────────────────────────────

export interface ClassroomPageData {
  classroom: Classroom;
  lessons: Lesson[];
  docs: string[];
  learningRecords: string[];
  referenceDocs: string[];
}

export function classroomPage(data: ClassroomPageData): string {
  const { classroom, lessons } = data;

  const lessonList =
    lessons.length === 0
      ? emptyState(
          "No lessons yet",
          "Ask your teacher for the next lesson in your agent session. It will show up here.",
        )
      : `<ol class="cl-lessons">
${lessons.map((lesson, i) => lessonRow(lesson, i)).join("\n")}
</ol>`;

  const body = `<div class="cl-hero">
  <h1><span class="cl-hero-emoji" aria-hidden="true">${escapeHtml(classroom.emoji)}</span>${escapeHtml(classroom.title)}</h1>
  ${classroom.mission ? `<p class="cl-lede">${escapeHtml(missionWhy(classroom.mission) ?? "")}</p>` : ""}
</div>
<section class="cl-section">
  <h2 class="cl-section-title">Lessons</h2>
  ${lessonList}
</section>
${sidePanel(data)}`;

  return shell({
    title: `${classroom.title} — Classrooms`,
    breadcrumb: `<a class="cl-crumb" href="/">Classrooms</a><span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">${escapeHtml(classroom.title)}</span>`,
    body,
  });
}

function lessonRow(lesson: Lesson, index: number): string {
  const href = `/c/${encodeURIComponent(lesson.classroom)}/${encodeURIComponent(lesson.name)}`;
  const badges: string[] = [];
  if (lesson.latestScore !== null) {
    badges.push(
      `<span class="cl-badge cl-badge-score" title="Quiz score">${Math.round(lesson.latestScore)}%</span>`,
    );
  }
  if (lesson.hasUngradedSubmission) {
    badges.push(`<span class="cl-badge cl-badge-pending" title="Awaiting grading">grading…</span>`);
  }
  if (lesson.annotationCount > 0) {
    badges.push(
      `<span class="cl-badge cl-badge-notes" title="Questions you asked">${lesson.annotationCount} Q</span>`,
    );
  }

  return `<li class="cl-lesson">
  <a class="cl-lesson-link" href="${href}">
    <span class="cl-lesson-index">${String(lesson.order ?? index + 1).padStart(2, "0")}</span>
    <span class="cl-lesson-body">
      <span class="cl-lesson-title">${escapeHtml(lesson.title)}</span>
      ${lesson.summary ? `<span class="cl-lesson-summary">${escapeHtml(lesson.summary)}</span>` : ""}
    </span>
    <span class="cl-lesson-badges">${badges.join("")}</span>
  </a>
</li>`;
}

/** How many learning records the classroom page lists before deferring to their page. */
export const RECENT_RECORDS = 5;

function sidePanel(data: ClassroomPageData): string {
  const { classroom, docs, learningRecords, referenceDocs } = data;
  const name = encodeURIComponent(classroom.name);
  const sections: string[] = [];

  if (docs.length > 0) {
    sections.push(
      panel(
        "Workspace",
        docs.map(
          (doc) => `<a href="/doc/${name}/${encodeURIComponent(doc)}">${escapeHtml(doc)}</a>`,
        ),
      ),
    );
  }
  if (referenceDocs.length > 0) {
    sections.push(
      panel(
        "Reference",
        referenceDocs.map(
          (file) =>
            `<a href="/r/${name}/${encodeURIComponent(file)}">${escapeHtml(prettyFileName(file))}</a>`,
        ),
      ),
    );
  }
  if (learningRecords.length > 0) {
    // Records accumulate for as long as the learner keeps going, so the panel shows only
    // the newest few; the full list, with summaries, has a page of its own.
    const recent = learningRecords.slice(-RECENT_RECORDS).reverse();
    sections.push(
      panel("Learning records", [
        ...recent.map(
          (file) =>
            `<a href="/doc/${name}/learning-records/${encodeURIComponent(file)}">${escapeHtml(prettyFileName(file))}</a>`,
        ),
        `<a class="cl-panel-more" href="/doc/${name}/learning-records">All ${plural(learningRecords.length, "record")} →</a>`,
      ]),
    );
  }

  if (sections.length === 0) return "";
  return `<section class="cl-panels">\n${sections.join("\n")}\n</section>`;
}

function panel(title: string, links: string[]): string {
  return `<div class="cl-panel">
  <h2 class="cl-panel-title">${escapeHtml(title)}</h2>
  <ul class="cl-panel-list">
${links.map((link) => `    <li>${link}</li>`).join("\n")}
  </ul>
</div>`;
}

/** `0003-closures-capture-by-value.md` → `Closures capture by value`. */
export function prettyFileName(file: string): string {
  const base = file.replace(/\.(md|html)$/i, "").replace(/^\d+[-_]/, "");
  const words = base.split(/[-_]/).filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ── Learning records page ─────────────────────────────────────────────────────

export interface RecordSummary {
  file: string;
  /** The `NNNN` prefix, when the file has one. */
  number: number | null;
  title: string;
  /** First paragraph of the body, flattened to plain text. */
  summary: string | null;
  superseded: boolean;
}

/**
 * Pull a title and one-paragraph summary out of a learning record.
 *
 * Records are a heading and a few sentences (see LEARNING-RECORD-FORMAT.md), so the
 * first paragraph is the record — the page can show it without opening the file.
 */
export function summarizeRecord(file: string, markdown: string): RecordSummary {
  let body = markdown.replace(/\r\n/g, "\n");
  let superseded = false;
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (frontmatter) {
    superseded = /^status:\s*superseded/im.test(frontmatter[1]);
    body = body.slice(frontmatter[0].length);
  }

  const heading = /^#\s+(.+)$/m.exec(body);
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#") && !/^status:/i.test(block));
  const prefix = /^(\d+)[-_]/.exec(file);

  return {
    file,
    number: prefix ? Number(prefix[1]) : null,
    title: heading ? plainText(heading[1]) : prettyFileName(file),
    summary: paragraph ? truncate(plainText(paragraph), 280) : null,
    superseded,
  };
}

/** Flatten the inline markdown a record is likely to use into readable text. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3).trimEnd() + "…" : text;
}

/** Every learning record, newest first — the newest is where the learner is now. */
export function learningRecordsPage(
  classroom: Classroom,
  records: Array<{ file: string; markdown: string }>,
): string {
  const name = encodeURIComponent(classroom.name);
  const summaries = records.map((r) => summarizeRecord(r.file, r.markdown)).reverse();

  const list =
    summaries.length === 0
      ? emptyState(
          "No learning records yet",
          "Your teacher writes one each time you demonstrate you have really learned something.",
        )
      : `<ol class="cl-lessons cl-records">
${summaries.map((record, i) => recordRow(name, record, summaries.length - i)).join("\n")}
</ol>`;

  return shell({
    title: `Learning records — ${classroom.title}`,
    breadcrumb: `${classroomCrumbs(classroom)}<span class="cl-crumb-sep" aria-hidden="true">/</span><span class="cl-crumb cl-crumb-current">Learning records</span>`,
    body: `<div class="cl-hero">
  <h1>Learning records</h1>
  <p class="cl-lede">What you have actually learned, newest first. ${plural(summaries.length, "record")}.</p>
</div>
${list}`,
  });
}

function recordRow(classroomName: string, record: RecordSummary, fallbackIndex: number): string {
  const href = `/doc/${classroomName}/learning-records/${encodeURIComponent(record.file)}`;
  const badge = record.superseded
    ? `<span class="cl-lesson-badges"><span class="cl-badge" title="Replaced by a later record">superseded</span></span>`
    : "";
  return `<li class="cl-lesson">
  <a class="cl-lesson-link" href="${href}">
    <span class="cl-lesson-index">${String(record.number ?? fallbackIndex).padStart(2, "0")}</span>
    <span class="cl-lesson-body">
      <span class="cl-lesson-title">${escapeHtml(record.title)}</span>
      ${record.summary ? `<span class="cl-lesson-summary">${escapeHtml(record.summary)}</span>` : ""}
    </span>
    ${badge}
  </a>
</li>`;
}

// ── Markdown document page ────────────────────────────────────────────────────

/**
 * A markdown document from the classroom.
 *
 * `parent` adds a crumb between the classroom and the document, for files that live
 * under an index of their own (a learning record, a note).
 */
export function documentPage(
  classroom: Classroom,
  fileName: string,
  markdown: string,
  parent?: { label: string; href: string },
): string {
  const sep = `<span class="cl-crumb-sep" aria-hidden="true">/</span>`;
  const parentCrumb = parent
    ? `${sep}<a class="cl-crumb" href="${escapeHtml(parent.href)}">${escapeHtml(parent.label)}</a>`
    : "";
  return shell({
    title: `${prettyFileName(fileName)} — ${classroom.title}`,
    breadcrumb: `${classroomCrumbs(classroom)}${parentCrumb}${sep}<span class="cl-crumb cl-crumb-current">${escapeHtml(prettyFileName(fileName))}</span>`,
    body: `<article class="cl-doc">\n${renderMarkdown(markdown)}\n</article>`,
  });
}

/** `Classrooms / <classroom>` — the start of every page inside a classroom. */
function classroomCrumbs(classroom: Classroom): string {
  return `<a class="cl-crumb" href="/">Classrooms</a><span class="cl-crumb-sep" aria-hidden="true">/</span><a class="cl-crumb" href="/c/${encodeURIComponent(classroom.name)}">${escapeHtml(classroom.title)}</a>`;
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function emptyState(title: string, html: string): string {
  return `<div class="cl-empty">
  <p class="cl-empty-title">${escapeHtml(title)}</p>
  <p class="cl-empty-body">${html}</p>
</div>`;
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function notFoundPage(message: string): string {
  return shell({
    title: "Not found — Classrooms",
    breadcrumb: `<a class="cl-crumb" href="/">Classrooms</a>`,
    body: emptyState("Not found", escapeHtml(message)),
  });
}
