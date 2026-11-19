// @ts-check
// The fix engine (#230, epic #229): a fix run and applied with no UI. The agent's answer is parsed
// and planned by fix-edits.js (target files only, old text found once); every file is copied to
// the autopilot's backup folder before it is written and gets a line in the undo log, so any one
// change can be put back. Fix it in the panel applies through here after its diff confirmation;
// the autopilot (#231) calls runFix with no confirmation. The agent run is injected (`run`), so
// tests never start Claude.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parseEdits, planEdits, parseDismissals } = require("./fix-edits.js");

/** The autopilot's folder next to Imprimatur's database: backups and the undo log, shared by every repo. */
const autopilotDir = (env = process.env) => path.join(path.dirname(require("./db.js").dbPath(env)), "autopilot");
const logOf = (dir) => path.join(dir, "undo.jsonl");

/**
 * @typedef {{prompt: string, label: string, edit: string[], whole?: string[], records?: any[]}} Fix
 * @typedef {{run: string, at: string, label: string, file: string, backup: string | null, created: boolean, after: string, undone?: boolean}} UndoLine
 */

/**
 * Writes a planned fix: each file only if it still holds the text the plan was made from (a new
 * one only if still missing), after a backup. canWrite(file) can refuse a file (a whole-file
 * target with a link on its way).
 * @param {{files: Map<string, {before: string, after: string, created?: boolean}>}} plan
 * @param {{dir: string, runId: string, label: string, at?: string, canWrite?: (file: string) => boolean}} o
 * @returns {{applied: UndoLine[], skipped: Array<{file: string, why: string}>}}
 */
function applyPlan(plan, { dir, runId, label, at = new Date().toISOString(), canWrite = () => true }) {
  const applied = [], skipped = [];
  const backups = path.join(dir, "backups", runId);
  if (plan.files.size) fs.mkdirSync(dir, { recursive: true });
  for (const [file, c] of plan.files) {
    if (!canWrite(file)) {
      skipped.push({ file, why: "not a safe place to write" });
      continue;
    }
    try {
      let backup = null;
      if (c.created) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, c.after, { flag: "wx" });
      } else {
        if (fs.readFileSync(file, "utf8") !== c.before) {
          skipped.push({ file, why: "changed since Claude read it" });
          continue;
        }
        fs.mkdirSync(backups, { recursive: true });
        backup = path.join(backups, `${applied.length + skipped.length + 1}-${path.basename(file)}`);
        fs.writeFileSync(backup, c.before);
        fs.writeFileSync(file, c.after);
      }
      /** @type {UndoLine} */
      const line = { run: runId, at, label, file, backup, created: !!c.created, after: c.after };
      fs.appendFileSync(logOf(dir), JSON.stringify(line) + "\n");
      applied.push(line);
    } catch (e) {
      skipped.push({ file, why: `could not be written: ${e instanceof Error ? e.message : e}` });
    }
  }
  return { applied, skipped };
}

/**
 * Runs a fix and applies it: the agent's answer through run(prompt), its edits planned and written
 * with backups. A failed run applies nothing.
 * @param {Fix} fix
 * @param {{run: (prompt: string) => Promise<{code: number | null, stdout: string, stderr: string}>, dir: string, runId: string, at?: string, canWrite?: (file: string) => boolean}} o
 */
async function runFix(fix, { run, dir, runId, at, canWrite }) {
  const r = await run(fix.prompt);
  if (r.code !== 0) return { ok: false, error: (r.stderr || `exit ${r.code}`).trim().split("\n")[0], applied: [], skipped: [], dismissals: [], answer: r.stdout };
  const plan = planEdits(parseEdits(r.stdout), fix.edit, undefined, { whole: fix.whole ?? [] });
  const done = applyPlan(plan, { dir, runId, label: fix.label, at, canWrite });
  const dismissals = parseDismissals(r.stdout, fix.records?.length ?? 0).map((d) => ({ ...d, rec: fix.records?.[d.n - 1] }));
  return { ok: true, error: "", applied: done.applied, skipped: [...plan.skipped, ...done.skipped], dismissals, answer: r.stdout };
}

/** The undo log, oldest first; a line undone later is marked undone. @param {string} dir @returns {UndoLine[]} */
function undoLog(dir) {
  let text = "";
  try {
    text = fs.readFileSync(logOf(dir), "utf8");
  } catch {}
  /** @type {UndoLine[]} */
  const lines = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l);
      if (x.undo) {
        const hit = lines.find((y) => y.run === x.run && y.file === x.file && !y.undone);
        if (hit) hit.undone = true;
      } else lines.push(x);
    } catch {}
  }
  return lines;
}

/**
 * Puts one change back: the backup over the file, or a created file removed. Refused when the file
 * changed after the fix, so a later edit is never lost.
 * @param {string} dir @param {UndoLine} line @returns {{ok: boolean, why?: string}}
 */
function undo(dir, line) {
  if (line.undone) return { ok: false, why: "already undone" };
  let now;
  try {
    now = fs.readFileSync(line.file, "utf8");
  } catch {
    return { ok: false, why: "the file is gone" };
  }
  if (now !== line.after) return { ok: false, why: "the file changed after the fix" };
  if (line.created) fs.rmSync(line.file);
  else if (line.backup) fs.writeFileSync(line.file, fs.readFileSync(line.backup, "utf8"));
  else return { ok: false, why: "no backup" };
  fs.appendFileSync(logOf(dir), JSON.stringify({ undo: true, run: line.run, file: line.file, at: new Date().toISOString() }) + "\n");
  return { ok: true };
}

module.exports = { autopilotDir, applyPlan, runFix, undoLog, undo };
