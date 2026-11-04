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

module.exports = { readUpstream, checkUpstream, staleOf, DAY };
