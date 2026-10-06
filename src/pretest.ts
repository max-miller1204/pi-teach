/** Remove teaching content until its diagnostic pretest has a grade. */
import { authoringContent, htmlAttributes, TAG_ATTRIBUTES } from "./authoring-html.ts";
export function stageLesson(
  html: string,
  gradedPretests: ReadonlySet<string>,
): { html: string; pendingPretests: string[]; lockedQuizIds: string[] } {
  const pending = new Set<string>();
  const locked = new Set<string>();
  const required = new Set<string>();
  let output = "";
  let cursor = 0;
  let gate: { start: number; content: number; id: string } | null = null;
  let depth = 0;
  const tokens = new RegExp(
    `<!--[\\s\\S]*?-->|<(script|style)\\b${TAG_ATTRIBUTES}>[\\s\\S]*?<\\/\\1\\s*>|<\\/?template\\b${TAG_ATTRIBUTES}>`,
    "gi",
  );
  for (const match of html.matchAll(tokens)) {
    const tag = match[0];
    if (!/^<\/?template\b/i.test(tag)) continue;
    if (/^<\/template/i.test(tag)) {
      if (depth === 0) throw new Error("Unmatched closing template in lesson.");
      depth--;
      if (gate && depth === 0) {
        output += html.slice(cursor, gate.start);
        if (gradedPretests.has(gate.id)) output += html.slice(gate.content, match.index);
        else {
          pending.add(gate.id);
          const content = authoringContent(html.slice(gate.content, match.index));
          for (const form of content.matchAll(new RegExp(`<form\\b${TAG_ATTRIBUTES}>`, "gi"))) {
            const id = htmlAttributes(form[0]).get("data-quiz-id");
            if (id) locked.add(id);
          }
          output +=
            "<p data-cl-pretest-pending>Submit the pretest. The lesson appears after grading.</p>";
        }
        cursor = match.index + tag.length;
        gate = null;
      }
    } else {
      const attribute = htmlAttributes(tag).get("data-cl-after-pretest");
      if (/\bdata-cl-after-pretest\b/i.test(tag) && !attribute)
        throw new Error("data-cl-after-pretest needs a quoted pretest id.");
      if (attribute) {
        if (depth !== 0) throw new Error("A pretest gate cannot be inside another template.");
        const id = attribute;
        if (!/^[\w.-]+$/.test(id)) throw new Error("Invalid pretest id in lesson gate.");
        gate = { start: match.index, content: match.index + tag.length, id };
        required.add(id);
      }
      depth++;
    }
  }
  if (depth !== 0) throw new Error("Unclosed template in lesson.");
  output += html.slice(cursor);
  const source = authoringContent(output);
  const pretests = [...source.matchAll(new RegExp(`<form\\b${TAG_ATTRIBUTES}>`, "gi"))]
    .map((m) => htmlAttributes(m[0]))
    .filter((attributes) => attributes.get("data-kind") === "pretest")
    .map((attributes) => attributes.get("data-quiz-id"));
  for (const id of required) {
    if (pretests.filter((value) => value === id).length !== 1)
      throw new Error(`Pretest gate requires one visible pretest form: ${id}.`);
  }
  return { html: output, pendingPretests: [...pending], lockedQuizIds: [...locked] };
}
