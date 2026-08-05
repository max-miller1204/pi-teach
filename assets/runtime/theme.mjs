/**
 * theme.mjs — the header light/dark toggle.
 *
 * The default is always the system preference; the toggle writes an explicit
 * `data-theme` on <html> that the stylesheet lets win over the media query. Cycling
 * back to "system" is deliberately not offered — clearing the override is a rare
 * need and a three-state toggle reads as a bug.
 */

const STORAGE_KEY = "pi-classroom-theme";

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function currentTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return systemPrefersDark() ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (err) {
    /* private browsing — the toggle still works for this page view */
  }
}

/** Wire up every `[data-cl-theme-toggle]` on the page. */
export function initTheme() {
  const toggles = document.querySelectorAll("[data-cl-theme-toggle]");
  for (const toggle of toggles) {
    toggle.addEventListener("click", () => {
      applyTheme(currentTheme() === "dark" ? "light" : "dark");
    });
  }
}
