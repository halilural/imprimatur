#!/usr/bin/env node
// The Claude Code plugin's generated files (#67), from the same hook list as
// `npm run setup` (scripts/setup.mjs wanted()) and the extension's version:
// - hooks/hooks.json;
// - .claude-plugin/plugin.json (its version follows vscode/package.json; the MCP server inline).
// test/plugin.test.mjs fails when the committed files differ from these.
//
//   npm run plugin
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pluginHooks } from "./setup.mjs";

const root = path.resolve(import.meta.dirname, "..");

/** The manifest. @param {string} version */
export const pluginManifest = (version) => ({
  name: "imprimatur",
  displayName: "Imprimatur",
  version,
  description:
    "See every doc edit your AI agent makes as tracked changes until you accept it: Claude Code hooks that record each edit and what the agent waits on you for, and an MCP server for tasks and records. Pair it with the Imprimatur VS Code extension (npm run setup -- --plugin).",
  author: { name: "halilural", url: "https://github.com/halilural" },
  homepage: "https://github.com/halilural/imprimatur",
  repository: "https://github.com/halilural/imprimatur",
  license: "MIT",
  keywords: ["tracked-changes", "review", "markdown", "tasks", "vscode"],
  // Inline, not a root .mcp.json: Claude Code also reads that file as this
  // repo's project MCP config, where ${CLAUDE_PLUGIN_ROOT} has no value.
  mcpServers: {
    imprimatur: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"] },
  },
  userConfig: {
    language: {
      type: "string",
      title: "Language",
      description: "Language of model-written text (edit descriptions, Waiting on you), e.g. Turkish. Empty: the agent's own.",
    },
    extensions: {
      type: "string",
      title: "File extensions",
      description: "Comma-separated extensions whose edits are tracked. Empty: md,mdx (or config.json from npm run setup -- --exts).",
    },
  },
});

/** Every generated file: path relative to the repo → its text. */
export function pluginFiles() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "vscode", "package.json"), "utf8"));
  const json = (v) => JSON.stringify(v, null, 2) + "\n";
  return {
    "hooks/hooks.json": json(pluginHooks()),
    ".claude-plugin/plugin.json": json(pluginManifest(version)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [rel, text] of Object.entries(pluginFiles())) {
    const file = path.join(root, rel);
    const same = fs.existsSync(file) && fs.readFileSync(file, "utf8") === text;
    if (!same) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    console.log(`${rel}: ${same ? "up to date" : "written"}`);
  }
}
