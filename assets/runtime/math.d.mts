/**
 * Types for math.mjs. Hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by vitest.
 */

export type MathPart =
  { text: string } | { tex: string; display: boolean } | { error: string; source: string };

export declare function splitMath(text: string): MathPart[];

export declare function mathSource(element: HTMLElement): string;

export declare function swapMathForSource(root: ParentNode): () => void;

export declare function initMath(root: ParentNode): Promise<void>;
