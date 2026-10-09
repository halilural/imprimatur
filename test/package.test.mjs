// The packaged extension holds every file it loads at runtime (#48: 0.30.5
// shipped without calls.js and failed to activate). Since #65 the code ships
// as one esbuild bundle (vscode/dist/extension.js): it must build, require no
// local file, and load.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtension } from "../scripts/build.mjs";

const dir = path.resolve(import.meta.dirname, "../vscode");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

test("package: main and every file the manifest points at are packaged", () => {
  const packaged = new Set(manifest.files);
  const c = manifest.contributes;
  const wanted = [
    manifest.main,
    manifest.icon,
    ...(c["markdown.previewStyles"] ?? []),
    ...(c["markdown.previewScripts"] ?? []),
    ...Object.values(c.viewsContainers ?? {}).flat().map((v) => v.icon),
  ].map((p) => p.replace(/^\.\//, ""));
  assert.deepEqual(wanted.filter((p) => !packaged.has(p)), []);
  // The bundle reads preview.css from the folder above it (graphView.js cssPaths).
  assert.ok(packaged.has("preview.css"));
  for (const p of packaged) if (!p.startsWith("dist/")) assert.ok(fs.existsSync(path.join(dir, p)), `${p} exists`);
});

test("package: the manifest declares workspace trust, kind and the graph's restore", () => {
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
  assert.equal(manifest.capabilities.virtualWorkspaces, false);
  assert.ok(manifest.activationEvents.includes("onWebviewPanel:imprimatur.graph"));
});

/** A vscode stand-in: every property, call and `new` gives itself back. */
const anything = () => {
  const p = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : p),
    apply: () => p,
    construct: () => p,
  });
  return p;
};

test("package: the bundle builds, requires only vscode and node:*, and loads", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-bundle-"));
  const out = path.join(tmp, "extension.js");
  await buildExtension({ outfile: out });
  const src = fs.readFileSync(out, "utf8");
  const required = [...new Set([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))];
  assert.deepEqual(required.filter((r) => r !== "vscode" && !r.startsWith("node:")), []);
  assert.ok(required.includes("node:sqlite"), "node:sqlite stays external");
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "vscode" ? anything() : load.call(this, request, ...rest);
  };
  try {
    const ext = createRequire(import.meta.url)(out);
    assert.equal(typeof ext.activate, "function");
  } finally {
    Module._load = load;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
