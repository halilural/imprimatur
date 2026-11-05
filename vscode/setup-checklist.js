// @ts-check
// The setup checklist (#142): what needs doing in the agent setup, each with what to do and an
// action. For now: plugins behind their marketplace (update), hand-installed skills changed
// upstream (review the change), health problems (open the file), open recommendations (review).
// The kinds that wait on other issues (the baseline #141, AGENTS.md shape #133, the doc
// standard and lint configs #129–#132) join when those land.
"use strict";
const path = require("node:path");
const { fixable, skillUpdatePrompt } = require("./fix-prompts.js");

/**
 * The checklist's rows and how many there are. Plain rows (PlainNode) for the setup view.
 * @param {Array<{label: string, global: boolean, items: any[], health: Array<{file: string, level: string, message: string, line?: number}>}>} scopes
 * @param {number} openRecommendations
 * @param {Array<{ok: boolean, label: string, why: string, fix?: any}>} [installs] the install checks (install-check.js)
 * @param {{root: string, items: any[]}} [baseline] the repo's baseline (baseline.js, #141)
 */
function checklistOf(scopes, openRecommendations, installs = [], baseline) {
  /** @type {any[]} */
  const rows = [];
  // What Imprimatur itself needs on this machine (#81) comes first: without it nothing else is recorded.
  for (const c of installs)
    if (!c.ok)
      rows.push({ type: "leaf", label: `Set up: ${c.label}`, description: c.why, tooltip: `${c.label}: ${c.why}.${c.fix ? ` ${c.fix.title}.` : ""}`, icon: "error",
        color: "problemsErrorIcon.foreground", ...(c.fix ? { command: "imprimatur.setup.installFix", args: [c.fix] } : {}) });
  // The baseline (#141): what every repo should have, installed from its own source on a yes.
  for (const b of baseline?.items ?? [])
    if (b.state === "install" || b.state === "enable")
      rows.push({ type: "leaf", label: `Baseline: ${b.state === "enable" ? "turn on" : "install"} ${b.label}`, description: b.why,
        tooltip: `Imprimatur's baseline for every repo: ${b.label}, ${b.why}.${b.warn ? `\n\n⚠ ${b.warn}.` : ""}\n\nThe button ${b.state === "enable" ? "turns it on at user scope" : b.kind === "skill" ? `downloads it from github.com/${b.repo} into ~/.claude/skills, with its source and commit` : "installs it at user scope with Claude Code"}, after a confirmation. Not wanted here: the row's menu → Not in This Repo.`,
        icon: b.warn ? "warning" : "cloud-download", color: b.warn ? "problemsWarningIcon.foreground" : undefined,
        command: "imprimatur.setup.installBaseline", args: [{ root: baseline?.root, item: b }], context: "baseline", baselineKey: b.key, repoRoot: baseline?.root });
  const off = (baseline?.items ?? []).filter((b) => b.state === "out");
  if (off.length)
    rows.push({ type: "leaf", label: `Baseline: ${off.length} off in this repo`, description: off.map((b) => b.label).join(", "), icon: "circle-slash",
      tooltip: "Baseline items this repo opted out of (here, or by turning the plugin off in its own settings). Click to bring one back.",
      command: "imprimatur.setup.baselineBack", args: [{ root: baseline?.root, items: off }] });
  const flat = (/** @type {any[]} */ items) => items.flatMap((i) => [i, ...flat(i.children ?? [])]);
  for (const s of scopes)
    for (const it of flat(s.items)) {
      if (it.update)
        rows.push({ type: "leaf", label: `Update ${it.label}`, description: `${s.label} · ${/update available: ([^·]+)/.exec(it.summary)?.[1]?.trim() ?? "newer"}`,
          tooltip: `${it.label} is behind what its marketplace offers. Update runs Claude Code's own \`claude plugin update\` at its scope; restart Claude Code sessions afterwards.`,
          markdown: true, icon: "cloud-download", command: "imprimatur.setup.updatePlugin", args: [{ item: it }] });
      if (it.compare)
        rows.push({ type: "leaf", label: `Review the upstream change of ${it.label}`, description: /upstream changed (\S+)/.exec(it.summary)?.[1] ?? "",
          tooltip: `The skill's folder changed in its source repo since it was installed. Read the change, then copy it in on purpose: a skill's text goes straight into the agent's context.`,
          // A click opens the skill; the compare page is on the row's menu, Fix it on its button.
          icon: "git-compare", abs: it.abs, item: it, context: skillUpdatePrompt(it) ? "checkFix-upstream" : "check-upstream", ...(skillUpdatePrompt(it) ? { fix: { kind: "skill", item: it } } : {}) });
    }
  for (const s of scopes)
    for (const p of s.health)
      rows.push({ type: "leaf", label: p.message, description: `${s.label} · ${path.basename(p.file)}`, tooltip: `Open ${p.file} and fix it.`,
        icon: p.level === "error" ? "error" : "warning", color: p.level === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground", abs: p.file, line: p.line,
        // A secret is the user's to remove and rotate: no Fix it for it (#156).
        ...(fixable(p) ? { context: "checkFix", fix: { kind: "health", problem: p } } : {}) });
  if (openRecommendations)
    rows.push({ type: "leaf", label: `${openRecommendations} open recommendation${openRecommendations === 1 ? "" : "s"}`, description: "see Recommendations",
      tooltip: "Findings from the agent setup audit and the project review. Apply or dismiss each under Recommendations, or run them again.", icon: "lightbulb", command: "imprimatur.setup.audit", context: "checkFix", fix: { kind: "findings" } });
  const node = rows.length
    ? { type: "group", label: "Checklist", description: `${rows.length} to do`, icon: "checklist", expanded: true, children: rows }
    : { type: "leaf", label: "Checklist", description: "nothing to do", icon: "pass", color: "testing.iconPassed" };
  return { count: rows.length, node };
}

module.exports = { checklistOf };
