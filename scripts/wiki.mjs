#!/usr/bin/env node
// The repo's generated wiki (#188): small plain-language pages for a product owner, docs/wiki/README.md
// and one docs/wiki/<feature>.md per capability, written by the model from the project's mission, the
// capabilities and the glossary; a page is written again only when those changed.
//   npm run wiki -- [--force]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
delete process.env.ANTHROPIC_API_KEY;
const { openDb } = require("../vscode/db.js");
const { generatedText, inside } = require("../vscode/docs-export.js");
const { buildWiki, HEADER: header } = require("../vscode/wiki.js");
const { repoRootOf } = require("../vscode/config.js");

const root = repoRootOf(process.cwd());
const db = openDb();
const repo = db.repoOf(root);
const out = await buildWiki(db, repo, root, { header, generatedText, inside: (f) => inside(root, f), force: process.argv.includes("--force"), log: (s) => process.stderr.write(`${s}\n`) });
console.log(out.length ? out.map((f) => `written ${f}`).join("\n") : "wiki up to date");
