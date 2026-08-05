/**
 * Types for anchor.mjs — hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by vitest.
 */

/** W3C-style text-quote selector: the quoted text plus context on each side. */
export interface TextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
  /** Index of this occurrence of `exact` within the document, 0-based. */
  occurrence: number;
}

export interface SelectorMatch {
  start: number;
  end: number;
  /** True when the surrounding context matched in full, not just the quoted text. */
  exact: boolean;
}

export declare const CONTEXT_LENGTH: number;

export declare function createSelector(text: string, start: number, end: number): TextQuoteSelector;

export declare function findSelector(
  text: string,
  selector: TextQuoteSelector,
): SelectorMatch | null;

export declare function normalizeText(value: string): string;
