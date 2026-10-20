#!/usr/bin/env node
// A file only the model can judge as a task's analysis or not (vscode/analysis.js onEdit),
// started detached by the PostToolUse hook so the hook stays quick:
//
//   node hooks/analysis.mjs <repo root> <path> [session] [branch] [at]
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [root, rel, session, branch, at] = process.argv.slice(2);
try {
  const a = require("../vscode/analysis.js");
  const db = require("../vscode/db.js").openDb();
  const repo = db.repoByRoot(root);
  const text = repo && rel ? fs.readFileSync(a.absPath(root, rel), "utf8") : undefined;
  if (text !== undefined) {
    await a.handle(db, repo.id, root, {
      rel, text, session: session || undefined, branch: branch || undefined, at: Number(at) || Date.now(), actor: { kind: "hook", id: session || undefined },
    });
  }
  db.close();
} catch (e) {
  process.stderr.write(`imprimatur analysis: ${e instanceof Error ? e.message : e}\n`);
}
process.exit(0);
