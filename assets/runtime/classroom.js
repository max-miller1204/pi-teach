/**
 * classroom.js — the lesson runtime, injected into every lesson at serve time.
 *
 * Two features live here:
 *
 *   1. Highlight to ask. Select text, hit "Ask", type a question. It goes to the
 *      teacher running in your Pi session; the answer streams back into a card
 *      pinned to the highlight. A card is a thread: the box at the bottom asks a
 *      follow-up, which the teacher answers with the earlier turns in view. Cards
 *      minimise to a numbered badge and reopen on click. Everything is persisted
 *      server-side, so it survives a reload.
 *
 *   2. Quizzes. Any `form.cl-quiz` in the lesson is hydrated: submitting posts the
 *      answers to disk and asks the teacher to grade them, and the grade renders
 *      inline when it arrives.
 *
 * No bundler, no dependencies. Answer and feedback markdown is rendered to HTML
 * server-side, so nothing here needs a markdown parser.
 */

import { createSelector, findSelector, normalizeText } from "./anchor.mjs";
import { initLinks } from "./links.mjs";
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
  loadState();
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
          "script, style, noscript, .cl-header, .cl-card-panel, .cl-ask-pill, .cl-badge-marker",
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
    if (range.commonAncestorContainer.parentElement?.closest("form.cl-quiz, .cl-card-panel")) {
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
    alert("Could not reach your Pi session. Is /classroom still running?");
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
    alert("Could not reach your Pi session. Is /classroom still running?");
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
      const mark = restoreAnnotation(annotation);
      // An orphaned annotation (the lesson text changed under it) still gets a card,
      // parked at the end of the lesson rather than silently discarded.
      renderCard(annotation, mark);
      if (!mark) minimiseCard(annotation.id);
    }

    if (state.submission) applyQuizState(state.submission, state.grade);
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
    applyQuizState(payload.submission, payload.grade);
  });

  source.addEventListener("reload", () => location.reload());
}

// ── Quizzes ───────────────────────────────────────────────────────────────────

function quizForms() {
  return [...document.querySelectorAll("form.cl-quiz")];
}

function hydrateQuizzes() {
  for (const form of quizForms()) {
    if (!form.dataset.quizId) form.dataset.quizId = "quiz";
    form.dataset.state = "fresh";

    if (form.dataset.title && !form.querySelector(".cl-quiz-title")) {
      const heading = document.createElement("p");
      heading.className = "cl-quiz-title";
      heading.textContent = form.dataset.title;
      form.prepend(heading);
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

    form.addEventListener("submit", (event) => onQuizSubmit(event, form));
  }
}

/** Read the learner's answers out of the form's canonical markup. */
function collectAnswers(form) {
  const answers = [];
  for (const question of form.querySelectorAll(".cl-q")) {
    const questionId = question.dataset.questionId;
    if (!questionId) continue;
    const prompt = normalizeText(question.querySelector(".cl-q-prompt")?.textContent ?? "");

    const checked = [
      ...question.querySelectorAll("input[type=radio], input[type=checkbox]"),
    ].filter((input) => input.checked);
    if (checked.length > 0) {
      for (const input of checked) {
        answers.push({
          questionId,
          prompt,
          value: input.value || "",
          label: normalizeText(input.closest("label")?.textContent ?? ""),
        });
      }
      continue;
    }

    const free = question.querySelector("textarea, input[type=text]");
    if (free) answers.push({ questionId, prompt, value: free.value.trim() });
  }
  return answers;
}

async function onQuizSubmit(event, form) {
  event.preventDefault();
  if (form.dataset.state === "submitted") return;

  const answers = collectAnswers(form);
  const unanswered =
    [...form.querySelectorAll(".cl-q")].length - new Set(answers.map((a) => a.questionId)).size;
  if (answers.length === 0 || unanswered > 0) {
    setQuizStatus(form, `Answer every question first (${unanswered} left).`);
    return;
  }

  setQuizState(form, "submitted");
  setQuizStatus(form, '<span class="cl-spinner"></span> Sent to your teacher for grading…', true);

  try {
    const response = await fetch("/api/quiz/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classroom: config.classroom,
        lesson: config.lesson,
        quizId: form.dataset.quizId,
        quizTitle: form.dataset.title || "Check on learning",
        answers,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (err) {
    console.error("[classroom] quiz submit failed", err);
    setQuizState(form, "fresh");
    setQuizStatus(form, "Could not reach your Pi session. Is /classroom still running?");
  }
}

function setQuizState(form, state) {
  form.dataset.state = state;
  const locked = state === "submitted" || state === "graded";
  for (const field of form.querySelectorAll("input, textarea")) field.disabled = locked;
  const submit = form.querySelector('button[type="submit"], .cl-submit');
  if (submit) {
    submit.disabled = locked;
    if (state === "graded") submit.textContent = "Graded";
    else if (state === "submitted") submit.textContent = "Submitted";
  }
}

function setQuizStatus(form, html, isHtml = false) {
  const status = form.querySelector("[data-cl-quiz-status]");
  if (!status) return;
  if (isHtml) status.innerHTML = html;
  else status.textContent = html;
}

/** Re-apply a stored submission (and its grade, if graded) to the form. */
function applyQuizState(submission, grade) {
  const form = quizForms().find((f) => f.dataset.quizId === submission.quizId) ?? quizForms()[0];
  if (!form) return;

  for (const answer of submission.answers) {
    const question = form.querySelector(
      `.cl-q[data-question-id="${cssEscape(answer.questionId)}"]`,
    );
    if (!question) continue;
    const choice = [...question.querySelectorAll("input[type=radio], input[type=checkbox]")].find(
      (input) => input.value === answer.value,
    );
    if (choice) choice.checked = true;
    else {
      const free = question.querySelector("textarea, input[type=text]");
      if (free) free.value = answer.value;
    }
  }

  if (!grade) {
    setQuizState(form, "submitted");
    setQuizStatus(
      form,
      '<span class="cl-spinner"></span> Waiting for your teacher to grade this…',
      true,
    );
    return;
  }

  setQuizState(form, "graded");
  setQuizStatus(form, `Graded ${new Date(grade.gradedAt).toLocaleString()}`);
  renderGrade(form, grade);
}

function renderGrade(form, grade) {
  form.querySelector("[data-cl-grade]")?.remove();

  const summary = document.createElement("div");
  summary.dataset.clGrade = "";
  const tone = grade.score >= 80 ? "pass" : grade.score >= 50 ? "mixed" : "fail";
  summary.innerHTML = `
    <div class="cl-grade-banner" data-tone="${tone}">
      <span class="cl-grade-score">${Math.round(grade.score)}%</span>
      <span>${grade.questions.filter((q) => q.correct).length} of ${grade.questions.length} correct</span>
    </div>
    <div class="cl-grade-feedback">${grade.feedbackHtml || ""}</div>`;
  const heading = form.querySelector(".cl-quiz-title");
  if (heading) heading.after(summary);
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
    verdict.innerHTML = `<span aria-hidden="true">${questionGrade.correct ? "✓" : "✕"}</span><span>${
      questionGrade.feedbackHtml || escapeText(questionGrade.feedback)
    }</span>`;
    question.appendChild(verdict);
  }
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
