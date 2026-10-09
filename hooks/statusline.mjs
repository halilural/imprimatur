#!/usr/bin/env node
// Claude Code status line (#66): one short line for the session's repo, e.g.
//   Imprimatur · 3 waiting on you · #64 👉 discover cache
// - "waiting on you": the user's open records in the repo (owner K, todo or
//   question) plus the open steps of the repo's waiting logs;
// - the task this session last wrote records of, with its 👉 (else its title).
// Nothing to say: "Imprimatur". Outside a git repo: nothing.
//
// Claude Code runs it after every assistant message (debounced 300 ms) and
// cancels a run still going: it reads files and the database only (no git, no
// model) and keeps its line for 2 s in a temp file per repo and session.
// Settings: {"statusLine": {"type": "command", "command": "node /…/hooks/statusline.mjs"}}
//
// Never fails: any error prints nothing and exits 0.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const CACHE_MS = 2000;
const TITLE_MAX = 40;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** ANSI, subtle: a dim name and separators, the count in yellow. NO_COLOR turns it off. */
const plain = "NO_COLOR" in process.env;
const dim = (s) => (plain ? s : `\x1b[2m${s}\x1b[22m`);
const warm = (s) => (plain ? s : `\x1b[33m${s}\x1b[39m`);

/** The nearest folder up with .git (a file in a worktree), as process.js's repoOf. @param {string} dir */
function repoOf(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/**
 * The status line's text for a repo and session (no cache).
 * @param {string} root @param {string | undefined} session
 */
function lineFor(root, session) {
  let asks = 0;
  /** @type {string | undefined} */ let current;
  // Only an existing database: opening one creates it.
  const { dbPath } = require("../vscode/db.js");
  if (fs.existsSync(dbPath())) {
    const records = require("../vscode/records.js");
    asks = records.userAsks(root).length;
    const key = session ? records.sessionTasks(root).get(session)?.at(-1) : undefined;
    if (key) {
      const pointer = records.recordsOf(root, key).find((/** @type {any} */ r) => r.pointer);
      const title = pointer?.title || records.taskTitle(root, key);
      current = `${key}${pointer ? " 👉" : ""}${title ? ` ${cut(title.replace(/\s+/g, " ").trim(), TITLE_MAX)}` : ""}`;
    }
  }
  const steps = require("../vscode/waiting.js").waitingSteps(root).filter((/** @type {any} */ s) => s.state === "open").length;
  const sep = dim(" · ");
  const parts = [dim("Imprimatur")];
  if (asks + steps) parts.push(warm(`${asks + steps} waiting on you`));
  if (current) parts.push(current);
  return parts.join(sep);
}

/** The cached line, if fresh. @param {string} file */
function cached(file) {
  try {
    const { at, line } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof line === "string" && Date.now() - at >= 0 && Date.now() - at < CACHE_MS) return line;
  } catch {}
  return undefined;
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (!input || typeof input !== "object") return;
  const dir = input.workspace?.current_dir ?? input.cwd;
  if (typeof dir !== "string" || !dir) return;
  const root = repoOf(dir);
  if (!root) return;
  const session = typeof input.session_id === "string" ? input.session_id : undefined;
  const id = crypto.createHash("sha1").update(`${root}\0${session ?? ""}\0${process.env.IMPRIMATUR_DB ?? ""}\0${plain}`).digest("hex").slice(0, 16);
  const file = path.join(os.tmpdir(), `imprimatur-statusline-${id}.json`);
  let line = cached(file);
  if (line === undefined) {
    line = lineFor(root, session);
    try {
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), line }));
    } catch {}
  }
  process.stdout.write(`${line}\n`);
}

try {
  main();
} catch {}
process.exitCode = 0;
