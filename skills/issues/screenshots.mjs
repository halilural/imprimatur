#!/usr/bin/env node
// Screenshots for an issue's "How to try it" (#158): puts the agent's PNGs on a branch of
// their own (no parent, so main's history stays small) through the GitHub API, and prints the
// Markdown to put under each "See" step. The API, not a local commit: a repo's hooks run on
// every local commit and expect the repo's files, which a branch holding only images lacks,
// and skipping hooks is not allowed.
//
//   node screenshots.mjs <issue> <png>... [--branch name] [--public] [--date YYYY-MM-DD]
//
// --branch: the branch, default screenshots/<issue>; use the repo's branch rule when it has
//   one (dirtywork: docs/<issue>-screenshots).
// --public: a public repo's images are public too; the script refuses it unless told the
//   images hold no personal data (records, notes, mail, job lists): UI with sample data only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Where an image goes on the branch: <issue>/<date>/<file name>. */
export function shotPath(issue, date, file) {
  return `${issue}/${date}/${path.basename(file)}`;
}

/** The image as Markdown: a commit URL, so it renders for whoever can see the repo. */
export function shotMarkdown(repo, sha, file, alt) {
  return `![${alt}](https://github.com/${repo}/blob/${sha}/${file}?raw=true)`;
}

/** The alt text from a file name: "2-session.png" → "2 session". */
export function altOf(file) {
  return path.basename(file, path.extname(file)).replace(/[-_]+/g, " ");
}

/** Whether to go on: a public repo only with --public. */
export function allowed(visibility, publicOk) {
  return visibility !== "PUBLIC" || publicOk;
}

function gh(args, input) {
  return JSON.parse(execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 64 << 20 }));
}

function main(argv) {
  const flags = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--public") flags.set("public", true);
    else if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[++i]);
    else rest.push(argv[i]);
  }
  const [issue, ...files] = rest;
  if (!/^\d+$/.test(issue ?? "") || !files.length) {
    console.error("usage: screenshots.mjs <issue> <png>... [--branch name] [--public] [--date YYYY-MM-DD]");
    process.exit(2);
  }
  const { nameWithOwner: repo, visibility } = JSON.parse(
    execFileSync("gh", ["repo", "view", "--json", "nameWithOwner,visibility"], { encoding: "utf8" })
  );
  if (!allowed(visibility, flags.get("public"))) {
    console.error(`${repo} is public: its images are public. Re-run with --public only if they show no personal data.`);
    process.exit(1);
  }
  const branch = flags.get("branch") ?? `screenshots/${issue}`;
  const date = flags.get("date") ?? new Date().toISOString().slice(0, 10);

  // The branch's head, if it exists: the new commit goes on top and keeps its files.
  let parent = null;
  try {
    parent = gh(["api", `repos/${repo}/git/ref/heads/${branch}`]).object.sha;
  } catch {
    // a new branch
  }
  const tree = files.map((f) => ({
    path: shotPath(issue, date, f),
    mode: "100644",
    type: "blob",
    sha: gh(
      ["api", `repos/${repo}/git/blobs`, "--input", "-"],
      JSON.stringify({ content: fs.readFileSync(f).toString("base64"), encoding: "base64" })
    ).sha,
  }));
  const base = parent ? gh(["api", `repos/${repo}/git/commits/${parent}`]).tree.sha : undefined;
  const treeSha = gh(
    ["api", `repos/${repo}/git/trees`, "--input", "-"],
    JSON.stringify({ tree, ...(base ? { base_tree: base } : {}) })
  ).sha;
  const commit = gh(
    ["api", `repos/${repo}/git/commits`, "--input", "-"],
    JSON.stringify({
      message: `docs(screenshots): How to try it for #${issue} (#${issue})`,
      tree: treeSha,
      parents: parent ? [parent] : [],
    })
  ).sha;
  if (parent) gh(["api", "-X", "PATCH", `repos/${repo}/git/refs/heads/${branch}`, "-f", `sha=${commit}`]);
  else gh(["api", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${commit}`]);
  for (const f of files) console.log(shotMarkdown(repo, commit, shotPath(issue, date, f), altOf(f)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
