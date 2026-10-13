#!/usr/bin/env node
// Project best-practice review (#86, #87): recommendations for how the repo is built,
// by ISO/IEC 25010:2023 and NIST SSDF, from documentation fetched now and evidence in
// the repo; records of the repo's Recommendations task (RECS).
//
//   npm run best -- [repo] [--categories security,reliability,…|all] [--refresh-sources] [--budget 1.5]
//
// Claude (haiku) maps the stack the first time (or with --refresh-sources); code
// fetches the docs; Claude (sonnet) judges one category per call, in parallel.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoRoot } = require("../vscode/review-state.js");
const { review, CATEGORIES, CORE, proseLang } = require("../vscode/best-practice.js");

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const catsArg = opt("--categories");
const categories = !catsArg ? CORE : catsArg === "all" ? Object.keys(CATEGORIES) : catsArg.split(",");
const budget = Number(opt("--budget") ?? 1.5);
const refreshSources = argv.includes("--refresh-sources");
const bad = categories.filter((c) => !(c in CATEGORIES));
const rest = argv.filter((a) => !a.startsWith("--"));
if (bad.length || !(budget > 0) || argv.some((a) => a.startsWith("--") && a !== "--refresh-sources")) {
  console.error(`usage: npm run best -- [repo] [--categories ${Object.keys(CATEGORIES).join(",")}|all] [--refresh-sources] [--budget 1.5]`);
  process.exit(2);
}
const root = repoRoot(path.resolve(rest[0] ?? process.cwd()));
if (!root) {
  console.error(`${rest[0] ?? process.cwd()}: not inside a git repo`);
  process.exit(1);
}
const db = require("../vscode/db.js").openDb();
try {
  const r = await review(db, root, { categories, refreshSources, budget, lang: proseLang(), progress: (m) => console.log(`… ${m}`) });
  for (const c of r.categories) console.log(`  ${c.category}: ${c.proposed} proposed, $${c.cost.toFixed(2)}${c.retried ? " (retried without tools)" : ""}${c.error ? `, ERROR ${c.error}` : ""}`);
  for (const d of r.dropped) console.log(`  dropped ${d.category} ${d.key}: ${d.why.join("; ")}`);
  console.log(`${root}: ${r.components} components, ${r.excerpts} excerpts; ${r.kept} kept (${r.merged} merged), ${r.added} new, ${r.refreshed} refreshed, ${r.dismissed} dismissed; $${r.cost.toFixed(2)}; ${JSON.stringify(Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, Math.round(v / 100) / 10])))} s`);
  console.log(`RECS: ${r.summary}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
