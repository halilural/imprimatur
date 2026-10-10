#!/usr/bin/env node
// Bundles the VS Code extension into one file (vscode/dist/extension.js) with
// esbuild: one file loads faster than ~25 required ones and the .vsix ships no
// sources. `vscode` and Node built-ins (node:sqlite among them) stay external.
// The hooks and the MCP server keep using vscode/*.js as they are.
// Next to it goes mermaid's browser build (dist/mermaid.min.js): the panel's
// document tabs draw ```mermaid blocks with it, loaded from the extension, never a CDN (#72).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = path.resolve(import.meta.dirname, "../vscode");
const MERMAID = path.resolve(import.meta.dirname, "../node_modules/mermaid/dist/mermaid.min.js");

/** @param {{outfile?: string}} [opts] */
export async function buildExtension({ outfile = path.join(dir, "dist", "extension.js") } = {}) {
  const out = await build({
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
  fs.copyFileSync(MERMAID, path.join(path.dirname(outfile), "mermaid.min.js"));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildExtension();
  console.log("built vscode/dist/extension.js and vscode/dist/mermaid.min.js");
}
