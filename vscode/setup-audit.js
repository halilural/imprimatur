// @ts-check
// Agent setup audit (#77): agnix (https://github.com/agent-sh/agnix) lints every
// agent file under a root against its rules, each sourced from the tools' docs.
// Its whole output is kept: no rule and no file is left out. Each finding is a
// record ("fixme") of the root's AUDIT task, matched across runs by a fingerprint:
//   new finding                  → open record
//   finding gone                 → done ("applied")
//   done record found again      → open again
//   dropped record (dismissed)   → stays dropped: a dismissed finding never comes back
// Global setup (~) is audited as its own root, the home folder's repo row.
"use strict";
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The agnix release this code reads; its JSON shape is pinned with it. */
const AGNIX = "agnix@0.57.0";
const TASK = "AUDIT";
const TASK_TITLE = "Agent setup audit (agnix)";
/** @type {import("./db.js").Actor} */
const ACTOR = { kind: "hook", id: "audit" };
const TITLE_MAX = 300;

/**
 * @typedef {{level: string, rule: string, file: string, line?: number, column?: number, message: string, suggestion?: string,
 *   assumption?: string, category?: string, rule_severity?: string, applies_to_tool?: string}} Diagnostic
 * @typedef {{fp: string, rule: string, level: string, file: string, rel: string, line: number, message: string, suggestion?: string,
 *   assumption?: string, category: string, severity?: string, tool?: string, group: string, owner?: string}} Finding
 * @typedef {{name?: string, severity?: string, category?: string, evidence?: {source_urls?: string[], verified_on?: string,
 *   normative_level?: string, source_type?: string}}} Rule
 */

/**
 * The agnix binary: AGNIX_BIN, else the one npx fetches (once, cached by npm). The npm
 * package is a Node wrapper around a Rust binary; calling the binary itself makes
 * `explain` instant (npx costs ~1.4 s a call).
 * @param {{env?: NodeJS.ProcessEnv, spawn?: typeof spawnSync}} [o] @returns {string}
 */
function locateAgnix({ env = process.env, spawn = spawnSync } = {}) {
  if (env.AGNIX_BIN) return env.AGNIX_BIN;
  const [cmd, args, opts, done] = locateCall();
  try {
    return binOf(spawn(cmd, args, opts));
  } finally {
    done();
  }
}

/** The npx call that prints the binary's path, and what removes its script after. @returns {[string, string[], any, () => void]} */
function locateCall() {
  const name = process.platform === "win32" ? "agnix-binary.exe" : "agnix-binary";
  // npx puts the package's node_modules/.bin on PATH; the binary sits in ../agnix/bin.
  const script = `const p=require("node:path"),f=require("node:fs");for(const d of process.env.PATH.split(p.delimiter)){const b=p.join(d,"..","agnix","bin",${JSON.stringify(name)});if(f.existsSync(b)){process.stdout.write(b);break}}`;
  // A file, not node -e: on Windows npx is a .cmd run through the shell, which would split the script.
  // In a fresh owner-only folder: a fixed name in the shared temp folder could be planted by another user.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-agnix-"));
  const file = path.join(dir, "locate.cjs");
  fs.writeFileSync(file, script, { mode: 0o600, flag: "wx" });
  const win = process.platform === "win32";
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  return ["npx", ["-y", "-p", AGNIX, "node", win ? `"${file}"` : file], { encoding: "utf8", shell: win, timeout: 180_000 }, done];
}

/** @param {any} r a spawn result @returns {string} */
function binOf(r) {
  const bin = String(r.stdout ?? "").trim();
  if (r.status !== 0 || !bin) throw new Error(`agnix not found (npx -p ${AGNIX}): ${String(r.stderr || r.error || "").trim().slice(0, 300)}`);
  return bin;
}

/**
 * agnix's JSON report for a root (or some paths under it). Exit 1 means errors were
 * found, not a failure.
 * @param {string} bin @param {string} root @param {{paths?: string[], spawn?: typeof spawnSync}} [o]
 * @returns {{version: string, files_checked: number, diagnostics: Diagnostic[]}}
 */
function runAgnix(bin, root, { paths = [root], spawn = spawnSync } = {}) {
  return reportOf(root, spawn(bin, [...paths, "--format", "json"], runOpts(root)));
}
/** @param {string} root */
const runOpts = (root) => ({ cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 600_000 });
/** @param {string} root @param {any} r a spawn result */
function reportOf(root, r) {
  try {
    return JSON.parse(String(r.stdout));
  } catch {
    throw new Error(`agnix ${root}: ${String(r.stderr || r.error || `exit ${r.status}`).trim().slice(0, 300)}`);
  }
}

/** spawnSync's answer, from a child that does not block (the extension host). @param {string} cmd @param {string[]} args @param {any} opts @returns {Promise<any>} */
function spawnAsync(cmd, args, opts = {}) {
  const { execFile } = require("node:child_process");
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, shell: opts.shell, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr, error: err && typeof err.code !== "number" ? err : undefined }));
  });
}

/**
 * locateAgnix without blocking: the first npx can download for a while.
 * @param {{env?: NodeJS.ProcessEnv}} [o] @returns {Promise<string>}
 */
async function locateAgnixAsync({ env = process.env } = {}) {
  if (env.AGNIX_BIN) return env.AGNIX_BIN;
  const [cmd, args, opts, done] = locateCall();
  try {
    return binOf(await spawnAsync(cmd, args, opts));
  } finally {
    done();
  }
}

/** runAgnix without blocking: a big home takes seconds. @param {string} bin @param {string} root @param {{paths?: string[]}} [o] */
async function runAgnixAsync(bin, root, { paths = [root] } = {}) {
  return reportOf(root, await spawnAsync(bin, [...paths, "--format", "json"], runOpts(root)));
}

/** A rule's metadata (sources, verified on), from `agnix explain`. @param {string} bin @param {string} id @param {{spawn?: typeof spawnSync}} [o] @returns {Rule | undefined} */
function explainRule(bin, id, { spawn = spawnSync } = {}) {
  const r = spawn(bin, ["explain", id, "--format", "json"], { encoding: "utf8", timeout: 30_000 });
  try {
    return JSON.parse(String(r.stdout));
  } catch {
    return undefined;
  }
}

/** Every rule of a report not yet in the cache, explained without blocking. @param {string} bin @param {{diagnostics?: Diagnostic[]}} report @param {Map<string, Rule | undefined>} rules */
async function explainRulesAsync(bin, report, rules) {
  for (const id of new Set((report.diagnostics ?? []).map((d) => d.rule))) {
    if (rules.has(id)) continue;
    const r = await spawnAsync(bin, ["explain", id, "--format", "json"], { timeout: 30_000 });
    try {
      rules.set(id, JSON.parse(String(r.stdout)));
    } catch {
      rules.set(id, undefined);
    }
  }
}

/**
 * Where a file's finding belongs: the repo itself, the user's own setup (~/.claude and
 * the like), a plugin (named) or an agent worktree.
 * @param {string} abs @param {{home?: string}} [o] @returns {{group: "project" | "user" | "plugin" | "worktree", owner?: string}}
 */
function groupOf(abs, { home = os.homedir() } = {}) {
  const p = slash(abs);
  const plug = p.match(/\/\.claude\/plugins\/(?:cache\/([^/]+)\/([^/]+)|marketplaces\/([^/]+)(?:\/plugins\/([^/]+))?)/);
  if (plug) {
    const [, market, name, mkt, sub] = plug;
    const owner = name ?? sub ?? mkt;
    return { group: "plugin", owner: /^temp_git_/.test(market ?? "") ? "temp" : owner };
  }
  if (/\/\.claude\/worktrees\/[^/]+\//.test(p)) return { group: "worktree", owner: p.match(/\/\.claude\/worktrees\/([^/]+)\//)?.[1] };
  const h = slash(home);
  const same = (/** @type {string} */ a, /** @type {string} */ b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (GLOBAL_DIRS.some((d) => same(p, `${h}/${d}`) || same(p.slice(0, h.length + d.length + 2), `${h}/${d}/`))) return { group: "user" };
  return { group: "project" };
}
/** @param {string} p */
const slash = (p) => p.split(path.sep).join("/");

/**
 * The path a fingerprint uses: a plugin's file without its version folder (or temp
 * clone), so a plugin update keeps its findings, and a dismissed one stays dismissed.
 * @param {string} abs @param {string} rel
 */
function fpPath(abs, rel) {
  const cache = slash(abs).match(/\/\.claude\/plugins\/cache\/([^/]+)\/(.*)$/);
  if (!cache) return rel;
  const [, market, rest] = cache;
  if (/^temp_git_/.test(market)) return `plugin-temp:${rest}`;
  const m = rest.match(/^([^/]+)\/[^/]+\/(.*)$/);
  return m ? `plugin:${market}/${m[1]}/${m[2]}` : `plugin:${market}/${rest}`;
}

/**
 * The report's diagnostics as findings, every one kept. The fingerprint is rule + file +
 * message + which occurrence: a line number is left out so an edit above it does not
 * make a finding look new.
 * @param {{diagnostics?: Diagnostic[]}} report @param {{root: string, home?: string, global?: boolean}} scope @returns {Finding[]}
 */
function findingsOf(report, { root, home = os.homedir(), global = false }) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  return (report.diagnostics ?? []).map((d) => {
    const abs = d.file ? path.resolve(root, d.file) : root;
    const rel = d.file ? path.relative(root, abs) || path.basename(abs) : "";
    const base = `${d.rule}\u0000${fpPath(abs, rel)}\u0000${d.message}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const fp = crypto.createHash("sha1").update(`${base}\u0000${n}`).digest("hex").slice(0, 16);
    let { group, owner } = groupOf(abs, { home });
    if (global && group === "project") group = "user";
    return {
      fp, rule: d.rule, level: d.level, file: abs, rel, line: d.line ?? 1, message: d.message, suggestion: d.suggestion, assumption: d.assumption,
      category: d.category ?? "other", severity: d.rule_severity, tool: d.applies_to_tool, group, owner,
    };
  });
}

/** A finding's record title: rule and message, one line. @param {Finding} f */
const titleOf = (f) => `${f.rule}: ${f.message.replace(/\s+/g, " ")}`.slice(0, TITLE_MAX);

/** A finding's record body (Markdown): where, how bad, what to do, and the rule's sources. @param {Finding} f @param {Rule} [rule] */
function bodyOf(f, rule) {
  const ev = rule?.evidence;
  const lines = [
    `**File:** \`${f.rel || "(project)"}\`${f.rel ? `:${f.line}` : ""}`,
    `**Level:** ${[f.level, f.severity, f.category, f.tool].filter(Boolean).join(" · ")}`,
    `**Group:** ${f.group}${f.owner ? ` (${f.owner})` : ""}`,
  ];
  if (f.suggestion) lines.push("", f.suggestion);
  if (f.assumption) lines.push("", `_Assumes:_ ${f.assumption}`);
  if (rule?.name || ev?.source_urls?.length) {
    const meta = [ev?.normative_level, ev?.source_type, ev?.verified_on && `verified ${ev.verified_on}`].filter(Boolean).join(", ");
    lines.push("", `**Rule:** ${f.rule}${rule?.name ? ` (${rule.name})` : ""}${meta ? `; ${meta}` : ""}`);
    for (const u of ev?.source_urls ?? []) lines.push(`- ${u}`);
  }
  return lines.join("\n");
}

/** The fields an audit record links: enough to group and open it without the body. @param {Finding} f */
const linksOf = (f) => ({
  audit: { fp: f.fp, rule: f.rule, level: f.level, category: f.category, group: f.group, ...(f.owner ? { owner: f.owner } : {}), file: f.file, line: f.line, agnix: AGNIX },
});

/**
 * What a run changes in the AUDIT task's records: a pure plan.
 * @param {Finding[]} findings @param {Array<{id: number, status: string, title: string, links?: any}>} records
 * @returns {{add: Finding[], reopen: Array<{id: number, f: Finding}>, update: Array<{id: number, f: Finding}>, resolve: number[], dismissed: number, open: number, live: Finding[]}}
 */
function reconcile(findings, records) {
  /** @type {Map<string, any>} */
  const byFp = new Map();
  for (const r of records) if (r.links?.audit?.fp) byFp.set(r.links.audit.fp, r);
  const found = new Set(findings.map((f) => f.fp));
  /** @type {ReturnType<typeof reconcile>} */
  const plan = { add: [], reopen: [], update: [], resolve: [], dismissed: 0, open: 0, live: [] };
  for (const f of findings) {
    const r = byFp.get(f.fp);
    if (r?.status !== "dropped") plan.live.push(f);
    if (!r) plan.add.push(f);
    else if (r.status === "dropped") plan.dismissed++;
    else if (r.status === "done") plan.reopen.push({ id: r.id, f });
    else if (r.links.audit.line !== f.line || r.title !== titleOf(f)) plan.update.push({ id: r.id, f });
  }
  for (const r of byFp.values()) if (r.status === "open" && !found.has(r.links.audit.fp)) plan.resolve.push(r.id);
  plan.open = findings.length - plan.dismissed;
  return plan;
}

/** The agent folders of the home that exist: the global setup. A walk of the whole home would read every project. @param {string} [home] */
function globalPaths(home = os.homedir()) {
  return GLOBAL_DIRS.map((d) => path.join(home, d)).filter(exists);
}
/** What agnix reads for a scope: the repo, or the home's agent folders. @param {{root: string, global?: boolean, home?: string}} scope */
const pathsOf = (scope) => {
  const home = scope.home ?? os.homedir();
  if (scope.global) return globalPaths(home);
  // A repo at the home itself would be a walk of every project: its agent folders are the global audit.
  return path.resolve(scope.root) === path.resolve(home) ? [] : [scope.root];
};
const GLOBAL_DIRS = [".claude", ".cursor", ".codex", ".gemini", ".kiro", ".copilot", ".windsurf", ".codeium", ".config/opencode"];

/**
 * Audits one root and writes the plan to its AUDIT task, in one transaction.
 * @param {any} db @param {{root: string, global?: boolean, home?: string}} scope
 * @param {{bin: string, dryRun?: boolean, rules?: Map<string, Rule | undefined>, spawn?: typeof spawnSync, now?: number, report?: any}} o
 */
function auditRoot(db, scope, { bin, dryRun = false, rules = new Map(), spawn = spawnSync, now = Date.now(), report }) {
  const home = scope.home ?? os.homedir();
  const paths = pathsOf(scope);
  const rep = report ?? (paths.length ? runAgnix(bin, scope.root, { paths, spawn }) : { files_checked: 0, diagnostics: [] });
  const findings = findingsOf(rep, { root: scope.root, home, global: scope.global });
  const repo = db.repoOf(scope.root, scope.global ? { name: "~" } : {});
  const read = () => {
    const task = db.taskByKey(repo.id, TASK);
    const records = task ? db.recordsOf(task.id, { dropped: true }).filter((/** @type {any} */ r) => r.links?.audit) : [];
    return { task, plan: reconcile(findings, records) };
  };
  const summaryOf = (/** @type {ReturnType<typeof reconcile>} */ plan) => ({
    root: scope.root, files: rep.files_checked ?? 0, findings: findings.length, added: plan.add.length, reopened: plan.reopen.length,
    resolved: plan.resolve.length, dismissed: plan.dismissed, open: plan.open, groups: countBy(findings, (f) => f.group), levels: countBy(findings, (f) => f.level),
  });
  const first = read().plan;
  if (dryRun) return summaryOf(first);
  const ruleOf = (/** @type {string} */ id) => {
    if (!rules.has(id)) rules.set(id, explainRule(bin, id, { spawn }));
    return rules.get(id);
  };
  // Explained before the transaction: it holds the database's write lock.
  for (const f of [...first.add, ...first.reopen.map((x) => x.f), ...first.update.map((x) => x.f)]) ruleOf(f.rule);
  const day = new Date(now).toISOString().slice(0, 10);
  // Read, plan and write in one transaction: an audit from another process (the MCP
  // server, the CLI) cannot add the same findings twice or reopen one just dismissed.
  return db.tx(() => {
    const { task, plan } = read();
    const summary = summaryOf(plan);
    const line = `${plan.open} open: ${describeCounts(countBy(plan.live, (f) => f.level))}`;
    const changed = plan.add.length || plan.reopen.length || plan.update.length || plan.resolve.length;
    // Created active; after that only its summary, and only when it says something new.
    const t = !task ? db.upsertTask(repo.id, TASK, { title: TASK_TITLE, status: "active", summary: line }, ACTOR)
      : task.summary !== line ? db.upsertTask(repo.id, TASK, { summary: line }, ACTOR) : task;
    if (!changed) return summary;
    for (const f of plan.add) db.addRecord(t.id, { kind: "fixme", title: titleOf(f), body: bodyOf(f, ruleOf(f.rule)), links: linksOf(f) }, ACTOR);
    for (const { id, f } of plan.reopen) db.updateRecord(id, { status: "open", title: titleOf(f), body: `${bodyOf(f, ruleOf(f.rule))}\n\n_Found again ${day}._`, links: linksOf(f) }, ACTOR);
    for (const { id, f } of plan.update) db.updateRecord(id, { title: titleOf(f), body: bodyOf(f, ruleOf(f.rule)), links: linksOf(f) }, ACTOR);
    for (const id of plan.resolve) {
      const r = db.record(id);
      db.updateRecord(id, { status: "done", body: `${r.body ?? ""}\n\n_Applied: gone in the audit of ${day}._` }, ACTOR);
    }
    return summary;
  });
}

/** @template T @param {T[]} xs @param {(x: T) => string} key @returns {Record<string, number>} */
function countBy(xs, key) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/** "3 errors, 14 warnings, 1 info". @param {Record<string, number>} levels */
function describeCounts(levels) {
  const parts = Object.entries(levels).sort(([a], [b]) => LEVELS.indexOf(a) - LEVELS.indexOf(b)).map(([l, n]) => `${n} ${l}${n === 1 || l === "info" ? "" : "s"}`);
  return parts.join(", ") || "nothing found";
}
const LEVELS = ["error", "warning", "info"];

/** One line per audited root, for the CLI, the MCP tool and the extension. @param {ReturnType<typeof auditRoot>} s */
function describeSummary(s) {
  const groups = Object.entries(s.groups).map(([g, n]) => `${g} ${n}`).join(", ");
  return `${s.root}: ${s.files} files, ${s.findings} findings (${describeCounts(s.levels)}${groups ? `; ${groups}` : ""}); ${s.added} new, ${s.resolved} applied, ${s.reopened} back, ${s.dismissed} dismissed`;
}

/** Whether a path exists (the home's agent folders are audited only when there). @param {string} p */
const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

module.exports = { AGNIX, TASK, ACTOR, locateAgnix, runAgnix, locateAgnixAsync, runAgnixAsync, explainRule, groupOf, findingsOf, titleOf, bodyOf, linksOf, reconcile, auditRoot, globalPaths, pathsOf, fpPath, explainRulesAsync, describeSummary, describeCounts, countBy, exists };
