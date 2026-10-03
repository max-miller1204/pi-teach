/**
 * Types for glossary.mjs: hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by the server and vitest.
 */

export interface TermMatch {
  start: number;
  end: number;
  /** Position of the matched term in the `terms` argument. */
  index: number;
}

export declare function findTerms(
  text: string,
  terms: ReadonlyArray<{ forms: string[] }>,
): TermMatch[];

export declare function firstUses(matches: TermMatch[]): TermMatch[];
