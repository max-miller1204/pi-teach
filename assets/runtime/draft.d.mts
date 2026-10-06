/**
 * Types for draft.mjs: hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by the server and vitest.
 */

export type DraftKind = "quiz" | "reflect" | "followup" | "ask" | "teacher";

export declare const MAX_DRAFT_TEXT: number;

export declare function isDraftKey(value: unknown): value is string;
export declare function draftKind(key: string): DraftKind;
export declare function draftId(key: string): string | null;
export declare function draftErrors(key: unknown, value: unknown): string[];
