/**
 * classroom.js — the lesson runtime, injected into every lesson at serve time.
 *
 * Two features live here:
 *
 *   1. Highlight to ask. Select text, hit "Ask", type a question. It goes to the
 *      teacher running in your agent session; the answer streams back into a card
 *      pinned to the highlight. A card is a thread: the box at the bottom asks a
 *      follow-up, which the teacher answers with the earlier turns in view. Cards
 *      minimise to a numbered badge and reopen on click. Everything is persisted
 *      server-side, so it survives a reload.
 *
 *   2. Quizzes. Any `form.cl-quiz` in the lesson is checked against the contract in
 *      assets/templates/quiz.html and hydrated: each `data-type` gets its controls,
 *      submitting posts the answers to disk and
 *      asks the teacher to grade them, and the grade renders inline when it arrives.
 *      A graded quiz stays locked. Saved attempts and grades are kept.
 *
 *   3. Self-explanations. A `form.cl-reflect` is saved and shown to the teacher, but
 *      never graded.
 *
 *   4. Glossary terms. The first use of each GLOSSARY.md term in each section is
 *      marked. A click asks the learner to recall the meaning, then shows it.
 *
 * No bundler, no dependencies. Answer and feedback markdown is rendered to HTML
 * server-side, so nothing here needs a markdown parser.
 */

import { gradePointsNotice, gradeSummary, questionGradeLabel, questionOutcome } from "./grade.mjs";
import { createSelector, findSelector, normalizeText } from "./anchor.mjs";
import { findTerms, firstUses } from "./glossary.mjs";
import { initLinks } from "./links.mjs";
import { QUIZ_KINDS, isContractId, isQuizKind, parseNumber, questionErrors } from "./quiz.mjs";
import { initTheme } from "./theme.mjs";

const config = readConfig();

function readConfig() {
  const node = document.getElementById("cl-config");
  if (!node) return null;
  try {
    return JSON.parse(node.textContent);
  } catch (err) {
    console.warn("[classroom] bad runtime config", err);
    return null;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

/** annotationId → { annotation, mark, badge, panel } */
const cards = new Map();
let contentRoot = null;
let askPill = null;
let composer = null;
/** Range captured when the ask pill was shown, before focus moves to the composer. */
let pendingRange = null;

const MINIMISED_KEY = `pi-classroom-minimised:${location.pathname}`;

function loadMinimised() {
  try {
    return new Set(JSON.parse(localStorage.getItem(MINIMISED_KEY) || "[]"));
  } catch (err) {
    return new Set();
  }
}

function saveMinimised(set) {
  try {
    localStorage.setItem(MINIMISED_KEY, JSON.stringify([...set]));
  } catch (err) {
    /* ignore */
  }
}

let minimised = loadMinimised();

// ── Boot ──────────────────────────────────────────────────────────────────────

function init() {
  contentRoot = resolveContentRoot();
  document.body.classList.add("cl-lesson-page");

  buildHeader();
  // After buildHeader: the toggle it wires up is the button the header just created.
  initTheme();
  initLinks();

  buildAskPill();
  buildComposer();
  hydrateQuizzes();
  hydrateReflections();
  // The glossary waits for the saved highlights: they anchor to the lesson text, and
  // must be restored before terms are wrapped.
  loadState().then(() =>
    initGlossary().catch((err) => console.error("[classroom] glossary failed", err)),
  );
  connectEvents();

  document.addEventListener("mouseup", onSelectionSettled);
  document.addEventListener("keyup", (event) => {
    if (event.key === "Shift" || event.key.startsWith("Arrow")) onSelectionSettled();
  });
  document.addEventListener("mousedown", (event) => {
    if (askPill && !askPill.contains(event.target)) hideAskPill();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeComposer();
  });
}

/**
 * Give the lesson the same header the rest of the site has.
 *
 * A lesson on disk is a bare document with no navigation, so the way back to the
 * classroom and the theme toggle are added here rather than being something every
 * lesson has to remember to include.
 */
function buildHeader() {
  if (document.querySelector(".cl-header")) return;

  const header = document.createElement("header");
  header.className = "cl-header";
  header.innerHTML = `
    <nav class="cl-breadcrumb">
      <a class="cl-crumb" href="/">Classrooms</a>
      <span class="cl-crumb-sep" aria-hidden="true">/</span>
      <a class="cl-crumb" href="/c/${encodeURIComponent(config.classroom)}"></a>
      <span class="cl-crumb-sep" aria-hidden="true">/</span>
      <span class="cl-crumb cl-crumb-current"></span>
    </nav>
    <button type="button" class="cl-theme-toggle" data-cl-theme-toggle aria-label="Toggle colour theme">
      <span class="cl-theme-icon cl-theme-icon-light" aria-hidden="true">☀</span>
      <span class="cl-theme-icon cl-theme-icon-dark" aria-hidden="true">☾</span>
    </button>`;

  // textContent, not innerHTML: these titles come from files on disk.
  header.querySelectorAll(".cl-crumb")[1].textContent = config.classroomTitle;
  header.querySelector(".cl-crumb-current").textContent = config.lessonTitle;
  document.body.prepend(header);
}

/**
 * The element whose text can be highlighted.
 *
 * Lessons are model-authored, so we cannot rely on a particular wrapper existing.
 * Prefer an explicit opt-in, then the usual semantic containers, then <body>.
 */
function resolveContentRoot() {
  return (
    document.querySelector("[data-cl-content]") ||
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.body
  );
}

// ── Plain-text index over the DOM ─────────────────────────────────────────────

/**
 * Flatten the content root to plain text, remembering which text node each
 * character came from.
 *
 * Whitespace is collapsed to match `normalizeText`, so an anchor recorded against a
 * reflowed document still resolves. Script/style text and existing card UI are
 * skipped — otherwise a highlight could "match" inside our own markup.
 */
function buildTextIndex(root) {
  const segments = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // The header and card UI are ours, not the lesson's — a highlight must never
      // anchor into them (and a lesson with no <main> makes contentRoot the body).
      if (
        parent.closest(
          "script, style, noscript, .cl-header, .cl-card-panel, .cl-ask-pill, .cl-badge-marker, .cl-term-pop, .cl-contract-error",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && node.nodeValue.trim().length > 0
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const raw = node.nodeValue;
    // Collapse whitespace while keeping a map back to offsets in the original node.
    let collapsed = "";
    const offsets = [];
    let lastWasSpace = text.length === 0 || /\s$/.test(text);
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\s/.test(ch)) {
        if (lastWasSpace) continue;
        collapsed += " ";
        offsets.push(i);
        lastWasSpace = true;
      } else {
        collapsed += ch;
        offsets.push(i);
        lastWasSpace = false;
      }
    }
    if (collapsed.length > 0) {
      segments.push({ node, start: text.length, length: collapsed.length, offsets });
      text += collapsed;
    }
    node = walker.nextNode();
  }

  return { text, segments };
}

/** Map a plain-text offset back to a { node, offset } DOM position. */
function locate(index, offset) {
  for (const segment of index.segments) {
    if (offset >= segment.start && offset < segment.start + segment.length) {
      return { node: segment.node, offset: segment.offsets[offset - segment.start] };
    }
  }
  const last = index.segments[index.segments.length - 1];
  if (!last) return null;
  return { node: last.node, offset: last.node.nodeValue.length };
}

/** Convert a plain-text span to a DOM Range. */
function rangeFromOffsets(index, start, end) {
  const from = locate(index, start);
  const to = locate(index, Math.max(start, end - 1));
  if (!from || !to) return null;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, Math.min(to.offset + 1, to.node.nodeValue.length));
  } catch (err) {
    return null;
  }
  return range;
}

/** Plain-text offsets for a live selection Range, or null if it is outside content. */
function offsetsFromRange(index, range) {
  const startInfo = offsetOf(index, range.startContainer, range.startOffset);
  const endInfo = offsetOf(index, range.endContainer, range.endOffset);
  if (startInfo === null || endInfo === null || endInfo <= startInfo) return null;
  return { start: startInfo, end: endInfo };
}

function offsetOf(index, node, offset) {
  for (const segment of index.segments) {
    if (segment.node !== node) continue;
    // Find the collapsed position at or after the raw offset.
    for (let i = 0; i < segment.offsets.length; i++) {
      if (segment.offsets[i] >= offset) return segment.start + i;
    }
    return segment.start + segment.length;
  }
  return null;
}

// ── Ask pill ──────────────────────────────────────────────────────────────────

function buildAskPill() {
  askPill = document.createElement("button");
  askPill.type = "button";
  askPill.className = "cl-ask-pill";
  askPill.hidden = true;
  askPill.innerHTML = '<span aria-hidden="true">✳</span> Ask';
  askPill.addEventListener("click", () => openComposer());
  document.body.appendChild(askPill);
}

function hideAskPill() {
  if (askPill) askPill.hidden = true;
}

function onSelectionSettled() {
  // Deferred so the browser has finished updating the selection after mouseup.
  setTimeout(() => {
    if (composer && !composer.hidden) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hideAskPill();

    const range = selection.getRangeAt(0);
    if (!contentRoot.contains(range.commonAncestorContainer)) return hideAskPill();
    if (
      range.commonAncestorContainer.parentElement?.closest(
        "form.cl-quiz, form.cl-reflect, .cl-card-panel, .cl-term-pop",
      )
    ) {
      return hideAskPill();
    }
    if (normalizeText(range.toString()).length < 2) return hideAskPill();

    pendingRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    askPill.hidden = false;
    position(
      askPill,
      rect.left + rect.width / 2 - askPill.offsetWidth / 2,
      rect.top - askPill.offsetHeight - 8,
    );
  }, 0);
}

/** Place an absolutely-positioned element at viewport coords, clamped on-screen. */
function position(element, viewportLeft, viewportTop) {
  const left = Math.max(8, Math.min(viewportLeft, window.innerWidth - element.offsetWidth - 8));
  element.style.left = `${left + window.scrollX}px`;
  element.style.top = `${Math.max(8, viewportTop) + window.scrollY}px`;
}

/**
 * Insert a card into the document flow, just after the block the highlight sits in.
 *
 * Transient UI (the ask pill, the composer) floats over the page; a card does not.
 * A floating card covers the very passage the learner is asking about, which is the
 * one thing it must not do, and lessons are set to a reading measure so there is
 * rarely margin wide enough to escape into. In the flow it never occludes anything,
 * needs no repositioning on scroll or resize, and works the same at every width.
 */
function placeCardInFlow(panel, mark) {
  const anchor = blockAncestor(mark) ?? mark;
  if (anchor.parentNode) anchor.after(panel);
  else contentRoot.appendChild(panel);
}

/** Nearest block-level ancestor within the content root, for flow insertion. */
function blockAncestor(node) {
  let el = node instanceof Element ? node : node.parentElement;
  while (el && el !== contentRoot) {
    if (getComputedStyle(el).display !== "inline") return el;
    el = el.parentElement;
  }
  return null;
}

// ── Composer ──────────────────────────────────────────────────────────────────

function buildComposer() {
  composer = document.createElement("div");
  composer.className = "cl-card-panel";
  composer.hidden = true;
  composer.innerHTML = `
    <div class="cl-card-head">
      <p class="cl-card-quote" data-cl-quote></p>
      <div class="cl-card-actions">
        <button type="button" class="cl-icon-button" data-cl-cancel aria-label="Cancel">✕</button>
      </div>
    </div>
    <div class="cl-card-content">
      <form class="cl-card-form" data-cl-ask-form>
        <textarea placeholder="What would you like to know about this?" data-cl-question required></textarea>
        <div class="cl-card-form-actions">
          <span class="cl-hint">⌘/Ctrl + Enter to send</span>
          <button type="submit" class="cl-button">Ask your teacher</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(composer);

  composer.querySelector("[data-cl-cancel]").addEventListener("click", closeComposer);
  composer.querySelector("[data-cl-ask-form]").addEventListener("submit", onAskSubmit);
  composer.querySelector("[data-cl-question]").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      composer.querySelector("[data-cl-ask-form]").requestSubmit();
    }
  });
}

function openComposer() {
  if (!pendingRange) return;
  hideAskPill();
  const rect = pendingRange.getBoundingClientRect();
  composer.querySelector("[data-cl-quote]").textContent = normalizeText(pendingRange.toString());
  composer.querySelector("[data-cl-question]").value = "";
  composer.hidden = false;
  position(composer, rect.left, rect.bottom + 10);
  composer.querySelector("[data-cl-question]").focus();
}

function closeComposer() {
  if (composer) composer.hidden = true;
  pendingRange = null;
}

async function onAskSubmit(event) {
  event.preventDefault();
  const question = composer.querySelector("[data-cl-question]").value.trim();
  if (!question || !pendingRange) return;

  const index = buildTextIndex(contentRoot);
  const offsets = offsetsFromRange(index, pendingRange);
  if (!offsets) {
    closeComposer();
    return;
  }
  const selector = createSelector(index.text, offsets.start, offsets.end);
  const range = pendingRange.cloneRange();
  closeComposer();

  const submit = composer.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: config.classroom,
        lesson: config.lesson,
        question,
        selection: selector.exact,
        anchor: selector,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const annotation = await response.json();
    const mark = wrapRange(range, annotation.id);
    renderCard(annotation, mark);
  } catch (err) {
    console.error("[classroom] ask failed", err);
    alert("Could not reach your teacher. Is the session that started the classroom still running?");
  } finally {
    submit.disabled = false;
  }
}

// ── Highlights ────────────────────────────────────────────────────────────────

/**
 * Wrap a range in a <mark>, splitting across element boundaries when needed.
 *
 * `surroundContents` throws on a range that crosses tags (a selection spanning a
 * bold word, say), so partially-selected text nodes are wrapped one at a time.
 */
function wrapRange(range, annotationId) {
  const marks = [];
  const nodes = textNodesInRange(range);

  for (const { node, start, end } of nodes) {
    let target = node;
    if (end < target.nodeValue.length) target.splitText(end);
    if (start > 0) target = target.splitText(start);

    const mark = document.createElement("mark");
    mark.className = "cl-hl cl-hl-pending";
    mark.dataset.annotationId = annotationId;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }

  for (const mark of marks) {
    mark.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCard(annotationId);
    });
  }
  // `marks` is in reverse document order (see textNodesInRange); the caller wants the
  // first one, since that is where the minimised badge goes.
  return marks[marks.length - 1] ?? null;
}

/** Text nodes intersecting a range, with the covered slice of each. */
function textNodesInRange(range) {
  const out = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
    null,
  );

  let node = walker.nextNode();
  while (node) {
    if (range.intersectsNode(node) && node.nodeValue.length > 0) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (end > start) out.push({ node, start, end });
    }
    node = walker.nextNode();
  }
  // Reverse so splitText on a later node cannot invalidate an earlier offset.
  return out.reverse();
}

/** Re-apply a stored annotation to the current document. */
function restoreAnnotation(annotation) {
  const index = buildTextIndex(contentRoot);
  const match = findSelector(index.text, annotation.anchor);
  if (!match) return null;
  const range = rangeFromOffsets(index, match.start, match.end);
  if (!range) return null;
  return wrapRange(range, annotation.id);
}

// ── Cards ─────────────────────────────────────────────────────────────────────

function renderCard(annotation, mark) {
  const existing = cards.get(annotation.id);
  const marks = document.querySelectorAll(`mark[data-annotation-id="${annotation.id}"]`);
  const anchorMark = mark ?? marks[0] ?? null;
  const panel = existing?.panel ?? createPanel(annotation.id, anchorMark);
  const badge = existing?.badge ?? createBadge(annotation.id, anchorMark);

  const turns = threadTurns(annotation);
  const pending = turns.some((turn) => turn.status === "pending");
  for (const m of marks) m.classList.toggle("cl-hl-pending", pending);

  panel.querySelector("[data-cl-quote]").textContent = annotation.selection;
  renderThread(panel.querySelector("[data-cl-thread]"), turns);

  // Following up needs something to follow up on, and the server refuses a follow-up on
  // a card whose first question is still spinning.
  const form = panel.querySelector("[data-cl-followup-form]");
  form.hidden = annotation.status === "pending";

  cards.set(annotation.id, { annotation, panel, badge, mark: anchorMark });

  // A freshly asked question opens; a restored one respects the saved state.
  if (minimised.has(annotation.id)) minimiseCard(annotation.id);
  else openCard(annotation.id);
}

function createPanel(annotationId, mark) {
  const panel = document.createElement("div");
  panel.className = "cl-card-panel cl-card-inline";
  panel.dataset.annotationId = annotationId;
  panel.hidden = true;
  panel.innerHTML = `
    <div class="cl-card-head">
      <p class="cl-card-quote" data-cl-quote></p>
      <div class="cl-card-actions">
        <button type="button" class="cl-icon-button" data-cl-minimise aria-label="Minimise">–</button>
        <button type="button" class="cl-text-button cl-text-button-danger" data-cl-delete>Delete</button>
      </div>
    </div>
    <div class="cl-card-content">
      <div class="cl-card-thread" data-cl-thread></div>
    </div>
    <!-- Outside cl-card-content on purpose: the thread scrolls, the composer stays put. -->
    <form class="cl-card-form cl-card-followup" data-cl-followup-form hidden>
      <textarea rows="2" placeholder="Ask a follow-up…" data-cl-followup required></textarea>
      <div class="cl-card-form-actions">
        <span class="cl-hint">⌘/Ctrl + Enter to send</span>
        <button type="submit" class="cl-button">Ask</button>
      </div>
    </form>`;

  if (mark) placeCardInFlow(panel, mark);
  else contentRoot.appendChild(panel); // orphaned annotation — park it at the end

  panel
    .querySelector("[data-cl-minimise]")
    .addEventListener("click", () => minimiseCard(annotationId));
  panel
    .querySelector("[data-cl-delete]")
    .addEventListener("click", () => confirmDeleteCard(annotationId));

  const form = panel.querySelector("[data-cl-followup-form]");
  form.addEventListener("submit", (event) => onFollowUpSubmit(event, annotationId));
  form.querySelector("[data-cl-followup]").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  return panel;
}

/** A card is a thread: the original question, then each follow-up, oldest first. */
function threadTurns(annotation) {
  return [
    {
      question: annotation.question,
      status: annotation.status,
      answerHtml: annotation.answerHtml,
    },
    ...(annotation.followUps ?? []).map((followUp) => ({
      question: followUp.question,
      status: followUp.status,
      answerHtml: followUp.answerHtml,
      followUp: true,
    })),
  ];
}

function renderThread(container, turns) {
  container.textContent = "";
  for (const turn of turns) container.appendChild(renderTurn(turn));
}

function renderTurn(turn) {
  const wrapper = document.createElement("div");
  wrapper.className = turn.followUp ? "cl-card-turn cl-card-turn-followup" : "cl-card-turn";

  const question = document.createElement("p");
  question.className = "cl-card-question";
  question.textContent = turn.question; // textContent: this is the learner's own text

  const answer = document.createElement("div");
  answer.className = "cl-card-answer";
  // innerHTML is safe here: the markdown was rendered to HTML server-side.
  if (turn.status === "answered" && turn.answerHtml) {
    answer.innerHTML = turn.answerHtml;
  } else if (turn.status === "failed") {
    answer.innerHTML = '<p class="cl-card-status">Your teacher could not answer this one.</p>';
  } else {
    answer.innerHTML =
      '<p class="cl-card-status"><span class="cl-spinner"></span> Asking your teacher…</p>';
  }

  wrapper.append(question, answer);
  return wrapper;
}

/** Ask a follow-up in an existing card, continuing the same thread. */
async function onFollowUpSubmit(event, annotationId) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = form.querySelector("[data-cl-followup]");
  const submit = form.querySelector('button[type="submit"]');
  const question = field.value.trim();
  if (!question) return;

  submit.disabled = true;
  try {
    const response = await fetch(`/api/annotations/${encodeURIComponent(annotationId)}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: config.classroom,
        lesson: config.lesson,
        question,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    const annotation = await response.json();
    field.value = "";
    renderCard(annotation, cards.get(annotationId)?.mark ?? null);
  } catch (err) {
    console.error("[classroom] follow-up failed", err);
    alert("Could not reach your teacher. Is the session that started the classroom still running?");
  } finally {
    submit.disabled = false;
  }
}

/** The small marker left in the text when a card is minimised. */
function createBadge(annotationId, mark) {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "cl-badge-marker";
  badge.dataset.annotationId = annotationId;
  badge.hidden = true;
  badge.textContent = "?";
  badge.setAttribute("aria-label", "Reopen your question");
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    openCard(annotationId);
  });

  const anchorMark = mark ?? document.querySelector(`mark[data-annotation-id="${annotationId}"]`);
  if (anchorMark?.parentNode) anchorMark.parentNode.insertBefore(badge, anchorMark.nextSibling);
  else document.body.appendChild(badge);
  return badge;
}

function openCard(annotationId) {
  const card = cards.get(annotationId);
  if (!card) return;
  card.panel.hidden = false;
  card.badge.hidden = true;
  minimised.delete(annotationId);
  saveMinimised(minimised);
  for (const m of document.querySelectorAll(`mark[data-annotation-id="${annotationId}"]`)) {
    m.classList.add("cl-hl-active");
  }
}

function minimiseCard(annotationId) {
  const card = cards.get(annotationId);
  if (!card) return;
  card.panel.hidden = true;
  card.badge.hidden = false;
  minimised.add(annotationId);
  saveMinimised(minimised);
  for (const m of document.querySelectorAll(`mark[data-annotation-id="${annotationId}"]`)) {
    m.classList.remove("cl-hl-active");
  }
}

function toggleCard(annotationId) {
  const card = cards.get(annotationId);
  if (!card) return;
  if (card.panel.hidden) openCard(annotationId);
  else minimiseCard(annotationId);
}

/**
 * Deleting a question is permanent, so it always goes through a modal confirmation —
 * a stray click on the card head must never destroy an answer.
 */
async function confirmDeleteCard(annotationId) {
  const card = cards.get(annotationId);
  if (!card) return;
  const confirmed = await askConfirm({
    title: "Delete this question?",
    body: "The question and your teacher's answer will be removed from this lesson for good.",
    confirmLabel: "Delete question",
  });
  if (confirmed) await deleteCard(annotationId);
}

/** Promise-based modal confirm; resolves false on cancel, Escape, or backdrop click. */
function askConfirm({ title, body, confirmLabel, cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "cl-confirm";
    dialog.innerHTML = `
      <h2 class="cl-confirm-title"></h2>
      <p class="cl-confirm-body"></p>
      <div class="cl-confirm-actions">
        <button type="button" class="cl-button cl-button-quiet" data-cl-cancel></button>
        <button type="button" class="cl-button cl-button-danger" data-cl-confirm></button>
      </div>`;
    dialog.querySelector(".cl-confirm-title").textContent = title;
    dialog.querySelector(".cl-confirm-body").textContent = body;
    const cancelButton = dialog.querySelector("[data-cl-cancel]");
    const confirmButton = dialog.querySelector("[data-cl-confirm]");
    cancelButton.textContent = cancelLabel;
    confirmButton.textContent = confirmLabel;

    let answered = false;
    const settle = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
      dialog.close();
    };

    cancelButton.addEventListener("click", () => settle(false));
    confirmButton.addEventListener("click", () => settle(true));
    // Escape fires `cancel`; a click on the backdrop lands on the dialog element itself.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      settle(false);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) settle(false);
    });
    dialog.addEventListener("close", () => {
      settle(false);
      dialog.remove();
    });

    document.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", ""); // very old browsers: still usable, just not modal
    cancelButton.focus();
  });
}

async function deleteCard(annotationId) {
  const card = cards.get(annotationId);
  if (!card) return;

  card.panel.remove();
  card.badge.remove();
  cards.delete(annotationId);
  minimised.delete(annotationId);
  saveMinimised(minimised);

  // Unwrap the highlight, leaving the lesson text as it was.
  for (const mark of document.querySelectorAll(`mark[data-annotation-id="${annotationId}"]`)) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
    parent.normalize();
  }

  try {
    await fetch(
      `/api/annotations/${encodeURIComponent(annotationId)}?classroom=${encodeURIComponent(config.classroom)}&lesson=${encodeURIComponent(config.lesson)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    console.warn("[classroom] delete failed", err);
  }
}

// ── Server state ──────────────────────────────────────────────────────────────

async function loadState() {
  try {
    const url = `/api/state?classroom=${encodeURIComponent(config.classroom)}&lesson=${encodeURIComponent(config.lesson)}`;
    const state = await (await fetch(url)).json();

    for (const annotation of state.annotations ?? []) {
      const existing = cards.get(annotation.id);
      const mark = existing ? existing.mark : restoreAnnotation(annotation);
      // An orphaned annotation (the lesson text changed under it) still gets a card,
      // parked at the end of the lesson rather than silently discarded.
      renderCard(annotation, mark);
      if (!mark) minimiseCard(annotation.id);
    }

    for (const quiz of state.quizzes) applyQuizState(quiz);
    for (const reflection of state.reflections) applyReflection(reflection);
    if (state.teacher) renderTeacher(state.teacher);
  } catch (err) {
    console.warn("[classroom] could not load lesson state", err);
  }
}

function connectEvents() {
  const url = `/api/events?classroom=${encodeURIComponent(config.classroom)}&lesson=${encodeURIComponent(config.lesson)}`;
  const source = new EventSource(url);

  source.addEventListener("answer", (event) => {
    const annotation = JSON.parse(event.data);
    const existing = cards.get(annotation.id);
    renderCard(annotation, existing?.mark ?? null);
    // An answer that arrives while minimised should not steal the reader's place.
    if (minimised.has(annotation.id)) minimiseCard(annotation.id);
  });

  source.addEventListener("grade", (event) => {
    const payload = JSON.parse(event.data);
    applyQuizState({
      submission: payload.submission,
      grade: payload.grade,
      attempts: payload.submission.attempt ?? 1,
    });
  });

  source.addEventListener("teacher", (event) => renderTeacher(JSON.parse(event.data)));
  source.addEventListener("open", () => {
    if (config.delivery === "service") loadState();
  });
  source.addEventListener("reload", () => location.reload());
}

// ── Quizzes ───────────────────────────────────────────────────────────────────

/**
 * The quiz contract lives in assets/templates/quiz.html. A form that breaks it is
 * not hydrated: every problem is shown on the page and in the console, and the form
 * cannot be submitted. A half-working quiz would hand the teacher answers that do not
 * match the questions.
 */

function quizForms() {
  return [...document.querySelectorAll("form.cl-quiz")];
}

/** Elements inside a question. */
function own(question, selector) {
  return [...question.querySelectorAll(selector)];
}

/** Summarise a question's markup as plain data, for `questionErrors`. */
function questionShape(question, kind) {
  const ids = (selector, attribute) =>
    [...question.querySelectorAll(selector)].map((el) => el.getAttribute(attribute) ?? "");
  const count = (selector) => own(question, selector).length;
  return {
    id: question.dataset.questionId ?? null,
    type: question.dataset.type ?? null,
    kind,
    reviewOf: question.dataset.reviewOf ?? null,
    select: question.dataset.select ?? null,
    hasStimulus: Boolean(question.querySelector(".cl-q-stimulus")),
    hasCloze: Boolean(question.querySelector(".cl-cloze")),
    radios: count("input[type=radio]"),
    checkboxes: count("input[type=checkbox]"),
    textInputs: count(
      "input[type=text]:not([data-blank]):not(.cl-number):not(.cl-unit), input:not([type]):not([data-blank]):not(.cl-number):not(.cl-unit)",
    ),
    textareas: count("textarea"),
    numbers: count("input.cl-number"),
    units: count(".cl-unit"),
    options: own(question, "input[type=radio], input[type=checkbox]").map((input) =>
      input.getAttribute("value"),
    ),
    blanks: ids("input[data-blank]", "data-blank"),
    orderItems: ids(".cl-order > li", "data-item"),
    matchLeft: ids(".cl-match-left > li", "data-item"),
    matchRight: ids(".cl-match-right > li", "data-item"),
    segments: ids(".cl-q-stimulus [data-segment]", "data-segment"),
  };
}

/** Problems with the form itself, before its questions are checked. */
function quizErrors(form, seenQuizIds) {
  const errors = [];
  const quizId = form.dataset.quizId;
  if (!quizId) errors.push("The quiz has no data-quiz-id.");
  else if (!isContractId(quizId)) errors.push(`The data-quiz-id "${quizId}" is not valid.`);
  else if (seenQuizIds.has(quizId)) errors.push(`Two quizzes use the data-quiz-id "${quizId}".`);

  const kind = form.dataset.kind;
  if (kind !== undefined && !isQuizKind(kind)) {
    errors.push(`Unknown data-kind "${kind}". Use one of: ${QUIZ_KINDS.join(", ")}.`);
  }
  const questions = [...form.querySelectorAll(".cl-q")];
  if (questions.length === 0) errors.push("The quiz has no .cl-q questions.");
  const ids = questions.map((q) => q.dataset.questionId).filter(Boolean);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0)
    errors.push(`Repeated data-question-id: ${[...new Set(repeated)].join(", ")}.`);
  return errors;
}

/** Show markup errors where they are, so nobody mistakes a broken quiz for a working one. */
function showErrors(container, heading, errors, before = null) {
  const box = document.createElement("div");
  box.className = "cl-contract-error";
  box.setAttribute("role", "alert");
  const title = document.createElement("p");
  title.className = "cl-contract-error-title";
  title.textContent = heading;
  const list = document.createElement("ul");
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = error;
    list.appendChild(item);
    console.error(`[classroom] ${heading} ${error}`);
  }
  box.append(title, list);
  if (before) container.insertBefore(box, before);
  else container.prepend(box);
}

const KIND_NOTES = {
  pretest:
    "Pretest. Answer before you read the lesson. Wrong answers are expected: they show your teacher what to focus on.",
  review:
    "Review. These questions come back to ideas from earlier lessons, so you recall them after a gap.",
};

function hydrateQuizzes() {
  const seenQuizIds = new Set();
  for (const form of quizForms()) {
    const formErrors = quizErrors(form, seenQuizIds);
    if (form.dataset.quizId) seenQuizIds.add(form.dataset.quizId);
    const kind = isQuizKind(form.dataset.kind) ? form.dataset.kind : "check";
    form.dataset.kind = kind;

    let broken = formErrors.length > 0;
    for (const question of form.querySelectorAll(".cl-q")) {
      const errors = questionErrors(questionShape(question, kind));
      if (errors.length > 0) {
        broken = true;
        const label = question.dataset.questionId ?? "without an id";
        showErrors(question, `Question ${label}`, errors);
      }
    }

    if (form.dataset.title && !form.querySelector(".cl-quiz-title")) {
      const heading = document.createElement("p");
      heading.className = "cl-quiz-title";
      heading.textContent = form.dataset.title;
      form.prepend(heading);
    }
    if (KIND_NOTES[kind] && !form.querySelector(".cl-quiz-kind")) {
      const note = document.createElement("p");
      note.className = "cl-quiz-kind";
      note.textContent = KIND_NOTES[kind];
      const title = form.querySelector(".cl-quiz-title");
      if (title) title.after(note);
      else form.prepend(note);
    }
    if (formErrors.length > 0) {
      showErrors(form, "This quiz has errors.", formErrors, form.querySelector(".cl-questions"));
    }

    let footer = form.querySelector(".cl-quiz-footer");
    if (!footer) {
      footer = document.createElement("div");
      footer.className = "cl-quiz-footer";
      form.appendChild(footer);
    }

    let submit = form.querySelector('button[type="submit"], .cl-submit');
    if (!submit) {
      submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "cl-submit";
      submit.textContent = "Submit for grading";
    }
    submit.classList.add("cl-button");
    footer.appendChild(submit);

    const status = document.createElement("span");
    status.className = "cl-quiz-status";
    status.dataset.clQuizStatus = "";
    footer.appendChild(status);

    if (broken) {
      setQuizState(form, "broken");
      setQuizStatus(
        form,
        "This quiz has errors, so it cannot be submitted. Ask your teacher to fix it.",
      );
      continue;
    }

    for (const question of form.querySelectorAll(".cl-q")) enhanceQuestion(form, question);
    form.dataset.state = "fresh";
    form.addEventListener("submit", (event) => onQuizSubmit(event, form));
  }
}

/** Add the controls a question type needs. */
function enhanceQuestion(form, question) {
  switch (question.dataset.type) {
    case "numeric":
      for (const input of question.querySelectorAll("input.cl-number")) {
        input.setAttribute("inputmode", "decimal");
        input.addEventListener("input", () => {
          const invalid = input.value.trim() !== "" && parseNumber(input.value) === null;
          input.setAttribute("aria-invalid", String(invalid));
        });
      }
      break;
    case "order":
      enhanceOrder(question);
      break;
    case "match":
      enhanceMatch(question);
      break;
    case "locate":
      enhanceLocate(form, question);
      break;
  }
}

function enhanceOrder(question) {
  const list = question.querySelector(".cl-order");
  // Keep the authored order so saved answers can replace the displayed selections.
  list.dataset.clInitial = [...list.children].map((li) => li.dataset.item).join(" ");
  for (const item of list.children) {
    const controls = document.createElement("span");
    controls.className = "cl-order-controls";
    controls.innerHTML = `
      <button type="button" class="cl-icon-button" data-cl-move="-1" aria-label="Move up">↑</button>
      <button type="button" class="cl-icon-button" data-cl-move="1" aria-label="Move down">↓</button>`;
    item.appendChild(controls);
    controls.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cl-move]");
      if (!button || button.disabled) return;
      const sibling =
        button.dataset.clMove === "-1" ? item.previousElementSibling : item.nextElementSibling;
      if (!sibling) return;
      if (button.dataset.clMove === "-1") sibling.before(item);
      else sibling.after(item);
      button.focus();
    });
  }
}

/** The text of an order item, without the move buttons. */
function itemLabel(item) {
  const clone = item.cloneNode(true);
  clone.querySelector(".cl-order-controls")?.remove();
  return normalizeText(clone.textContent);
}

function enhanceMatch(question) {
  const rights = [...question.querySelectorAll(".cl-match-right > li")];
  for (const left of question.querySelectorAll(".cl-match-left > li")) {
    const select = document.createElement("select");
    select.className = "cl-match-select";
    select.dataset.matchFor = left.dataset.item;
    select.setAttribute("aria-label", `Match for ${normalizeText(left.textContent)}`);
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Choose a match…";
    select.appendChild(blank);
    for (const right of rights) {
      const option = document.createElement("option");
      option.value = right.dataset.item;
      option.textContent = normalizeText(right.textContent);
      select.appendChild(option);
    }
    left.appendChild(select);
  }
}

function enhanceLocate(form, question) {
  const many = question.dataset.select === "many";
  for (const segment of question.querySelectorAll(".cl-q-stimulus [data-segment]")) {
    segment.classList.add("cl-segment");
    segment.setAttribute("role", "button");
    segment.setAttribute("tabindex", "0");
    segment.setAttribute("aria-pressed", "false");
    const toggle = () => {
      if (form.dataset.state !== "fresh") return;
      const pressed = segment.getAttribute("aria-pressed") !== "true";
      if (!many) {
        for (const other of question.querySelectorAll(".cl-segment")) {
          other.setAttribute("aria-pressed", "false");
        }
      }
      segment.setAttribute("aria-pressed", String(pressed));
    };
    segment.addEventListener("click", toggle);
    segment.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }
}

/** Plain text of a stimulus block. Line breaks are kept, because code needs them. */
function stimulusText(element) {
  const text = (element.innerText || element.textContent || "").trim();
  const images = [...element.querySelectorAll("img")].map(
    (img) => `[image: ${img.getAttribute("alt") || "no alt text"}]`,
  );
  return [text, ...images].filter(Boolean).join("\n");
}

/** A cloze passage as text, with each blank written as `[[<blank id>]]`. */
function clozeText(element) {
  const clone = element.cloneNode(true);
  for (const blank of clone.querySelectorAll("input[data-blank]")) {
    blank.replaceWith(document.createTextNode(`[[${blank.dataset.blank}]]`));
  }
  return normalizeText(clone.textContent);
}

/**
 * Read one question's answer.
 *
 * Returns `{ answer }`, or `{ missing: true }` when the learner has not answered it
 * yet, or `{ invalid: message }` when the answer cannot be sent as it is.
 */
function collectAnswer(question) {
  const type = question.dataset.type;
  const answer = {
    questionId: question.dataset.questionId,
    type,
    prompt: normalizeText(question.querySelector(".cl-q-prompt")?.textContent ?? ""),
  };
  const stimulus = question.querySelector(".cl-q-stimulus");
  if (stimulus) answer.stimulus = stimulusText(stimulus);
  if (question.dataset.reviewOf) answer.reviewOf = question.dataset.reviewOf;

  const labelOf = (input) => normalizeText(input.closest("label")?.textContent ?? input.value);

  switch (type) {
    case "choice": {
      const chosen = own(question, "input[type=radio]").find((input) => input.checked);
      if (!chosen) return { missing: true };
      answer.value = chosen.value;
      answer.label = labelOf(chosen);
      break;
    }
    case "multi": {
      const chosen = own(question, "input[type=checkbox]").filter((input) => input.checked);
      if (chosen.length === 0) return { missing: true };
      answer.parts = chosen.map((input) => ({ id: input.value, value: labelOf(input) }));
      break;
    }
    case "term":
    case "short": {
      const field = own(question, "textarea, input[type=text], input:not([type])")[0];
      if (!field.value.trim()) return { missing: true };
      answer.value = field.value.trim();
      break;
    }
    case "numeric": {
      const number = question.querySelector("input.cl-number");
      if (!number.value.trim()) return { missing: true };
      if (parseNumber(number.value) === null) {
        return { invalid: `"${number.value.trim()}" is not a number. Write it like 9.81 or 3e8.` };
      }
      answer.value = number.value.trim();
      const unit = question.querySelector(".cl-unit");
      if (unit) answer.unit = unit.value.trim();
      break;
    }
    case "cloze": {
      const blanks = [...question.querySelectorAll("input[data-blank]")];
      if (blanks.some((blank) => !blank.value.trim())) return { missing: true };
      answer.passage = clozeText(question.querySelector(".cl-cloze"));
      answer.parts = blanks.map((blank) => ({
        id: blank.dataset.blank,
        value: blank.value.trim(),
      }));
      break;
    }
    case "order":
      answer.parts = [...question.querySelectorAll(".cl-order > li")].map((item) => ({
        id: item.dataset.item,
        value: itemLabel(item),
      }));
      break;
    case "match": {
      const selects = [...question.querySelectorAll("select.cl-match-select")];
      if (selects.some((select) => !select.value)) return { missing: true };
      answer.pairs = selects.map((select) => ({
        left: select.dataset.matchFor,
        right: select.value,
        leftLabel: itemText(select.closest("li")),
        rightLabel: normalizeText(select.selectedOptions[0].textContent),
      }));
      break;
    }
    case "locate": {
      const chosen = [...question.querySelectorAll(".cl-segment[aria-pressed=true]")];
      if (chosen.length === 0) return { missing: true };
      answer.parts = chosen.map((segment) => ({
        id: segment.dataset.segment,
        value: normalizeText(segment.textContent),
      }));
      break;
    }
  }

  return { answer };
}

/** The text of a match item, without the select the runtime added. */
function itemText(item) {
  const clone = item.cloneNode(true);
  clone.querySelector("select")?.remove();
  return normalizeText(clone.textContent);
}

async function onQuizSubmit(event, form) {
  event.preventDefault();
  if (form.dataset.state !== "fresh") return;

  const questions = [...form.querySelectorAll(".cl-q")];
  const answers = [];
  let missing = 0;
  for (const [i, question] of questions.entries()) {
    const result = collectAnswer(question);
    if (result.invalid) {
      setQuizStatus(form, `Question ${i + 1}: ${result.invalid}`);
      return;
    }
    if (result.missing) missing += 1;
    else answers.push(result.answer);
  }
  if (missing > 0) {
    setQuizStatus(form, `Answer every question first (${missing} left).`);
    return;
  }

  setQuizState(form, "submitted");
  form.dataset.activeAttempt = String(Number(form.dataset.attempts ?? "0") + 1);
  setQuizStatus(form, '<span class="cl-spinner"></span> Sent to your teacher for grading…', true);

  let response;
  try {
    response = await fetch("/api/quiz/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: config.classroom,
        lesson: config.lesson,
        quizId: form.dataset.quizId,
        quizTitle: form.dataset.title || "Check on learning",
        kind: form.dataset.kind,
        answers,
      }),
    });
  } catch (err) {
    console.error("[classroom] quiz submit failed", err);
    setQuizState(form, "fresh");
    setQuizStatus(
      form,
      "Could not reach your teacher. Is the session that started the classroom still running?",
    );
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    console.error("[classroom] quiz refused", body.error);
    setQuizState(form, "fresh");
    setQuizStatus(form, `The classroom refused this quiz: ${body.error}`);
    return;
  }
  const submission = await response.json();
  applyQuizState({ submission, grade: null, attempts: submission.attempt });
}

function setQuizState(form, state) {
  form.dataset.state = state;
  const locked = state !== "fresh";
  for (const field of form.querySelectorAll(
    ".cl-q input, .cl-q textarea, .cl-q select, .cl-q button",
  )) {
    field.disabled = locked;
  }
  for (const segment of form.querySelectorAll(".cl-segment")) {
    segment.setAttribute("tabindex", locked ? "-1" : "0");
  }
  const submit = form.querySelector('button[type="submit"], .cl-submit');
  if (submit) {
    submit.disabled = locked;
    if (state === "graded") submit.textContent = "Graded";
    else if (state === "submitted") submit.textContent = "Submitted";
    else submit.textContent = "Submit for grading";
  }
}

function setQuizStatus(form, html, isHtml = false) {
  const status = form.querySelector("[data-cl-quiz-status]");
  if (!status) return;
  if (isHtml) status.innerHTML = html;
  else status.textContent = html;
}

/** Clear displayed answers before restoring a saved attempt. */
function clearQuizAnswers(form) {
  for (const input of form.querySelectorAll(".cl-q input")) {
    if (input.type === "radio" || input.type === "checkbox") input.checked = false;
    else input.value = "";
    input.removeAttribute("aria-invalid");
  }
  for (const field of form.querySelectorAll(".cl-q textarea, .cl-q select")) field.value = "";
  for (const segment of form.querySelectorAll(".cl-segment")) {
    segment.setAttribute("aria-pressed", "false");
  }
  for (const list of form.querySelectorAll(".cl-order"))
    reorder(list, list.dataset.clInitial.split(" "));
}

/** Put the items of an order list in the given order of item ids. */
function reorder(list, ids) {
  for (const id of ids) {
    const item = [...list.children].find((li) => li.dataset.item === id);
    if (item) list.appendChild(item);
  }
}

/** Put a saved answer back into its question. */
function restoreAnswer(question, group) {
  const answer = group[0];
  const byValue = (selector, value) =>
    own(question, selector).find((input) => input.value === value);

  switch (answer.type) {
    // Answers saved before question types were enforced: one entry for each ticked box.
    case undefined:
      for (const entry of group) {
        const choice = byValue("input[type=radio], input[type=checkbox]", entry.value);
        if (choice) choice.checked = true;
        else {
          const free = own(question, "textarea, input[type=text]")[0];
          if (free) free.value = entry.value;
        }
      }
      return;
    case "choice": {
      const choice = byValue("input[type=radio]", answer.value);
      if (choice) choice.checked = true;
      break;
    }
    case "multi":
      for (const part of answer.parts) {
        const box = byValue("input[type=checkbox]", part.id);
        if (box) box.checked = true;
      }
      break;
    case "term":
    case "short": {
      const field = own(question, "textarea, input[type=text], input:not([type])")[0];
      if (field) field.value = answer.value;
      break;
    }
    case "numeric": {
      const number = question.querySelector("input.cl-number");
      if (number) number.value = answer.value;
      const unit = question.querySelector(".cl-unit");
      if (unit && answer.unit !== undefined) unit.value = answer.unit;
      break;
    }
    case "cloze":
      for (const part of answer.parts) {
        const blank = question.querySelector(`input[data-blank="${cssEscape(part.id)}"]`);
        if (blank) blank.value = part.value;
      }
      break;
    case "order": {
      const list = question.querySelector(".cl-order");
      if (list)
        reorder(
          list,
          answer.parts.map((part) => part.id),
        );
      break;
    }
    case "match":
      for (const pair of answer.pairs) {
        const select = question.querySelector(`select[data-match-for="${cssEscape(pair.left)}"]`);
        if (select) select.value = pair.right;
      }
      break;
    case "locate":
      for (const part of answer.parts) {
        const segment = question.querySelector(`.cl-segment[data-segment="${cssEscape(part.id)}"]`);
        if (segment) segment.setAttribute("aria-pressed", "true");
      }
      break;
  }
}

/** Re-apply the latest attempt at a quiz (and its grade, if graded) to its form. */
function applyQuizState(state) {
  const { submission, grade, attempts } = state;
  const form = quizForms().find((f) => f.dataset.quizId === submission.quizId);
  if (!form) {
    console.error(
      `[classroom] A saved attempt belongs to quiz "${submission.quizId}", which is not on this page.`,
    );
    return;
  }
  if (form.dataset.state === "broken") return;
  if (attempts < Number(form.dataset.activeAttempt ?? "0")) return;
  if (submission.submittedAt < Number(form.dataset.submittedAt ?? "0")) return;
  // The grade can arrive through SSE before the submit response arrives.
  if (!grade && form.dataset.submissionId === submission.id && form.dataset.state === "graded")
    return;
  form.dataset.activeAttempt = String(attempts);
  form.dataset.submissionId = submission.id;
  form.dataset.submittedAt = String(submission.submittedAt);
  form.dataset.attempts = String(attempts);

  // Clear first: a grade can arrive for an attempt the form is already showing.
  form.querySelector("[data-cl-grade]")?.remove();
  for (const verdict of form.querySelectorAll(".cl-q-verdict")) verdict.remove();
  clearQuizAnswers(form);

  const groups = new Map();
  for (const answer of submission.answers) {
    if (!groups.has(answer.questionId)) groups.set(answer.questionId, []);
    groups.get(answer.questionId).push(answer);
  }
  for (const [questionId, group] of groups) {
    const question = form.querySelector(`.cl-q[data-question-id="${cssEscape(questionId)}"]`);
    if (question) restoreAnswer(question, group);
  }

  const attemptNote = attempts > 1 ? ` · attempt ${attempts}` : "";
  if (!grade) {
    setQuizState(form, "submitted");
    setQuizStatus(
      form,
      `<span class="cl-spinner"></span> Submission saved. Waiting for your teacher to grade it.${attemptNote}${config.delivery === "wait" ? " Your teacher receives page requests while listening. If no grade arrives, return to chat and ask them to listen." : ""}`,
      true,
    );
    return;
  }

  setQuizState(form, "graded");
  setQuizStatus(form, `Graded ${new Date(grade.gradedAt).toLocaleString()}${attemptNote}`);
  renderGrade(form, grade);
}

function renderGrade(form, grade) {
  form.querySelector("[data-cl-grade]")?.remove();

  const summary = document.createElement("div");
  summary.dataset.clGrade = "";
  // A pretest comes before teaching, so its score is information, not a verdict.
  const tone =
    form.dataset.kind === "pretest"
      ? "info"
      : grade.score >= 80
        ? "pass"
        : grade.score >= 50
          ? "mixed"
          : "fail";
  summary.innerHTML = `
    <div class="cl-grade-banner" data-tone="${tone}">
      <span class="cl-grade-score">${Math.round(grade.score)}%</span>
      <span>${gradeSummary(grade.questions)}</span>
    </div>
    <div class="cl-grade-feedback">${grade.feedbackHtml || ""}</div>
    ${gradePointsNotice(grade) ? `<p class="cl-quiz-status">${escapeText(gradePointsNotice(grade))}</p>` : ""}`;
  const anchor = form.querySelector(".cl-quiz-kind") ?? form.querySelector(".cl-quiz-title");
  if (anchor) anchor.after(summary);
  else form.prepend(summary);

  for (const questionGrade of grade.questions) {
    const question = form.querySelector(
      `.cl-q[data-question-id="${cssEscape(questionGrade.questionId)}"]`,
    );
    if (!question) continue;
    question.querySelector(".cl-q-verdict")?.remove();
    const verdict = document.createElement("div");
    verdict.className = "cl-q-verdict";
    verdict.dataset.correct = String(questionGrade.correct);
    verdict.dataset.outcome = questionOutcome(questionGrade);
    verdict.innerHTML = `<span>${escapeText(questionGradeLabel(questionGrade))}</span><span>${
      questionGrade.feedbackHtml || escapeText(questionGrade.feedback)
    }</span>`;
    question.appendChild(verdict);
  }
}

// ── Self-explanations ─────────────────────────────────────────────────────────

/**
 * A `form.cl-reflect` asks the learner to explain something in their own words. It is
 * saved and shown to the teacher, but never graded: explaining is the exercise.
 */
function reflectForms() {
  return [...document.querySelectorAll("form.cl-reflect")];
}

function hydrateReflections() {
  const seen = new Set();
  for (const form of reflectForms()) {
    const errors = [];
    const id = form.dataset.reflectId;
    if (!id) errors.push("The self-explanation has no data-reflect-id.");
    else if (!isContractId(id)) errors.push(`The data-reflect-id "${id}" is not valid.`);
    else if (seen.has(id)) errors.push(`Two self-explanations use the data-reflect-id "${id}".`);
    if (id) seen.add(id);
    if (!form.querySelector(".cl-reflect-prompt")) errors.push("It has no .cl-reflect-prompt.");
    if (form.querySelectorAll("textarea").length !== 1) errors.push("It needs exactly 1 textarea.");

    const footer = document.createElement("div");
    footer.className = "cl-quiz-footer";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "cl-button";
    save.textContent = "Save";
    const status = document.createElement("span");
    status.className = "cl-quiz-status";
    status.dataset.clQuizStatus = "";
    footer.append(save, status);
    form.appendChild(footer);

    if (errors.length > 0) {
      showErrors(form, "This self-explanation has errors.", errors);
      save.disabled = true;
      for (const field of form.querySelectorAll("textarea")) field.disabled = true;
      continue;
    }
    form.addEventListener("submit", (event) => onReflectSubmit(event, form));
  }
}

async function onReflectSubmit(event, form) {
  event.preventDefault();
  const field = form.querySelector("textarea");
  const text = field.value.trim();
  if (!text) {
    setQuizStatus(form, "Write your explanation first.");
    return;
  }
  const save = form.querySelector('button[type="submit"]');
  save.disabled = true;
  try {
    const response = await fetch("/api/reflect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: config.classroom,
        lesson: config.lesson,
        reflectId: form.dataset.reflectId,
        prompt: normalizeText(form.querySelector(".cl-reflect-prompt").textContent),
        text,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(body.error);
    }
    const reflection = await response.json();
    setQuizStatus(
      form,
      `Saved ${new Date(reflection.savedAt).toLocaleString()}. Your teacher will read it.`,
    );
  } catch (err) {
    console.error("[classroom] reflection failed", err);
    setQuizStatus(form, `Could not save: ${err.message}`);
  } finally {
    save.disabled = false;
  }
}

function applyReflection(reflection) {
  const form = reflectForms().find((f) => f.dataset.reflectId === reflection.reflectId);
  if (!form) {
    console.error(
      `[classroom] A saved self-explanation belongs to "${reflection.reflectId}", which is not on this page.`,
    );
    return;
  }
  form.querySelector("textarea").value = reflection.text;
  setQuizStatus(form, `Saved ${new Date(reflection.savedAt).toLocaleString()}.`);
}

// ── Glossary terms ────────────────────────────────────────────────────────────

/**
 * Mark the first use of each glossary term in each section of the lesson.
 *
 * Recall first: a click asks the learner what the term means before it shows the
 * definition, so each look is a small retrieval attempt rather than a re-read.
 */
let termPopover = null;

async function initGlossary() {
  const response = await fetch(`/api/glossary?classroom=${encodeURIComponent(config.classroom)}`);
  if (!response.ok) throw new Error(`GET /api/glossary returned ${response.status}`);
  const glossary = await response.json();
  for (const error of glossary.errors) console.error(`[classroom] GLOSSARY.md: ${error}`);
  if (glossary.terms.length === 0) return;

  buildTermPopover();
  for (const section of glossarySections()) markTerms(section, glossary.terms);
}

/** Top-level sections of the lesson, or the whole lesson when it has none. */
function glossarySections() {
  const sections = [...contentRoot.querySelectorAll("section")].filter(
    (section) => !section.parentElement?.closest("section"),
  );
  return sections.length > 0 ? sections : [contentRoot];
}

const NO_TERMS =
  "script, style, pre, code, a, button, label, select, h1, h2, h3, h4, h5, h6, " +
  "form.cl-quiz, form.cl-reflect, .cl-header, .cl-card-panel, .cl-ask-pill, " +
  ".cl-badge-marker, .cl-term, .cl-term-pop, .cl-contract-error, mark.cl-hl";

function markTerms(section, terms) {
  const nodes = [];
  let text = "";
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest(NO_TERMS)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, start: text.length });
    text += node.nodeValue;
  }

  const matches = firstUses(
    findTerms(text, terms).filter((match) => {
      const owner = nodes.findLast((entry) => entry.start <= match.start);
      return owner && match.end <= owner.start + owner.node.nodeValue.length;
    }),
  );
  // Last first, so splitting a node cannot move the offsets of an earlier match.
  for (const match of matches.reverse()) {
    const owner = nodes.findLast((entry) => entry.start <= match.start);
    if (!owner || match.end > owner.start + owner.node.nodeValue.length) continue; // spans tags
    let target = owner.node;
    const from = match.start - owner.start;
    const to = match.end - owner.start;
    if (to < target.nodeValue.length) target.splitText(to);
    if (from > 0) target = target.splitText(from);

    const term = document.createElement("span");
    term.className = "cl-term";
    term.tabIndex = 0;
    term.setAttribute("role", "button");
    term.setAttribute("aria-haspopup", "dialog");
    target.parentNode.insertBefore(term, target);
    term.appendChild(target);
    const entry = terms[match.index];
    term.addEventListener("click", (event) => {
      event.stopPropagation();
      openTermPopover(term, entry);
    });
    term.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTermPopover(term, entry);
      }
    });
  }
}

function buildTermPopover() {
  termPopover = document.createElement("div");
  termPopover.className = "cl-term-pop";
  termPopover.setAttribute("role", "dialog");
  termPopover.hidden = true;
  termPopover.innerHTML = `
    <p class="cl-term-pop-title" data-cl-term-title></p>
    <p class="cl-term-pop-ask">What does it mean? Say it to yourself first.</p>
    <button type="button" class="cl-button" data-cl-reveal>Show the definition</button>
    <div class="cl-term-pop-definition" data-cl-definition hidden></div>
    <p class="cl-term-pop-avoid" data-cl-avoid hidden></p>`;
  document.body.appendChild(termPopover);

  termPopover.querySelector("[data-cl-reveal]").addEventListener("click", () => {
    termPopover.querySelector("[data-cl-reveal]").hidden = true;
    termPopover.querySelector(".cl-term-pop-ask").hidden = true;
    termPopover.querySelector("[data-cl-definition]").hidden = false;
    termPopover.querySelector("[data-cl-avoid]").hidden =
      !termPopover.querySelector("[data-cl-avoid]").textContent;
  });
  document.addEventListener("mousedown", (event) => {
    if (!termPopover.hidden && !termPopover.contains(event.target)) termPopover.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") termPopover.hidden = true;
  });
}

function openTermPopover(anchor, entry) {
  termPopover.querySelector("[data-cl-term-title]").textContent = entry.term;
  // innerHTML is safe here: the definition was rendered to HTML server-side.
  termPopover.querySelector("[data-cl-definition]").innerHTML = entry.definitionHtml;
  termPopover.querySelector("[data-cl-avoid]").textContent =
    entry.avoid.length > 0 ? `Not: ${entry.avoid.join(", ")}` : "";
  termPopover.querySelector("[data-cl-reveal]").hidden = false;
  termPopover.querySelector(".cl-term-pop-ask").hidden = false;
  termPopover.querySelector("[data-cl-definition]").hidden = true;
  termPopover.querySelector("[data-cl-avoid]").hidden = true;
  termPopover.hidden = false;
  const rect = anchor.getBoundingClientRect();
  position(termPopover, rect.left, rect.bottom + 8);
  termPopover.querySelector("[data-cl-reveal]").focus();
}

function escapeText(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

/** CSS.escape with a fallback for the handful of browsers that lack it. */
function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/["\\\]\[]/g, "\\$&");
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Runs last on purpose: init() touches the module's `let` bindings, which are in the
// temporal dead zone until their declarations above have been evaluated.
if (config) init();

// Dedicated teacher chat stays available after the initiating chat ends.
let teacherPanel = null;
let teacherReplyId = null;
function renderTeacher(state) {
  if (!state) return;
  if (!teacherPanel) {
    teacherPanel = document.createElement("section");
    teacherPanel.className = "cl-teacher";
    teacherPanel.innerHTML =
      '<h2>Your teacher</h2><p class="cl-teacher-identity"></p><div class="cl-teacher-messages" aria-live="polite"></div><div class="cl-teacher-requests" aria-live="polite"></div><form><label>Reply to your teacher<textarea required maxlength="8000"></textarea></label><button class="cl-button" type="submit">Send reply</button><p class="cl-teacher-error" role="alert"></p></form>';
    document.body.appendChild(teacherPanel);
    teacherPanel.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const field = teacherPanel.querySelector("textarea"),
        button = teacherPanel.querySelector('button[type="submit"]');
      teacherReplyId ??= crypto.randomUUID();
      button.disabled = true;
      try {
        await teacherPost("chat", { text: field.value, id: teacherReplyId });
        field.value = "";
        teacherReplyId = null;
        teacherPanel.querySelector(".cl-teacher-error").textContent = "";
      } catch (err) {
        teacherPanel.querySelector(".cl-teacher-error").textContent = err.message;
      } finally {
        button.disabled = false;
      }
    });
    teacherPanel.querySelector("textarea").addEventListener("input", () => {
      teacherReplyId = null;
    });
  }
  teacherPanel.querySelector(".cl-teacher-identity").textContent =
    `${state.identity.backend} teacher. Session: ${state.identity.sessionId || "Starts with your first request"}.`;
  const messages = teacherPanel.querySelector(".cl-teacher-messages");
  messages.replaceChildren();
  for (const message of state.messages) {
    const item = document.createElement("p");
    item.style.whiteSpace = "pre-wrap";
    item.textContent = `${message.role === "teacher" ? "Teacher" : "You"}: ${message.text}`;
    messages.appendChild(item);
  }
  const requests = teacherPanel.querySelector(".cl-teacher-requests");
  requests.replaceChildren();
  for (const request of state.requests.filter((r) => r.status !== "done")) {
    const item = document.createElement("p");
    item.textContent =
      request.status === "failed"
        ? `Teacher failed: ${request.error}`
        : `${request.kind}: ${request.status}`;
    if (request.status === "failed") {
      const retry = document.createElement("button");
      retry.className = "cl-button";
      retry.textContent = "Retry request";
      retry.onclick = async () => {
        retry.disabled = true;
        try {
          await teacherPost("retry", { id: request.id });
        } catch (err) {
          teacherPanel.querySelector(".cl-teacher-error").textContent = err.message;
          retry.disabled = false;
        }
      };
      item.appendChild(retry);
    }
    requests.appendChild(item);
  }
}
async function teacherPost(action, body) {
  const response = await fetch(`/api/teacher/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classroom: config.classroom, lesson: config.lesson, ...body }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Teacher request returned ${response.status}`);
  return result;
}
