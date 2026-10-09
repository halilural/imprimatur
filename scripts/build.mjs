#!/usr/bin/env node
// Bundles the VS Code extension into one file (vscode/dist/extension.js) with
// esbuild: one file loads faster than ~25 required ones and the .vsix ships no
// sources. `vscode` and Node built-ins (node:sqlite among them) stay external.
// The hooks and the MCP server keep using vscode/*.js as they are.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = path.resolve(import.meta.dirname, "../vscode");

/** @param {{outfile?: string}} [opts] */
export async function buildExtension({ outfile = path.join(dir, "dist", "extension.js") } = {}) {
  return build({
    entryPoints: [path.join(dir, "extension.js")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode", "node:*"],
    sourcemap: false,
    logLevel: "warning",
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildExtension();
  console.log("built vscode/dist/extension.js");
}
