/** Read authored questions for authoring diagnostics. Runtime validation stays separate. */
import { isQuestionType, QUESTION_TYPES, type QuestionType } from "../assets/runtime/quiz.mjs";
import { authoringContent, htmlAttributes, TAG_ATTRIBUTES } from "./authoring-html.ts";

/** One `.cl-q` element as written, before any check. */
export interface AuthoredQuestion {
  id: string | null;
  type: string | null;
  reviewOf?: string;
}

/** The authored quiz identities used by the server's assessment contract. */
export function authoredQuizzes(
  html: string,
): Array<{ id: string | null; kind: string; questions: AuthoredQuestion[] }> {
  const source = authoringContent(html);
  return [
    ...source.matchAll(new RegExp(`<form\\b(${TAG_ATTRIBUTES})>([\\s\\S]*?)<\\/form\\s*>`, "gi")),
  ].flatMap((form) => {
    const attributes = htmlAttributes(form[1]);
    if (!attributes.get("class")?.split(/\s+/).includes("cl-quiz")) return [];
    return [
      {
        id: attributes.get("data-quiz-id") ?? null,
        kind: attributes.get("data-kind") ?? "check",
        questions: authoredQuestions(form[2]),
      },
    ];
  });
}

export function authoredQuestions(html: string): AuthoredQuestion[] {
  const questions: AuthoredQuestion[] = [];
  const source = authoringContent(html);
  for (const tag of source.matchAll(new RegExp(`<[a-z][\\w-]*\\b(${TAG_ATTRIBUTES})>`, "gi"))) {
    const attributes = htmlAttributes(tag[1]);
    if (!attributes.get("class")?.split(/\s+/).includes("cl-q")) continue;
    questions.push({
      id: attributes.get("data-question-id") ?? null,
      type: attributes.get("data-type") ?? null,
      ...(attributes.has("data-review-of") ? { reviewOf: attributes.get("data-review-of") } : {}),
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
    `- **Quiz format check:** All ${types.length} authored questions use short. Check the mental task and answer cues. Keep short when it fits. The nine types are capabilities, not a variety quota. This is an authoring diagnostic, not a submission error.`,
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
