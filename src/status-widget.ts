/**
 * status-widget.ts — the "classroom server running on port N" line in the TUI.
 *
 * The server is session-scoped, so with several Pi sessions open there is no way to tell
 * which one holds the teacher — the one a learner's browser is talking to. This widget
 * makes that obvious: it is present exactly while this session is serving, and it names
 * the port, which is what distinguishes one session's server from another's.
 *
 * Plain string lines rather than a component factory: those are the only widget contents
 * RPC mode honours, and colour is applied here from the live theme instead.
 */

import * as server from "./server.js";

/** Namespaced so it never collides with another extension's widget. */
export const WIDGET_KEY = "classroom-server";

/** The slice of `ctx.ui` this module needs, kept narrow so tests can stub it. */
export interface WidgetHost {
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  theme?: { fg(color: string, text: string): string };
}

let host: WidgetHost | null = null;

/**
 * The widget's lines, or undefined when there is nothing to show.
 *
 * Pure, so the wording is testable without a TUI.
 */
export function statusWidgetLines(
  port: number | null,
  theme?: WidgetHost["theme"],
): string[] | undefined {
  if (port === null) return undefined;
  const paint = (color: string, text: string) => theme?.fg(color, text) ?? text;
  return [
    `${paint("accent", "📚 classroom")} ${paint("dim", "server running on port")} ${paint("accent", String(port))}`,
  ];
}

/** Adopt a session's UI and draw the current state. Pass null to forget it. */
export function attachStatusWidget(ui: WidgetHost | null): void {
  host = ui;
  refreshStatusWidget();
}

/**
 * Redraw (or clear) the widget from the server's live state.
 *
 * Safe to call at any time: with no UI attached, or in a mode with no widgets at all, it
 * does nothing. Reading the port from the server rather than being told it keeps the
 * widget honest when `start()` falls back to an ephemeral port.
 */
export function refreshStatusWidget(): void {
  if (!host) return;
  try {
    host.setWidget(WIDGET_KEY, statusWidgetLines(server.getPort(), host.theme), {
      placement: "belowEditor",
    });
  } catch {
    // A mode without widget support must not take the server down with it.
  }
}

/** Clear the widget and drop the UI reference, on session shutdown. */
export function detachStatusWidget(): void {
  if (host) {
    try {
      host.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* nothing to clear */
    }
  }
  host = null;
}
