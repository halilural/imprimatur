// @ts-check
// Scan history: what waited on the user before Imprimatur was set up. The
// hooks only see turns after setup, so asks from earlier work never reached
// "Waiting on you". Two sources:
// - Claude Code's own session transcripts (~/.claude/projects/<slug>/*.jsonl),
//   last DAYS days: earlier turns' 👉 lines become steps, the user's later
//   messages are kept on them, then Haiku audits the session with its final
//   message (vscode/audit.js), as the Stop hook would have. Sessions that
//   already have a waiting log (the hook ran) or were scanned before are skipped.
// - TODO.md files (TODO.md, docs/todos/*/TODO.md, todos/*/TODO.md): "TODO: (K)" lines, the user's
//   own to-dos. Rescanned each time: new lines are added, lines gone or DONE
//   are ticked (by "file").
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { audit, pointedAsks } = require("./audit.js");
const { WAITING_DIR, itemsOf, readLog, tickStep } = require("./waiting.js");
const { todoFiles } = require("./tasks.js");

const DAYS = 30;
const SCANNED = path.join(".claude", "imprimatur", "scanned.json");
/** The waiting log that holds the TODO.md steps. */
const FILES_SESSION = "todo-files";
const TRANSCRIPTS = path.join(os.homedir(), ".claude", "projects");

/** Claude Code's folder name for a project dir: every other character becomes "-". @param {string} dir */
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");

/** The user's own words in a prompt (tags the IDE or harness adds are not theirs). @param {string} s */
const userWords = (s) => s.replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, "").trim();

/**
 * A transcript's turns: the user's prompt and the agent's final message.
 * Side chains (subagents), meta records and tool results are skipped.
 * @param {string} file
 * @returns {{cwd?: string, title?: string, turns: Array<{at: string, end: string, request: string, message: string}>}}
 */
function turnsOf(file) {
  /** @type {Array<{at: string, end: string, request: string, message: string}>} */
  const turns = [];
  let cwd;
  let title;
  let lastId;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "ai-title" && typeof r.aiTitle === "string") title = r.aiTitle.split("\n")[0].slice(0, 80);
    if (r.isSidechain || r.isMeta || (r.type !== "user" && r.type !== "assistant")) continue;
    cwd ??= r.cwd;
    const content = r.message?.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    if (r.type === "user") {
      if (blocks.some((b) => b.type === "tool_result")) continue;
      const request = userWords(text);
      if (request) turns.push({ at: r.timestamp, end: r.timestamp, request, message: "" });
      lastId = undefined;
    } else if (text && turns.length) {
      // The final message: the last assistant message's text (its blocks share an id).
      const t = turns[turns.length - 1];
      t.message = r.message?.id && r.message.id === lastId ? `${t.message}\n${text}` : text;
      t.end = r.timestamp;
      lastId = r.message?.id;
    }
  }
  return { cwd, title, turns: turns.filter((t) => t.message) };
}

/**
 * The project's transcripts: Claude's folders for the repo root and dirs under
 * it, each session started inside the root. @param {string} root @param {string} [home]
 */
function transcriptsOf(root, home = TRANSCRIPTS) {
  if (!fs.existsSync(home)) return [];
  const slug = slugOf(root);
  return fs
    .readdirSync(home)
    .filter((d) => d === slug || d.startsWith(`${slug}-`))
    .flatMap((d) =>
      fs
        .readdirSync(path.join(home, d))
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => path.join(home, d, n)),
    );
}

/** @param {string} root @returns {{sessions: string[]}} */
function readScanned(root) {
  try {
    return { sessions: [], ...JSON.parse(fs.readFileSync(path.join(root, SCANNED), "utf8")) };
  } catch {
    return { sessions: [] };
  }
}

/**
 * A waiting log only the scan wrote: its items, your later messages and the
 * audit's ticks. A hook's records (a turn end, a question) or your own tick
 * mean the session went on after setup or you worked on it: kept.
 * @param {string} log
 */
const scanOnly = (log) =>
  readLog(log).every((r) => r.kind === "verify" || r.kind === "answer" || (r.kind === "check" && (r.by === "audit" || r.by === "file")));

/** True once the project was scanned (the extension scans a project once on its own). @param {string} root */
const scannedBefore = (root) => fs.existsSync(path.join(root, SCANNED));

/** @param {string} log @param {object} row */
function append(log, row) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify(row) + "\n");
}

/**
 * One past session into its waiting log. Returns the steps it left open.
 * @param {string} root @param {string} session
 * @param {ReturnType<typeof turnsOf>} tx
 * @param {{ask?: (prompt: string) => Promise<string>, lang?: string}} opts
 */
async function scanSession(root, session, tx, opts) {
  const log = path.join(root, WAITING_DIR, `${session}.jsonl`);
  const turns = tx.turns;
  const last = turns[turns.length - 1];
  for (const turn of turns.slice(0, -1)) {
    // The user's next message is kept on the open steps (answers, decisions).
    if (fs.existsSync(log)) append(log, { t: turn.at, session, kind: "answer", answer: turn.request.split("\n")[0].slice(0, 1500) });
    const asks = pointedAsks(turn.message);
    if (asks.length)
      append(log, { t: turn.end, session, kind: "verify", text: asks.join("\n"), detail: turn.message.slice(0, 4000), prompt: turn.request.slice(0, 200), title: tx.title });
  }
  if (fs.existsSync(log)) append(log, { t: last.at, session, kind: "answer", answer: last.request.split("\n")[0].slice(0, 1500) });
  const turn = { message: last.message.slice(0, 6000), request: last.request.slice(0, 200), title: tx.title, session, lang: opts.lang, at: last.end };
  try {
    await audit(log, turn, opts.ask);
  } catch {
    // No model: the agent's 👉 lines are its asks.
    const asks = pointedAsks(last.message);
    if (asks.length) append(log, { t: last.end, session, kind: "verify", text: asks.join("\n"), detail: turn.message.slice(0, 4000), prompt: turn.request, title: tx.title });
  }
}

/**
 * The user's to-dos in TODO.md files: "TODO: (K)" lines that are not done.
 * @param {string} root @returns {Array<{file: string, text: string}>}
 */
function todoAsks(root) {
  return todoFiles(root)
    .filter((f) => fs.existsSync(path.join(root, f)))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(root, f), "utf8")
        .split("\n")
        .map((l) => /^\s*[-*]\s+(?:👉\s*)?TODO:\s*\(K\)\s*(.+)$/u.exec(l)?.[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim())
        .filter((t) => !!t)
        .map((text) => ({ file: f, text: /** @type {string} */ (text) })),
    );
}

/**
 * Sync the TODO.md steps: add new ones (one item per file), tick the open ones
 * no longer in their file. @param {string} root @returns {{added: number, ticked: number}}
 */
function scanTodos(root) {
  const log = path.join(root, WAITING_DIR, `${FILES_SESSION}.jsonl`);
  const now = todoAsks(root);
  const items = itemsOf(readLog(log), FILES_SESSION);
  const known = new Set(items.flatMap((it) => it.text.split("\n").map((t) => `${it.prompt}\n${t}`)));
  let ticked = 0;
  for (const it of items) {
    if (!it.open) continue;
    it.text.split("\n").forEach((text, i) => {
      if (it.checked?.includes(i) || now.some((a) => a.file === it.prompt && a.text === text)) return;
      tickStep(log, { item: it.t, i }, "file", `no longer open in ${it.prompt}`);
      ticked++;
    });
  }
  const fresh = now.filter((a) => !known.has(`${a.file}\n${a.text}`));
  const files = [...new Set(fresh.map((a) => a.file))];
  const t = Date.now();
  files.forEach((file, k) => {
    const text = fresh.filter((a) => a.file === file).map((a) => a.text).join("\n");
    append(log, { t: new Date(t + k).toISOString(), session: FILES_SESSION, kind: "verify", text, prompt: file, title: file, todo: file });
  });
  return { added: fresh.length, ticked };
}

/**
 * Scan a project's history into "Waiting on you". Runs `parallel` model calls at a time.
 * @param {string} root repo root
 * @param {{ask?: (prompt: string) => Promise<string>, lang?: string, days?: number, home?: string, parallel?: number, again?: boolean, progress?: (done: number, total: number) => void}} [opts]
 * again: rescan the sessions only the scan wrote (their logs are replaced)
 * @returns {Promise<{sessions: number, todos: {added: number, ticked: number}}>}
 */
async function scanHistory(root, opts = {}) {
  const since = Date.now() - (opts.days ?? DAYS) * 86_400_000;
  const scanned = readScanned(root);
  const done = new Set(scanned.sessions);
  // Again: what the scan alone wrote is written anew (e.g. in another language).
  if (opts.again)
    for (const session of [...done]) {
      const log = path.join(root, WAITING_DIR, `${session}.jsonl`);
      if (fs.existsSync(log) && !scanOnly(log)) continue;
      if (fs.existsSync(log)) fs.rmSync(log);
      done.delete(session);
    }
  const jobs = [];
  for (const file of transcriptsOf(root, opts.home)) {
    const session = path.basename(file, ".jsonl").replace(/[^\w-]/g, "");
    if (done.has(session) || fs.existsSync(path.join(root, WAITING_DIR, `${session}.jsonl`))) continue;
    if (fs.statSync(file).mtimeMs < since) continue;
    const tx = turnsOf(file);
    const inside = tx.cwd && !path.relative(root, tx.cwd).startsWith("..");
    tx.turns = tx.turns.filter((t) => Date.parse(t.end) >= since);
    if (!inside || !tx.turns.length) continue;
    jobs.push({ session, tx });
  }
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { session, tx } = jobs[next++];
      await scanSession(root, session, tx, opts);
      done.add(session);
      opts.progress?.(++finished, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: opts.parallel ?? 4 }, worker));
  const todos = scanTodos(root);
  fs.mkdirSync(path.dirname(path.join(root, SCANNED)), { recursive: true });
  fs.writeFileSync(path.join(root, SCANNED), JSON.stringify({ at: new Date().toISOString(), sessions: [...done] }, null, 2) + "\n");
  return { sessions: jobs.length, todos };
}

module.exports = { scanHistory, scanTodos, todoAsks, turnsOf, transcriptsOf, scannedBefore, slugOf, FILES_SESSION };
