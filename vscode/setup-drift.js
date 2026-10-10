// @ts-check
// Setup drift (#31): the same agent file (same repo-relative path, e.g.
// .claude/hooks/where-we-left-off.sh) copied into several repos, and whether
// the copies still match. Repos: the window's roots plus the git repos one
// level under `imprimatur.setup.driftRoots` (default ~/projects). Files the
// user means to differ (CLAUDE.md by default) are left out. Cheap: an async
// walk like the setup scanner's (same skips, depth 6), hashes cached by
// size + mtime, other repos re-walked at most every few minutes.
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { classify } = require("./agent-setup.js");

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "vendor", "target", ".venv", "venv", "__pycache__", ".terraform"]);
const MAX_DEPTH = 6;
/** Imprimatur's own data and agent worktrees (copies of the repo): not setup. */
const SKIP_REL = [".claude/imprimatur", ".claude/worktrees"];
const DEFAULT_EXCLUDE = ["CLAUDE.md", "CLAUDE.local.md", ".claude/settings.local.json"];
/** Repos outside the window are walked again after this long. */
const WALK_TTL_MS = 5 * 60_000;

/** "~/x" → home/x. @param {string} p */
const expandHome = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Whether a path is left out: an entry without "/" matches the file name, one
 * ending in "/" a folder prefix, else the whole path.
 * @param {string} rel @param {string[]} exclude
 */
function excluded(rel, exclude) {
  const base = rel.split("/").pop();
  return exclude.some((e) => (e.endsWith("/") ? rel.startsWith(e) : e.includes("/") ? rel === e : base === e));
}

/**
 * Group copies of each path across repos by content hash. Pure.
 * @param {Array<{name: string, files: Record<string, string>}>} repos files: rel -> hash
 * @param {{exclude?: string[]}} [opts]
 * @returns {Map<string, {rel: string, total: number, variants: Array<{hash: string, repos: string[]}>}>}
 *   only paths found in two or more repos; variants most common first
 */
function groupDrift(repos, opts = {}) {
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  /** @type {Map<string, Map<string, string[]>>} */
  const byRel = new Map();
  for (const r of repos)
    for (const [rel, hash] of Object.entries(r.files)) {
      if (!hash || excluded(rel, exclude)) continue;
      const hashes = byRel.get(rel) ?? new Map();
      byRel.set(rel, hashes);
      hashes.set(hash, [...(hashes.get(hash) ?? []), r.name]);
    }
  const out = new Map();
  for (const [rel, hashes] of [...byRel].sort(([a], [b]) => a.localeCompare(b))) {
    const variants = [...hashes].map(([hash, names]) => ({ hash, repos: names.sort() })).sort((a, b) => b.repos.length - a.repos.length || a.hash.localeCompare(b.hash));
    const total = variants.reduce((n, v) => n + v.repos.length, 0);
    if (total >= 2) out.set(rel, { rel, total, variants });
  }
  return out;
}

/**
 * One repo's view of a group: in how many of the other copies it differs.
 * @param {{total: number, variants: Array<{hash: string, repos: string[]}>} | undefined} group @param {string} hash
 * @returns {{differs: number, total: number, others: Array<{hash: string, repos: string[]}>} | undefined} undefined when every copy matches
 */
function driftOf(group, hash) {
  if (!group || group.variants.length < 2) return undefined;
  const mine = group.variants.find((v) => v.hash === hash);
  const others = group.variants.filter((v) => v.hash !== hash);
  return { differs: group.total - (mine?.repos.length ?? 0), total: group.total, others };
}

/** "differs in 2 of 5 repos". @param {{differs: number, total: number}} d */
const driftLabel = (d) => `differs in ${d.differs} of ${d.total} repos`;

/**
 * Repos to compare: the roots, then git repos one level under each drift root;
 * each once (by real path). Names are folder names, or ~-relative paths when two clash.
 * @param {string[]} roots @param {string[]} driftRoots
 * @returns {Array<{name: string, root: string}>}
 */
function driftRepos(roots, driftRoots) {
  const seen = new Set();
  const list = [];
  const add = (root) => {
    let real;
    try {
      real = fs.realpathSync(root);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    list.push(root);
  };
  roots.forEach(add);
  for (const d of driftRoots.map(expandHome)) {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {}
    for (const e of entries) if (e.isDirectory() && fs.existsSync(path.join(d, e.name, ".git"))) add(path.join(d, e.name));
  }
  const home = os.homedir();
  const count = new Map();
  for (const r of list) count.set(path.basename(r), (count.get(path.basename(r)) ?? 0) + 1);
  return list.map((root) => ({
    root,
    name: count.get(path.basename(root)) > 1 ? (root.startsWith(home) ? `~${root.slice(home.length)}` : root) : path.basename(root),
  }));
}

/** Agent files under a folder, like agent-setup's findAgentFiles but async. @param {string} root @returns {Promise<string[]>} */
async function walkAgentFiles(root) {
  const out = [];
  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !SKIP_REL.includes(rel) && depth < MAX_DEPTH) await walk(abs, depth + 1);
      } else if (e.isFile() && classify(rel)) out.push(rel);
    }
  };
  await walk(root, 0);
  return out.sort();
}

class DriftScanner {
  constructor() {
    /** @type {Map<string, {size: number, mtimeMs: number, hash: string}>} abs -> hash, kept while size and mtime hold */
    this.hashes = new Map();
    /** @type {Map<string, {at: number, rels: string[]}>} root -> last walk */
    this.walks = new Map();
    /** @type {Array<{name: string, root: string}>} */
    this.repos = [];
    /** @type {ReturnType<typeof groupDrift>} */
    this.groups = new Map();
    this.hashed = 0;
  }

  /** Content hash, from the cache while size and mtime are unchanged. @param {string} abs */
  async hashOf(abs) {
    try {
      const st = await fsp.stat(abs);
      const hit = this.hashes.get(abs);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.hash;
      const hash = crypto.createHash("sha1").update(await fsp.readFile(abs)).digest("hex").slice(0, 12);
      this.hashed++;
      this.hashes.set(abs, { size: st.size, mtimeMs: st.mtimeMs, hash });
      return hash;
    } catch {
      return "";
    }
  }

  /**
   * Rescan: window roots are walked every time, other repos when their walk is old.
   * @param {string[]} roots @param {{driftRoots?: string[], exclude?: string[], now?: number}} [opts]
   */
  async scan(roots, opts = {}) {
    const now = opts.now ?? Date.now();
    const inWindow = new Set(roots);
    this.repos = driftRepos(roots, opts.driftRoots ?? ["~/projects"]);
    const repos = await Promise.all(
      this.repos.map(async ({ name, root }) => {
        let w = this.walks.get(root);
        if (!w || inWindow.has(root) || now - w.at > WALK_TTL_MS) this.walks.set(root, (w = { at: now, rels: await walkAgentFiles(root) }));
        /** @type {Record<string, string>} */
        const files = {};
        for (const rel of w.rels) if (!excluded(rel, opts.exclude ?? DEFAULT_EXCLUDE)) files[rel] = await this.hashOf(path.join(root, rel));
        return { name, files };
      }),
    );
    this.groups = groupDrift(repos, { exclude: opts.exclude });
    return this.groups;
  }

  /** A file's drift as its repo sees it. @param {string} rel @param {string} abs */
  driftFor(rel, abs) {
    const hit = this.hashes.get(abs);
    return hit ? driftOf(this.groups.get(rel), hit.hash) : undefined;
  }

  /** Where a variant lives: the first repo with that hash. @param {string} rel @param {string} hash */
  pathOf(rel, hash) {
    const name = this.groups.get(rel)?.variants.find((v) => v.hash === hash)?.repos[0];
    const repo = this.repos.find((r) => r.name === name);
    return repo && path.join(repo.root, rel);
  }
}

module.exports = { DEFAULT_EXCLUDE, excluded, groupDrift, driftOf, driftLabel, driftRepos, walkAgentFiles, DriftScanner, expandHome };
