// @ts-check
// A warning the agent keeps getting becomes a blocking hook (#218): a process check in warn mode
// that fired at least MIN times in the last DAYS days, in at least SESSIONS sessions (counted from
// the hook output in Claude Code's transcripts, ticket-tokens.js), is suggested in Agent Setup; on
// the user's yes its mode in .claude/imprimatur.json becomes "block", its other settings kept.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DAYS = 14;
const MIN = 5;
const SESSIONS = 2;
/**
 * Lines that are not a broken rule: context the agent is given every time (languages, where we
 * left off, file context) and the reminder issueCreate gives after every new issue by design.
 */
const NOT_RULES = new Set(["whereWeLeftOff", "repoLang", "replyLang", "fileContext", "issueCreate", "docSync"]);

/**
 * The checks to suggest, from the findings and the repo's settings. Pure.
 * @param {Map<string, {count: number, sessions: number}>} findings @param {Record<string, any> | undefined} settings process.js settingsOf
 * @returns {Array<{name: string, count: number, sessions: number}>}
 */
function candidates(findings, settings) {
  if (!settings) return [];
  return [...findings]
    .filter(([name, f]) => !NOT_RULES.has(name) && settings[name]?.mode === "warn" && f.count >= MIN && f.sessions >= SESSIONS)
    .map(([name, f]) => ({ name, ...f }))
    .sort((a, b) => b.count - a.count);
}

/** The repo's suggestions now. @param {string} root @param {{now?: number}} [o] */
function suggestions(root, { now = Date.now() } = {}) {
  const { settingsOf } = require("./process.js");
  const tt = require("./ticket-tokens.js");
  return candidates(tt.checkFindings(tt.projectDirOf(root), now - DAYS * 86_400_000), settingsOf(root));
}

/**
 * Sets a check's mode to "block" in the repo's .claude/imprimatur.json, keeping an object setting's
 * other fields. Never through a symbolic link.
 * @param {string} root @param {string} name
 */
function makeBlock(root, name) {
  const file = path.join(root, ".claude", "imprimatur.json");
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(".claude/imprimatur.json is a symbolic link: not written");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const proc = raw.process && typeof raw.process === "object" ? raw.process : (raw.process = {});
  const cur = proc[name];
  proc[name] = cur && typeof cur === "object" ? { ...cur, mode: "block" } : "block";
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Agent Setup's checklist rows. @param {string} root @param {ReturnType<typeof suggestions>} list */
function blockRows(root, list) {
  return list.map((c) => ({
    type: "leaf", label: `Rule broken often: ${c.name}`, description: `warned ${c.count} times in ${c.sessions} sessions (${DAYS} days) · make it block?`, icon: "shield",
    tooltip: `The agent was warned by Imprimatur's ${c.name} check ${c.count} times in ${c.sessions} sessions over the last ${DAYS} days: a warning it keeps getting is a rule it keeps breaking. Click to make the check block (the agent must fix it before going on); .claude/imprimatur.json is changed after you confirm.`,
    command: "imprimatur.setup.blockCheck", args: [{ root, name: c.name, count: c.count }],
  }));
}

module.exports = { candidates, suggestions, makeBlock, blockRows, NOT_RULES, MIN, SESSIONS, DAYS };
