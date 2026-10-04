/** Read authored questions for authoring diagnostics. Runtime validation stays separate. */
import { isQuestionType, QUESTION_TYPES, type QuestionType } from "../assets/runtime/quiz.mjs";

/** One `.cl-q` element as written, before any check. */
export interface AuthoredQuestion {
  id: string | null;
  type: string | null;
}

export function authoredQuestions(html: string): AuthoredQuestion[] {
  const questions: AuthoredQuestion[] = [];
  const source = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  for (const tag of source.matchAll(/<[a-z][\w-]*\b([^<>]*)>/gi)) {
    const attributes = new Map<string, string>();
    for (const attr of tag[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(attr[1].toLowerCase(), attr[2] ?? attr[3]);
    }
    if (!attributes.get("class")?.split(/\s+/).includes("cl-q")) continue;
    questions.push({
      id: attributes.get("data-question-id") ?? null,
      type: attributes.get("data-type") ?? null,
    });
  }
  return questions;
}

export function authoredQuestionTypes(html: string): QuestionType[] {
  return validTypes(authoredQuestions(html));
}

function validTypes(questions: AuthoredQuestion[]): QuestionType[] {
  return questions.map((q) => q.type).filter((type): type is QuestionType => isQuestionType(type));
}

/** "2 numeric, 1 short": how often each type is used, most used first. */
export function typeCounts(types: QuestionType[]): string {
  const counts = new Map<QuestionType, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || QUESTION_TYPES.indexOf(a[0]) - QUESTION_TYPES.indexOf(b[0]))
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

export function quizDiversityLines(types: QuestionType[]): string[] {
  if (types.length < 3 || !types.every((type) => type === "short")) return [];
  return [
    `- **Quiz format check:** All ${types.length} authored questions use short. Check whether term, numeric, cloze, order, or locate fits the skill. Keep short for explanations. This is an authoring diagnostic, not a submission error.`,
  ];
}

/** Questions the page will refuse: a missing or unknown data-type, such as the scaffold placeholder. */
export function unfinishedQuestionLines(questions: AuthoredQuestion[]): string[] {
  const broken = questions.filter((q) => !isQuestionType(q.type));
  if (broken.length === 0) return [];
  const names = broken.map(
    (q) => `\`${q.id ?? "(no id)"}\` (${q.type === null ? "no data-type" : `"${q.type}"`})`,
  );
  return [
    `- **Unfinished questions:** ${names.join(", ")}. The page refuses this quiz. Choose a type from quiz.html and write the question.`,
  ];
}
