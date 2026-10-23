// @ts-check
// The design documents and the glossary written once for a repo that never had them (or
// whose old ADRs/PDRs no section links): at session start, when the repo has enough
// records and was never backfilled, a background `claude -p` (sonnet) reads the records
// and the code and writes the sections through Imprimatur's MCP server. Once per repo:
// meta "backfill:<repoId>" is claimed before it starts, so it never runs again there,
// whatever the run's outcome. From then on docUpdate (process.js) keeps them current.
"use strict";
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

/** Fewer records than this: too little to write about (a new repo fills its docs as it goes). */
const MIN_RECORDS = 10;
const MODEL = "sonnet";
const BUDGET_USD = 3;
const MAX_TURNS = 120;
const TIMEOUT_MS = 30 * 60_000;
const KINDS = /** @type {const} */ (["architecture", "product", "glossary"]);
const RECORD_KIND = { architecture: "adr", product: "pdr", glossary: null };
const MCP_TOOLS = ["doc_get", "doc_section_upsert", "search", "task_get", "task_list"].map((t) => `mcp__imprimatur__${t}`);
const REPO_TOOLS = ["Read", "Glob", "Grep"];
const metaKey = (/** @type {number} */ repoId) => `backfill:${repoId}`;

/**
 * The documents a backfill would write: empty ones, and ones with ADRs/PDRs no section links.
 * @param {any} db @param {number} repoId @returns {string[]}
 */
function targets(db, repoId) {
  const h = db.docHealth(repoId);
  return KINDS.filter((k) => h[k].sections === 0 || h[k].unlinked > 0);
}

/**
 * Whether the repo is due: never backfilled, enough records, something to write, not the home folder.
 * @param {any} db @param {number} repoId @param {string} root @param {string} [home]
 */
function due(db, repoId, root, home = os.homedir()) {
  if (path.resolve(root) === path.resolve(home)) return false;
  if (db.meta(metaKey(repoId)) !== undefined) return false;
  if (db.recordCount(repoId) < MIN_RECORDS) return false;
  return targets(db, repoId).length > 0;
}

/** One line of a record for the prompt, its body cut. @param {any} r */
const recordLine = (r) => `- [${r.id}] ${r.kind.toUpperCase()} (${r.task}) ${r.title}${r.body ? `\n  ${String(r.body).replace(/\s+/g, " ").slice(0, 500)}` : ""}`;

/**
 * The instructions for the backfill agent.
 * @param {any} db @param {number} repoId @param {string} root @param {string[]} kinds @param {string} lang
 */
function promptFor(db, repoId, root, kinds, lang) {
  const h = db.docHealth(repoId);
  const parts = [
    `You write this repository's living design documents in Imprimatur, once, for a project that never had them complete. Repo: ${root}`,
    "Use only Read/Glob/Grep on the repo and the imprimatur MCP tools. Change no file. Pass repo = the repo path above to every imprimatur tool.",
    "Documents: architecture (how it is built: components, storage, data flow, integrations, deployment), product (what the user gets: features, flows, screens, rules), glossary (one section per project term: title = the term, body = its meaning in this project, 1-4 sentences).",
    `Write in the language the documents already use; if they are empty, in ${lang}.`,
    "Rules:",
    "- First doc_get each document below (full: true) and never duplicate or rewrite a section that already covers a topic: add the missing sections, and link records to existing sections when they fit.",
    "- A section is a topic (key: a short slug, a-z 0-9 -), a few paragraphs or a list; headings inside from ### down. Facts only, from the records and the code: no guesses, no marketing.",
    "- Link every ADR/PDR listed below to the section that covers it (doc_section_upsert records: [ids]); a record whose decision was later reversed still links, to the section that says what holds now.",
    "- Glossary: 10-30 terms that a newcomer would not know: domain words, the project's own names for things, abbreviations. Not generic programming words.",
    "- If the repo holds hand-written design docs (docs/, README), use them as sources.",
    "- When done, stop. Reply with one line: how many sections you wrote per document.",
    "",
    "Documents to work on:",
  ];
  for (const k of kinds) {
    const rk = RECORD_KIND[/** @type {keyof typeof RECORD_KIND} */ (k)];
    parts.push(`## ${k}: ${h[k].sections} sections now${rk ? `, ${h[k].unlinked} ${rk.toUpperCase()}s no section links` : ""}`);
    if (rk) for (const r of db.unlinkedRecords(repoId, rk).slice(0, 150)) parts.push(recordLine(r));
  }
  return parts.join("\n");
}

/** The claude arguments: sonnet, the repo tools and Imprimatur's MCP server only, no settings (no hooks). @param {string} mcpServer */
function claudeArgs(mcpServer) {
  const mcp = JSON.stringify({ mcpServers: { imprimatur: { type: "stdio", command: process.execPath, args: [mcpServer] } } });
  const tools = [...REPO_TOOLS, ...MCP_TOOLS];
  const { DENY } = require("./best-practice.js");
  return ["-p", "--model", MODEL, "--max-turns", String(MAX_TURNS), "--output-format", "json",
    "--tools", REPO_TOOLS.join(","), "--allowedTools", ...tools, "--disallowedTools", ...DENY, "--permission-mode", "dontAsk",
    "--mcp-config", mcp, "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands",
    "--max-budget-usd", String(BUDGET_USD)];
}

/**
 * Runs the backfill and waits for it (hooks/backfill.mjs, detached from the session). The
 * outcome goes to meta "backfill:<repoId>".
 * @param {any} db @param {number} repoId @param {string} root
 * @param {{exec?: (cmd: string, args: string[], opts: any) => Promise<{code: number, stdout: string, stderr: string}>, lang?: string}} [o]
 */
async function runBackfill(db, repoId, root, o = {}) {
  const bp = require("./best-practice.js");
  const exec = o.exec ?? bp.run;
  const kinds = targets(db, repoId);
  const started = JSON.parse(db.meta(metaKey(repoId)) ?? "{}");
  const save = (/** @type {any} */ v) => db.setMeta(metaKey(repoId), JSON.stringify({ ...started, kinds, ...v }));
  if (!kinds.length) return save({ status: "nothing", at: Date.now() });
  const prompt = promptFor(db, repoId, root, kinds, o.lang ?? bp.proseLang(root));
  // Tool search off: with it the MCP tools are deferred behind ToolSearch, which --tools
  // leaves out, so the child saw only Read/Glob/Grep and wrote nothing.
  const env = { ...bp.childEnv(), ENABLE_TOOL_SEARCH: "false" };
  const r = await exec("claude", claudeArgs(path.join(__dirname, "..", "mcp", "server.mjs")), { cwd: root, timeout: TIMEOUT_MS, env, input: prompt });
  let res = {};
  try {
    res = JSON.parse(r.stdout);
  } catch {}
  const after = db.docHealth(repoId);
  // Done only when nothing is left to write: a clean exit that wrote nothing is not done.
  const left = targets(db, repoId);
  save({
    status: r.code !== 0 || res.is_error ? "failed" : left.length ? "incomplete" : "done", left, at: Date.now(), cost: Number(res.total_cost_usd ?? 0),
    result: String(res.result ?? r.stderr ?? "").trim().slice(0, 300),
    sections: Object.fromEntries(KINDS.map((k) => [k, after[k].sections])),
  });
}

/**
 * At session start: claims the repo's one backfill and starts it in the background when it
 * is due. True when it started one.
 * @param {any} db @param {number} repoId @param {string} root
 * @param {{start?: (root: string) => void, home?: string}} [o] start: tests replace the detached process
 */
function maybeStart(db, repoId, root, o = {}) {
  if (process.env.IMPRIMATUR_CHILD) return false;
  if (!due(db, repoId, root, o.home)) return false;
  if (!db.claimMeta(metaKey(repoId), JSON.stringify({ status: "running", started: Date.now() }))) return false;
  // Under `node --test` only a test's own start runs: never a real claude.
  const start = o.start ?? (process.env.NODE_TEST_CONTEXT ? () => {} : startDetached);
  start(root);
  return true;
}

/** The backfill in its own process, outliving the hook. @param {string} root */
function startDetached(root) {
  spawn(process.execPath, [path.join(__dirname, "..", "hooks", "backfill.mjs"), root], {
    cwd: root, detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, IMPRIMATUR_CHILD: "1" },
  }).unref();
}

module.exports = { MIN_RECORDS, targets, due, promptFor, claudeArgs, runBackfill, maybeStart, metaKey };
