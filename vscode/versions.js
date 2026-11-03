// @ts-check
// Which Imprimatur builds a machine runs (#123): the VS Code extension, the Claude Code
// plugin (hooks, MCP server) and the code a script runs from. A schema migration shipped in
// one of them makes the others read-only, so they should be one version.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @param {string} f */
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The Imprimatur plugin Claude Code runs for every project: user scope, enabled.
 * @param {{home?: string}} [o] @returns {{id: string, version: string, installPath: string} | undefined}
 */
function imprimaturPlugin({ home = os.homedir() } = {}) {
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins;
  if (!installed || typeof installed !== "object") return undefined;
  const enabled = readJson(path.join(home, ".claude", "settings.json"))?.enabledPlugins ?? {};
  for (const [id, entries] of Object.entries(installed)) {
    if (!/^imprimatur@/.test(id) || enabled[id] === false) continue;
    const user = (Array.isArray(entries) ? entries : []).find((e) => (e?.scope ?? "user") === "user" && typeof e.installPath === "string");
    if (user && fs.existsSync(user.installPath)) return { id, version: String(user.version ?? ""), installPath: user.installPath };
  }
  return undefined;
}

/**
 * The installed VS Code extension's version (WSL/remote, desktop, Insiders).
 * @param {{home?: string}} [o] @returns {string | undefined}
 */
function extensionVersion({ home = os.homedir() } = {}) {
  for (const d of [".vscode-server", ".vscode", ".vscode-insiders", ".vscode-server-insiders"]) {
    const list = readJson(path.join(home, d, "extensions", "extensions.json"));
    const e = Array.isArray(list) && list.find((x) => String(x?.identifier?.id ?? "").toLowerCase() === "halilural.imprimatur");
    if (e?.version) return String(e.version);
  }
  return undefined;
}

/**
 * The version of the code in a checkout or plugin folder (the folder that holds hooks/).
 * @param {string} root @returns {string | undefined}
 */
function codeVersion(root) {
  return readJson(path.join(root, ".claude-plugin", "plugin.json"))?.version ?? readJson(path.join(root, "vscode", "package.json"))?.version;
}

/** Same folder, whatever the slashes or a trailing one. @param {string} a @param {string} b */
const sameDir = (a, b) => path.resolve(a) === path.resolve(b);

module.exports = { imprimaturPlugin, extensionVersion, codeVersion, sameDir };
