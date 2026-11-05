// @ts-check
// The upstream check for hand-installed skills (#140): for each SOURCE.txt origin (a GitHub
// repo, the skill's folder in it, the installed commit), the newest commit that touches the
// folder and the installed commit's date, through the gh CLI, at most once a day. The result
// is kept in a JSON file that the setup scan reads (markUpstream).
// shortcut: GitHub only and through gh (its login, its rate limit); other hosts are not checked.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const DAY = 24 * 60 * 60 * 1000;

/** The last check, {} when there is none. @param {string} file @returns {Record<string, any>} */
function readUpstream(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** One GitHub API call through gh. @param {string} endpoint @returns {Promise<any>} */
const ghApi = (endpoint) =>
  new Promise((resolve, reject) =>
    execFile("gh", ["api", endpoint], { timeout: 20_000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return reject(new Error(String(err.message).split("\n")[0].slice(0, 120)));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    }),
  );

/** Origins whose check is missing, older than a day, or for another installed commit. @param {any[]} origins @param {Record<string, any>} cache @param {number} now */
const staleOf = (origins, cache, now) => {
  const seen = new Set();
  return origins.filter((o) => {
    if (seen.has(o.key)) return false;
    seen.add(o.key);
    const c = cache[o.key];
    return !c || c.commit !== o.commit || now - c.checkedAt >= DAY;
  });
};

/**
 * Checks the stale origins and writes the file. Returns whether anything was checked.
 * @param {{key: string, repo: string, path: string, commit: string}[]} origins
 * @param {string} file @param {{now?: number, api?: (endpoint: string) => Promise<any>}} [o]
 */
async function checkUpstream(origins, file, { now = Date.now(), api = ghApi } = {}) {
  const cache = readUpstream(file);
  const stale = staleOf(origins, cache, now);
  if (!stale.length) return false;
  for (const o of stale) {
    // Names come from a file anyone could have written: only plain GitHub names and a hex commit go into the URL.
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo) || !/^[0-9a-f]{7,40}$/i.test(o.commit) || /\.\./.test(o.path)) {
      cache[o.key] = { commit: o.commit, checkedAt: now, error: "not a GitHub source" };
      continue;
    }
    try {
      const [latest] = await api(`repos/${o.repo}/commits?per_page=1${o.path ? `&path=${encodeURIComponent(o.path)}` : ""}`);
      const installed = await api(`repos/${o.repo}/commits/${o.commit}`);
      cache[o.key] = {
        commit: o.commit, checkedAt: now,
        latest: String(latest?.sha ?? ""), latestDate: String(latest?.commit?.committer?.date ?? ""),
        installedSha: String(installed?.sha ?? ""), installedDate: String(installed?.commit?.committer?.date ?? ""),
      };
    } catch (e) {
      cache[o.key] = { commit: o.commit, checkedAt: now, error: e instanceof Error ? e.message : String(e) };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 1));
  return true;
}

/** One file's raw text through gh (a GET). @param {string} endpoint @returns {Promise<string>} */
const ghRaw = (endpoint) =>
  new Promise((resolve, reject) =>
    execFile("gh", ["api", "-H", "Accept: application/vnd.github.raw", endpoint], { timeout: 20_000, maxBuffer: 4 << 20, encoding: "utf8" }, (err, out) =>
      err ? reject(new Error(String(err.message).split("\n")[0].slice(0, 120))) : resolve(out)));

/** Caps on a downloaded skill folder: a skill is a few text files. */
const MAX_FILES = 60;
const MAX_BYTES = 2 << 20;

/**
 * Downloads a skill's folder at a commit into dest (#156), for Fix it to compare and copy.
 * Only GET requests; every path is checked to stay inside the folder and dest.
 * @param {{repo: string, path: string}} origin @param {string} ref a commit sha @param {string} dest an empty folder
 * @param {{api?: typeof ghApi, raw?: typeof ghRaw}} [o] @returns {Promise<string[]>} the files written, relative to dest
 */
async function fetchSkillFolder(origin, ref, dest, { api = ghApi, raw = ghRaw } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(origin.repo) || !/^[0-9a-f]{7,40}$/i.test(ref) || /(^|\/)\.\.(\/|$)/.test(origin.path)) throw new Error("not a plain GitHub source");
  const base = origin.path ? `${origin.path.replace(/\/+$/, "")}/` : "";
  const tree = await api(`repos/${origin.repo}/git/trees/${ref}?recursive=1`);
  const files = (Array.isArray(tree?.tree) ? tree.tree : []).filter((e) => e?.type === "blob" && typeof e.path === "string" && e.path.startsWith(base));
  if (!files.length) throw new Error(`no files under ${origin.path || "the root"} at ${ref.slice(0, 7)}`);
  if (files.length > MAX_FILES) throw new Error(`${files.length} files: more than a skill should have`);
  const root = path.resolve(dest);
  const written = [];
  let bytes = 0;
  for (const f of files) {
    const rel = f.path.slice(base.length);
    const out = path.resolve(root, rel);
    if (!rel || rel.split("/").includes("..") || !out.startsWith(root + path.sep)) continue;
    const text = await raw(`repos/${origin.repo}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`);
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new Error("the folder is larger than a skill should be");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    written.push(rel);
  }
  return written;
}

/**
 * Takes a reviewed skill version in (#156): copies the downloaded files over the installed
 * skill and records the new commit in its SOURCE.txt. Files only the installed copy has stay
 * (SOURCE.txt among them). Done here, not by the agent: Claude Code does not let an agent
 * edit ~/.claude/skills.
 * @param {string} from the downloaded folder @param {string} to the installed skill's folder
 * @param {string[]} files the downloaded files, relative @param {string} commit the new commit
 * @param {string} note what the review checked, one line @param {string} day YYYY-MM-DD
 */
function applySkillUpdate(from, to, files, commit, note, day) {
  const root = path.resolve(to);
  for (const rel of files) {
    const out = path.resolve(root, rel);
    if (!rel || rel.split(/[\\/]/).includes("..") || !out.startsWith(root + path.sep) || path.basename(rel) === "SOURCE.txt") continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(from, rel), out);
  }
  const src = path.join(root, "SOURCE.txt");
  const text = fs.existsSync(src) ? fs.readFileSync(src, "utf8") : "";
  const line = `updated: ${day} to ${commit.slice(0, 7)}, reviewed by Claude through Imprimatur's Fix it: ${note.replace(/[\r\n]+/g, " ").slice(0, 200)}`;
  const next = /^commit:.*$/m.test(text) ? text.replace(/^commit:.*$/m, `commit: ${commit.slice(0, 7)}`) : `${text}commit: ${commit.slice(0, 7)}\n`;
  fs.writeFileSync(src, `${next.replace(/\n?$/, "\n")}${line}\n`);
}

/** The review's verdict, its last "VERDICT:" line: SAFE, or STOP with a reason. @param {string} answer */
function verdictOf(answer) {
  const m = [...String(answer).matchAll(/^\s*\**VERDICT:\**\s*(SAFE|STOP)\b[:\s-]*(.*)$/gim)].at(-1);
  return m ? { safe: m[1].toUpperCase() === "SAFE", reason: m[2].trim() } : { safe: false, reason: "the review gave no verdict" };
}

module.exports = { readUpstream, checkUpstream, staleOf, fetchSkillFolder, applySkillUpdate, verdictOf, DAY };
