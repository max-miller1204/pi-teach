/**
 * Types for diagrams.mjs. Hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by vitest.
 */

export declare function dedentSource(text: string): string;

export declare function diagramSource(element: Element): string;

export declare function initDiagrams(root: ParentNode): Promise<void>;
