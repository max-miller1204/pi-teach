/**
 * Types for links.mjs — hand-written because this repo has no build step and the
 * module has to stay loadable by a bare browser as well as by vitest.
 */

export declare function opensInNewTab(href: string, origin: string): boolean;

export declare function initLinks(): void;
