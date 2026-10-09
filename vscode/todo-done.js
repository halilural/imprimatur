// @ts-check
// A task marked done in Imprimatur's database closes what waited on the user
// for it, in every session (#43, #60): the task's open steps opened before the
// task last changed are ticked (by: "file"). An ask that came after the task was
// done stays open. waiting.mjs runs it at each turn end and the graph on each
// draw; a task already seen at the same change time is skipped
// (.claude/imprimatur/todo-done.json).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { WAITING_DIR, readLog, itemsOf, tickStep } = require("./waiting.js");
const { stepTask } = require("./tasks.js");
const records = require("./records.js");

const SEEN = path.join(".claude", "imprimatur", "todo-done.json");
/**
 * The closing rules' version: a cache written under other rules is read again
 * from scratch, so what they missed closes by itself (3: the database, #60).
 */
const RULES = 3;

/**
 * Tick the open steps of tasks the database says are done.
 * @param {string} root repo root @returns {number} steps ticked
 */
function closeDoneTasks(root) {
  /** @type {Record<string, number>} */
  let seen = {};
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(root, SEEN), "utf8"));
    if (kept?.rules === RULES && kept.tasks) seen = kept.tasks;
  } catch {
    // first run, or a file being written
  }
  /** @type {Map<string, number>} task → when it was done */
  const done = new Map();
  for (const [key, at] of records.doneTasks(root)) {
    if (seen[key] === at) continue;
    seen[key] = at;
    done.set(key, at);
  }
  if (!done.size) return 0;
  let ticked = 0;
  const dir = path.join(root, WAITING_DIR);
  if (fs.existsSync(dir))
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
      const log = path.join(dir, name);
      for (const it of itemsOf(readLog(log), name.slice(0, -".jsonl".length))) {
        if (!it.open) continue;
        const checked = new Set(it.checked ?? []);
        // Per step: one turn's asks can be about several tasks.
        it.text
          .split("\n")
          .filter((l) => l.trim())
          .forEach((text, i) => {
            const task = stepTask(it, text);
            const at = task ? done.get(task) : undefined;
            if (at === undefined || Date.parse(it.t) >= at || checked.has(i)) return;
            tickStep(log, { item: it.t, i }, "file", `${task} done in Imprimatur`);
            ticked++;
          });
      }
    }
  fs.mkdirSync(path.dirname(path.join(root, SEEN)), { recursive: true });
  fs.writeFileSync(path.join(root, SEEN), JSON.stringify({ rules: RULES, tasks: seen }, null, 2) + "\n");
  return ticked;
}

module.exports = { closeDoneTasks };
