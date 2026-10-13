/** Read authored questions for authoring diagnostics. Runtime validation stays separate. */
import {
  isQuestionType,
  isQuizKind,
  QUESTION_TYPES,
  type QuestionType,
  type QuestionShape,
} from "../assets/runtime/quiz.mjs";
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

/** Read the same control shapes that the browser validates before hydration. */
export function authoredQuestionShapes(html: string): QuestionShape[] {
  interface Element {
    tag: string;
    attributes: Map<string, string>;
    parent: Element | null;
    children: Element[];
  }
  const root: Element = { tag: "root", attributes: new Map(), parent: null, children: [] };
  const stack = [root];
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  const tags = new RegExp(`<(/?)([a-z][\\w-]*)\\b(${TAG_ATTRIBUTES})>`, "gi");
  for (const match of authoringContent(html).matchAll(tags)) {
    const tag = match[2].toLowerCase();
    if (stack.at(-1)!.tag === "textarea" && !(match[1] && tag === "textarea")) continue;
    if (match[1]) {
      const index = stack.map((element) => element.tag).lastIndexOf(tag);
      if (index > 0) stack.length = index;
    } else {
      const parent = stack.at(-1)!;
      const element: Element = { tag, attributes: htmlAttributes(match[3]), parent, children: [] };
      parent.children.push(element);
      if (!voidTags.has(tag)) stack.push(element);
    }
  }
  const hasClass = (element: Element, name: string) =>
    element.attributes.get("class")?.split(/\s+/).includes(name) === true;
  const descendants = (element: Element): Element[] =>
    element.children.flatMap((child) => [
      child,
      ...(child.tag === "template" ? [] : descendants(child)),
    ]);
  return descendants(root)
    .filter((element) => hasClass(element, "cl-q"))
    .map((question) => {
      let form = question.parent;
      while (form && form.tag !== "form") form = form.parent;
      if (!form || !hasClass(form, "cl-quiz"))
        throw new Error("An authored question needs a quiz form.");
      const kind = form.attributes.get("data-kind") ?? "check";
      if (!isQuizKind(kind)) throw new Error(`Invalid quiz kind: ${kind}.`);
      const elements = descendants(question);
      const count = (probe: (element: Element) => boolean) => elements.filter(probe).length;
      const inputType = (element: Element, type: string) =>
        element.tag === "input" && element.attributes.get("type")?.toLowerCase() === type;
      const options = elements.filter(
        (element) => inputType(element, "radio") || inputType(element, "checkbox"),
      );
      const ids = (list: string) =>
        elements
          .filter(
            (element) => element.tag === "li" && element.parent && hasClass(element.parent, list),
          )
          .map((element) => element.attributes.get("data-item") ?? "");
      return {
        id: question.attributes.get("data-question-id") ?? null,
        type: question.attributes.get("data-type") ?? null,
        kind,
        reviewOf: question.attributes.get("data-review-of") ?? null,
        select: question.attributes.get("data-select") ?? null,
        hasStimulus: elements.some((element) => hasClass(element, "cl-q-stimulus")),
        hasCloze: elements.some((element) => hasClass(element, "cl-cloze")),
        radios: count((element) => inputType(element, "radio")),
        checkboxes: count((element) => inputType(element, "checkbox")),
        textInputs: count(
          (element) =>
            element.tag === "input" &&
            (inputType(element, "text") || !element.attributes.has("type")) &&
            !element.attributes.has("data-blank") &&
            !hasClass(element, "cl-number") &&
            !hasClass(element, "cl-unit"),
        ),
        textareas: count((element) => element.tag === "textarea"),
        numbers: count((element) => element.tag === "input" && hasClass(element, "cl-number")),
        units: count((element) => hasClass(element, "cl-unit")),
        options: options.map((element) => element.attributes.get("value") ?? null),
        blanks: elements
          .filter((element) => element.tag === "input" && element.attributes.has("data-blank"))
          .map((element) => element.attributes.get("data-blank")!),
        orderItems: ids("cl-order"),
        matchLeft: ids("cl-match-left"),
        matchRight: ids("cl-match-right"),
        segments: elements
          .filter((element) => {
            if (!element.attributes.has("data-segment")) return false;
            let parent = element.parent;
            while (parent && parent !== question) {
              if (hasClass(parent, "cl-q-stimulus")) return true;
              parent = parent.parent;
            }
            return false;
          })
          .map((element) => element.attributes.get("data-segment")!),
      };
    });
}
