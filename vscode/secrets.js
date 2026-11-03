// @ts-check
// Keys and tokens out of config.json (#124). config.json (next to the database) keeps the
// settings anyone may see; secrets.json (mode 0600, same folder) keeps the secret fields,
// as nested sections: {"sync": {"token": …}, "tracker": {"jira": {"token": …}}}. Claude
// Code is told not to read or edit it (setup.mjs: permissions.deny), so an agent working
// in the home folder does not pull a token into its context by looking at the settings.
//
// A key moves only once whoever reads it reads secrets.json too: Imprimatur's own
// (tracker.jira.token) and the keys a loaded plugin names in its `secrets` export. A
// plugin from before stays as it was, its key in config.json, and keeps working.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** The secret fields Imprimatur itself reads. */
const OWN = ["tracker.jira.token"];
/** Secret fields Imprimatur knows of, to report the ones no loaded reader can take yet. */
const KNOWN = ["sync.token", "cards.key", "gitlab.key", "tracker.jira.token"];

/** @param {string} dbFile */
const filesOf = (dbFile) => ({ config: path.join(path.dirname(dbFile), "config.json"), secrets: path.join(path.dirname(dbFile), "secrets.json") });

/** @param {string} file @returns {Record<string, any> | undefined} undefined: missing or not JSON */
const read = (file) => {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
};
/** @param {string} file @param {any} value */
const write = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
};
/** @param {any} obj @param {string[]} keys */
const getAt = (obj, keys) => keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
/** @param {any} obj @param {string[]} keys @param {any} v */
const setAt = (obj, keys, v) => {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === "object" ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = v;
};
/** @param {any} obj @param {string[]} keys */
const deleteAt = (obj, keys) => {
  const parent = getAt(obj, keys.slice(0, -1));
  if (parent && typeof parent === "object") delete parent[keys[keys.length - 1]];
};

/**
 * Moves each named secret field from config.json to secrets.json. Values are never
 * returned or logged: only the names moved and the ones left (no loaded reader of
 * secrets.json for them yet).
 * @param {string} dbFile @param {{keys?: string[]}} [o] keys: the fields to move (OWN and the loaded plugins')
 * @returns {{moved: string[], left: string[]}}
 */
function migrateSecrets(dbFile, { keys = OWN } = {}) {
  const f = filesOf(dbFile);
  const config = read(f.config);
  if (!config) return { moved: [], left: [] };
  const secrets = read(f.secrets) ?? {};
  const allowed = new Set(keys);
  /** @type {string[]} */
  const moved = [];
  /** @type {string[]} */
  const left = [];
  for (const name of [...new Set([...KNOWN, ...keys])]) {
    const at = name.split(".");
    const v = getAt(config, at);
    if (typeof v !== "string" || !v) continue;
    if (!allowed.has(name)) {
      left.push(name);
      continue;
    }
    // A value already in secrets.json (written by a newer plugin) wins; config.json's goes.
    if (getAt(secrets, at) === undefined) setAt(secrets, at, v);
    deleteAt(config, at);
    moved.push(name);
  }
  if (moved.length) {
    // Secrets first: a crash between the two writes leaves the key in both, never in neither.
    write(f.secrets, secrets);
    write(f.config, config);
  }
  return { moved, left };
}

/** The keys the plugins of an open database read from secrets.json, with Imprimatur's own. @param {any} db */
const keysOf = (db) => [...OWN, ...(db?.plugins ?? []).flatMap((/** @type {any} */ p) => (Array.isArray(p.secrets) ? p.secrets.filter((/** @type {any} */ k) => typeof k === "string") : []))];

/**
 * One section of the settings with its secrets: config.json's, secrets.json's fields on
 * top. A secrets.json others may read, or a symlink, is ignored.
 * @param {string} dbFile @param {string[]} section e.g. ["tracker", "jira"]
 * @param {{platform?: string}} [o] @returns {Record<string, any> | undefined}
 */
function sectionWithSecrets(dbFile, section, { platform = process.platform } = {}) {
  const f = filesOf(dbFile);
  const pub = getAt(read(f.config), section);
  let sec;
  try {
    const st = fs.lstatSync(f.secrets);
    if (!st.isSymbolicLink() && (platform === "win32" || (st.mode & 0o077) === 0)) sec = getAt(read(f.secrets), section);
  } catch {}
  if (!pub && !sec) return undefined;
  return { ...(pub && typeof pub === "object" ? pub : {}), ...(sec && typeof sec === "object" ? sec : {}) };
}

/**
 * The deny rules that keep Claude Code's file tools off secrets.json: a path under the
 * home as ~/…, else absolute (//…).
 * @param {string} dbFile @param {string} [home]
 */
function denyRules(dbFile, home = os.homedir()) {
  const file = filesOf(dbFile).secrets;
  const rel = path.relative(home, file);
  const spec = !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : `/${file.split(path.sep).join("/")}`;
  return [`Read(${spec})`, `Edit(${spec})`];
}

/**
 * Settings with the deny rules in permissions.deny. Pure: returns a copy and the change.
 * @param {any} settings @param {string[]} rules
 */
function mergeDeny(settings, rules) {
  const out = structuredClone(settings ?? {});
  const deny = Array.isArray(out.permissions?.deny) ? out.permissions.deny : [];
  const add = rules.filter((r) => !deny.includes(r));
  if (!add.length) return { settings: out, change: undefined };
  out.permissions ??= {};
  out.permissions.deny = [...deny, ...add];
  return { settings: out, change: `added   permissions.deny ${add.map((r) => `"${r}"`).join(", ")} (agents do not read the keys)` };
}

module.exports = { OWN, KNOWN, filesOf, migrateSecrets, keysOf, sectionWithSecrets, denyRules, mergeDeny };
