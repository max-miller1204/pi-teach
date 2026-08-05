/**
 * Cross-platform "open this URL in the default browser" helper.
 *
 * Best-effort: opening a browser is a convenience, so every failure is swallowed and
 * the caller still reports the URL.
 */

import { spawn } from "node:child_process";

export function openUrl(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* opener missing — ignore */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
