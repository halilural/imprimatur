// The packaged extension holds every file its code requires (#48: 0.30.5
// shipped without calls.js and failed to activate).
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dir = path.resolve(import.meta.dirname, "../vscode");

test("package: every local require of a packaged file is packaged", () => {
  const { main, files } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const packaged = new Set(files);
  assert.ok(packaged.has(path.basename(main)), `main ${main} is packaged`);
  const missing = [];
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/require\("\.\/([^"]+)"\)/g)) {
      const dep = m[1].endsWith(".js") ? m[1] : `${m[1]}.js`;
      if (!packaged.has(dep)) missing.push(`${file} → ${dep}`);
      else walk(dep);
    }
  };
  walk(path.basename(main));
  assert.deepEqual(missing, []);
});
