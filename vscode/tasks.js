// @ts-check
// Which task a waiting step belongs to, and where it is written down (#34).
// The task key comes from the step's own record (the model names it), else
// from the TODO.md the session edited (todos/<key>/TODO.md, from the Agent
// Change Graph's history). The key links to the first link in that TODO.md
// that names it (its issue or Jira page, no setting needed); the step opens
// the TODO.md at the line that says the same thing.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { HISTORY_DIR } = require("./review-state.js");

/** A task key in text: a Jira-style key (LATD-13937) or a GitHub issue (#26). @param {string} [text] */
function taskKeyIn(text) {
  if (!text) return undefined;
  // Not inside a longer code (MT-AR-011 is a test id, not task AR-011).
  const jira = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/.exec(text);
  if (jira) return jira[1];
  const gh = /(?:^|[\s(])#(\d+)\b/.exec(text);
  return gh ? `#${gh[1]}` : undefined;
}

/** A key as written by a model or a person, in the form the TODO.md folders give: "80" → "#80". @param {string} [key] */
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
 * The task a waiting item or step is about: the model's, its TODO.md's, else a
 * key in its text or request. @param {{task?: string, todo?: string, text?: string, prompt?: string}} it
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

/**
 * The TODO.md files each session edited, newest last (from the edit history).
 * @param {string} root @returns {Map<string, string[]>} session → repo-relative paths
 */
function sessionTodos(root) {
  /** @type {Array<{p: string, file: string, key: string}>} */
  const logs = [];
  const base = path.join(root, HISTORY_DIR);
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/(^|[/\\])TODO\.md\.jsonl$/i.test(p)) logs.push({ p, file: path.relative(base, p).slice(0, -".jsonl".length), key: statKey(p) });
    }
  };
  walk(base);
  // The logs hold every edit's whole text: parsed again only when one changed.
  const key = logs.map((l) => `${l.file}:${l.key}`).join("|");
  const hit = sessionTodosCache.get(root);
  if (hit && hit.key === key) return hit.map;
  /** @type {Map<string, Array<{t: string, file: string}>>} */
  const found = new Map();
  for (const { p, file } of logs)
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      // Only the session and time are needed: not the whole line's text.
      const session = /"session":"([^"]+)"/.exec(line.slice(0, 400))?.[1];
      const t = /"t":"([^"]+)"/.exec(line.slice(0, 200))?.[1];
      if (session && t) found.set(session, [...(found.get(session) ?? []), { t, file }]);
    }
  const map = new Map([...found].map(([s, edits]) => [s, [...new Set(edits.sort((a, b) => a.t.localeCompare(b.t)).map((e) => e.file))]]));
  sessionTodosCache.set(root, { key, map });
  return map;
}

/** @type {Map<string, {key: string, map: Map<string, string[]>}>} */
const sessionTodosCache = new Map();

/** A file's size and change time, "" when missing. @param {string} f */
function statKey(f) {
  try {
    const st = fs.statSync(f);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

/**
 * A repo file's text and its lines' words, read again only when it changed.
 * @type {Map<string, {key: string, text: string, lines: Array<Set<string>>}>}
 */
const textCache = new Map();
/** @param {string} abs */
function textOf(abs) {
  const key = statKey(abs);
  if (!key) return undefined;
  const hit = textCache.get(abs);
  if (hit && hit.key === key) return hit;
  const text = fs.readFileSync(abs, "utf8");
  const entry = { key, text, lines: text.split("\n").map(words) };
  textCache.set(abs, entry);
  return entry;
}

/** Words of a line, for matching a step to it. @param {string} s */
const words = (s) => new Set((s.toLocaleLowerCase("tr").match(/[\p{L}\p{N}#-]{3,}/gu) ?? []));

/**
 * The 1-based line of a TODO.md that says what the step says (the best word
 * overlap, at least 40% of the step's words), else 0.
 * @param {string} text the TODO.md's content @param {string} step
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

/** The first link in a TODO.md that names the key, by its text or address. @param {string} text @param {string} key */
function linkFor(text, key) {
  const n = key.startsWith("#") ? key.slice(1) : undefined;
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const [, label, url] = m;
    if (label.includes(key) || url.includes(key) || (n && new RegExp(`/(issues|pull)/${n}(\\b|$)`).test(url))) return url;
  }
  return undefined;
}

/** The repo's GitHub address from its origin remote, for #n without a link in a TODO.md. @param {string} root */
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

/** Where task folders live, newer layout first (#54): docs/todos/<key>/, then todos/<key>/. */
const TODO_DIRS = [path.join("docs", "todos"), "todos"];

/** Every TODO.md the layouts name: the root one, then each task folder's (repo-relative, may not exist). @param {string} root */
function todoFiles(root) {
  return [
    "TODO.md",
    ...TODO_DIRS.flatMap((dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).map((d) => path.join(dir, d, "TODO.md")) : [])),
  ];
}

/** The task a file under a task folder belongs to: (docs/)todos/37/… → #37, todos/LATD-12/… → LATD-12. @param {string} file */
function taskOfFile(file) {
  const parts = file.split(/[\\/]/);
  const at = parts[0] === "todos" ? 1 : parts[0] === "docs" && parts[1] === "todos" ? 2 : 0;
  const [dir, ...rest] = parts.slice(at);
  if (!at || !dir || !rest.length) return undefined;
  return /^\d+$/.test(dir) ? `#${dir}` : taskKeyIn(dir);
}

/** The task's own TODO.md by the usual layout ((docs/)todos/<key>/TODO.md, <n>/ for #n), if it exists. @param {string} root @param {string} key */
function todoOfKey(root, key) {
  return TODO_DIRS.map((dir) => path.join(dir, key.replace(/^#/, ""), "TODO.md")).find((rel) => fs.existsSync(path.join(root, rel)));
}

/**
 * Where a Jira project's pages live, learned from links in the repo's TODO.md
 * files (…/browse/LATD-123): LATD-13931 gets one without a TODO.md of its own.
 * @param {string} root @param {string} key @param {Map<string, any>} [cache]
 */
function jiraBase(root, key, cache = new Map()) {
  if (!cache.has("jira")) {
    /** @type {Map<string, string>} project → address up to and with /browse/ */
    const bases = new Map();
    for (const f of todoFiles(root)) {
      const t = textOf(path.join(root, f));
      if (!t) continue;
      for (const m of t.text.matchAll(/(https?:\/\/[^\s)\]]+\/browse\/)([A-Z][A-Z0-9]+)-\d+/g)) if (!bases.has(m[2])) bases.set(m[2], m[1]);
    }
    cache.set("jira", bases);
  }
  const base = cache.get("jira").get(key.split("-")[0]);
  return base ? `${base}${key}` : undefined;
}

/**
 * Task and place of a waiting step.
 * @param {string} root
 * @param {{session: string, text: string, task?: string, todo?: string, prompt?: string, detail?: string}} step
 * @param {Map<string, string[]>} todos from sessionTodos
 * @param {Map<string, any>} [cache] shared across the steps of one render
 * @returns {{task?: string, url?: string, todo?: string, line?: number}}
 */
function placeOf(root, step, todos, cache = new Map()) {
  const edited = todos.get(step.session) ?? [];
  const named = step.task || taskKeyIn(step.text) || taskKeyIn(step.prompt);
  // The TODO.md: the step's own (Scan history), else one the session edited that names its task
  // or says the step. A session on several things does not tag every step with its last TODO.md.
  const read = (f) => textOf(path.join(root, f));
  // The task's own TODO.md counts even when this session did not edit it (a scanned old session).
  let todo = step.todo ?? (named ? edited.find((f) => keyOfTodo(f) === named) ?? todoOfKey(root, named) : undefined);
  const own = todo ? read(todo) : undefined;
  let text = own?.text;
  let line = own ? lineFor(own.text, step.text, own.lines) : 0;
  if (!todo)
    for (const f of [...edited].reverse()) {
      const t = read(f);
      const l = t ? lineFor(t.text, step.text, t.lines) : 0;
      if (l) [todo, text, line] = [f, t.text, l];
      if (l) break;
    }
  const task = named ?? (todo ? keyOfTodo(todo) : undefined);
  const gh = task?.startsWith("#") ? githubOf(root) : undefined;
  const fallback = gh ? `${gh}/issues/${task.slice(1)}` : task && !task.startsWith("#") ? jiraBase(root, task, cache) : undefined;
  if (!todo || text === undefined) return task ? { task, ...(fallback && { url: fallback }) } : { task };
  return { task, url: (task ? linkFor(text, task) : undefined) ?? fallback, todo, line };
}

module.exports = { TODO_DIRS, todoFiles, taskOfFile, todoOfKey, taskKeyIn, normKey, leadKey, keyOfTodo, taskOf, stepTask, namesTask, sessionTodos, lineFor, linkFor, placeOf, jiraBase };
