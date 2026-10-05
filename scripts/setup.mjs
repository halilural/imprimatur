#!/usr/bin/env node
// Sets Imprimatur up on this machine, for every repo:
// - the Claude Code hooks in ~/.claude/settings.json (a backup first; ours are
//   found by their script name, added when missing, updated when the path or
//   language differs; other hooks are left alone);
// - the VS Code extension (npm run package + code --install-extension);
// - with --lang, imprimatur.language (the extension's model calls use the
//   hooks' language), and with --show-in, where Markdown changes show (preview | editor | both), in
//   VS Code's machine settings (~/.vscode-server/data/Machine/settings.json on
//   a remote/WSL machine, else the user settings);
// - checks that the `claude` CLI is on PATH (the model features use it).
//
//   npm run setup -- [--lang Turkish] [--show-in both] [--exts md,mdx] [--no-extension] [--dry-run]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ASK = "AskUserQuestion";

/**
 * The hooks Imprimatur needs: [event, matcher, script, args].
 * @param {string[]} exts @returns {Array<[string, string | undefined, string, string]>}
 */
const wanted = (exts) => [
  ["PreToolUse", "Edit|Write|Bash", "baseline.mjs", ` ${exts.join(" ")}`],
  ["PostToolUse", "Bash", "baseline.mjs", ` ${exts.join(" ")}`],
  ["PreToolUse", ASK, "waiting.mjs", ""],
  ["PostToolUse", ASK, "waiting.mjs", ""],
  ["PermissionRequest", "*", "waiting.mjs", ""],
  ["Notification", "agent_needs_input|elicitation_dialog|elicitation_url_dialog", "waiting.mjs", ""],
  ["Stop", undefined, "waiting.mjs", ""],
  ["UserPromptSubmit", undefined, "waiting.mjs", ""],
];

/**
 * Settings with Imprimatur's hooks in place. Pure: returns a copy and the changes.
 * @param {any} settings ~/.claude/settings.json content
 * @param {{root: string, lang?: string, exts?: string[]}} opts root: this repo
 * @returns {{settings: any, changes: string[]}}
 */
export function mergeHooks(settings, { root, lang, exts = ["md", "mdx"] }) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  const changes = [];
  for (const [event, matcher, script, args] of wanted(exts)) {
    const command = `${lang ? `IMPRIMATUR_LANG=${lang} ` : ""}node "${path.join(root, "hooks", script)}"${args}`;
    const entries = (out.hooks[event] ??= []);
    const ours = entries
      .filter((e) => (e.matcher ?? "") === (matcher ?? ""))
      .flatMap((e) => e.hooks ?? [])
      .find((h) => typeof h.command === "string" && h.command.includes(`hooks/${script}`));
    const label = `${event}${matcher ? ` [${matcher}]` : ""} → ${script}`;
    if (!ours) {
      entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] });
      changes.push(`added   ${label}`);
    } else if (ours.command.replace(/"/g, "") !== command.replace(/"/g, "")) {
      ours.command = command;
      changes.push(`updated ${label}`);
    }
  }
  return { settings: out, changes };
}

/**
 * VS Code settings with one imprimatur setting set. Pure: returns a copy and the change.
 * @param {any} settings @param {string} key @param {string} value @param {string} fallback shown when unset
 */
function mergeSetting(settings, key, value, fallback) {
  const out = structuredClone(settings ?? {});
  if (out[key] === value) return { settings: out, change: undefined };
  const change = `${key}: ${out[key] ?? `(default ${fallback})`} → ${value}`;
  out[key] = value;
  return { settings: out, change };
}

/** imprimatur.showIn (--show-in). @param {any} settings @param {string} showIn */
export function mergeShowIn(settings, showIn) {
  if (!["preview", "editor", "both"].includes(showIn)) throw new Error(`--show-in: preview, editor or both, not ${showIn}`);
  return mergeSetting(settings, "imprimatur.showIn", showIn, "preview");
}

/**
 * imprimatur.language (--lang): the extension's model calls (Scan history,
 * Audit) write in the hooks' language. The hooks get it from IMPRIMATUR_LANG
 * in their command; the extension does not see that variable.
 * @param {any} settings @param {string} lang
 */
export const mergeLanguage = (settings, lang) => mergeSetting(settings, "imprimatur.language", lang, "the agent's language");

/** Where VS Code keeps this machine's settings: the server's machine settings on a remote, else the user's. */
function vscodeSettingsFile() {
  const home = os.homedir();
  if (fs.existsSync(path.join(home, ".vscode-server"))) return path.join(home, ".vscode-server", "data", "Machine", "settings.json");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User", "settings.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? home, "Code", "User", "settings.json");
  return path.join(home, ".config", "Code", "User", "settings.json");
}

/** Back up a file (if any), then write JSON to it. @param {string} file @param {any} data */
function writeWithBackup(file, data) {
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-imprimatur`;
    fs.copyFileSync(file, backup);
    console.log(`  backup: ${backup}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** @param {string[]} argv */
function options(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    lang: get("--lang"),
    showIn: get("--show-in"),
    exts: get("--exts")?.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    extension: !argv.includes("--no-extension"),
    dry: argv.includes("--dry-run"),
  };
}

/** @param {string} cmd @param {string[]} args */
const has = (cmd, args = ["--version"]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const opts = options(process.argv.slice(2));
  const file = path.join(os.homedir(), ".claude", "settings.json");
  const before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const { settings, changes } = mergeHooks(before, { root, lang: opts.lang, exts: opts.exts });

  console.log(`Hooks in ${file}:`);
  console.log(changes.length ? changes.map((c) => `  ${c}`).join("\n") : "  all in place");
  if (changes.length && !opts.dry) writeWithBackup(file, settings);

  if (opts.showIn || opts.lang) {
    const vs = vscodeSettingsFile();
    const wanted = { ...(opts.showIn && { "imprimatur.showIn": opts.showIn }), ...(opts.lang && { "imprimatur.language": opts.lang }) };
    // VS Code settings may carry comments: those files are left to the user.
    let current = {};
    try {
      current = fs.existsSync(vs) ? JSON.parse(fs.readFileSync(vs, "utf8")) : {};
    } catch {
      console.log(`VS Code settings ${vs}: not plain JSON (comments?); set ${JSON.stringify(wanted)} there by hand.`);
      current = undefined;
    }
    if (current) {
      let next = current;
      const changes = [];
      for (const [merge, value] of [[mergeShowIn, opts.showIn], [mergeLanguage, opts.lang]]) {
        if (!value) continue;
        const r = merge(next, value);
        next = r.settings;
        if (r.change) changes.push(r.change);
      }
      console.log(`VS Code settings ${vs}:\n  ${changes.join("\n  ") || "already set"}`);
      if (changes.length && !opts.dry) writeWithBackup(vs, next);
    }
  }

  if (opts.extension && !opts.dry) {
    console.log("Extension:");
    execFileSync("npm", ["run", "-s", "package"], { cwd: root, stdio: "inherit" });
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "vscode", "package.json"), "utf8"));
    const vsix = path.join(root, "dist", `imprimatur-${version}.vsix`);
    if (has("code")) execFileSync("code", ["--install-extension", vsix, "--force"], { stdio: "inherit" });
    else console.log(`  'code' not on PATH: install ${vsix} from the Extensions view (Install from VSIX).`);
  }

  console.log(
    has("claude")
      ? "claude CLI: found (edit descriptions, chat sync and audit use it)."
      : "claude CLI: not on PATH; edit descriptions, chat sync and audit fall back to rules.",
  );
  console.log("New Claude Code sessions pick the hooks up; reload VS Code windows for the extension.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
