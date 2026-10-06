/** Validate private objective mappings. These checks do not judge question quality. */
import { isContractId } from "../assets/runtime/quiz.mjs";
import { authoringContent, htmlAttributes, TAG_ATTRIBUTES } from "./authoring-html.ts";
import { authoredQuizzes } from "./quiz-authoring.ts";
import { stageLesson } from "./pretest.ts";

export const MENTAL_TASKS = [
  "prediction",
  "explanation",
  "attempted-solution",
  "retrieval",
  "application",
  "method-choice",
  "diagnosis",
  "justification",
  "transfer",
] as const;
export interface Objective {
  statement: string;
  application: boolean;
  /** Desired retention duration, not a deadline. Omit when the learner has no goal. */
  retentionDays?: number;
  /** Related strategies that require selection. Keep these labels private. */
  interleaveGroup?: string;
  strategy?: string;
}
export interface QuestionPlan {
  objective: string;
  task: (typeof MENTAL_TASKS)[number];
  support: "independent" | "assisted";
  /** Element id inside this pretest's teaching gate. */
  teaching?: string;
}
export interface TeachingPlan {
  version: 1;
  objectives: Record<string, Objective>;
  quizzes: Record<
    string,
    {
      purpose: "prequestion" | "prerequisite" | "prior-retrieval" | "assessment";
      questions: Record<string, QuestionPlan>;
    }
  >;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseTeachingPlan(text: string, html: string): TeachingPlan {
  const plan = object(JSON.parse(text), "Teaching plan");
  if (plan.version !== 1) throw new Error("Teaching plan needs version 1.");
  const objectives = object(plan.objectives, "Teaching objectives");
  if (!Object.keys(objectives).length) throw new Error("Teaching plan needs an objective.");
  for (const [id, raw] of Object.entries(objectives)) {
    const o = object(raw, `Objective ${id}`);
    if (!isContractId(id) || !nonempty(o.statement) || typeof o.application !== "boolean")
      throw new Error(`Objective ${id} needs a valid id, statement, and application flag.`);
    if (
      o.retentionDays !== undefined &&
      (typeof o.retentionDays !== "number" ||
        !Number.isFinite(o.retentionDays) ||
        o.retentionDays < 1)
    )
      throw new Error(`Objective ${id} needs positive retentionDays of at least 1.`);
    if (
      (o.interleaveGroup === undefined) !== (o.strategy === undefined) ||
      (o.strategy !== undefined && (!nonempty(o.strategy) || !nonempty(o.interleaveGroup)))
    )
      throw new Error(`Objective ${id} needs both interleaveGroup and strategy.`);
  }
  const mappings = object(plan.quizzes, "Teaching quiz mappings");
  const quizzes = authoredQuizzes(html);
  const stage = stageLesson(html, new Set());
  const assessed = new Set<string>();
  const prequestioned = new Set<string>();
  for (const quiz of quizzes) {
    const mapping = object(mappings[quiz.id!], `Mapping for quiz ${quiz.id}`);
    const purpose = mapping.purpose;
    if (!["prequestion", "prerequisite", "prior-retrieval", "assessment"].includes(String(purpose)))
      throw new Error(`Quiz ${quiz.id} needs an explicit purpose.`);
    const gated = stage.gatedPretests.includes(quiz.id!);
    if (gated && purpose !== "prequestion")
      throw new Error(`Gated pretest ${quiz.id} must ask about the upcoming lesson.`);
    if ((purpose === "prequestion" || purpose === "prerequisite") && quiz.kind !== "pretest")
      throw new Error(`Quiz ${quiz.id} must use kind pretest for ${purpose}.`);
    if (quiz.kind === "pretest" && purpose === "assessment")
      throw new Error(`Pretest ${quiz.id} needs a prequestion or diagnostic purpose.`);
    const questions = object(mapping.questions, `Questions for ${quiz.id}`);
    for (const question of quiz.questions) {
      const where = `${quiz.id}/${question.id}`;
      const q = object(questions[question.id!], `Mapping for ${where}`);
      if (typeof q.objective !== "string" || !Object.hasOwn(objectives, q.objective))
        throw new Error(`Question ${where} names no objective.`);
      if (
        !MENTAL_TASKS.includes(q.task as QuestionPlan["task"]) ||
        !["independent", "assisted"].includes(String(q.support))
      )
        throw new Error(`Question ${where} needs a mental task and support level.`);
      if (purpose === "prequestion") {
        if (!["prediction", "explanation", "attempted-solution"].includes(String(q.task)))
          throw new Error(
            `Prequestion ${where} must invite a prediction, explanation, or attempted solution.`,
          );
        prequestioned.add(q.objective);
        if (gated) {
          if (!isContractId(q.teaching))
            throw new Error(`Prequestion ${where} needs a teaching target.`);
          const initial = authoringContent(stage.html);
          const released = authoringContent(stageLesson(html, new Set([quiz.id!])).html);
          const hasId = (source: string) =>
            [...source.matchAll(new RegExp(`<[^/!][\\w-]*\\b(${TAG_ATTRIBUTES})>`, "gi"))].filter(
              (tag) => htmlAttributes(tag[1]).get("id") === q.teaching,
            ).length;
          if (hasId(initial) || hasId(released) !== 1)
            throw new Error(
              `Prequestion ${where} needs one teaching target inside its gate: ${q.teaching}.`,
            );
        }
      } else if (quiz.kind !== "pretest" && purpose === "assessment") assessed.add(q.objective);
    }
    if (Object.keys(questions).some((id) => !quiz.questions.some((q) => q.id === id)))
      throw new Error(`Quiz ${quiz.id} has a mapping for an unknown question.`);
  }
  if (Object.keys(mappings).some((id) => !quizzes.some((q) => q.id === id)))
    throw new Error("Teaching plan maps an unknown quiz.");
  if (stage.gatedPretests.length) {
    for (const id of Object.keys(objectives)) {
      if (!prequestioned.has(id) || !assessed.has(id))
        throw new Error(
          `Upcoming objective ${id} needs a prequestion and a post-teaching assessment.`,
        );
    }
  }
  return plan as unknown as TeachingPlan;
}
