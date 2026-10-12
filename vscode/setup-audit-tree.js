// @ts-check
// "Recommendations" in Agent setup (#77): the AUDIT records (setup-audit.js) as a tree,
// per audited root → group (project, user, plugins by name, worktrees) → category →
// finding, errors first; applied and dismissed findings under their own rows. Plain
// rows only (setupView.js draws them), so it is testable without VS Code.
"use strict";

/**
 * @typedef {{type: "group" | "leaf", label: string, description?: string, tooltip?: string, markdown?: boolean, icon?: string, color?: string,
 *   abs?: string, line?: number, context?: string, recordId?: number, command?: string, expanded?: boolean, open?: number, children?: Row[]}} Row
 * @typedef {{id: number, status: string, title: string, body?: string | null, links?: any}} AuditRecord
 */

const LEVEL_ORDER = ["error", "warning", "info"];
const LEVEL_ICON = { error: ["error", "problemsErrorIcon.foreground"], warning: ["warning", "problemsWarningIcon.foreground"], info: ["info", "problemsInfoIcon.foreground"] };
const GROUPS = /** @type {const} */ ([
  ["project", "Project", "repo"],
  ["user", "Your setup", "account"],
  ["plugin", "Plugins", "extensions"],
  ["worktree", "Worktrees", "git-branch"],
]);

/** "2 errors · 14 warnings". @param {AuditRecord[]} recs */
function levelLine(recs) {
  /** @type {Record<string, number>} */
  const n = {};
  for (const r of recs) n[r.links.audit.level] = (n[r.links.audit.level] ?? 0) + 1;
  return LEVEL_ORDER.filter((l) => n[l]).map((l) => `${n[l]} ${l}${n[l] === 1 || l === "info" ? "" : "s"}`).join(" · ");
}

/** @param {AuditRecord} a @param {AuditRecord} b */
const byLevel = (a, b) => LEVEL_ORDER.indexOf(a.links.audit.level) - LEVEL_ORDER.indexOf(b.links.audit.level) || a.title.localeCompare(b.title);

/** A finding row: opens the file at its line; its record's body is the tooltip. @param {AuditRecord} r @param {string} root @returns {Row} */
function findingRow(r, root) {
  const a = r.links.audit;
  const message = r.title.replace(/^[^:]+:\s*/, "");
  const rel = a.file.startsWith(`${root}/`) || a.file.startsWith(`${root}\\`) ? a.file.slice(root.length + 1) : a.file;
  const [icon, color] = r.status === "open" ? LEVEL_ICON[/** @type {keyof typeof LEVEL_ICON} */ (a.level)] ?? LEVEL_ICON.info : r.status === "done" ? ["pass", "testing.iconPassed"] : ["circle-slash", "disabledForeground"];
  return {
    type: "leaf", label: message, description: `${a.rule} · ${rel}${a.line ? `:${a.line}` : ""}`, tooltip: r.body ?? r.title, markdown: true,
    icon, color, abs: a.file, line: a.line, context: `auditFinding-${r.status}`, recordId: r.id,
  };
}

/** Findings by category, the biggest first. @param {AuditRecord[]} recs @param {string} root @returns {Row[]} */
function byCategory(recs, root) {
  /** @type {Map<string, AuditRecord[]>} */
  const cats = new Map();
  for (const r of recs) cats.set(r.links.audit.category, [...(cats.get(r.links.audit.category) ?? []), r]);
  return [...cats.entries()]
    .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
    .map(([cat, rs]) => ({ type: "group", label: cat, description: `${rs.length} · ${levelLine(rs)}`, icon: "symbol-namespace", children: rs.sort(byLevel).map((r) => findingRow(r, root)) }));
}

/** By owner (a plugin, a worktree), then category. @param {AuditRecord[]} recs @param {string} root @returns {Row[]} */
function byOwner(recs, root) {
  /** @type {Map<string, AuditRecord[]>} */
  const owners = new Map();
  for (const r of recs) owners.set(r.links.audit.owner ?? "?", [...(owners.get(r.links.audit.owner ?? "?") ?? []), r]);
  return [...owners.entries()]
    .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
    .map(([owner, rs]) => ({ type: "group", label: owner, description: `${rs.length} · ${levelLine(rs)}`, icon: "package", children: byCategory(rs, root) }));
}

/**
 * One audited root's rows: its open findings by group, then Applied and Dismissed.
 * @param {{label: string, root: string, records: AuditRecord[], summary?: string | null}} scope @returns {Row}
 */
function scopeRow(scope) {
  const recs = scope.records.filter((r) => r.links?.audit);
  const open = recs.filter((r) => r.status === "open");
  /** @type {Row[]} */
  const children = [];
  for (const [g, label, icon] of GROUPS) {
    const rs = open.filter((r) => r.links.audit.group === g);
    if (!rs.length) continue;
    const owned = g === "plugin" || g === "worktree";
    children.push({ type: "group", label, description: `${rs.length} · ${levelLine(rs)}`, icon, expanded: g === "project" || g === "user", children: owned ? byOwner(rs, scope.root) : byCategory(rs, scope.root) });
  }
  const done = recs.filter((r) => r.status === "done");
  const dropped = recs.filter((r) => r.status === "dropped");
  if (done.length) children.push({ type: "group", label: "Applied", description: String(done.length), icon: "pass", children: done.map((r) => findingRow(r, scope.root)) });
  if (dropped.length) children.push({ type: "group", label: "Dismissed", description: String(dropped.length), icon: "circle-slash", children: dropped.map((r) => findingRow(r, scope.root)) });
  return {
    type: "group", label: scope.label, description: open.length ? `${open.length} open · ${levelLine(open)}` : "nothing open", icon: "folder",
    tooltip: scope.summary ?? undefined, children,
  };
}

/**
 * The "Recommendations" row: every audited root under it; before any audit, a row that
 * runs one.
 * @param {Array<{label: string, root: string, records: AuditRecord[], summary?: string | null}>} scopes @returns {Row}
 */
function recommendationsRow(scopes) {
  const audited = scopes.filter((s) => s.records.some((r) => r.links?.audit));
  if (!audited.length) {
    return { type: "leaf", label: "Recommendations", description: "audit the agent setup (agnix)", icon: "lightbulb", command: "imprimatur.setup.audit",
      tooltip: "Lints every agent file against rules from the tools' docs; findings are kept as records (open, applied, dismissed)." };
  }
  const open = audited.flatMap((s) => s.records.filter((r) => r.links?.audit && r.status === "open"));
  return { type: "group", label: `Recommendations (${open.length})`, description: levelLine(open), icon: "lightbulb", open: open.length, children: audited.map(scopeRow) };
}

module.exports = { recommendationsRow, scopeRow, findingRow, levelLine };
