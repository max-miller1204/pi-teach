/**
 * math.mjs: draw TeX math in lessons and reference documents.
 *
 * An author writes inline math as \( ... \) and display math as \[ ... \] in the
 * page text. Each formula becomes a span.cl-math that keeps its TeX in data-tex, and
 * the vendored Temml build draws it as MathML. Browsers draw MathML natively with the
 * device's math font. The build loads only on a page that has math. TeX that does
 * not parse shows its error on the page and in the console, like a broken quiz.
 *
 * Text that leaves the page (grading, a quoted highlight) reads each formula as its
 * TeX, because MathML text loses the structure: x² reads as "x2".
 */

const TEMML_URL = "/static/vendor/temml/temml.mjs";

/** Text in these is never math: code shows TeX literally, and runtime UI is ours. */
const NO_MATH =
  "script, style, textarea, pre, code, kbd, samp, math, svg, .cl-math, .cl-diagram, .cl-no-math";

let temmlLoad = null;

/**
 * Split text at its \( \) and \[ \] delimiters.
 *
 * A delimiter after a backslash is literal. An opening delimiter with no closing one
 * in the same text is an error part: HTML tags inside a formula, or a `<` not written
 * as `&lt;`, split the text before it gets here.
 *
 * @param {string} text
 * @returns {import("./math.d.mts").MathPart[]}
 */
export function splitMath(text) {
  const parts = [];
  let from = 0;
  let index = 0;
  while ((index = text.indexOf("\\", index)) !== -1) {
    const next = text[index + 1];
    if (next === "\\") {
      index += 2;
      continue;
    }
    if (next !== "(" && next !== "[") {
      index += 1;
      continue;
    }
    const display = next === "[";
    const close = display ? "\\]" : "\\)";
    const end = text.indexOf(close, index + 2);
    if (from < index) parts.push({ text: text.slice(from, index) });
    if (end === -1) {
      parts.push({
        error: `No closing ${close} in the same text. Write < as &lt; and keep HTML tags out of math.`,
        source: text.slice(index),
      });
      return parts;
    }
    parts.push({ tex: text.slice(index + 2, end), display });
    index = from = end + 2;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}

/** A formula's TeX, in the delimiters it was written with. */
export function mathSource(element) {
  const tex = element.dataset.tex;
  if (tex === undefined) throw new Error("mathSource: the element is not a formula");
  return element.classList.contains("cl-math-display") ? `\\[${tex}\\]` : `\\(${tex}\\)`;
}

/**
 * Replace each formula in `root` with a text node of its TeX.
 *
 * Read the text, then call the returned function to put the formulas back. Do both in
 * one task, so the browser never paints the TeX. On a copy, skip the restore.
 */
export function swapMathForSource(root) {
  // An unclosed delimiter has no data-tex: it reads as its error and source.
  const swaps = [...root.querySelectorAll(".cl-math[data-tex]")].map((math) => {
    const text = document.createTextNode(mathSource(math));
    math.replaceWith(text);
    return [math, text];
  });
  return () => {
    for (const [math, text] of swaps) text.replaceWith(math);
  };
}

/**
 * Replace each delimited formula in `root` with a span.cl-math and draw it.
 *
 * The swap is synchronous, so the text index never sees the TeX. The returned promise
 * settles when every formula is drawn or shows its error.
 */
export function initMath(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.includes("\\(") && !node.nodeValue.includes("\\[")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.parentElement?.closest(NO_MATH)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);

  const formulas = [];
  for (const node of nodes) {
    const parts = splitMath(node.nodeValue);
    if (parts.every((part) => "text" in part)) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if ("text" in part) {
        fragment.append(part.text);
      } else if ("error" in part) {
        const math = document.createElement("span");
        math.className = "cl-math";
        fragment.append(math);
        showError(math, part.error, part.source);
      } else {
        const math = document.createElement("span");
        math.className = part.display ? "cl-math cl-math-display" : "cl-math";
        math.dataset.tex = part.tex;
        math.setAttribute("aria-busy", "true");
        math.textContent = mathSource(math);
        fragment.append(math);
        formulas.push(math);
      }
    }
    node.replaceWith(fragment);
  }
  if (formulas.length === 0) return Promise.resolve();

  return loadTemml().then(
    (temml) => {
      for (const math of formulas) draw(temml, math);
    },
    (error) => {
      for (const math of formulas) showError(math, error.message, mathSource(math));
    },
  );
}

function draw(temml, math) {
  try {
    math.innerHTML = temml.renderToString(math.dataset.tex, {
      displayMode: math.classList.contains("cl-math-display"),
      throwOnError: true,
    });
    math.removeAttribute("aria-busy");
  } catch (error) {
    showError(math, error instanceof Error ? error.message : String(error), mathSource(math));
  }
}

function loadTemml() {
  temmlLoad ??= import(TEMML_URL).then(
    (module) => module.default,
    () => {
      throw new Error(`Could not load ${TEMML_URL}`);
    },
  );
  return temmlLoad;
}

/** Show why a formula did not draw, with its source, so nobody reads it as the answer. */
function showError(math, message, source) {
  console.error(`[classroom] Math did not render: ${message.trim()}`);

  const box = document.createElement("span");
  box.className = "cl-contract-error";
  box.setAttribute("role", "alert");
  const title = document.createElement("span");
  title.className = "cl-contract-error-title";
  title.textContent = "Math did not render";
  const detail = document.createElement("span");
  detail.className = "cl-math-error-detail";
  detail.textContent = message.trim();
  const code = document.createElement("code");
  code.textContent = source;
  box.append(title, detail, code);
  math.replaceChildren(box);
  math.removeAttribute("aria-busy");
}
