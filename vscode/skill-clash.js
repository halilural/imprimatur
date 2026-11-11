// @ts-check
// Skill names that come from two places (#208). A plugin's skills are namespaced
// (plugin:skill) and never clash; the bare ones do: the repo's .claude/skills, the user's
// ~/.claude/skills (an Imprimatur checkout links its skills there), and claude.ai's synced ones.
// Two with one name: which one Claude Code runs is not something to rely on.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** A skill folder's name: its SKILL.md front matter `name`, else the folder's. @param {string} dir */
function nameOf(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const m = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm);
    return m ? m[1].trim() : path.basename(dir);
  } catch {
    return undefined;
  }
}

/** The skills under a folder, one level down. @param {string} dir @returns {Array<{name: string, dir: string, link?: string}>} */
function skillsIn(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith(".")).flatMap((n) => {
    const d = path.join(dir, n);
    const name = nameOf(d);
    if (!name) return [];
    let link;
    try {
      link = fs.lstatSync(d).isSymbolicLink() ? fs.realpathSync(d) : undefined;
    } catch {}
    return [{ name, dir: d, ...(link ? { link } : {}) }];
  });
}

/** A folder's subfolders. @param {string} dir */
const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

/** An Imprimatur checkout's skill: a link into <checkout>/skills/<name>, the checkout having vscode/process.js. @param {string | undefined} target */
const imprimaturSkill = (target) => !!target && fs.existsSync(path.join(path.dirname(path.dirname(target)), "vscode", "process.js"));

/**
 * The repo's bare skills by source, and the names that come from more than one.
 * @param {string} root @param {string} home
 * @returns {Array<{name: string, from: Array<{source: string, dir: string}>}>}
 */
function skillClashes(root, home) {
  const synced = path.join(home, ".claude", "skills", "synced");
  const all = [
    ...skillsIn(path.join(root, ".claude", "skills")).map((s) => ({ ...s, source: "project" })),
    ...skillsIn(path.join(home, ".claude", "skills")).filter((s) => s.dir !== synced)
      .map((s) => ({ ...s, source: imprimaturSkill(s.link) ? "Imprimatur" : "user" })),
    // claude.ai keeps one folder per sync under synced/, its skills one level further down.
    ...subdirs(synced).flatMap((g) => skillsIn(g)).map((s) => ({ ...s, source: "claude.ai" })),
  ];
  /** @type {Map<string, Array<{source: string, dir: string}>>} */
  const by = new Map();
  for (const s of all) by.set(s.name, [...(by.get(s.name) ?? []), { source: s.source, dir: s.dir }]);
  return [...by.entries()].filter(([, from]) => from.length > 1).map(([name, from]) => ({ name, from }));
}

/**
 * The clashes as audit diagnostics, one per name, on the repo's own copy when it has one.
 * @param {string} root @param {string} home
 */
function clashDiagnostics(root, home) {
  return skillClashes(root, home).map(({ name, from }) => {
    const here = from.find((f) => f.source === "project") ?? from[0];
    const where = from.map((f) => `${f.source} (${f.dir.startsWith(home) ? `~${f.dir.slice(home.length)}` : path.relative(root, f.dir)})`).join(", ");
    return {
      level: "warning", rule: "IMP-SETUP-001", file: path.join(here.dir, "SKILL.md"), line: 1, category: "skills", applies_to_tool: "claude-code",
      message: `skill "${name}" comes from ${from.length} places: ${where}`,
      suggestion: from.some((f) => f.source === "Imprimatur")
        ? "Keep one. A copy of a skill Imprimatur already ships (Matt Pocock's, for one) can go from the repo; a different skill of the same name gets another `name` in its SKILL.md. With Imprimatur as a Claude Code plugin (npm run setup -- --plugin) its skills are namespaced (imprimatur:…) and stop clashing."
        : "Keep one, or give one of them another `name` in its SKILL.md.",
    };
  });
}

module.exports = { skillClashes, clashDiagnostics, nameOf };
