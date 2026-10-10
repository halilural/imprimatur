// @ts-check
// Issue tracker sync (#70): task status between Imprimatur and GitHub Issues or Jira.
// - Push: status changes made here wait in the database's tracker_outbox (db.upsertTask
//   queues them) and close or reopen the issue: GitHub through `gh`, Jira through its REST API.
// - Pull: issues closed or reopened there set the task's status here (as actor
//   tracker:<provider>, which closes the epic's lines and queues no push); an open GitHub
//   issue with no task gets one.
// Which tracker a task uses: "#N" in a repo whose origin is github.com, and gh works →
// github; a Jira key ("PROJ-12") with config.json {tracker: {jira: {baseUrl, email}}} and a
// token (IMPRIMATUR_JIRA_TOKEN, or tracker.jira.token in a 0600 config.json) → jira; else none.
// Another tracker (Linear …) is one more entry in PROVIDERS: {match, available, push, pull}.
// No vscode here: the extension, scripts/tracker.mjs and the tests share it.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { normOrigin } = require("./db.js");

const GH_KEY = /^#(\d+)$/;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
/** A queued push is dropped after this many failed tries. */
const MAX_TRIES = 5;
const TIMEOUT_MS = 30_000;
const JIRA_BATCH = 50;
/** The sweep warning (process.js) stays quiet while a tracker sync ran this recently. */
const ACTIVE_MS = 15 * 60_000;
/** Jira resolutions that mean "not done, given up": the task becomes dropped. */
const JIRA_DROPPED = /won'?t|declin|duplicate|cancel|reject|not planned|obsolete/i;

/** @param {string} provider */
const actorOf = (provider) => ({ kind: /** @type {"import"} */ ("import"), id: `tracker:${provider}` });
const CLOSED = new Set(["done", "dropped"]);

/**
 * Runs gh; resolves stdout, rejects with stderr. @param {string[]} args
 * @returns {Promise<string>}
 */
function ghExec(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${String(stderr || err.message).trim().split("\n")[0]}`));
      else resolve(stdout);
    });
  });
}

/** "owner/name" when the origin is a GitHub repo. @param {string | null | undefined} origin */
function githubRepo(origin) {
  if (!origin) return undefined;
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(normOrigin(origin));
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * The Jira settings, or undefined (with why, for the log).
 * @param {string} dbFile @param {NodeJS.ProcessEnv} [env] @param {string} [platform]
 * @returns {{jira?: {baseUrl: string, email: string, token: string}, why?: string}}
 */
function readJira(dbFile, env = process.env, platform = process.platform) {
  const file = path.join(path.dirname(dbFile), "config.json");
  let jira;
  try {
    jira = JSON.parse(fs.readFileSync(file, "utf8"))?.tracker?.jira;
  } catch {
    return {};
  }
  if (!jira || typeof jira.baseUrl !== "string" || typeof jira.email !== "string" || !jira.baseUrl || !jira.email) return {};
  let token = env.IMPRIMATUR_JIRA_TOKEN?.trim();
  if (!token && typeof jira.token === "string" && jira.token) {
    // A token in the file only when only this user can read it.
    if (platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) return { why: `${file} holds a Jira token but is readable by others (chmod 600 it)` };
    token = jira.token;
  }
  if (!token) return { why: "Jira is set up but has no token (IMPRIMATUR_JIRA_TOKEN or tracker.jira.token)" };
  return { jira: { baseUrl: jira.baseUrl.replace(/\/+$/, ""), email: jira.email, token } };
}

/**
 * One Jira REST call. @param {{baseUrl: string, email: string, token: string}} jira
 * @param {string} route @param {any} [body] POST when given @param {typeof fetch} [fetchFn]
 */
async function jiraCall(jira, route, body, fetchFn = fetch) {
  const res = await fetchFn(`${jira.baseUrl}${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString("base64")}`,
      accept: "application/json",
      ...(body && { "content-type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`jira ${route.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`.trim()), { status: res.status });
  return text ? JSON.parse(text) : {};
}

/** Text as Jira's comment body (Atlassian Document Format). @param {string} text */
const adf = (text) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/** Jira's "2026-10-01T12:00:00.000+0000" → epoch ms. @param {string} s */
const jiraTime = (s) => Date.parse(String(s ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));

/**
 * The task status an issue's state asks for, or undefined when it is already there.
 * @param {any} task @param {"open" | "done" | "dropped"} state @param {number} updatedAt
 */
function statusFor(task, state, updatedAt) {
  // Only an issue changed after the task: a change made here and not pushed yet wins.
  if (!(updatedAt > task.updated_at)) return undefined;
  if (state !== "open" && !CLOSED.has(task.status)) return state;
  if (state === "open" && CLOSED.has(task.status)) return "active";
  return undefined;
}

/**
 * Pulls one GitHub repo's issues into its tasks.
 * @param {any} db @param {any} repo @param {string} slug owner/name
 * @param {{gh: (args: string[]) => Promise<string>, dryRun?: boolean, log: (line: string) => void}} o
 */
async function pullGithub(db, repo, slug, { gh, dryRun, log }) {
  const out = { changes: 0, created: 0 };
  const issues = JSON.parse(await gh(["issue", "list", "-R", slug, "--state", "all", "--limit", "500", "--json", "number,title,state,stateReason,updatedAt,milestone"]));
  const actor = actorOf("github");
  for (const issue of issues) {
    const key = `#${issue.number}`;
    const task = db.taskByKey(repo.id, key);
    if (!task) {
      if (issue.state !== "OPEN") continue;
      if (dryRun) log(`tracker github: would add ${slug}${key} ${issue.title}`);
      else db.upsertTask(repo.id, key, { title: issue.title ?? "", status: "open" }, actor);
      out.created++;
      continue;
    }
    if (db.trackerPending(task.id)) continue;
    const state = issue.state === "CLOSED" ? (issue.stateReason === "NOT_PLANNED" ? "dropped" : "done") : "open";
    /** @type {{status?: string, title?: string}} */
    const fields = {};
    const status = statusFor(task, state, Date.parse(issue.updatedAt));
    if (status) fields.status = status;
    if (!task.title && issue.title) fields.title = issue.title;
    if (!Object.keys(fields).length) continue;
    if (dryRun) log(`tracker github: would set ${slug}${key} ${JSON.stringify(fields)}`);
    else db.upsertTask(repo.id, key, fields, actor);
    out.changes++;
  }
  return out;
}

/**
 * Pulls Jira issues into the tasks keyed by them.
 * @param {any} db @param {any[]} tasks @param {{jira: any, fetch?: typeof fetch, dryRun?: boolean, log: (line: string) => void}} o
 */
async function pullJira(db, tasks, { jira, fetch: fetchFn, dryRun, log }) {
  const out = { changes: 0, created: 0 };
  const actor = actorOf("jira");
  const fields = ["summary", "status", "updated", "resolution"];
  for (let i = 0; i < tasks.length; i += JIRA_BATCH) {
    const batch = tasks.slice(i, i + JIRA_BATCH);
    let issues;
    try {
      issues = (await jiraCall(jira, "/rest/api/3/search/jql", { jql: `key in (${batch.map((t) => t.key).join(",")})`, fields, maxResults: JIRA_BATCH }, fetchFn)).issues ?? [];
    } catch (e) {
      // A key Jira does not know fails the whole query: ask one by one, skipping the unknown.
      if (/** @type {any} */ (e).status !== 400) throw e;
      issues = [];
      for (const t of batch) {
        try {
          issues.push(await jiraCall(jira, `/rest/api/3/issue/${encodeURIComponent(t.key)}?fields=${fields.join(",")}`, undefined, fetchFn));
        } catch (err) {
          if (/** @type {any} */ (err).status !== 404) throw err;
        }
      }
    }
    for (const issue of issues) {
      const task = batch.find((t) => t.key === issue.key);
      if (!task || db.trackerPending(task.id)) continue;
      const now = db.taskById(task.id);
      const cat = issue.fields?.status?.statusCategory?.key;
      const state = cat === "done" ? (JIRA_DROPPED.test(issue.fields?.resolution?.name ?? "") ? "dropped" : "done") : "open";
      /** @type {{status?: string, title?: string}} */
      const set = {};
      const status = statusFor(now, state, jiraTime(issue.fields?.updated));
      if (status) set.status = status;
      if (!now.title && issue.fields?.summary) set.title = issue.fields.summary;
      if (!Object.keys(set).length) continue;
      if (dryRun) log(`tracker jira: would set ${task.key} ${JSON.stringify(set)}`);
      else db.upsertTask(now.repo_id, task.key, set, actor);
      out.changes++;
    }
  }
  return out;
}

/**
 * Closes or reopens one GitHub issue; "already" when it is in that state.
 * @param {{action: string, comment?: string | null}} row @param {string} slug @param {string} n
 * @param {(args: string[]) => Promise<string>} gh @param {boolean} [dryRun]
 */
async function pushGithub(row, slug, n, gh, dryRun) {
  const { state } = JSON.parse(await gh(["issue", "view", n, "-R", slug, "--json", "state"]));
  const close = row.action !== "reopen";
  if (close ? state === "CLOSED" : state === "OPEN") return "already";
  if (dryRun) return "would";
  if (close) {
    await gh(["issue", "close", n, "-R", slug, "--reason", row.action === "close_dropped" ? "not planned" : "completed", "--comment", `Imprimatur: ${row.comment ?? ""}`.trim()]);
  } else {
    await gh(["issue", "reopen", n, "-R", slug]);
  }
  return "done";
}

/**
 * Moves one Jira issue to a done (close) or new/in-progress (reopen) status, with a comment.
 * @param {{action: string, key: string, comment?: string | null}} row @param {any} jira
 * @param {typeof fetch | undefined} fetchFn @param {boolean} [dryRun]
 */
async function pushJira(row, jira, fetchFn, dryRun) {
  const key = encodeURIComponent(row.key);
  const issue = await jiraCall(jira, `/rest/api/3/issue/${key}?fields=status`, undefined, fetchFn);
  const close = row.action !== "reopen";
  const isDone = issue.fields?.status?.statusCategory?.key === "done";
  if (close === isDone) return "already";
  const { transitions = [] } = await jiraCall(jira, `/rest/api/3/issue/${key}/transitions`, undefined, fetchFn);
  const cat = (/** @type {any} */ t) => t.to?.statusCategory?.key;
  const pick = close ? transitions.find((t) => cat(t) === "done")
    : transitions.find((t) => cat(t) === "indeterminate") ?? transitions.find((t) => cat(t) === "new");
  if (!pick) throw new Error(`jira ${row.key}: no transition to a ${close ? "done" : "open"} status`);
  if (dryRun) return "would";
  await jiraCall(jira, `/rest/api/3/issue/${key}/transitions`, { transition: { id: pick.id } }, fetchFn);
  const text = close ? `Imprimatur: ${row.comment ?? ""}`.trim() : `Imprimatur: reopened${row.comment ? ` (${row.comment})` : ""}`;
  await jiraCall(jira, `/rest/api/3/issue/${key}/comment`, { body: adf(text) }, fetchFn);
  return "done";
}

/**
 * One tracker sync: push the queued status changes, then pull the repos' issues.
 * @param {any} db vscode/db.js handle
 * @param {{repos?: any[], gh?: (args: string[]) => Promise<string>, fetch?: typeof fetch, env?: NodeJS.ProcessEnv,
 *   originOf?: (root: string) => string | undefined, dryRun?: boolean, log?: (line: string) => void, now?: () => number}} [o]
 *   repos: whose issues are pulled (pushes go out for every repo)
 */
async function trackerOnce(db, o = {}) {
  const { repos = [], gh = ghExec, fetch: fetchFn, env = process.env, originOf, dryRun = false, log = () => {}, now = Date.now } = o;
  const result = { providers: /** @type {Set<string>} */ (new Set()), pushed: 0, already: 0, failed: 0, dropped: 0, changes: 0, created: 0, errors: /** @type {string[]} */ ([]) };
  /** @type {boolean | undefined} */
  let ghOk;
  const ghWorks = async () => {
    if (ghOk === undefined) {
      try {
        await gh(["auth", "status", "--hostname", "github.com"]);
        ghOk = true;
      } catch (e) {
        ghOk = false;
        log(`tracker github: gh is not available or not logged in (${e instanceof Error ? e.message : e})`);
      }
    }
    return ghOk;
  };
  const { jira, why } = readJira(db.file, env);
  if (why) log(`tracker jira: ${why}`);
  /** @type {Map<number, string | undefined>} */
  const origins = new Map();
  const slugOf = (/** @type {any} */ repo) => {
    if (!origins.has(repo.id)) {
      let origin = repo.origin;
      if (!origin && originOf && repo.root && !repo.root.startsWith("origin:") && fs.existsSync(repo.root)) origin = originOf(repo.root);
      origins.set(repo.id, githubRepo(origin));
    }
    return origins.get(repo.id);
  };

  // Push.
  for (const row of db.trackerOutbox()) {
    if (!row.key) {
      if (!dryRun) db.trackerDone(row.id);
      continue;
    }
    /** @type {() => Promise<string>} */
    let push;
    let provider;
    const gk = GH_KEY.exec(row.key);
    const slug = gk && slugOf({ id: row.repo_id, origin: row.origin, root: row.root });
    if (gk && slug) {
      // gh missing or logged out: the change waits, no try counted.
      if (!(await ghWorks())) continue;
      provider = "github";
      push = () => pushGithub(row, slug, gk[1], gh, dryRun);
    } else if (JIRA_KEY.test(row.key) && jira) {
      provider = "jira";
      push = () => pushJira(row, jira, fetchFn, dryRun);
    } else {
      // No tracker for this task: nothing to push to.
      if (!dryRun) db.trackerDone(row.id);
      continue;
    }
    result.providers.add(provider);
    try {
      const r = await push();
      if (r === "would") log(`tracker ${provider}: would ${row.action.replace("_", " ")} ${row.key}`);
      if (!dryRun) db.trackerDone(row.id);
      if (r === "already") result.already++;
      else result.pushed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed++;
      result.errors.push(msg);
      if (dryRun) continue;
      const tries = db.trackerFailed(row.id);
      if (tries >= MAX_TRIES) {
        db.trackerDone(row.id);
        result.dropped++;
        log(`tracker ${provider}: gave up on ${row.action} ${row.key} after ${tries} tries: ${msg}`);
      }
    }
  }

  // Pull.
  const jiraTasks = [];
  for (const repo of repos) {
    const slug = slugOf(repo);
    if (slug && (await ghWorks())) {
      result.providers.add("github");
      try {
        const r = await pullGithub(db, repo, slug, { gh, dryRun, log });
        result.changes += r.changes;
        result.created += r.created;
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (jira) jiraTasks.push(...db.tasksOf(repo.id, { limit: 100_000 }).filter((/** @type {any} */ t) => JIRA_KEY.test(t.key)));
  }
  if (jira && jiraTasks.length) {
    result.providers.add("jira");
    try {
      const r = await pullJira(db, jiraTasks, { jira, fetch: fetchFn, dryRun, log });
      result.changes += r.changes;
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (!dryRun && result.providers.size && !result.errors.length) db.setMeta("tracker_ok_at", now());
  return result;
}

/** One line for the log. @param {Awaited<ReturnType<typeof trackerOnce>>} r */
function describe(r) {
  if (!r.providers.size) return "tracker: no issue tracker for these repos";
  const parts = [`pushed ${r.pushed}`];
  if (r.already) parts.push(`${r.already} already there`);
  parts.push(`pulled ${r.changes} change${r.changes === 1 ? "" : "s"}`, `${r.created} new task${r.created === 1 ? "" : "s"}`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.dropped) parts.push(`${r.dropped} given up`);
  const line = `tracker ${[...r.providers].sort().join("+")}: ${parts.join(", ")}`;
  return r.errors.length ? `${line} (${r.errors[0]}${r.errors.length > 1 ? ` and ${r.errors.length - 1} more` : ""})` : line;
}

/**
 * Whether tracker sync ran lately on this device: then it closes the issue of a task set
 * done, and the sweep warning is not needed. @param {any} db @param {number} [now]
 */
function trackerActive(db, now = Date.now()) {
  try {
    const at = Number(db?.meta?.("tracker_ok_at"));
    return Number.isFinite(at) && now - at < ACTIVE_MS;
  } catch {
    return false;
  }
}

module.exports = { trackerOnce, describe, trackerActive, githubRepo, readJira, statusFor, jiraTime, ghExec, MAX_TRIES, ACTIVE_MS, JIRA_KEY, GH_KEY };
