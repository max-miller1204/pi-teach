/** Read question types for authoring diagnostics. Runtime validation stays separate. */
import { isQuestionType, type QuestionType } from "../assets/runtime/quiz.mjs";

export function authoredQuestionTypes(html: string): QuestionType[] {
  const types: QuestionType[] = [];
  const source = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const tag of source.matchAll(/<[a-z][\w-]*\b([^<>]*)>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of tag[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(attr[1].toLowerCase(), attr[2] ?? attr[3]);
    }
    if (!attributes.get("class")?.split(/\s+/).includes("cl-q")) continue;
    const type = attributes.get("data-type");
    if (isQuestionType(type)) types.push(type);
  }
  return types;
}

export function quizDiversityLines(types: QuestionType[]): string[] {
  if (types.length < 3 || !types.every((type) => type === "short")) return [];
  return [
    `- **Quiz format check:** All ${types.length} authored questions use short. Check whether term, numeric, cloze, order, or locate fits the skill. Keep short for explanations. This is an authoring diagnostic, not a submission error.`,
  ];
}
