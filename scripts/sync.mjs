#!/usr/bin/env node
// Syncs Imprimatur's database with the sync Worker (#61).
//
//   npm run sync                    push queued changes, pull everyone else's
//   npm run sync -- --setup <url>   save the settings, turn sync on (queues what is here), sync;
//                                   the token comes from IMPRIMATUR_SYNC_TOKEN or is asked for
//                                   (never on the command line: it would stay in shell history)
//   npm run sync -- --off           stop queueing changes (the settings stay; --setup queues again)
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDb, PLACEHOLDER } = require("../vscode/db.js");
const { readConfig, writeConfig, syncOnce, describe } = require("../vscode/sync.js");
const { originOf } = require("../vscode/import.js");

/** The token: env, else typed without echo (a terminal), else the first line of stdin. */
async function readToken() {
  if (process.env.IMPRIMATUR_SYNC_TOKEN) return process.env.IMPRIMATUR_SYNC_TOKEN.trim();
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.split(/\r?\n/)[0].trim();
  }
  process.stderr.write("Sync token (not shown): ");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let token = "";
    const done = (fn) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (/** @type {string} */ s) => {
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(token.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") token = token.slice(0, -1);
        else token += ch;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

const argv = process.argv.slice(2);
const db = openDb();
let code = 0;
try {
  if (argv[0] === "--off") {
    db.disableSync();
    console.log("Imprimatur sync is off: changes are no longer queued (--setup turns it on and queues everything again).");
  } else {
    if (argv[0] === "--setup") {
      const [, url, extra] = argv;
      if (extra) throw new Error("the token does not go on the command line; set IMPRIMATUR_SYNC_TOKEN or type it when asked");
      if (!/^https?:\/\/\S+$/.test(url ?? "")) throw new Error("usage: npm run sync -- --setup <https://worker-url>");
      const token = await readToken();
      if (!token) throw new Error("no token given");
      console.log(`settings saved to ${writeConfig(db.file, { url, token })} (mode 0600)`);
      // Repos made before #61 have no origin: learn it, so their tasks get a sync key.
      for (const repo of db.repos()) {
        if (repo.origin || repo.root.startsWith(PLACEHOLDER) || !fs.existsSync(repo.root)) continue;
        const origin = originOf(repo.root);
        if (origin) db.repoOf(repo.root, { origin });
      }
      const n = db.enableSync();
      console.log(`sync on (device ${db.deviceId()})${n ? `: ${n} existing fields queued` : ""}`);
      for (const r of db.unsyncedClones()) console.log(`note: ${r.root} is a second clone of ${r.origin}; only the first one syncs`);
    }
    const cfg = readConfig(db.file);
    if (!cfg) throw new Error("sync is not set up: npm run sync -- --setup <url>");
    if (!db.syncOn()) console.log("note: sync is off here (npm run sync -- --setup turns it on); pulling only");
    console.log(describe(await syncOnce(db, cfg, { log: (line) => console.log(line) })));
  }
} catch (e) {
  console.error(`Imprimatur: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  db.close();
}
process.exit(code);
