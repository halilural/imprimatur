#!/usr/bin/env node
// Sets Imprimatur up on this machine, for every repo:
// - the Claude Code hooks in ~/.claude/settings.json (a backup first; ours are
//   found by their script name, added when missing, updated when the path or
//   language differs; other hooks are left alone);
// - the VS Code extension (npm run package + code --install-extension);
// - checks that the `claude` CLI is on PATH (the model features use it).
//
//   npm run setup -- [--lang Turkish] [--exts md,mdx] [--no-extension] [--dry-run]
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

/** @param {string[]} argv */
function options(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    lang: get("--lang"),
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
  if (changes.length && !opts.dry) {
    if (fs.existsSync(file)) {
      const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}-imprimatur`;
      fs.copyFileSync(file, backup);
      console.log(`  backup: ${backup}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
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
