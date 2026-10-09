#!/usr/bin/env node
// Syncs Imprimatur's database with the sync Worker (#61).
//
//   npm run sync                              push queued changes, pull everyone else's
//   npm run sync -- --setup <url> <token>     save the settings, turn sync on (queues what is here), sync
//   npm run sync -- --off                     stop queueing changes (the settings stay)
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDb, PLACEHOLDER } = require("../vscode/db.js");
const { readConfig, writeConfig, syncOnce, describe } = require("../vscode/sync.js");
const { originOf } = require("../vscode/import.js");

const argv = process.argv.slice(2);
const db = openDb();
let code = 0;
try {
  if (argv[0] === "--off") {
    db.disableSync();
    console.log("Imprimatur sync is off: changes are no longer queued.");
  } else {
    if (argv[0] === "--setup") {
      const [, url, token] = argv;
      if (!/^https?:\/\/\S+$/.test(url ?? "") || !token) throw new Error("usage: npm run sync -- --setup <https://worker-url> <token>");
      console.log(`settings saved to ${writeConfig(db.file, { url, token })} (mode 0600)`);
      // Repos made before #61 have no origin: learn it, so their tasks get a sync key.
      for (const repo of db.repos()) {
        if (repo.origin || repo.root.startsWith(PLACEHOLDER) || !fs.existsSync(repo.root)) continue;
        const origin = originOf(repo.root);
        if (origin) db.repoOf(repo.root, { origin });
      }
      const n = db.enableSync();
      console.log(`sync on (device ${db.deviceId()})${n ? `: ${n} existing fields queued` : ""}`);
    }
    const cfg = readConfig(db.file);
    if (!cfg) throw new Error("sync is not set up: npm run sync -- --setup <url> <token>");
    if (!db.syncOn()) console.log("note: sync is off here (npm run sync -- --setup turns it on); pulling only");
    console.log(describe(await syncOnce(db, cfg)));
  }
} catch (e) {
  console.error(`Imprimatur: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  db.close();
}
process.exit(code);
