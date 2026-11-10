#!/usr/bin/env node
// Moving the old documents to Matt Pocock's model (#185). This first step is the dry run: for every
// repo it lists what goes where and changes nothing. Haiku (the user's Claude subscription through
// `claude -p`, never an API key) sorts each Architecture and Product section and each PDR into
//   project:<mission|constraints|stack|roadmap>  the small project page
//   adr          a decision that passes Pocock's test (hard to reverse, surprising, a real trade-off)
//   glossary     a term and its meaning
//   out-of-scope a concept the project rejected
//   drop         repeats the code, a spec, an ADR, or is no longer true
// Task analyses are all deleted (user decision, 2026-11-10); glossary and decision records stay.
//
//   npm run migrate -- [--repo <name>] [--out <file.json>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
delete process.env.ANTHROPIC_API_KEY;
const { openDb } = require("../vscode/db.js");
const { askModel } = require("../vscode/model.js");

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const only = opt("--repo");
const out = opt("--out") ?? path.join(os.homedir(), ".local", "share", "imprimatur", "migrate", `dry-run-${new Date().toISOString().slice(0, 10)}.json`);
export const TARGETS = ["project:mission", "project:constraints", "project:stack", "project:roadmap", "adr", "glossary", "out-of-scope", "drop"];

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The prompt for one batch of items. @param {string} repo @param {string} what @param {Array<{key: string, title: string, body: string}>} items */
export function promptFor(repo, what, items) {
  return [
    `You sort the old design notes of the software repo "${repo}" into Matt Pocock's model. These are ${what}.`,
    "For each item pick exactly one target:",
    "- project:mission (why the project exists, who it is for), project:constraints (limits that are not visible in the code), project:stack (the technology used), project:roadmap (what comes next): the small project page.",
    "- adr: a decision that is ALL of: hard to reverse, surprising without its context, and the result of a real trade-off.",
    "- glossary: it defines a term of the project.",
    "- out-of-scope: a concept or feature the project decided not to do.",
    "- drop: it repeats what the code, a spec or another note says, it is a log of work done, or it is no longer true.",
    'Answer with JSON only: an array of {"key": "...", "target": "...", "reason": "at most 12 words"}, one per item, in the same order.',
    "",
    JSON.stringify(items.map((i) => ({ key: i.key, title: clip(i.title, 200), body: clip(i.body, 1200) }))),
  ].join("\n");
}

/** The model's JSON array, or undefined. @param {string} text */
export function parseAnswer(text) {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return undefined;
  try {
    const a = JSON.parse(m[0]);
    return Array.isArray(a) ? a.filter((x) => x && typeof x.key === "string" && TARGETS.includes(x.target)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sorts items in batches of `size`, four calls at a time; what got no answer is asked again in
 * batches of two, so one slow or garbled reply does not leave a whole batch unsorted.
 * @returns {Promise<Map<string, {target: string, reason: string}>>}
 */
async function sortItems(repo, what, items, size = 8) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const got = new Map();
  for (let i = 0; i < batches.length; i += 4) {
    const answers = await Promise.all(batches.slice(i, i + 4).map(async (b) => {
      for (let t = 0; t < 2; t++) {
        try {
          const a = parseAnswer(await askModel(promptFor(repo, what, b)));
          if (a) return a;
        } catch {}
      }
      return [];
    }));
    for (const a of answers) for (const x of a) got.set(x.key, { target: x.target, reason: clip(x.reason, 120) });
  }
  const left = items.filter((i) => !got.has(i.key));
  if (left.length && size > 2) for (const [k, v] of await sortItems(repo, what, left, 2)) got.set(k, v);
  return got;
}

async function main() {
  const db = openDb();
  const repos = db.repos().filter((r) => !only || r.name === only);
  const report = { at: new Date().toISOString(), repos: [] };
  for (const repo of repos) {
    const docs = db.q("SELECT * FROM documents WHERE repo_id = ?").all(repo.id);
    const analyses = docs.filter((d) => d.kind === "analysis");
    const sections = [];
    for (const d of docs.filter((x) => x.kind === "architecture" || x.kind === "product")) {
      for (const s of db.docSections(d.id).filter((x) => x.status === "current")) sections.push({ key: `${d.kind}/${s.key}`, title: s.title, body: s.body ?? "" });
    }
    const pdrs = db.q(`SELECT r.* FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND r.kind = 'pdr' AND r.status <> 'dropped'`).all(repo.id)
      .map((r) => ({ key: `pdr/${r.id}`, title: r.title, body: r.body ?? "" }));
    if (!analyses.length && !sections.length && !pdrs.length) continue;
    process.stderr.write(`${repo.name}: ${sections.length} sections, ${pdrs.length} PDRs…\n`);
    const sorted = new Map([...(await sortItems(repo.name, "sections of its Architecture and Product documents", sections)), ...(await sortItems(repo.name, "product decision records (PDRs)", pdrs))]);
    const items = [...sections, ...pdrs].map((i) => ({ key: i.key, title: clip(i.title, 140), ...(sorted.get(i.key) ?? { target: "unsorted", reason: "the model gave no answer" }) }));
    const count = Object.fromEntries([...TARGETS, "unsorted"].map((t) => [t, items.filter((i) => i.target === t).length]).filter(([, n]) => n));
    report.repos.push({
      name: repo.name, root: repo.root,
      delete: { analyses: analyses.length, analysis_sections: analyses.reduce((n, d) => n + db.q("SELECT count(*) n FROM doc_sections WHERE doc_id = ?").get(d.id).n, 0) },
      count, items,
    });
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  for (const r of report.repos) console.log(`${r.name}: delete ${r.delete.analyses} analyses (${r.delete.analysis_sections} sections); ${Object.entries(r.count).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Dry run, nothing changed. Report: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
