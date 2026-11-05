#!/usr/bin/env node
// Claude Code status line (#66): one short line for the session's repo, e.g.
//   Imprimatur · 3 waiting on you · 12 edits to accept · #64 👉 discover cache
// - "waiting on you": the user's open records in the repo (owner K, todo or
//   question) plus the open steps of the repo's waiting logs;
// - "edits to accept" (#92): the agent's edits not accepted (as the extension last counted them);
// - the task this session last wrote records of, with its 👉 (else its title).
// Nothing to say: "Imprimatur". Outside a git repo: nothing.
//
// Claude Code runs it after every assistant message (debounced 300 ms) and
// cancels a run still going: it reads files and the database only (no git, no
// model) and keeps its line for 2 s in a temp file per repo and session.
// Settings: {"statusLine": {"type": "command", "command": "node /…/hooks/statusline.mjs"}}
//
// #123: with the Imprimatur plugin installed, the plugin's copy answers (the same code as the
// hooks and the MCP server), and a version other than the extension's is flagged: "⚠ 0.73.0 ≠
// extension 0.75.0".
//
// #149: it also keeps the session's cost, time, lines and tokens (vscode/sessions.js).
//
// Never fails: any error prints nothing and exits 0.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
/** The checkout or plugin folder this copy runs from. */
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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
  const edits = require("../vscode/review-state.js").readOpenEdits(root);
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
  if (edits) parts.push(`${edits} edit${edits === 1 ? "" : "s"} to accept`);
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
  // #149: the session's cost, time, lines and tokens, its row kept current.
  try {
    require("../vscode/sessions.js").recordSession(root, input);
  } catch {}
  const id = crypto.createHash("sha1").update(`${root}\0${session ?? ""}\0${process.env.IMPRIMATUR_DB ?? ""}\0${plain}`).digest("hex").slice(0, 16);
  const file = path.join(os.tmpdir(), `imprimatur-statusline-${id}.json`);
  let line = cached(file);
  if (line === undefined) {
    // A locked database must not hold the status line: wait 200 ms at most, and cache even a
    // failed answer so the next refresh does not wait again.
    try {
      require("../vscode/records.js").configure({ busyMs: 200 });
      line = lineFor(root, session);
    } catch {
      line = "Imprimatur";
    }
    line += skew();
    try {
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), line }));
    } catch {}
  }
  process.stdout.write(`${line}\n`);
}

/** " · ⚠ 0.73.0 ≠ extension 0.75.0" when this code and the installed extension differ (#123), else "". */
function skew() {
  try {
    const v = require("../vscode/versions.js");
    const own = v.codeVersion(HERE);
    const ext = v.extensionVersion();
    return own && ext && own !== ext ? dim(" · ") + warm(`⚠ ${own} ≠ extension ${ext}`) : "";
  } catch {
    return "";
  }
}

/** The plugin's own status line, when the plugin is installed and this copy is not it (#123). */
function pluginCopy() {
  if (process.env.IMPRIMATUR_STATUSLINE_HOP) return undefined;
  try {
    const v = require("../vscode/versions.js");
    const p = v.imprimaturPlugin();
    if (!p || v.sameDir(p.installPath, HERE)) return undefined;
    const f = path.join(p.installPath, "hooks", "statusline.mjs");
    return fs.existsSync(f) ? f : undefined;
  } catch {
    return undefined;
  }
}

const delegate = pluginCopy();
let answered = false;
if (delegate) {
  // It reads stdin and prints its line itself; once only (an older copy has no hop check).
  process.env.IMPRIMATUR_STATUSLINE_HOP = "1";
  try {
    await import(pathToFileURL(delegate).href);
    answered = true;
  } catch {}
}
if (!answered)
  try {
    main();
  } catch {}
process.exitCode = 0;
