// @ts-check
// A task marked done in its TODO.md closes what waited on the user for it, in
// every session (#43): the task's open steps opened before the TODO.md last
// changed are ticked (by: "file"). An ask that came after the task was done
// stays open. waiting.mjs runs it at each turn end; a TODO.md already seen at
// the same mtime is skipped (.claude/imprimatur/todo-done.json).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { WAITING_DIR, readLog, itemsOf, tickStep } = require("./waiting.js");
const { keyOfTodo, stepTask } = require("./tasks.js");

const SEEN = path.join(".claude", "imprimatur", "todo-done.json");
/**
 * The closing rules' version: a cache written under other rules is read again
 * from scratch, so what they missed closes by itself (2: a step's own task, #45).
 */
const RULES = 2;

/**
 * Is the TODO.md's task done? Its "## Durum" / "## Status" section starts with
 * Bitti / Done, or a "Durum: Bitti" line says so. @param {string} text
 */
function isDone(text) {
  const DONE = /^(?:✅\s*)?(?:bitti|tamamlandı|kapandı|done|closed|completed)\b/iu;
  const lines = text.split("\n").map((l) => l.replace(/\*\*|__/g, "").trim());
  const h = lines.findIndex((l) => /^#{2,3}\s*(durum|status)\s*$/iu.test(l));
  if (h >= 0) {
    const first = lines.slice(h + 1).find((l) => l);
    if (first && !first.startsWith("#") && DONE.test(first)) return true;
  }
  return lines.some((l) => /^(?:[-*]\s+)?(?:durum|status)\s*[:·—-]\s*/iu.test(l) && DONE.test(l.replace(/^(?:[-*]\s+)?(?:durum|status)\s*[:·—-]\s*/iu, "")));
}

/** The task's TODO.md files: todos/<key>/TODO.md. @param {string} root */
function taskTodos(root) {
  const todos = path.join(root, "todos");
  if (!fs.existsSync(todos)) return [];
  return fs
    .readdirSync(todos)
    .map((d) => path.join("todos", d, "TODO.md"))
    .filter((f) => fs.existsSync(path.join(root, f)));
}

/**
 * Tick the open steps of tasks whose TODO.md says done.
 * @param {string} root repo root @returns {number} steps ticked
 */
function closeDoneTasks(root) {
  /** @type {Record<string, number>} */
  let seen = {};
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(root, SEEN), "utf8"));
    if (kept?.rules === RULES && kept.files) seen = kept.files;
  } catch {
    // first run, or a file being written
  }
  /** @type {Map<string, {file: string, at: number}>} task → its done TODO.md */
  const done = new Map();
  let changed = false;
  for (const file of taskTodos(root)) {
    const at = fs.statSync(path.join(root, file)).mtimeMs;
    if (seen[file] === at) continue;
    seen[file] = at;
    changed = true;
    const key = keyOfTodo(file);
    if (key && isDone(fs.readFileSync(path.join(root, file), "utf8"))) done.set(key, { file, at });
  }
  let ticked = 0;
  const dir = path.join(root, WAITING_DIR);
  if (done.size && fs.existsSync(dir))
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
            const hit = task ? done.get(task) : undefined;
            if (!hit || Date.parse(it.t) >= hit.at || checked.has(i)) return;
            tickStep(log, { item: it.t, i }, "file", `${task} done in ${hit.file}`);
            ticked++;
          });
      }
    }
  if (!changed) return 0;
  fs.mkdirSync(path.dirname(path.join(root, SEEN)), { recursive: true });
  fs.writeFileSync(path.join(root, SEEN), JSON.stringify({ rules: RULES, files: seen }, null, 2) + "\n");
  return ticked;
}

module.exports = { isDone, closeDoneTasks };
