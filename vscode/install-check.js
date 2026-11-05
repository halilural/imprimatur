// @ts-check
// First run (#81): what Imprimatur needs on this machine, and what is missing. The Claude
// Code CLI; the hooks and the MCP server, from the Claude Code plugin or from `npm run setup`
// (hooks in ~/.claude/settings.json, the server in ~/.claude.json); the database. Each check
// says what to do and how: a command, a terminal line, or a page.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const INSTALL_URL = "https://github.com/halilural/imprimatur#install";
const PLUGIN_LINE = "claude plugin marketplace add halilural/imprimatur && claude plugin install imprimatur@imprimatur";

/** @param {string} f */
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * @typedef {{id: string, ok: boolean, label: string, why: string, fix?: {kind: "terminal" | "url" | "command", value: string, title: string}}} Check
 * @param {{home?: string, claudeBin?: string, plugin?: {id: string, version: string} | undefined, dbError?: string | undefined}} o
 * @returns {Check[]}
 */
function installChecks({ home = os.homedir(), claudeBin = "", plugin, dbError }) {
  const settings = readJson(path.join(home, ".claude", "settings.json")) ?? {};
  const hookText = JSON.stringify(settings.hooks ?? {});
  // `npm run setup` points the hooks at the repo's hooks/run.mjs.
  const ownHooks = /imprimatur[^"]*[\\/]hooks[\\/]run\.mjs/.test(hookText);
  const mcp = readJson(path.join(home, ".claude.json"))?.mcpServers?.imprimatur;
  const from = plugin ? `the Claude Code plugin ${plugin.id} ${plugin.version}` : "";
  return [
    { id: "cli", ok: !!claudeBin, label: "Claude Code CLI",
      why: claudeBin ? `found at ${claudeBin.replace(home, "~")}` : "not found on PATH or in ~/.local/bin: Imprimatur's hooks and MCP server run inside Claude Code",
      ...(claudeBin ? {} : { fix: { kind: /** @type {const} */ ("url"), value: INSTALL_URL, title: "How to install" } }) },
    { id: "hooks", ok: !!plugin || ownHooks, label: "Imprimatur's hooks in Claude Code",
      why: plugin ? `from ${from}` : ownHooks ? "in ~/.claude/settings.json (npm run setup)" : "not installed: agent edits, asks and sessions are not recorded",
      ...(plugin || ownHooks ? {} : { fix: { kind: /** @type {const} */ ("terminal"), value: PLUGIN_LINE, title: "Install the plugin" } }) },
    { id: "mcp", ok: !!plugin || !!mcp, label: "Imprimatur's MCP server",
      why: plugin ? `from ${from}` : mcp ? "in ~/.claude.json (npm run setup)" : "not installed: the agent cannot read or write tasks and records",
      ...(plugin || mcp ? {} : { fix: { kind: /** @type {const} */ ("terminal"), value: PLUGIN_LINE, title: "Install the plugin" } }) },
    { id: "db", ok: !dbError, label: "Imprimatur database", why: dbError ? `cannot be opened: ${dbError}` : "opens",
      ...(dbError ? { fix: { kind: /** @type {const} */ ("command"), value: "workbench.action.reloadWindow", title: "Reload Window" } } : {}) },
  ];
}

module.exports = { installChecks, INSTALL_URL, PLUGIN_LINE };
