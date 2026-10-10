#!/usr/bin/env node
// Prints (never runs) the `gh api` commands that add an `issues` webhook to each GitHub
// repo the database knows (#71), so an issue closed or reopened on GitHub reaches VS Code
// in seconds (the sync Worker's POST /v1/github tells the live connections).
//   node scripts/github-webhooks.mjs [--url https://imprimatur-sync.<you>.workers.dev]
// The URL defaults to the sync settings (config.json next to the database). The secret is
// left as $GITHUB_WEBHOOK_SECRET in the commands: set it in your shell to the value you gave
// `npx wrangler secret put GITHUB_WEBHOOK_SECRET`, then paste the commands.
// Reads the database read-only; changes nothing.
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { dbPath } = require("../vscode/db.js");
const { readConfig } = require("../vscode/sync.js");
const { githubRepo } = require("../vscode/tracker.js");

/** owner/name of every repo in the database whose origin is on github.com, sorted, once each. @param {string} file */
export function githubRepos(file) {
  if (!fs.existsSync(file)) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT origin FROM repos WHERE origin IS NOT NULL").all();
    const seen = new Map();
    for (const r of rows) {
      const name = githubRepo(/** @type {string} */ (r.origin));
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  } finally {
    db.close();
  }
}

/** The command for one repo. @param {string} repo owner/name @param {string} url the Worker's address */
export function hookCommand(repo, url) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `gh api ${q(`repos/${repo}/hooks`)} --method POST`,
    "-f name=web -F active=true",
    `-f 'events[]=issues'`,
    `-f ${q(`config[url]=${url.replace(/\/+$/, "")}/v1/github`)}`,
    "-f 'config[content_type]=json'",
    `-f "config[secret]=$GITHUB_WEBHOOK_SECRET"`,
  ].join(" ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = dbPath();
  const i = process.argv.indexOf("--url");
  const url = i > 0 ? process.argv[i + 1] : readConfig(file)?.url;
  if (!url) {
    console.error("No sync URL: set up sync first (npm run sync -- --setup <url>) or pass --url <url>.");
    process.exit(1);
  }
  const repos = githubRepos(file);
  if (!repos.length) {
    console.error(`No GitHub repos in ${file}.`);
    process.exit(0);
  }
  console.log(`# ${repos.length} GitHub repo${repos.length === 1 ? "" : "s"} in ${file}. Nothing was run.`);
  console.log(`# First: export GITHUB_WEBHOOK_SECRET=<the value given to wrangler secret put GITHUB_WEBHOOK_SECRET>`);
  console.log(`# A repo that already has this hook gets a second one: check with gh api repos/<repo>/hooks.`);
  for (const r of repos) console.log(hookCommand(r, url));
}
