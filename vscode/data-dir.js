// @ts-check
// Where a repo's Imprimatur data lives (#126): next to the database, not in the repo.
//   <database folder>/repos/<repo name>-<sha1 of its real path, 10>/
// It holds what .claude/imprimatur/ held (baseline/, history/, waiting/, activity/,
// pending/, archive/, docs-backup/, the state files). Every reader and writer keeps its
// old relative constant (".claude/imprimatur/history") and asks dataPath(root, CONST).
// The first use in a process moves an old in-repo folder here, under a lock; the old
// folder keeps its .gitignore and a MOVED.md. mergeLegacy() takes in what an older
// release still writes there.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The in-repo folder of releases before 0.89.0, and the prefix of every data constant. */
const LEGACY = path.join(".claude", "imprimatur");
/** What stays in the old folder after the move. */
const KEEP = new Set([".gitignore", "MOVED.md"]);
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 60_000;

/** @type {Map<string, string>} */
const known = new Map();

/** The folder every repo's data folder is in. @param {NodeJS.ProcessEnv} [env] */
const dataHome = (env = process.env) => path.join(path.dirname(require("./db.js").dbPath(env)), "repos");

/** A repo's folder name: readable, and unique per real path. @param {string} root */
function keyOf(root) {
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(real);
  } catch {}
  const name = path.basename(real).replace(/[^\w.-]+/g, "_").slice(0, 40) || "repo";
  return `${name}-${crypto.createHash("sha1").update(real).digest("hex").slice(0, 10)}`;
}

const sleep = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Moves src into dst, entry by entry: a missing target is renamed (copied across devices);
 * folders merge; two .jsonl files are joined (src appended to dst); for any other file the
 * one already in dst stays. src is gone afterwards.
 * @param {string} src @param {string} dst
 */
function mergeInto(src, dst) {
  const st = fs.lstatSync(src);
  // A link is not followed nor moved: what it points to may be outside the repo.
  if (st.isSymbolicLink()) return;
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      if (/** @type {any} */ (e).code !== "EXDEV") throw e;
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    }
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src)) mergeInto(path.join(src, name), path.join(dst, name));
    fs.rmSync(src, { recursive: true, force: true });
    return;
  }
  if (src.endsWith(".jsonl")) {
    const text = fs.readFileSync(src, "utf8");
    if (text) {
      const tail = fs.readFileSync(dst, "utf8");
      fs.appendFileSync(dst, (tail && !tail.endsWith("\n") ? "\n" : "") + text);
    }
  }
  fs.rmSync(src, { force: true });
}

/**
 * Whether the old folder is really the repo's own: neither .claude nor .claude/imprimatur a
 * link, and its real path inside the repo's. A repo could point either at any folder of the
 * user (~/.ssh), and the move would carry that folder's files away.
 * @param {string} root @param {string} legacy
 */
function inRepo(root, legacy) {
  try {
    for (const p of [path.dirname(legacy), legacy]) if (fs.lstatSync(p).isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(path.resolve(root));
    return fs.realpathSync(legacy).startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

/** Writes a plain new file: a link in its place is removed first, never written through. @param {string} f @param {string} text */
function plainWrite(f, text) {
  try {
    if (fs.lstatSync(f).isSymbolicLink() || fs.existsSync(f)) fs.rmSync(f, { force: true });
  } catch {}
  fs.writeFileSync(f, text, { flag: "wx" });
}

/** The old folder's entries still to take in. @param {string} legacy */
const leftovers = (legacy) => {
  try {
    return fs.readdirSync(legacy).filter((n) => !KEEP.has(n));
  } catch {
    return [];
  }
};

/**
 * Takes in an old in-repo folder, under a lock (another process waits; a stale lock is
 * taken over). Returns how many entries moved.
 * @param {string} root @param {string} dir
 */
function mergeLegacy(root, dir = dataDir(root)) {
  const legacy = path.join(path.resolve(root), LEGACY);
  if (!inRepo(root, legacy) || !leftovers(legacy).length) return 0;
  const lock = `${dir}.moving`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) return 0; // another process is moving it
      else sleep(25);
    }
  }
  let moved = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of leftovers(legacy)) {
      try {
        mergeInto(path.join(legacy, name), path.join(dir, name));
        moved++;
      } catch {
        // a hook writing it right now: the next run takes it
      }
    }
    plainWrite(path.join(legacy, ".gitignore"), "# Imprimatur's local data (edit copies, logs): never committed.\n*\n");
    plainWrite(path.join(legacy, "MOVED.md"), `Imprimatur keeps this repo's data outside the repo since 0.89.0 (#126):\n\n${dir}\n\nThis folder can be deleted.\n`);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
  return moved;
}

/**
 * A repo's data folder, made when missing; the first call in a process takes in the old
 * in-repo folder.
 * @param {string} root @param {{env?: NodeJS.ProcessEnv}} [o]
 */
function dataDir(root, { env = process.env } = {}) {
  const r = path.resolve(root);
  const home = dataHome(env);
  const hit = known.get(`${home}\0${r}`);
  if (hit) return hit;
  const dir = path.join(home, keyOf(r));
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!fs.existsSync(path.join(dir, "root.txt"))) fs.writeFileSync(path.join(dir, "root.txt"), r + "\n");
  } catch {}
  known.set(`${home}\0${r}`, dir);
  try {
    mergeLegacy(r, dir);
  } catch {}
  return dir;
}

/**
 * A path in a repo's data folder. `rel` is one of the old relative constants
 * (".claude/imprimatur/history"), or a path inside the folder ("history").
 * @param {string} root @param {string} rel @param {...string} more
 */
function dataPath(root, rel, ...more) {
  const r = path.normalize(rel);
  const inside = r === LEGACY ? "" : r.startsWith(LEGACY + path.sep) ? r.slice(LEGACY.length + 1) : r;
  return path.join(dataDir(root), inside, ...more);
}

/** Forget the folders found (tests that change IMPRIMATUR_DB). */
const forget = () => known.clear();

module.exports = { LEGACY, dataDir, dataPath, dataHome, keyOf, mergeLegacy, mergeInto, forget };
