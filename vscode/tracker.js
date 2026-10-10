// @ts-check
// Issue tracker sync (#70): task status between Imprimatur and GitHub Issues or Jira.
// - Push: status changes made here wait in the database's tracker_outbox (db.upsertTask
//   queues them) and close or reopen the issue: GitHub through `gh`, Jira through its REST
//   API, with a fixed comment (nothing from the task's text). A row whose task changed
//   status since is dropped; one being pushed by another window (claimed) is left to it.
//   Transient failures (network, 5xx, 429, rate limits) wait with backoff and never use up
//   the row's tries; other failures count, and the row goes after MAX_TRIES.
// - Pull: acts only on an issue whose STATE changed since the last pull (tracker_state);
//   the first pull of a repo records the states and changes no task. A change sets the
//   task's status as actor tracker:<provider> (which closes the epic's lines and queues no
//   push). Open GitHub issues without a task get one (createTasks, at most MAX_CREATE a run).
// Which tracker a task uses: "#N" in a repo whose origin is github.com, and gh works →
// github; a Jira key ("PROJ-12") with config.json {tracker: {jira: {baseUrl, email}}} and a
// token (IMPRIMATUR_JIRA_TOKEN, or tracker.jira.token in a 0600 config.json) → jira. A row
// whose tracker is not available now waits; another tracker (Linear …) is one more key
// shape here with its own push and pull.
// No vscode here: the extension, scripts/tracker.mjs and the tests share it.
"use strict";
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { normOrigin } = require("./db.js");

const GH_KEY = /^#(\d+)$/;
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
/** A queued push is dropped after this many failures that count (not transient ones). */
const MAX_TRIES = 5;
const TIMEOUT_MS = 30_000;
const JIRA_BATCH = 50;
/** Tasks made from open issues, at most, per run. */
const MAX_CREATE = 50;
/** The sweep warning (process.js) stays quiet while a tracker sync ran this recently... */
const ACTIVE_MS = 15 * 60_000;
/** ...and no push of the repo waits longer than this or has failed. */
const STUCK_MS = 10 * 60_000;
/** Jira resolutions that mean "not done, given up": the task becomes dropped. */
const JIRA_DROPPED = /won'?t|declin|duplicate|cancel|reject|not planned|obsolete/i;
/** The comment each push leaves: fixed, so nothing private reaches the issue. */
const COMMENT = { close_done: "Imprimatur: tamamlandı", close_dropped: "Imprimatur: bırakıldı", reopen: "Imprimatur: yeniden açıldı" };
/** The task status a queued action stands for: else the row is stale. */
const WANTS = {
  close_done: (/** @type {string} */ s) => s === "done",
  close_dropped: (/** @type {string} */ s) => s === "dropped",
  reopen: (/** @type {string} */ s) => s === "open" || s === "active",
};
/** gh's words for a failure that passes by itself. */
const GH_TRANSIENT = /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|connection|could not connect|rate limit|abuse|HTTP (5\d\d|429)|\b(502|503|504)\b|Bad Gateway|Service Unavailable/i;

/** @param {string} provider */
const actorOf = (provider) => ({ kind: /** @type {"import"} */ ("import"), id: `tracker:${provider}` });
const CLOSED = new Set(["done", "dropped"]);

/** Whether a failure passes by itself (retry later, no try used). @param {unknown} e */
function isTransient(e) {
  const t = /** @type {any} */ (e)?.transient;
  if (typeof t === "boolean") return t;
  return GH_TRANSIENT.test(e instanceof Error ? e.message : String(e));
}

/**
 * Runs gh; resolves stdout, rejects with stderr (transient when it timed out or says so).
 * @param {string[]} args @returns {Promise<string>}
 */
function ghExec(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const msg = `gh ${args.slice(0, 2).join(" ")}: ${String(stderr || err.message).trim().split("\n")[0]}`;
      reject(Object.assign(new Error(msg), { transient: Boolean(/** @type {any} */ (err).killed) || GH_TRANSIENT.test(msg) }));
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
 * The Jira settings, or undefined (with why, for the log). https only (http for localhost);
 * a token in config.json only when it is a plain file only this user can read.
 * @param {string} dbFile @param {NodeJS.ProcessEnv} [env] @param {string} [platform]
 * @returns {{jira?: {baseUrl: string, email: string, token: string}, why?: string}}
 */
function readJira(dbFile, env = process.env, platform = process.platform) {
  const file = path.join(path.dirname(dbFile), "config.json");
  let jira;
  let st;
  try {
    st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { why: `${file} is a symlink; Jira settings are read only from a plain file` };
    jira = JSON.parse(fs.readFileSync(file, "utf8"))?.tracker?.jira;
  } catch {
    return {};
  }
  if (!jira || typeof jira.baseUrl !== "string" || typeof jira.email !== "string" || !jira.baseUrl || !jira.email) return {};
  const baseUrl = jira.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(baseUrl)) {
    return { why: `Jira baseUrl must be https (${baseUrl})` };
  }
  let token = env.IMPRIMATUR_JIRA_TOKEN?.trim();
  if (!token && typeof jira.token === "string" && jira.token) {
    if (platform !== "win32" && (st.mode & 0o077) !== 0) return { why: `${file} holds a Jira token but is readable by others (chmod 600 it)` };
    token = jira.token;
  }
  if (!token) return { why: "Jira is set up but has no token (IMPRIMATUR_JIRA_TOKEN or tracker.jira.token)" };
  return { jira: { baseUrl, email: jira.email, token } };
}

/**
 * One Jira REST call; a network failure, 5xx or 429 is transient.
 * @param {{baseUrl: string, email: string, token: string}} jira
 * @param {string} route @param {any} [body] POST when given @param {typeof fetch} [fetchFn]
 */
async function jiraCall(jira, route, body, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(`${jira.baseUrl}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString("base64")}`,
        accept: "application/json",
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw Object.assign(new Error(`jira ${route.split("?")[0]}: ${e instanceof Error ? e.message : e}`), { transient: true });
  }
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`jira ${route.split("?")[0]}: HTTP ${res.status} ${text.slice(0, 200)}`.trim()), {
      status: res.status, transient: res.status >= 500 || res.status === 429,
    });
  }
  return text ? JSON.parse(text) : {};
}

/** Text as Jira's comment body (Atlassian Document Format). @param {string} text */
const adf = (text) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

/**
 * The task status an issue's new state asks for, or undefined when the task is there already.
 * @param {string} status the task's @param {"open" | "done" | "dropped"} state the issue's
 */
function statusFor(status, state) {
  if (state === "open") return CLOSED.has(status) ? "active" : undefined;
  return status === state ? undefined : state;
}

/**
 * Applies one repo's issue states: only state changes since the last pull; the first pull
 * records them. @param {any} db @param {any} repo @param {string} provider
 * @param {Array<{key: string, state: "open" | "done" | "dropped", title?: string}>} issues
 * @param {{dryRun?: boolean, log: (line: string) => void, now: number, create?: {left: number, skipped: number}, label: (key: string) => string}} o
 */
function applyStates(db, repo, provider, issues, { dryRun, log, now, create, label }) {
  const out = { changes: 0, created: 0 };
  const actor = actorOf(provider);
  const baseline = `tracker_baseline:${provider}:${repo.id}`;
  const first = !db.meta(baseline);
  const seen = db.trackerStates(repo.id, provider);
  const record = (/** @type {string} */ key, /** @type {string} */ state) => {
    if (!dryRun) db.setTrackerState(repo.id, key, provider, state, now);
  };
  for (const issue of issues) {
    const task = db.taskByKey(repo.id, issue.key);
    if (!task) {
      if (issue.state === "open" && create) {
        if (create.left > 0) {
          create.left--;
          if (dryRun) log(`tracker ${provider}: would add ${label(issue.key)} ${issue.title ?? ""}`);
          else db.upsertTask(repo.id, issue.key, { title: issue.title ?? "", status: "open" }, actor);
          out.created++;
        } else {
          create.skipped++;
        }
      }
      record(issue.key, issue.state);
      continue;
    }
    // A push of this task still waits: what is here wins; its state is looked at again later.
    if (db.trackerPending(task.id)) continue;
    const prev = seen.get(issue.key);
    /** @type {{status?: string, title?: string}} */
    const fields = {};
    if (!first && prev !== undefined && prev !== issue.state) {
      const status = statusFor(task.status, issue.state);
      if (status) fields.status = status;
    }
    if (!task.title && issue.title) fields.title = issue.title;
    if (Object.keys(fields).length) {
      if (dryRun) log(`tracker ${provider}: would set ${label(issue.key)} ${JSON.stringify(fields)}`);
      else db.upsertTask(repo.id, issue.key, fields, actor);
      out.changes++;
    }
    record(issue.key, issue.state);
  }
  if (!dryRun && first) db.setMeta(baseline, now);
  return out;
}

/**
 * Pulls one GitHub repo's issues. @param {any} db @param {any} repo @param {string} slug owner/name
 * @param {{gh: (args: string[]) => Promise<string>, dryRun?: boolean, log: (line: string) => void, now: number, create?: {left: number, skipped: number}}} o
 */
async function pullGithub(db, repo, slug, o) {
  const list = JSON.parse(await o.gh(["issue", "list", "-R", slug, "--state", "all", "--limit", "500", "--json", "number,title,state,stateReason,updatedAt,milestone"]));
  const issues = list.map((/** @type {any} */ i) => ({
    key: `#${i.number}`,
    title: i.title,
    state: /** @type {"open" | "done" | "dropped"} */ (i.state === "CLOSED" ? (i.stateReason === "NOT_PLANNED" ? "dropped" : "done") : "open"),
  }));
  return applyStates(db, repo, "github", issues, { ...o, label: (k) => `${slug}${k}` });
}

/**
 * Pulls the Jira issues of one repo's Jira-keyed tasks (no task is made from Jira).
 * @param {any} db @param {any} repo @param {any[]} tasks
 * @param {{jira: any, fetch?: typeof fetch, dryRun?: boolean, log: (line: string) => void, now: number}} o
 */
async function pullJira(db, repo, tasks, o) {
  const fields = ["summary", "status", "updated", "resolution"];
  const found = [];
  for (let i = 0; i < tasks.length; i += JIRA_BATCH) {
    const batch = tasks.slice(i, i + JIRA_BATCH);
    try {
      found.push(...((await jiraCall(o.jira, "/rest/api/3/search/jql", { jql: `key in (${batch.map((t) => t.key).join(",")})`, fields, maxResults: JIRA_BATCH }, o.fetch)).issues ?? []));
    } catch (e) {
      // A key Jira does not know fails the whole query: ask one by one, skipping the unknown.
      if (/** @type {any} */ (e).status !== 400) throw e;
      for (const t of batch) {
        try {
          found.push(await jiraCall(o.jira, `/rest/api/3/issue/${encodeURIComponent(t.key)}?fields=${fields.join(",")}`, undefined, o.fetch));
        } catch (err) {
          if (/** @type {any} */ (err).status !== 404) throw err;
        }
      }
    }
  }
  const issues = found.map((/** @type {any} */ issue) => ({
    key: String(issue.key),
    title: issue.fields?.summary,
    state: /** @type {"open" | "done" | "dropped"} */ (issue.fields?.status?.statusCategory?.key === "done"
      ? (JIRA_DROPPED.test(issue.fields?.resolution?.name ?? "") ? "dropped" : "done") : "open"),
  }));
  return applyStates(db, repo, "jira", issues, { ...o, create: undefined, label: (k) => k });
}

/**
 * Closes or reopens one GitHub issue with the fixed comment; "already" when it is in that state.
 * @param {{action: string}} row @param {string} slug @param {string} n
 * @param {(args: string[]) => Promise<string>} gh @param {boolean} [dryRun]
 */
async function pushGithub(row, slug, n, gh, dryRun) {
  const { state } = JSON.parse(await gh(["issue", "view", n, "-R", slug, "--json", "state"]));
  const close = row.action !== "reopen";
  if (close ? state === "CLOSED" : state === "OPEN") return "already";
  if (dryRun) return "would";
  const comment = /** @type {any} */ (COMMENT)[row.action];
  if (close) await gh(["issue", "close", n, "-R", slug, "--reason", row.action === "close_dropped" ? "not planned" : "completed", "--comment", comment]);
  else await gh(["issue", "reopen", n, "-R", slug, "--comment", comment]);
  return "done";
}

/**
 * The Jira transition for an action: by the target's name (Done/Closed/Resolved; Won't Do/
 * Cancelled/Rejected), else the first into a done status; reopen: in progress, else to do.
 * @param {any[]} transitions @param {string} action
 */
function pickTransition(transitions, action) {
  const cat = (/** @type {any} */ t) => t.to?.statusCategory?.key;
  const named = (/** @type {RegExp} */ re) => transitions.find((t) => re.test(String(t.to?.name ?? "")) || re.test(String(t.name ?? "")));
  if (action === "reopen") return transitions.find((t) => cat(t) === "indeterminate") ?? transitions.find((t) => cat(t) === "new");
  const byName = action === "close_dropped" ? named(/^(won'?t do|cancell?ed|rejected)$/i) : named(/^(done|closed|resolved)$/i);
  return byName ?? transitions.find((t) => cat(t) === "done");
}

/**
 * Moves one Jira issue with the fixed comment, posted first and once per row (a retry
 * posts it if an earlier try did not).
 * @param {any} db @param {{id: number, action: string, key: string, commented?: number, tries?: number, fails?: number}} row @param {any} jira
 * @param {typeof fetch | undefined} fetchFn @param {boolean} [dryRun]
 */
async function pushJira(db, row, jira, fetchFn, dryRun) {
  const key = encodeURIComponent(row.key);
  const comment = async () => {
    if (row.commented) return;
    await jiraCall(jira, `/rest/api/3/issue/${key}/comment`, { body: adf(/** @type {any} */ (COMMENT)[row.action]) }, fetchFn);
    db.trackerCommented(row.id);
    row.commented = 1;
  };
  const issue = await jiraCall(jira, `/rest/api/3/issue/${key}?fields=status`, undefined, fetchFn);
  const close = row.action !== "reopen";
  if (close === (issue.fields?.status?.statusCategory?.key === "done")) {
    // Moved by an earlier try whose comment did not go out: it goes now.
    if (!dryRun && (row.tries || row.fails)) await comment();
    return "already";
  }
  const { transitions = [] } = await jiraCall(jira, `/rest/api/3/issue/${key}/transitions`, undefined, fetchFn);
  const pick = pickTransition(transitions, row.action);
  if (!pick) throw Object.assign(new Error(`jira ${row.key}: no transition to a ${close ? "done" : "open"} status`), { transient: false });
  if (dryRun) return "would";
  await comment();
  await jiraCall(jira, `/rest/api/3/issue/${key}/transitions`, { transition: { id: pick.id } }, fetchFn);
  return "done";
}

/**
 * One tracker sync: push the queued status changes, then pull the repos' issues.
 * @param {any} db vscode/db.js handle
 * @param {{repos?: any[], gh?: (args: string[]) => Promise<string>, fetch?: typeof fetch, env?: NodeJS.ProcessEnv,
 *   originOf?: (root: string) => string | undefined, dryRun?: boolean, createTasks?: boolean, maxCreate?: number,
 *   log?: (line: string) => void, now?: () => number}} [o]
 *   repos: whose issues are pulled (pushes go out for every repo)
 */
async function trackerOnce(db, o = {}) {
  const { repos = [], gh = ghExec, fetch: fetchFn, env = process.env, originOf, dryRun = false, createTasks = true, maxCreate = MAX_CREATE, log = () => {}, now = Date.now } = o;
  const result = {
    providers: /** @type {Set<string>} */ (new Set()), pushed: 0, already: 0, stale: 0, waiting: 0, failed: 0, dropped: 0, changes: 0, created: 0,
    errors: /** @type {string[]} */ ([]),
  };
  /** @type {Record<string, number>} */
  const failedBy = {};
  const fail = (/** @type {string} */ provider, /** @type {unknown} */ e) => {
    result.errors.push(e instanceof Error ? e.message : String(e));
    failedBy[provider] = (failedBy[provider] ?? 0) + 1;
  };
  const claimant = crypto.randomUUID();
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
    // Its task is gone, or its key fits no tracker: it can never be pushed.
    if (!row.key || (!GH_KEY.test(row.key) && !JIRA_KEY.test(row.key))) {
      if (!dryRun) db.trackerDone(row.id);
      continue;
    }
    // The task's status changed since (and the change queued its own row, or needs none).
    if (!/** @type {any} */ (WANTS)[row.action]?.(row.task_status)) {
      if (!dryRun) db.trackerDone(row.id);
      result.stale++;
      continue;
    }
    if (row.next_at && row.next_at > now()) {
      result.waiting++;
      continue;
    }
    /** @type {() => Promise<string>} */
    let push;
    let provider;
    const gk = GH_KEY.exec(row.key);
    if (gk) {
      const slug = slugOf({ id: row.repo_id, origin: row.origin, root: row.root });
      // Not a GitHub repo here (yet), or gh missing / logged out: the row waits.
      if (!slug || !(await ghWorks())) {
        result.waiting++;
        continue;
      }
      provider = "github";
      push = () => pushGithub(row, slug, gk[1], gh, dryRun);
    } else {
      if (!jira) {
        result.waiting++;
        continue;
      }
      provider = "jira";
      push = () => pushJira(db, row, jira, fetchFn, dryRun);
    }
    result.providers.add(provider);
    // Another window is pushing it.
    if (!dryRun && !db.trackerClaim(row.id, claimant, now())) continue;
    try {
      const r = await push();
      if (r === "would") log(`tracker ${provider}: would ${row.action.replace("_", " ")} ${row.key}`);
      if (!dryRun) db.trackerDone(row.id);
      if (r === "already") result.already++;
      else result.pushed++;
    } catch (e) {
      result.failed++;
      fail(provider, e);
      if (dryRun) continue;
      if (isTransient(e)) {
        db.trackerBackoff(row.id, now());
        continue;
      }
      const tries = db.trackerFailed(row.id);
      if (tries >= MAX_TRIES) {
        db.trackerDone(row.id);
        result.dropped++;
        log(`tracker ${provider}: gave up on ${row.action} ${row.key} after ${tries} tries: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Pull.
  const create = createTasks ? { left: maxCreate, skipped: 0 } : undefined;
  for (const repo of repos) {
    const slug = slugOf(repo);
    if (slug && (await ghWorks())) {
      result.providers.add("github");
      try {
        const r = await pullGithub(db, repo, slug, { gh, dryRun, log, now: now(), create });
        result.changes += r.changes;
        result.created += r.created;
      } catch (e) {
        fail("github", e);
      }
    }
    const jiraTasks = jira ? db.tasksOf(repo.id, { limit: 100_000 }).filter((/** @type {any} */ t) => JIRA_KEY.test(t.key)) : [];
    if (jiraTasks.length) {
      result.providers.add("jira");
      try {
        const r = await pullJira(db, repo, jiraTasks, { jira, fetch: fetchFn, dryRun, log, now: now() });
        result.changes += r.changes;
      } catch (e) {
        fail("jira", e);
      }
    }
  }
  if (create?.skipped) log(`tracker github: ${create.skipped} more open issue${create.skipped === 1 ? "" : "s"} without a task; at most ${maxCreate} tasks are made per run`);
  if (!dryRun) for (const p of result.providers) if (!failedBy[p]) db.setMeta(`tracker_ok_at:${p}`, now());
  return result;
}

/** One line for the log. @param {Awaited<ReturnType<typeof trackerOnce>>} r */
function describe(r) {
  if (!r.providers.size) return `tracker: no issue tracker for these repos${r.waiting ? ` (${r.waiting} push${r.waiting === 1 ? "" : "es"} waiting)` : ""}`;
  const parts = [`pushed ${r.pushed}`];
  if (r.already) parts.push(`${r.already} already there`);
  parts.push(`pulled ${r.changes} change${r.changes === 1 ? "" : "s"}`, `${r.created} new task${r.created === 1 ? "" : "s"}`);
  if (r.stale) parts.push(`${r.stale} outdated`);
  if (r.waiting) parts.push(`${r.waiting} waiting`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.dropped) parts.push(`${r.dropped} given up`);
  const line = `tracker ${[...r.providers].sort().join("+")}: ${parts.join(", ")}`;
  return r.errors.length ? `${line} (${r.errors[0]}${r.errors.length > 1 ? ` and ${r.errors.length - 1} more` : ""})` : line;
}

/** Whether a provider's sync succeeded lately on this device. @param {any} db @param {string} provider @param {number} [now] */
function trackerActive(db, provider, now = Date.now()) {
  try {
    const at = Number(db?.meta?.(`tracker_ok_at:${provider}`));
    return Number.isFinite(at) && now - at < ACTIVE_MS;
  } catch {
    return false;
  }
}

/**
 * Whether the sweep warning (task done, GitHub issue open) can stay quiet for a repo:
 * GitHub sync ran lately and none of the repo's GitHub pushes is stuck (failed, or
 * waiting over STUCK_MS). @param {any} db @param {number | undefined} repoId @param {number} [now]
 */
function githubSyncCovers(db, repoId, now = Date.now()) {
  if (repoId === undefined || !trackerActive(db, "github", now)) return false;
  try {
    return !db.trackerRowsOf(repoId).some((/** @type {any} */ r) => GH_KEY.test(r.key) && (r.tries > 0 || r.fails > 0 || now - r.at > STUCK_MS));
  } catch {
    return false;
  }
}

module.exports = {
  trackerOnce, describe, trackerActive, githubSyncCovers, githubRepo, readJira, statusFor, pickTransition, isTransient, ghExec,
  MAX_TRIES, MAX_CREATE, ACTIVE_MS, STUCK_MS, COMMENT, JIRA_KEY, GH_KEY,
};
