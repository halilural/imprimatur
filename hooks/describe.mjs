#!/usr/bin/env node
// Describe one agent edit by hand (the graph does it on its own when it shows
// the edit, #63; vscode/describe.js):
//
//   node describe.mjs <root> <file relative to root> <toolUseId | #n> [language]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
export const { DESCRIPTIONS, diffText, promptFor, cleanSentence, editTexts, describe, askModel } = require("../vscode/describe.js");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, file, toolUseId, lang = "English"] = process.argv.slice(2);
  describe(root, file, toolUseId, lang)
    .catch((e) => process.stderr.write(`imprimatur describe: ${e.message}\n`))
    .finally(() => process.exit(0));
}
