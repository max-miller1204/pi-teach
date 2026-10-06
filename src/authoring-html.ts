/** Read quoted HTML attributes without ending a tag inside an attribute value. */
export const TAG_ATTRIBUTES = String.raw`(?:[^"'<>]|"[^"]*"|'[^']*')*`;

export function htmlAttributes(text: string): Map<string, string> {
  return new Map(
    [...text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [
      a[1].toLowerCase(),
      a[2] ?? a[3],
    ]),
  );
}

export function authoringContent(html: string): string {
  return html.replace(
    new RegExp(
      `<!--[\\s\\S]*?-->|<(script|style)\\b${TAG_ATTRIBUTES}>[\\s\\S]*?<\\/\\1\\s*>`,
      "gi",
    ),
    "",
  );
}
