#!/usr/bin/env node
// Best-practice review (#86): recommendations for how the repo is built, each from an
// official source read now and evidence in the repo; kept as records of the BEST task.
//
//   npm run best -- [repo] [--pillars deps,security,testing] [--refresh-sources] [--budget 1.5]
//
// Runs Claude (sonnet) once for the source map (first time, or --refresh-sources) and
// once per pillar, in parallel; each call stops at --budget dollars.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { repoRoot } = require("../vscode/review-state.js");
const { review, PILLARS, proseLang } = require("../vscode/best-practice.js");

const argv = process.argv.slice(2);
const opt = (flag) => {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const pillars = opt("--pillars")?.split(",") ?? Object.keys(PILLARS);
const budget = Number(opt("--budget") ?? 1.5);
const refreshSources = argv.includes("--refresh-sources");
const bad = pillars.filter((p) => !(p in PILLARS));
const rest = argv.filter((a) => !a.startsWith("--"));
if (bad.length || !(budget > 0) || argv.some((a) => a.startsWith("--") && a !== "--refresh-sources")) {
  console.error(`usage: npm run best -- [repo] [--pillars ${Object.keys(PILLARS).join(",")}] [--refresh-sources] [--budget 1.5]`);
  process.exit(2);
}
const root = repoRoot(path.resolve(rest[0] ?? process.cwd()));
if (!root) {
  console.error(`${rest[0] ?? process.cwd()}: not inside a git repo`);
  process.exit(1);
}
const db = require("../vscode/db.js").openDb();
const t0 = Date.now();
try {
  const r = await review(db, root, { pillars, refreshSources, budget, lang: proseLang(), progress: (m) => console.log(`… ${m}`) });
  for (const p of r.pillars) console.log(`  ${p.pillar}: ${p.proposed} proposed, $${p.cost.toFixed(2)}${p.error ? `, ERROR ${p.error}` : ""}`);
  for (const d of r.dropped) console.log(`  dropped ${d.pillar} ${d.key}: ${d.why.join("; ")}`);
  console.log(`${root}: ${r.components} components; ${r.kept} kept, ${r.added} new, ${r.refreshed} refreshed, ${r.dismissed} dismissed; $${r.cost.toFixed(2)}, ${Math.round((Date.now() - t0) / 1000)} s`);
  console.log(`BEST: ${r.summary}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
