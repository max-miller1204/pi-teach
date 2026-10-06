/** Durable requests and teacher ownership. This file is never served as an asset. */
import * as fs from "node:fs";
import * as path from "node:path";
import { classroomDir, isValidSlug } from "./paths.ts";
import type { TeacherIdentity, TeacherPlan } from "./teacher.ts";

export interface TeacherRequest {
  id: string;
  classroom: string;
  lesson: string;
  kind: "ask" | "follow-up" | "quiz" | "reflect" | "chat";
  target: string;
  turn?: string;
  prompt: string;
  at: number;
  status: "queued" | "running" | "planned" | "done" | "failed";
  error?: string;
  plan?: TeacherPlan;
  applied?: number;
  recordFile?: string;
}
export interface TeacherMessage {
  id: string;
  lesson: string;
  role: "learner" | "teacher";
  text: string;
  at: number;
}
export interface TeacherState {
  version: 1;
  identity: TeacherIdentity;
  requests: TeacherRequest[];
  messages: TeacherMessage[];
}
function file(classroom: string): string {
  if (!isValidSlug(classroom)) throw new Error("Invalid classroom.");
  return path.join(classroomDir(classroom), ".teacher.json");
}
export function readTeacherState(classroom: string): TeacherState | null {
  try {
    const state = JSON.parse(fs.readFileSync(file(classroom), "utf8")) as TeacherState;
    if (
      state.version !== 1 ||
      !["codex", "claude"].includes(state.identity.backend) ||
      !Array.isArray(state.requests) ||
      !Array.isArray(state.messages)
    )
      throw new Error(`Invalid teacher state for ${classroom}.`);
    return state;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
export function saveTeacherState(classroom: string, state: TeacherState): void {
  const target = file(classroom),
    temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}
