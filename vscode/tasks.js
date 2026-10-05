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

/** The key a TODO.md's folder names: todos/LATD-13937/TODO.md → LATD-13937, todos/25/TODO.md → #25. @param {string} todo */
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
  /** @type {Map<string, Array<{t: string, file: string}>>} */
  const found = new Map();
  const base = path.join(root, HISTORY_DIR);
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/(^|[/\\])TODO\.md\.jsonl$/i.test(p)) {
        const file = path.relative(base, p).slice(0, -".jsonl".length);
        for (const line of fs.readFileSync(p, "utf8").split("\n")) {
          try {
            const r = JSON.parse(line);
            if (r.session) found.set(r.session, [...(found.get(r.session) ?? []), { t: r.t, file }]);
          } catch {
            // a line being written
          }
        }
      }
    }
  };
  walk(base);
  return new Map([...found].map(([s, edits]) => [s, [...new Set(edits.sort((a, b) => a.t.localeCompare(b.t)).map((e) => e.file))]]));
}

/** Words of a line, for matching a step to it. @param {string} s */
const words = (s) => new Set((s.toLocaleLowerCase("tr").match(/[\p{L}\p{N}#-]{3,}/gu) ?? []));

/**
 * The 1-based line of a TODO.md that says what the step says (the best word
 * overlap, at least 40% of the step's words), else 0.
 * @param {string} text the TODO.md's content @param {string} step
 */
function lineFor(text, step) {
  const want = words(step);
  if (!want.size) return 0;
  let best = 0;
  let line = 0;
  text.split("\n").forEach((l, i) => {
    const have = words(l);
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

/** The task's own TODO.md by the usual layout (todos/<key>/TODO.md, todos/<n>/TODO.md for #n), if it exists. @param {string} root @param {string} key */
function todoOfKey(root, key) {
  const rel = path.join("todos", key.replace(/^#/, ""), "TODO.md");
  return fs.existsSync(path.join(root, rel)) ? rel : undefined;
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
    const todos = path.join(root, "todos");
    const files = ["TODO.md", ...(fs.existsSync(todos) ? fs.readdirSync(todos).map((d) => path.join("todos", d, "TODO.md")) : [])];
    for (const f of files) {
      if (!fs.existsSync(path.join(root, f))) continue;
      for (const m of fs.readFileSync(path.join(root, f), "utf8").matchAll(/(https?:\/\/[^\s)\]]+\/browse\/)([A-Z][A-Z0-9]+)-\d+/g)) if (!bases.has(m[2])) bases.set(m[2], m[1]);
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
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : undefined);
  // The task's own TODO.md counts even when this session did not edit it (a scanned old session).
  let todo = step.todo ?? (named ? edited.find((f) => keyOfTodo(f) === named) ?? todoOfKey(root, named) : undefined);
  let text = todo ? read(todo) : undefined;
  let line = text ? lineFor(text, step.text) : 0;
  if (!todo)
    for (const f of [...edited].reverse()) {
      const t = read(f);
      const l = t ? lineFor(t, step.text) : 0;
      if (l) [todo, text, line] = [f, t, l];
      if (l) break;
    }
  const task = named ?? (todo ? keyOfTodo(todo) : undefined);
  const gh = task?.startsWith("#") ? githubOf(root) : undefined;
  const fallback = gh ? `${gh}/issues/${task.slice(1)}` : task && !task.startsWith("#") ? jiraBase(root, task, cache) : undefined;
  if (!todo || text === undefined) return task ? { task, ...(fallback && { url: fallback }) } : { task };
  return { task, url: (task ? linkFor(text, task) : undefined) ?? fallback, todo, line };
}

module.exports = { taskKeyIn, keyOfTodo, sessionTodos, lineFor, linkFor, placeOf, jiraBase };
