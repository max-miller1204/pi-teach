/**
 * diagrams.mjs: render Mermaid diagrams in lessons and reference documents.
 *
 * An author writes the diagram source in a <pre class="mermaid"> block. The page
 * loads the vendored Mermaid build only when it has such a block. Each block becomes
 * a div.cl-diagram that holds the SVG, and the SVG is drawn again when the theme
 * changes. A diagram that does not parse shows its error on the page and in the
 * console, like a broken quiz. No diagram is drawn from a CDN: lessons must work
 * offline.
 */

const MERMAID_URL = "/static/vendor/mermaid/mermaid.min.js";

/** The authored source of each rendered diagram, keyed by its div.cl-diagram. */
const sources = new WeakMap();

let mermaidLoad = null;
let renderQueue = Promise.resolve();
let renderCount = 0;

/**
 * Remove the indent that every line of a source shares, and the blank lines around it.
 *
 * Authors indent a <pre> to match the HTML around it. Mindmaps read structure from
 * indentation, so only the shared part may go.
 */
export function dedentSource(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const indents = lines
    .filter((line) => line.trim() !== "")
    .map((line) => /^[ \t]*/.exec(line)[0].length);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shared).trimEnd()).join("\n");
}

/** The Mermaid source of a div.cl-diagram. Grading reads it instead of the SVG text. */
export function diagramSource(element) {
  const source = sources.get(element);
  if (source === undefined) throw new Error("diagramSource: the element is not a diagram");
  return source;
}

/**
 * Replace each <pre class="mermaid"> in `root` with a div.cl-diagram and draw it.
 *
 * The swap is synchronous, so the text index never sees the source text. The
 * returned promise settles when the first drawing is done.
 */
export function initDiagrams(root) {
  const diagrams = [...root.querySelectorAll("pre.mermaid")].map((pre) => {
    const diagram = document.createElement("div");
    diagram.className = "cl-diagram";
    diagram.setAttribute("aria-busy", "true");
    for (const name of ["aria-label", "aria-labelledby", "aria-describedby"]) {
      if (pre.hasAttribute(name)) diagram.setAttribute(name, pre.getAttribute(name));
    }
    if (pre.hasAttribute("aria-label") || pre.hasAttribute("aria-labelledby"))
      diagram.setAttribute("role", "img");
    sources.set(diagram, dedentSource(pre.textContent));
    pre.replaceWith(diagram);
    return diagram;
  });
  if (diagrams.length === 0) return Promise.resolve();

  const redraw = () => draw(diagrams);
  new MutationObserver(redraw).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
  return draw(diagrams);
}

/** Queue one drawing of every diagram, so two theme changes cannot interleave. */
function draw(diagrams) {
  renderQueue = renderQueue.then(async () => {
    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (error) {
      for (const diagram of diagrams) showError(diagram, error);
      return;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: themeVariables(),
    });
    for (const diagram of diagrams) {
      try {
        const { svg } = await mermaid.render(`cl-diagram-${++renderCount}`, sources.get(diagram));
        diagram.innerHTML = svg;
        diagram.removeAttribute("aria-busy");
      } catch (error) {
        showError(diagram, error);
      }
    }
  });
  return renderQueue;
}

function loadMermaid() {
  mermaidLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MERMAID_URL;
    script.addEventListener("load", () => resolve(globalThis.mermaid));
    script.addEventListener("error", () => reject(new Error(`Could not load ${MERMAID_URL}`)));
    document.head.append(script);
  });
  return mermaidLoad;
}

/** Mermaid's base theme, coloured from the classroom tokens of the current theme. */
function themeVariables() {
  const style = getComputedStyle(document.documentElement);
  const token = (name) => {
    const value = style.getPropertyValue(name).trim();
    if (!value) throw new Error(`classroom.css defines no ${name}`);
    return value;
  };
  return {
    darkMode: token("color-scheme") === "dark",
    background: token("--cl-bg"),
    fontFamily: token("--cl-sans"),
    primaryColor: token("--cl-accent-soft"),
    primaryTextColor: token("--cl-text"),
    primaryBorderColor: token("--cl-accent"),
    secondaryColor: token("--cl-surface-2"),
    tertiaryColor: token("--cl-surface"),
    lineColor: token("--cl-text-muted"),
    edgeLabelBackground: token("--cl-bg"),
    textColor: token("--cl-text"),
    noteBkgColor: token("--cl-highlight"),
    noteTextColor: token("--cl-text"),
    noteBorderColor: token("--cl-border-strong"),
  };
}

/** Show why a diagram did not draw, above its source, so nobody mistakes it for art. */
function showError(diagram, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[classroom] Diagram did not render: ${message}`);

  const box = document.createElement("div");
  box.className = "cl-contract-error";
  box.setAttribute("role", "alert");
  const title = document.createElement("p");
  title.className = "cl-contract-error-title";
  title.textContent = "Diagram did not render";
  const detail = document.createElement("pre");
  detail.textContent = message;
  box.append(title, detail);

  const source = document.createElement("pre");
  source.textContent = sources.get(diagram);
  diagram.replaceChildren(box, source);
  diagram.removeAttribute("aria-busy");
}
