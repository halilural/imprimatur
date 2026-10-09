// @ts-check
// Which task a waiting step belongs to, and which record says it (#34, #60).
// The task key comes from the step itself (the model names it, or its text
// does), else from the tasks the session wrote records of (Imprimatur's
// database, vscode/records.js). The key links to its GitHub issue or Jira page;
// the step points at the task's record that says the same thing.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const records = require("./records.js");

/** A task key in text: a Jira-style key (LATD-13937) or a GitHub issue (#26). @param {string} [text] */
function taskKeyIn(text) {
  if (!text) return undefined;
  // Not inside a longer code (MT-AR-011 is a test id, not task AR-011).
  const jira = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/.exec(text);
  if (jira) return jira[1];
  const gh = /(?:^|[\s(])#(\d+)\b/.exec(text);
  return gh ? `#${gh[1]}` : undefined;
}

/** A key as written by a model or a person, in the form tasks use: "80" → "#80". @param {string} [key] */
function normKey(key) {
  const k = String(key ?? "").trim();
  if (/^#?\d+$/.test(k)) return `#${k.replace(/^#/, "")}`;
  return taskKeyIn(k);
}

/**
 * The key a step's text starts with ("#88: check the board" is about #88). A
 * Jira-style key only before a colon: "UTF-8 dosyası…" names no task. @param {string} [text]
 */
function leadKey(text) {
  const m = /^\s*(?:(#\d+)(?![\w-])|([A-Z][A-Z0-9]{1,9}-\d+)\s*:)/.exec(text ?? "");
  return m ? m[1] ?? m[2] : undefined;
}

/**
 * The task a waiting item or step is about: the model's, its TODO.md's (items
 * written before #60), else a key in its text or request. @param {{task?: string, todo?: string, text?: string, prompt?: string}} it
 */
const taskOf = (it) => normKey(it.task) || (it.todo ? keyOfTodo(it.todo) : undefined) || taskKeyIn(it.text) || taskKeyIn(it.prompt);

/**
 * One step's task: the key its own text starts with, else its item's. One turn's
 * asks can be about several tasks; the item carries one. @param {Parameters<typeof taskOf>[0]} it @param {string} text the step
 */
const stepTask = (it, text) => leadKey(text) ?? taskOf(it);

/**
 * Does a message name the task: the key itself, or a Jira key's number alone
 * ("13977 kapatıldı" names LATD-13977)? @param {string} text @param {string} key
 */
function namesTask(text, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, "i").test(text)) return true;
  const num = /^[A-Z][A-Z0-9]*-(\d{3,})$/.exec(key)?.[1];
  return !!num && new RegExp(`(?<![\\w-])${num}(?![\\w-])`).test(text);
}

/** The key a TODO.md's folder names: (docs/)todos/LATD-13937/TODO.md → LATD-13937, todos/25/TODO.md → #25. @param {string} todo */
function keyOfTodo(todo) {
  const dir = path.basename(path.dirname(todo));
  if (/^\d+$/.test(dir)) return `#${dir}`;
  return taskKeyIn(dir);
}

/** Words of a line, for matching a step to it. @param {string} s */
const words = (s) => new Set((s.toLocaleLowerCase("tr").match(/[\p{L}\p{N}#-]{3,}/gu) ?? []));

/**
 * The 1-based line of a text that says what the step says (the best word
 * overlap, at least 40% of the step's words), else 0.
 * @param {string} text one record title per line @param {string} step
 */
function lineFor(text, step, lineWords) {
  const want = words(step);
  if (!want.size) return 0;
  let best = 0;
  let line = 0;
  (lineWords ?? text.split("\n").map(words)).forEach((have, i) => {
    const share = [...want].filter((w) => have.has(w)).length / want.size;
    if (share > best) [best, line] = [share, i + 1];
  });
  return best >= 0.4 ? line : 0;
}

/** The repo's GitHub address from its origin remote, for #n. @param {string} root */
function githubOf(root) {
  try {
    const config = fs.readFileSync(path.join(root, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
    const gh = m && /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(m[1]);
    return gh ? `https://github.com/${gh[1]}` : undefined;
  } catch {
    return undefined;
  }
}

/** The task a file under a task folder belongs to: (docs/)todos/37/… → #37, todos/LATD-12/… → LATD-12 (edits made before #60). @param {string} file */
function taskOfFile(file) {
  const parts = file.split(/[\\/]/);
  const at = parts[0] === "todos" ? 1 : parts[0] === "docs" && parts[1] === "todos" ? 2 : 0;
  const [dir, ...rest] = parts.slice(at);
  if (!at || !dir || !rest.length) return undefined;
  return /^\d+$/.test(dir) ? `#${dir}` : taskKeyIn(dir);
}

/**
 * The task's record that says what the step says, if one does.
 * @param {string} root @param {string} task @param {string} step @param {Map<string, any>} cache
 */
function recordFor(root, task, step, cache) {
  const k = `records:${task}`;
  if (!cache.has(k)) {
    const list = records.recordsOf(root, task);
    cache.set(k, { list, lines: list.map((r) => words(r.title)) });
  }
  const { list, lines } = cache.get(k);
  const line = list.length ? lineFor("", step, lines) : 0;
  return line ? list[line - 1] : undefined;
}

/**
 * Task and record of a waiting step.
 * @param {string} root
 * @param {{session: string, text: string, task?: string, todo?: string, prompt?: string, detail?: string}} step
 * @param {Map<string, string[]>} sessions from records.sessionTasks: the tasks each session worked on
 * @param {Map<string, any>} [cache] shared across the steps of one render
 * @returns {{task?: string, url?: string, record?: number}}
 */
function placeOf(root, step, sessions, cache = new Map()) {
  let task = normKey(step.task) || (step.todo ? keyOfTodo(step.todo) : undefined) || taskKeyIn(step.text) || taskKeyIn(step.prompt);
  let record = task ? recordFor(root, task, step.text, cache) : undefined;
  // No key: the session's tasks, newest first, whose record says the step.
  if (!task)
    for (const key of [...(sessions.get(step.session) ?? [])].reverse()) {
      record = recordFor(root, key, step.text, cache);
      if (record) {
        task = key;
        break;
      }
    }
  if (!task) return {};
  const gh = task.startsWith("#") ? githubOf(root) : undefined;
  // One Jira lookup per project and draw: it searches every record.
  const jira = (key) => {
    const k = `jira:${key.split("-")[0]}`;
    if (!cache.has(k)) cache.set(k, records.jiraLink(root, key)?.replace(/[A-Z][A-Z0-9]*-\d+$/, ""));
    const base = cache.get(k);
    return base ? `${base}${key}` : undefined;
  };
  const url = gh ? `${gh}/issues/${task.slice(1)}` : !task.startsWith("#") ? jira(task) : undefined;
  return { task, ...(url && { url }), ...(record && { record: record.id }) };
}

module.exports = { taskOfFile, taskKeyIn, normKey, leadKey, keyOfTodo, taskOf, stepTask, namesTask, lineFor, placeOf, githubOf };
