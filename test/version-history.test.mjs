import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const { recordVersions, readVersions, versionLine } = createRequire(import.meta.url)("../vscode/version-history.js");

test("version history (#140): a new version is added with the day it was seen; the same one is not; the first uses the install day", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "versions-")), "v", "versions.json");
  recordVersions(file, [{ key: "plugin p@m (user)", value: "4.10.0", since: "2026-09-30" }, { key: "skill s", value: "" }], "2026-11-01");
  const before = fs.statSync(file).mtimeMs;
  recordVersions(file, [{ key: "plugin p@m (user)", value: "4.10.0", since: "2026-09-30" }], "2026-11-02");
  assert.equal(fs.statSync(file).mtimeMs, before, "nothing new, nothing written");
  const h = recordVersions(file, [{ key: "plugin p@m (user)", value: "5.3.3", since: "2026-09-30" }], "2026-11-04");
  assert.deepEqual(h["plugin p@m (user)"], [{ value: "4.10.0", since: "2026-09-30" }, { value: "5.3.3", since: "2026-11-04" }]);
  assert.equal(readVersions(file)["skill s"], undefined);
  assert.equal(versionLine(h["plugin p@m (user)"]), "versions: 4.10.0 (2026-09-30) → 5.3.3 (2026-11-04)");
  assert.equal(versionLine([{ value: "1", since: "x" }]), "");
});
