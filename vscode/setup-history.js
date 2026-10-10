// @ts-check
// Setup history (#32): when each agent file was added and last changed
// (`git log --follow`: date, short hash, subject), cached per repo by HEAD so
// git only runs again after a commit; and, lazily (hover or "Explain last
// change"), one sentence from Haiku saying what the last change did, cached in
// <repo>/.claude/imprimatur/setup-history.json by commit + path. No model call
// in an untrusted workspace.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const FILE = path.join(".claude", "imprimatur", "setup-history.json");
const DIFF_LINES = 120;
const SEP = "\x1e";
const FIELD = "\x1f";
const FORMAT = `${SEP}%H${FIELD}%h${FIELD}%aI${FIELD}%s`;

/** @typedef {{hash: string, short: string, date: string, subject: string, path: string}} Commit */

/** @param {string[]} args @param {string} cwd @returns {Promise<string>} */
const git = (args, cwd) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

/**
 * `git log --follow --name-only --format=FORMAT` output, newest first: each
 * commit with the file's path at that commit. Pure.
 * @param {string} out @param {string} rel the path now (when a commit lists none)
 * @returns {Commit[]}
 */
function parseLog(out, rel) {
  return out
    .split(SEP)
    .filter((r) => r.trim())
    .map((r) => {
      const [head, ...rest] = r.split("\n");
      const [hash, short, date, subject] = head.split(FIELD);
      return { hash, short, date, subject: subject ?? "", path: rest.map((l) => l.trim()).filter(Boolean)[0] ?? rel };
    })
    .filter((c) => c.hash);
}

/** First (added) and last commit of a log. @param {Commit[]} log */
const span = (log) => (log.length ? { first: log[log.length - 1], last: log[0] } : undefined);

/** "2026-10-05". @param {string} iso */
const day = (iso) => iso.slice(0, 10);

/**
 * Tooltip lines (Markdown) for a file's history. Pure.
 * @param {{first: Commit, last: Commit} | undefined} h @param {string} [explained]
 */
function historyLines(h, explained) {
  if (!h) return ["_Not committed yet._"];
  const line = (c) => `${day(c.date)} · \`${c.short}\` · ${c.subject.replace(/[\\`*_[\]]/g, "\\$&")}`;
  const out = [`Added ${line(h.first)}`];
  if (h.last.hash !== h.first.hash) out.push(`Last changed ${line(h.last)}`);
  if (explained) out.push(`_${explained}_`);
  return out;
}

/** Diff lines of one file in one commit, capped. @param {string} patch */
function capDiff(patch) {
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  const body = (start < 0 ? lines : lines.slice(start)).filter((l, i, a) => i < a.length - 1 || l);
  return body.length > DIFF_LINES ? [...body.slice(0, DIFF_LINES), `… ${body.length - DIFF_LINES} more lines`].join("\n") : body.join("\n");
}

/** @param {string} rel @param {Commit} c @param {string} diff @param {string} lang */
function promptFor(rel, c, diff, lang) {
  return [
    `A commit ("${c.subject}") changed ${rel}, a file that sets up a coding agent (its rules, hooks, settings or skills).`,
    `Below is the change ("-" removed, "+" added). In ${lang}, write ONE sentence (at most 120 characters)`,
    `saying what the change does to the agent's behaviour, in plain words. No file name, no quotes, no markdown, no preamble.`,
    "",
    diff,
  ].join("\n");
}

class SetupHistory {
  /**
   * @param {{ask?: (prompt: string) => Promise<string>, allowed?: (what: string) => boolean, lang?: () => string,
   *   run?: (args: string[], cwd: string) => Promise<string>}} [opts]
   */
  constructor(opts = {}) {
    this.ask = opts.ask ?? ((p) => require("./model.js").askModel(p));
    this.allowed = opts.allowed ?? (() => true);
    this.lang = opts.lang ?? (() => "English");
    this.run = opts.run ?? git;
    /** @type {Map<string, {head: string, files: Record<string, {first: Commit, last: Commit} | null>, explained: Record<string, string>}>} */
    this.repos = new Map();
    /** @type {Map<string, Promise<string | undefined>>} */
    this.pending = new Map();
  }

  /** @param {string} root */
  load(root) {
    let r = this.repos.get(root);
    if (r) return r;
    r = { head: "", files: {}, explained: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
      r = { head: String(saved.head ?? ""), files: saved.files ?? {}, explained: saved.explained ?? {} };
    } catch {}
    this.repos.set(root, r);
    return r;
  }

  /** @param {string} root */
  save(root) {
    const r = this.load(root);
    try {
      fs.mkdirSync(path.join(root, path.dirname(FILE)), { recursive: true });
      fs.writeFileSync(path.join(root, FILE), JSON.stringify(r, null, 1) + "\n");
    } catch {}
  }

  /**
   * Bring a repo's history up to date: git runs only for files not known at
   * this HEAD (all of them after a new commit). True when something changed.
   * @param {string} root @param {string[]} rels
   */
  async refresh(root, rels) {
    const r = this.load(root);
    let head = "";
    try {
      head = (await this.run(["rev-parse", "HEAD"], root)).trim();
    } catch {
      return false; // not a git repo, or no commit yet
    }
    if (head !== r.head) {
      r.head = head;
      r.files = {};
    }
    const todo = rels.filter((rel) => !(rel in r.files));
    if (!todo.length) return false;
    for (let i = 0; i < todo.length; i += 4)
      await Promise.all(
        todo.slice(i, i + 4).map(async (rel) => {
          try {
            r.files[rel] = span(parseLog(await this.run(["log", "--follow", "--name-only", `--format=${FORMAT}`, "--", rel], root), rel)) ?? null;
          } catch {
            r.files[rel] = null;
          }
        }),
      );
    this.save(root);
    return true;
  }

  /** @param {string} root @param {string} rel */
  info(root, rel) {
    return this.load(root).files[rel] ?? undefined;
  }

  /** The cached sentence for a file's last change, if any. @param {string} root @param {string} rel */
  explained(root, rel) {
    const h = this.info(root, rel);
    return h ? this.load(root).explained[`${h.last.hash}:${rel}`] : undefined;
  }

  /**
   * One sentence on what the file's last commit changed: from the cache, else
   * from the model (never in an untrusted workspace). undefined when none.
   * @param {string} root @param {string} rel
   */
  async explain(root, rel) {
    const h = this.info(root, rel);
    if (!h) return undefined;
    const key = `${h.last.hash}:${rel}`;
    const r = this.load(root);
    if (r.explained[key]) return r.explained[key];
    if (!this.allowed("explain last setup change (claude)")) return undefined;
    const id = `${root}\n${key}`;
    if (this.pending.has(id)) return this.pending.get(id);
    const job = (async () => {
      try {
        const patch = await this.run(["show", "--format=", "--no-color", "--first-parent", h.last.hash, "--", h.last.path], root);
        const diff = capDiff(patch);
        if (!diff.trim()) return undefined;
        const { cleanSentence } = require("./describe.js");
        const text = cleanSentence(await this.ask(promptFor(rel, h.last, diff, this.lang())));
        if (!text) return undefined;
        r.explained[key] = text;
        this.save(root);
        return text;
      } catch {
        return undefined;
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, job);
    return job;
  }
}

module.exports = { FILE, FORMAT, parseLog, span, historyLines, capDiff, promptFor, SetupHistory };
