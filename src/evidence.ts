/** Evidence context is separate from credit. Missing history stays unknown. */
import type { Objective, QuestionPlan } from "./teaching-plan.ts";

export const ASSISTANCE = ["none", "hint", "solution", "unknown"] as const;
export type Assistance = (typeof ASSISTANCE)[number];
export interface PerformanceEvidence {
  objectiveId: string;
  objective: Objective;
  task: QuestionPlan["task"];
  support: QuestionPlan["support"];
  assistance: Assistance;
}
export function isAssistance(value: unknown): value is Assistance {
  return ASSISTANCE.includes(value as Assistance);
}
export function independent(evidence: PerformanceEvidence | undefined): boolean {
  return evidence?.support === "independent" && evidence.assistance === "none";
}
export type EvidenceContext =
  "unknown" | "assisted" | "immediate-independent" | "delayed-retrieval" | "delayed-transfer";
export function evidenceContext(
  evidence: PerformanceEvidence | undefined,
  elapsedMs: number,
): EvidenceContext {
  if (!evidence || evidence.assistance === "unknown") return "unknown";
  if (!independent(evidence)) return "assisted";
  if (elapsedMs < 24 * 60 * 60 * 1000) return "immediate-independent";
  return evidence.task === "transfer" ? "delayed-transfer" : "delayed-retrieval";
}
