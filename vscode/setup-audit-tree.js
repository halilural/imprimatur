// @ts-check
// "Recommendations" in Agent setup (#77): the AUDIT records (setup-audit.js) grouped.
// auditGroups is the one grouping, for the Agent setup tree and the task page (#77):
//   status (open, applied, dismissed)
//     [dismissed: reason (third-party plugin, synced skill, false alarm, this machine, other)]
//     → source (project, your setup, synced skills, plugins → plugin, worktrees → worktree)
//     → agnix's category (claude-hooks, agent-skills, ...) → rule → finding, errors first.
// Plain data and rows only (setupView.js and tasksView.js draw them): testable without VS Code.
"use strict";

/**
 * @typedef {{type: "group" | "leaf", label: string, description?: string, tooltip?: string, markdown?: boolean, icon?: string, color?: string,
 *   abs?: string, line?: number, context?: string, recordId?: number, command?: string, expanded?: boolean, open?: number, children?: Row[]}} Row
 * @typedef {{id: number, status: string, title: string, body?: string | null, links?: any}} AuditRecord
 * @typedef {{key: string, label: string, icon: string, count: number, levels: Record<string, number>, children?: Group[], records?: AuditRecord[]}} Group
 */

const LEVEL_ORDER = ["error", "warning", "info"];
const LEVEL_ICON = { error: ["error", "problemsErrorIcon.foreground"], warning: ["warning", "problemsWarningIcon.foreground"], info: ["info", "problemsInfoIcon.foreground"] };
/** [key, English, Turkish, icon] */
const STATUSES = [["open", "Open", "Açık", "lightbulb"], ["done", "Applied", "Uygulandı", "pass"], ["dropped", "Dismissed", "Reddedildi", "circle-slash"]];
const SOURCES = [
  ["project", "Project", "Proje", "repo"],
  ["user", "Your setup", "Senin ayarların", "account"],
  ["synced", "Synced skills (claude.ai)", "Eşitlenen skill'ler (claude.ai)", "cloud"],
  ["plugin", "Plugins", "Plugin'ler", "extensions"],
  ["worktree", "Worktrees", "Worktree'ler", "git-branch"],
];
const REASON_LABELS = {
  plugin: ["Third-party plugin", "Üçüncü taraf plugin", "extensions"],
  synced: ["Synced skill (claude.ai)", "Eşitlenen skill (claude.ai)", "cloud"],
  false: ["False alarm", "Yanlış alarm", "close"],
  local: ["Specific to this machine", "Bu makineye özel", "device-desktop"],
  other: ["Other", "Diğer", "question"],
};

/** "2 errors · 14 warnings". @param {AuditRecord[] | Record<string, number>} recs */
function levelLine(recs) {
  const n = Array.isArray(recs) ? countLevels(recs) : recs;
  return LEVEL_ORDER.filter((l) => n[l]).map((l) => `${n[l]} ${l}${n[l] === 1 || l === "info" ? "" : "s"}`).join(" · ");
}
/** @param {AuditRecord[]} recs @returns {Record<string, number>} */
function countLevels(recs) {
  /** @type {Record<string, number>} */
  const n = {};
  for (const r of recs) n[r.links.audit.level] = (n[r.links.audit.level] ?? 0) + 1;
  return n;
}

/** @param {AuditRecord} a @param {AuditRecord} b */
const byLevel = (a, b) => LEVEL_ORDER.indexOf(a.links.audit.level) - LEVEL_ORDER.indexOf(b.links.audit.level) || a.title.localeCompare(b.title);

/**
 * Why a dismissed finding was dismissed: links.audit.reason, else what its source says
 * (a plugin's or a synced skill's), else other.
 * @param {AuditRecord} r
 */
function reasonOf(r) {
  const a = r.links.audit;
  if (a.reason && a.reason in REASON_LABELS) return a.reason;
  if (a.group === "plugin") return "plugin";
  if (a.group === "synced" || /[\\/]\.claude[\\/]skills[\\/]synced[\\/]/.test(a.file ?? "")) return "synced";
  return "other";
}

/** The rule's name: links (new records), else the body's "**Rule:** ID (Name)". @param {AuditRecord} r */
function ruleNameOf(r) {
  return r.links.audit.ruleName ?? /\*\*Rule:\*\* \S+ \(([^)]+)\)/.exec(r.body ?? "")?.[1];
}

/** "claude-hooks" → "Claude hooks". @param {string} c */
const categoryLabel = (c) => (c ? c[0].toUpperCase() + c.slice(1).replace(/-/g, " ") : "Other");

/**
 * Groups by key, biggest first (a fixed order when given).
 * @param {AuditRecord[]} recs @param {(r: AuditRecord) => string} keyOf
 * @param {(key: string, rs: AuditRecord[]) => Omit<Group, "count" | "levels">} make @param {string[]} [order]
 * @returns {Group[]}
 */
function groupBy(recs, keyOf, make, order) {
  /** @type {Map<string, AuditRecord[]>} */
  const by = new Map();
  for (const r of recs) by.set(keyOf(r), [...(by.get(keyOf(r)) ?? []), r]);
  return [...by.entries()]
    .sort(([a, x], [b, y]) => (order ? order.indexOf(a) - order.indexOf(b) : 0) || y.length - x.length || a.localeCompare(b))
    .map(([k, rs]) => ({ ...make(k, rs), count: rs.length, levels: countLevels(rs) }));
}

/**
 * Source → (plugin / worktree name) → category → rule → findings.
 * @param {AuditRecord[]} recs @param {number} lang 1 English, 2 Turkish
 * @returns {Group[]}
 */
function bySource(recs, lang) {
  const byRule = (/** @type {AuditRecord[]} */ rs) =>
    groupBy(rs, (r) => r.links.audit.rule, (rule, xs) => {
      const name = ruleNameOf(xs[0]);
      return { key: `rule:${rule}`, label: name ? `${rule} ${name}` : rule, icon: "law", records: xs.sort(byLevel) };
    });
  const byCategory = (/** @type {AuditRecord[]} */ rs) =>
    groupBy(rs, (r) => r.links.audit.category ?? "other", (c, xs) => ({ key: `cat:${c}`, label: categoryLabel(c), icon: "symbol-namespace", children: byRule(xs) }));
  return groupBy(recs, (r) => r.links.audit.group ?? "project", (src, rs) => {
    const s = SOURCES.find((x) => x[0] === src) ?? [src, src, src, "folder"];
    const owned = src === "plugin" || src === "worktree";
    const children = owned
      ? groupBy(rs, (r) => r.links.audit.owner ?? "?", (o, xs) => ({ key: `owner:${o}`, label: o, icon: "package", children: byCategory(xs) }))
      : byCategory(rs);
    return { key: `src:${src}`, label: s[lang], icon: s[3], children };
  }, SOURCES.map((s) => s[0]));
}

/**
 * The one grouping of a root's audit records (see the top of the file).
 * @param {AuditRecord[]} records @param {{lang?: "en" | "tr"}} [o] @returns {Group[]}
 */
function auditGroups(records, { lang = "en" } = {}) {
  const L = lang === "tr" ? 2 : 1;
  const recs = records.filter((r) => r.links?.audit);
  return STATUSES.flatMap(([st, en, tr, icon]) => {
    const rs = recs.filter((r) => r.status === st);
    if (!rs.length) return [];
    const children = st === "dropped"
      ? groupBy(rs, reasonOf, (why, xs) => {
        const lab = REASON_LABELS[/** @type {keyof typeof REASON_LABELS} */ (why)];
        return { key: `why:${why}`, label: lab[L - 1], icon: lab[2], children: bySource(xs, L) };
      }, Object.keys(REASON_LABELS))
      : bySource(rs, L);
    return [{ key: `st:${st}`, label: L === 2 ? tr : en, icon, count: rs.length, levels: countLevels(rs), children }];
  });
}

/** A finding row: opens the file at its line; its record's body is the tooltip. @param {AuditRecord} r @param {string} root @returns {Row} */
function findingRow(r, root) {
  const a = r.links.audit;
  const message = r.title.replace(/^[^:]+:\s*/, "");
  const rel = a.file.startsWith(`${root}/`) || a.file.startsWith(`${root}\\`) ? a.file.slice(root.length + 1) : a.file;
  const [icon, color] = r.status === "open" ? LEVEL_ICON[/** @type {keyof typeof LEVEL_ICON} */ (a.level)] ?? LEVEL_ICON.info : r.status === "done" ? ["pass", "testing.iconPassed"] : ["circle-slash", "disabledForeground"];
  return {
    type: "leaf", label: message, description: `${rel}${a.line ? `:${a.line}` : ""}`, tooltip: r.body ?? r.title, markdown: true,
    icon, color, abs: a.file, line: a.line, context: `auditFinding-${r.status}`, recordId: r.id,
  };
}

/** A group as a tree row; the open status and the project / your setup sources start expanded. @param {Group} g @param {string} root @returns {Row} */
function groupRow(g, root) {
  const levels = g.key.startsWith("st:") && g.key !== "st:open" ? "" : levelLine(g.levels);
  return {
    type: "group", label: g.label, description: [String(g.count), levels].filter(Boolean).join(" · "), icon: g.icon,
    expanded: g.key === "st:open" || g.key === "src:project" || g.key === "src:user",
    children: g.children ? g.children.map((c) => groupRow(c, root)) : (g.records ?? []).map((r) => findingRow(r, root)),
  };
}

/**
 * One audited root's rows: its records by status, then the grouping.
 * @param {{label: string, root: string, records: AuditRecord[], summary?: string | null}} scope @returns {Row}
 */
function scopeRow(scope) {
  const recs = scope.records.filter((r) => r.links?.audit);
  const open = recs.filter((r) => r.status === "open");
  return {
    type: "group", label: scope.label, description: open.length ? `${open.length} open · ${levelLine(open)}` : "nothing open", icon: "folder",
    tooltip: scope.summary ?? undefined, children: auditGroups(recs).map((g) => groupRow(g, scope.root)),
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

module.exports = { recommendationsRow, scopeRow, findingRow, groupRow, auditGroups, reasonOf, ruleNameOf, levelLine, REASON_LABELS };
