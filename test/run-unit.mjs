// npm test: the unit tests, with their own database. Several tests run the hooks, which
// open the device database (vscode/db.js dbPath); without IMPRIMATUR_DB that is the real
// one, and a branch's new migration (#70) would upgrade it under the installed extension.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-unit-"));
// Every temp folder the tests make goes under this run's own one, removed at the end: a run
// left ~500 folders in /tmp (a RAM tmpfs on WSL), 40 runs filled its 5.9 GB.
const scratch = path.join(tmp, "tmp");
fs.mkdirSync(scratch);
const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, IMPRIMATUR_DB: process.env.IMPRIMATUR_DB_TEST ?? path.join(tmp, "imprimatur.db") };
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), "test/*.test.mjs"], {
  cwd: path.join(import.meta.dirname, ".."),
  env,
  stdio: "inherit",
});
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
