#!/usr/bin/env node
// Copies shared-browser/formUtils.js into extension/shared/ -- Chrome only
// loads extension files from inside the extension's own directory, so this
// keeps the extension's copy in sync with the single source of truth used
// by Playwright (src/apply/formFields.ts loads shared-browser/ directly).
// Run this after editing shared-browser/formUtils.js, then reload the
// extension in chrome://extensions.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "shared-browser", "formUtils.js");
const dest = join(root, "extension", "shared", "formUtils.js");

copyFileSync(src, dest);
console.log(`Synced ${src} -> ${dest}`);
