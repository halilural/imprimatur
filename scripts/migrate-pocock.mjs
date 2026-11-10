#!/usr/bin/env node
// Moving the old documents to Matt Pocock's model (#185). This first step is the dry run: for every
// repo it lists what goes where and changes nothing. Haiku (the user's Claude subscription through
// `claude -p`, never an API key) sorts each Architecture and Product section and each PDR into
//   project:<mission|constraints|stack|roadmap>  the small project page
//   capability   how a feature works today (docs/capabilities/<name>.md, OpenSpec style)
//   spec         the target state of an issue still open: it goes into that task's spec
//   adr          a decision that passes Pocock's test (hard to reverse, surprising, a real trade-off)
//   glossary     a term and its meaning
//   out-of-scope a concept the project rejected
//   drop         repeats the code, a spec, an ADR, or is no longer true
// Task analyses are all deleted (user decision, 2026-11-10); glossary and decision records stay.
//
//   npm run migrate -- [--repo <name>] [--out <file.json>]          the dry run: a report, nothing changed
//   npm run migrate -- --apply <report.json> [--repo <name>]        moves what an approved report says
// Apply backs the database up first (VACUUM INTO, beside it), then per repo in one transaction: every
// item is copied to its target, its source marked superseded (a section) or dropped (a PDR moved
// elsewhere; a PDR that is an ADR only changes kind), analyses are marked superseded, and the repo is
// marked migrated so a second apply skips it. Superseded and dropped are reversible and sync as edits.
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
export const TARGETS = ["project:mission", "project:constraints", "project:stack", "project:roadmap", "capability", "spec", "adr", "glossary", "out-of-scope", "drop"];

const slugOf = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "general";
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** The prompt for one batch of items. @param {string} repo @param {string} what @param {Array<{key: string, title: string, body: string, issue?: string}>} items */
export function promptFor(repo, what, items) {
  return [
    `You sort the old design notes of the software repo "${repo}" into Matt Pocock's model. These are ${what}.`,
    "For each item pick exactly one target:",
    "- project:mission (why the project exists, who it is for), project:constraints (limits that are not visible in the code), project:stack (the technology used), project:roadmap (one line of what comes next for the whole project, never a single feature): the small project page.",
    "- capability: how a feature of the product works today, its current behaviour (shipped, or its issue is done). Also give \"name\": a short kebab-case name of the capability (e.g. meeting-notes), the same name for items about the same feature.",
    "- spec: the target state or plan of a feature whose issue is still open (\"issue\" says open or active).",
    "- adr: a decision that is ALL of: hard to reverse, surprising without its context, and the result of a real trade-off between named options. A description of how something works is a capability, not an adr; expect few adrs.",
    "- glossary: it defines a term of the project.",
    "- out-of-scope: a concept or feature the project decided not to do.",
    "- drop: it repeats what the code, a spec or another note says, it is a log of work done, or it is no longer true.",
    'Answer with JSON only: an array of {"key": "...", "target": "...", "name": "only for capability", "reason": "at most 12 words"}, one per item, in the same order.',
    "",
    JSON.stringify(items.map((i) => ({ key: i.key, title: clip(i.title, 200), ...(i.issue && { issue: i.issue }), body: clip(i.body, 1200) }))),
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
    for (const a of answers) for (const x of a) got.set(x.key, { target: x.target, ...(x.target === "capability" && { name: slugOf(x.name) }), reason: clip(x.reason, 120) });
  }
  const left = items.filter((i) => !got.has(i.key));
  if (left.length && size > 2) for (const [k, v] of await sortItems(repo, what, left, 2)) got.set(k, v);
  return got;
}

const ACTOR = { kind: "agent", id: "migrate-pocock" };
const PLACE = { "project:mission": ["project", "mission"], "project:constraints": ["project", "constraints"], "project:stack": ["project", "stack"],
  "project:roadmap": ["project", "roadmap"], glossary: ["glossary"], "out-of-scope": ["out-of-scope"] };

/** A section key not yet used in the document. @param {any} db @param {number} docId @param {string} want */
function freeKey(db, docId, want) {
  const base = slugOf(want).slice(0, 60);
  let key = base;
  for (let n = 2; db.docSection(docId, key); n++) key = `${base}-${n}`;
  return key;
}

/**
 * Moves one repo's items to their targets (see the header). Returns the counts of what was written.
 * @param {any} db @param {{id: number, name: string}} repo @param {Array<{key: string, target: string, name?: string, task?: string}>} items
 */
export function applyRepo(db, repo, items) {
  const mark = `pocock-migrated:${repo.id}`;
  if (db.meta(mark)) return { skipped: true };
  return db.tx(() => {
    const done = {};
    const count = (t) => (done[t] = (done[t] ?? 0) + 1);
    for (const item of items) {
      const [from, ref] = item.key.split("/");
      const src = from === "pdr" ? db.record(Number(ref)) : (() => {
        const doc = db.docFind(repo.id, from);
        return doc && db.docSection(doc.id, ref) && { ...db.docSection(doc.id, ref), doc_id: doc.id };
      })();
      if (!src) throw new Error(`${repo.name}: ${item.key} is gone since the dry run`);
      const title = src.title, body = src.body ?? null;
      let target = item.target;
      if (target === "unsorted") target = "drop";
      if (target === "adr" && from === "pdr") {
        db.updateRecord(src.id, { kind: "adr" }, ACTOR);
        count("adr");
        continue;
      }
      if (target === "adr") {
        const task = db.upsertTask(repo.id, item.task ?? "pocock-migration", item.task ? {} : { title: "Moved from the old Architecture and Product documents (#185)", status: "done" }, ACTOR);
        db.addRecord(task.id, { kind: "adr", status: "done", title, body, links: { from: item.key } }, ACTOR);
      } else if (target === "capability" || target === "spec") {
        const doc = target === "spec" ? db.taskDocOf(repo.id, item.task, "spec") : db.taskDocOf(repo.id, item.name || "general", "capability");
        db.upsertSection(doc.id, freeKey(db, doc.id, ref === String(Number(ref)) ? title : ref), { title, body, ...(target === "spec" && { chapter: "notes" }) }, ACTOR);
      } else if (PLACE[target]) {
        const [kind, chapter] = PLACE[target];
        const doc = db.docOf(repo.id, kind);
        db.upsertSection(doc.id, freeKey(db, doc.id, ref === String(Number(ref)) ? title : ref), { title, body, ...(chapter && { chapter }) }, ACTOR);
      } else if (target !== "drop") throw new Error(`${repo.name}: ${item.key} has an unknown target ${target}`);
      count(target);
      if (from === "pdr") db.updateRecord(src.id, { status: "dropped", links: { ...(src.links ?? {}), moved: target } }, ACTOR);
      else db.upsertSection(src.doc_id, ref, { status: "superseded" }, ACTOR);
    }
    for (const d of db.q("SELECT id FROM documents WHERE repo_id = ? AND kind = 'analysis'").all(repo.id)) {
      for (const s of db.docSections(d.id).filter((x) => x.status === "current")) {
        db.upsertSection(d.id, s.key, { status: "superseded" }, ACTOR);
        count("analysis superseded");
      }
    }
    db.setMeta(mark, new Date().toISOString());
    return done;
  });
}

async function apply(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const db = openDb();
  const backup = `${db.file}.before-185-${Date.now()}`;
  db.q("VACUUM INTO ?").run(backup);
  console.log(`Backup: ${backup}`);
  for (const r of report.repos.filter((x) => !only || x.name === only)) {
    const repo = db.repos().find((x) => x.root === r.root);
    if (!repo) {
      console.log(`${r.name}: not in this database, skipped`);
      continue;
    }
    const got = applyRepo(db, repo, r.items);
    console.log(`${r.name}: ${got.skipped ? "already migrated, skipped" : Object.entries(got).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
}

async function main() {
  if (opt("--apply")) return apply(opt("--apply"));
  const db = openDb();
  const repos = db.repos().filter((r) => !only || r.name === only);
  const report = { at: new Date().toISOString(), repos: [] };
  for (const repo of repos) {
    const docs = db.q("SELECT * FROM documents WHERE repo_id = ?").all(repo.id);
    // A section names its issue in its title, "(#788)": the issue and its status tell spec from capability.
    const issueOf = (title) => {
      const k = /\(#(\d+)/.exec(title)?.[1];
      const t = k && db.taskByKey(repo.id, `#${k}`);
      return t ? { task: t.key, issue: `${t.key} ${t.status}` } : {};
    };
    const analyses = docs.filter((d) => d.kind === "analysis");
    const sections = [];
    for (const d of docs.filter((x) => x.kind === "architecture" || x.kind === "product")) {
      for (const s of db.docSections(d.id).filter((x) => x.status === "current")) sections.push({ key: `${d.kind}/${s.key}`, title: s.title, body: s.body ?? "", ...issueOf(s.title) });
    }
    const pdrs = db.q(`SELECT r.*, t.key AS task_key, t.status AS task_status FROM records r JOIN tasks t ON t.id = r.task_id WHERE t.repo_id = ? AND r.kind = 'pdr' AND r.status <> 'dropped'`).all(repo.id)
      .map((r) => ({ key: `pdr/${r.id}`, title: r.title, body: r.body ?? "", task: r.task_key, issue: `${r.task_key} ${r.task_status}` }));
    if (!analyses.length && !sections.length && !pdrs.length) continue;
    process.stderr.write(`${repo.name}: ${sections.length} sections, ${pdrs.length} PDRs…\n`);
    const sorted = new Map([...(await sortItems(repo.name, "sections of its Architecture and Product documents", sections)), ...(await sortItems(repo.name, "product decision records (PDRs)", pdrs))]);
    const items = [...sections, ...pdrs].map((i) => ({ key: i.key, title: clip(i.title, 140), ...(i.task && { task: i.task }), ...(sorted.get(i.key) ?? { target: "unsorted", reason: "the model gave no answer" }) }));
    // A spec needs the task it belongs to; one with no task is the task-less plan of a roadmap line.
    for (const i of items) if (i.target === "spec" && !i.task) i.target = "project:roadmap";
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
