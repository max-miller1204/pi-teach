/**
 * shell.js — behaviour for the landing, classroom, and document pages.
 *
 * Deliberately tiny: these pages are navigation, and everything interesting happens
 * inside a lesson (see classroom.js).
 */

import { initLinks } from "./links.mjs";
import { initTheme } from "./theme.mjs";

initTheme();
initLinks();
