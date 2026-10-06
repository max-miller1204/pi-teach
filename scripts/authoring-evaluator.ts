/** Run a separate semantic evaluator on generated content. Keep its raw plan. */
import * as fs from "node:fs";
import {
  contentEvaluationPrompt,
  parseContentJudgments,
  type AuthoredContent,
} from "../src/authoring-evaluation.ts";
import { runTeacher, type Backend } from "../src/teacher.ts";
export async function evaluateContent(
  backend: Backend,
  cwd: string,
  content: AuthoredContent,
  rawArtifact?: string,
) {
  const raw = await runTeacher({ backend }, contentEvaluationPrompt(content), cwd, () => {});
  if (rawArtifact) fs.writeFileSync(rawArtifact, JSON.stringify(raw, null, 2));
  if (raw.calls.length || raw.learning_record || raw.notes_markdown)
    throw new Error("Content evaluator must not request writes or learning records.");
  return {
    raw,
    judgments: parseContentJudgments(raw.message, content),
    kind: "agent-adherence",
    humanLearningEvidence: false,
  };
}
