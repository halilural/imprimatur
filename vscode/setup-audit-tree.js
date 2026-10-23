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
/** [key, label, the same label (second slot of the old two-language tables), icon] */
const STATUSES = [["open", "Open", "Open", "lightbulb"], ["done", "Applied", "Applied", "pass"], ["dropped", "Dismissed", "Dismissed", "circle-slash"]];
const SOURCES = [
  ["project", "Project", "Project", "repo"],
  ["user", "Your setup", "Your setup", "account"],
  ["synced", "Synced skills (claude.ai)", "Synced skills (claude.ai)", "cloud"],
  ["plugin", "Plugins", "Plugins", "extensions"],
  ["worktree", "Worktrees", "Worktrees", "git-branch"],
];
/** Why Claude Code does not load a file (#78): [label, the same label]. */
const IDLE_LABELS = {
  catalog: ["Marketplace catalog", "Marketplace catalog"],
  temp: ["Leftover temp clone", "Leftover temp clone"],
  "not-installed": ["Plugin version not installed", "Plugin version not installed"],
  disabled: ["Plugin turned off", "Plugin turned off"],
  "other-tool": ["For another tool, not a plugin part", "For another tool, not a plugin part"],
  worktree: ["Worktree copy", "Worktree copy"],
};
const REASON_LABELS = {
  plugin: ["Third-party plugin", "Third-party plugin", "extensions"],
  synced: ["Synced skill (claude.ai)", "Synced skill (claude.ai)", "cloud"],
  false: ["False alarm", "False alarm", "close"],
  local: ["Specific to this machine", "Specific to this machine", "device-desktop"],
  other: ["Other", "Other", "question"],
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

/** Open and loaded by Claude Code: what Recommendations counts (#78). @param {AuditRecord} r */
const isOpen = (r) => r.status === "open" && r.links.audit.effect !== "inactive";

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
 * @param {AuditRecord[]} recs @param {number} lang 1 or 2 (both the same English labels now)
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
 * The one grouping of a root's audit records (see the top of the file). Open findings
 * split into what Claude Code loads and what it does not (#78), by why.
 * @param {AuditRecord[]} records @param {{lang?: "en" | "tr"}} [o] @returns {Group[]}
 */
function auditGroups(records, { lang = "en" } = {}) {
  const L = lang === "tr" ? 2 : 1;
  const recs = records.filter((r) => r.links?.audit && !r.links.audit.duplicate);
  return STATUSES.flatMap(([st, en, tr, icon]) => {
    const rs = recs.filter((r) => r.status === st);
    if (!rs.length) return [];
    if (st === "open") {
      const on = rs.filter((r) => r.links.audit.effect !== "inactive");
      const off = rs.filter((r) => r.links.audit.effect === "inactive");
      /** @type {Group[]} */
      const out = [];
      if (on.length) out.push({ key: "st:open", label: L === 2 ? tr : en, icon, count: on.length, levels: countLevels(on), children: bySource(on, L) });
      if (off.length) {
        out.push({
          key: "st:idle", label: "Not loaded", icon: "eye-closed", count: off.length, levels: countLevels(off),
          children: groupBy(off, (r) => r.links.audit.why ?? "other-tool", (why, xs) => {
            const lab = IDLE_LABELS[/** @type {keyof typeof IDLE_LABELS} */ (why)] ?? [why, why];
            return { key: `idle:${why}`, label: lab[L - 1], icon: "eye-closed", children: bySource(xs, L) };
          }),
        });
      }
      return out;
    }
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

/** "2 high · 1 medium". @param {Record<string, number> | undefined} n */
const severityLine = (n) => ["high", "medium", "low"].filter((l) => n?.[l]).map((l) => `${n?.[l]} ${l}`).join(" · ");

/** A path of the repo, never outside it (evidence is model output; a synced record may predate the gate). @param {string} root @param {string | undefined} file */
function inside(root, file) {
  if (!file) return undefined;
  const p = require("node:path");
  const abs = p.resolve(root, file);
  return abs.startsWith(p.resolve(root) + p.sep) ? abs : undefined;
}

/** A project recommendation row (#87): opens its first evidence; its record's body is the tooltip. @param {AuditRecord} r @param {string} root @returns {Row} */
function bestRow(r, root) {
  const b = r.links.best;
  const first = String(b.evidence?.[0] ?? "");
  const [, file, line] = /^([^:#]+)(?::(\d+))?/.exec(first) ?? [];
  const icon = r.status === "open" ? (b.severity === "high" ? ["error", "problemsErrorIcon.foreground"] : b.severity === "medium" ? ["warning", "problemsWarningIcon.foreground"] : ["info", "problemsInfoIcon.foreground"])
    : r.status === "done" ? ["pass", "testing.iconPassed"] : ["circle-slash", "disabledForeground"];
  return {
    type: "leaf", label: r.title, description: `${b.component ?? ""}${first ? ` · ${first}` : ""}`, tooltip: r.body ?? r.title, markdown: true, icon: icon[0], color: icon[1],
    ...(inside(root, file) ? { abs: inside(root, file), line: line ? Number(line) : undefined } : {}), context: `bestFinding-${r.status}`, recordId: r.id,
  };
}

/** A project group as a tree row. @param {any} g @param {string} root @returns {Row} */
function bestGroupRow(g, root) {
  return {
    type: "group", label: g.label, description: [String(g.count), g.key.startsWith("st:") && g.key !== "st:open" ? "" : severityLine(g.levels)].filter(Boolean).join(" · "), icon: g.icon,
    expanded: g.key === "st:open",
    children: g.children ? g.children.map((/** @type {any} */ c) => bestGroupRow(c, root)) : (g.records ?? []).map((/** @type {AuditRecord} */ r) => bestRow(r, root)),
  };
}

/** Open project recommendations. @param {AuditRecord} r */
const isBestOpen = (r) => r.status === "open" && Boolean(r.links?.best);

/**
 * One root's rows (#87): the agent setup audit's findings and the project's
 * best-practice recommendations, each under its own row when both are there.
 * @param {{label: string, root: string, records: AuditRecord[], summary?: string | null}} scope @returns {Row}
 */
function scopeRow(scope) {
  const audit = scope.records.filter((r) => r.links?.audit && !r.links.audit.duplicate);
  const best = scope.records.filter((r) => r.links?.best && !r.links.best.duplicate);
  const auditRows = auditGroups(audit).map((g) => groupRow(g, scope.root));
  const { bestGroups } = require("./best-tree.js");
  const bestRows = bestGroups(best, { lang: "en" }).map((g) => bestGroupRow(g, scope.root));
  const openA = audit.filter(isOpen).length;
  const openB = best.filter(isBestOpen).length;
  /** @type {Row[]} */
  const children = audit.length && best.length
    ? [
      { type: "group", label: "Agent setup", description: openA ? `${openA} open` : "nothing open", icon: "hubot", expanded: true, children: auditRows },
      { type: "group", label: "Project", description: openB ? `${openB} open` : "nothing open", icon: "repo", expanded: true, children: bestRows },
    ]
    : [...auditRows, ...bestRows];
  const open = openA + openB;
  return { type: "group", label: scope.label, description: open ? `${open} open` : "nothing open", icon: "folder", tooltip: scope.summary ?? undefined, children };
}

/**
 * The "Recommendations" row: every root with recommendations under it; before any, a
 * row that asks what to run.
 * @param {Array<{label: string, root: string, records: AuditRecord[], summary?: string | null}>} scopes @returns {Row}
 */
function recommendationsRow(scopes) {
  const some = scopes.map((s) => ({ ...s, records: s.records.filter((r) => !r.links?.audit?.duplicate && !r.links?.best?.duplicate) }))
    .filter((s) => s.records.some((r) => r.links?.audit || r.links?.best));
  if (!some.length) {
    return { type: "leaf", label: "Recommendations", description: "audit the agent setup, review the project", icon: "lightbulb", command: "imprimatur.setup.audit",
      tooltip: "The agent setup audit (agnix, by the tools' docs) and the project review (Claude, by ISO/IEC 25010 and NIST SSDF); every finding is a record (open, applied, dismissed)." };
  }
  const audit = some.flatMap((s) => s.records.filter((r) => r.links?.audit && isOpen(r)));
  const best = some.flatMap((s) => s.records.filter(isBestOpen));
  const open = audit.length + best.length;
  return { type: "group", label: `Recommendations (${open})`, description: [levelLine(audit), severityLine(Object.fromEntries(["high", "medium", "low"].map((l) => [l, best.filter((r) => r.links.best.severity === l).length])))].filter(Boolean).join(" · "), icon: "lightbulb", open, children: some.map(scopeRow) };
}

module.exports = { IDLE_LABELS, isOpen, isBestOpen, recommendationsRow, scopeRow, findingRow, groupRow, bestRow, bestGroupRow, auditGroups, reasonOf, ruleNameOf, levelLine, REASON_LABELS };
