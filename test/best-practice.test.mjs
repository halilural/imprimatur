// #86 best-practice review: source map, gate, records, task page — no model, no network.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { gate, reconcileBest, summaryLine, review, baseName, checkSource, TASK } = require("../vscode/best-practice.js");
const { bestGroups } = require("../vscode/best-tree.js");
const { openDb } = require("../vscode/db.js");

const rec = (key, extra = {}) => ({
  key, component: "Node.js", title: `Do ${key}`, why: "Because the docs say so.", severity: "medium", evidence: ["package.json:1"],
  source: { url: "https://nodejs.org/api/sqlite.html", title: "node:sqlite", version_or_date: "v22" }, next_step: "Change it.", decision_ids: [], pillar: "deps", ...extra,
});

function repo(files = { "package.json": '{"engines":{"node":">=22"}}\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "best-repo-"));
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(root, f), t);
  return root;
}

test("best: the gate keeps only an https source with evidence in the repo; decision ids must be the repo's", () => {
  const root = repo();
  const { kept, dropped } = gate([
    rec("deps-ok", { decision_ids: [5, 99] }),
    rec("deps-http", { source: { url: "http://x", title: "x", version_or_date: "1" } }),
    rec("deps-none", { evidence: [] }),
    rec("deps-gone", { evidence: ["nope.js:1"] }),
    rec("Bad Key"),
  ], root, new Set([5]));
  assert.deepEqual(kept.map((r) => r.key), ["deps-ok"]);
  assert.deepEqual(kept[0].decision_ids, [5]);
  assert.deepEqual(dropped.map((d) => [d.key, d.why[0]]), [["deps-http", "no public https source"], ["deps-none", "no evidence"], ["deps-gone", "evidence not in the repo: nope.js:1"], ["Bad Key", "bad key"]]);
  // Outside the repo, past the end of the file, a private host, a broken shape: dropped, never thrown.
  const more = gate([
    rec("deps-up", { evidence: ["../../etc/passwd"] }), rec("deps-line", { evidence: ["package.json:999"] }),
    rec("deps-local", { source: { url: "https://localhost/x", title: "x", version_or_date: "1" } }),
    { key: "deps-odd", title: null, evidence: "package.json", source: null },
    rec("deps-big", { why: "x".repeat(5000) }),
  ], root, new Set());
  assert.deepEqual(more.kept.map((r) => r.key), ["deps-big"]);
  assert.equal(more.kept[0].why.length, 2000, "capped");
  assert.deepEqual(more.dropped.map((d) => d.key), ["deps-up", "deps-line", "deps-local", "deps-odd"]);
});

test("best: reconcile adds new keys, refreshes found ones, never touches dismissed ones", () => {
  const records = [
    { id: 1, status: "open", links: { best: { key: "a" } } },
    { id: 2, status: "done", links: { best: { key: "b" } } },
    { id: 3, status: "dropped", links: { best: { key: "c" } } },
  ];
  for (const r of records) r.links.best.pillar = "deps";
  const plan = reconcileBest([rec("a"), rec("b"), rec("c"), rec("d"), rec("d"), rec("d", { pillar: "security" })], records);
  assert.deepEqual(plan.add.map((r) => `${r.pillar}:${r.key}`), ["deps:d", "security:d"], "a key is the pillar's");
  assert.deepEqual(plan.refresh.map((x) => x.id), [1, 2]);
  assert.equal(plan.dismissed, 1);
  assert.equal(summaryLine([
    { status: "open", links: { best: { severity: "high" } } }, { status: "open", links: { best: { severity: "low" } } },
    { status: "done", links: { best: {} } }, { status: "dropped", links: { best: {} } },
  ]), "2 open (1 high, 1 low) · 1 applied · 1 dismissed");
  assert.equal(baseName("Node.js runtime (incl. node:sqlite)"), "Node.js");
});

test("best: a source is checked — catalog MCP, Context7 id, https URL", async () => {
  const fetchFn = async (url) => ({ ok: !String(url).includes("missing"), status: String(url).includes("missing") ? 404 : 200 });
  assert.deepEqual(await checkSource({ kind: "mcp", ref: "cloudflare-docs", covers: [] }, { fetchFn }), { ok: true });
  assert.equal((await checkSource({ kind: "mcp", ref: "made-up", covers: [] }, { fetchFn })).ok, false);
  assert.equal((await checkSource({ kind: "context7", ref: "/nodejs/node", covers: [] }, { fetchFn })).ok, true);
  assert.equal((await checkSource({ kind: "context7", ref: "/missing/x", covers: [] }, { fetchFn })).ok, false);
  assert.equal((await checkSource({ kind: "url", ref: "http://nodejs.org", covers: [] }, { fetchFn })).ok, false);
  assert.equal((await checkSource({ kind: "url", ref: "https://127.0.0.1/x", covers: [] }, { fetchFn })).ok, false);
  assert.equal((await checkSource({ kind: "context7", ref: "/a/../../x", covers: [] }, { fetchFn })).ok, false);
});

test("best: a review builds the map once, writes recommendations, refreshes them later; the page groups them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "best-db-"));
  const db = openDb({ path: path.join(dir, "imprimatur.db") });
  const root = repo();
  const calls = [];
  // The fake model: the map, then one recommendation per pillar.
  const ask = async (prompt, schema, o) => {
    calls.push({ map: "components" in schema.properties, servers: o.servers, fetchDomains: o.fetchDomains, search: o.search });
    if ("components" in schema.properties) {
      return { out: { components: [{ name: "Node.js runtime", version: ">=22", evidence: ["package.json:1"], sources: [
        { kind: "url", ref: "https://nodejs.org/en/about/previous-releases", covers: ["release-notes"] },
        { kind: "mcp", ref: "cloudflare-docs", covers: ["api"] },
        { kind: "url", ref: "https://missing.example/x", covers: ["api"] },
      ] }], missing: [] }, cost: 1, turns: 3 };
    }
    const pillar = /PILLAR: (\w+)/.exec(prompt)[1];
    return { out: { recommendations: [rec(`${pillar}-node-floor`, { pillar: undefined })] }, cost: 0.5, turns: 2 };
  };
  const fetchFn = async (url) => {
    if (String(url).includes("/api/v1/search")) return { ok: true, status: 200, json: async () => ({ results: [{ id: "/nodejs/node", title: "Node.js" }] }) };
    return { ok: !String(url).includes("missing"), status: String(url).includes("missing") ? 404 : 200 };
  };
  try {
    let r = await review(db, root, { pillars: ["deps", "security"], ask, fetchFn, now: 1000 });
    assert.equal(r.added, 2);
    assert.equal(r.cost, 2);
    assert.equal(calls.filter((c) => c.map).length, 1);
    assert.ok(calls.find((c) => !c.map).servers.includes("cloudflare-docs"), "the map's MCP goes to the pillar call");
    assert.deepEqual(calls.find((c) => !c.map).fetchDomains, ["nodejs.org"], "a pillar fetches only the map's hosts");
    assert.equal(calls.find((c) => !c.map).search, undefined, "no web search in a pillar");
    assert.equal(calls.find((c) => c.map).search, true);
    const repoRow = db.repoByRoot(root);
    const task = db.taskByKey(repoRow.id, TASK);
    const all = () => db.recordsOf(task.id, { dropped: true });
    const map = all().find((x) => x.links?.bestSources).links.bestSources;
    assert.deepEqual(map.components[0].sources.map((s) => s.ref), ["https://nodejs.org/en/about/previous-releases", "cloudflare-docs", "/nodejs/node"], "a failed URL goes; Context7 added by the check");
    assert.deepEqual(map.lastRun, { deps: 1000, security: 1000 });
    assert.deepEqual(db.whereWeLeftOff(repoRow.id).map((t) => t.key), [], "BEST is a container");
    // Second run: the map is reused, the same key refreshed, nothing added.
    calls.length = 0;
    const todo = all().find((x) => x.links?.best?.pillar === "security");
    db.updateRecord(todo.id, { status: "dropped", links: { ...todo.links, best: { ...todo.links.best, reason: "decided" } } }, { kind: "user" });
    r = await review(db, root, { pillars: ["deps", "security"], ask, fetchFn, now: 2000 });
    assert.equal(calls.filter((c) => c.map).length, 0);
    assert.deepEqual([r.added, r.refreshed, r.dismissed], [0, 1, 1]);
    assert.equal(task.key, "BEST");
    assert.equal(db.taskByKey(repoRow.id, TASK).summary, "1 open (1 medium) · 1 dismissed");
    // The page: open → pillar → component; dismissed → why.
    const groups = bestGroups(all());
    assert.deepEqual(groups.map((g) => [g.label, g.count]), [["Açık", 1], ["Reddedildi", 1]]);
    assert.equal(groups[0].children[0].label, "Bağımlılıklar ve sürümler");
    assert.equal(groups[1].children[0].label, "Bilerek yapmadık (karar)");
    const { tasksPage, tasksHtml } = require("../vscode/tasksView.js");
    const html = tasksHtml(tasksPage(db, root, { sel: task.id, filter: "active" }, { home: dir }));
    assert.match(html, /Best practice önerileri/);
    assert.match(html, /Kaynak haritası/);
    assert.match(html, /data-act="bestDismiss"/);
    assert.doesNotMatch(html, /class="note[^"]*"[^>]*data-q="Source map/, "the map's note is not listed as a note");
  } finally {
    db.close();
  }
});

test("best: the child gets a minimal environment, secrets denied, the prompt on stdin", async () => {
  const { askClaude, childEnv, DENY } = require("../vscode/best-practice.js");
  const env = childEnv({ PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "x", IMPRIMATUR_JIRA_TOKEN: "y", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "HOME", "IMPRIMATUR_CHILD", "PATH"]);
  let seen;
  const exec = async (cmd, args, opts) => {
    seen = { args, opts };
    return { code: 0, stdout: JSON.stringify({ structured_output: { ok: 1 }, total_cost_usd: 0.3, num_turns: 2 }), stderr: "" };
  };
  const r = await askClaude("PROMPT", { type: "object" }, { cwd: "/r", exec, fetchDomains: ["nodejs.org"] });
  assert.equal(r.cost, 0.3);
  assert.equal(seen.opts.input, "PROMPT");
  assert.ok(!seen.args.includes("PROMPT"), "not an argument");
  assert.ok(seen.args.includes("WebFetch(domain:nodejs.org)") && !seen.args.includes("WebFetch"), "fetch limited to the map's hosts");
  assert.ok(!seen.args.join(" ").includes("WebSearch"));
  assert.ok(DENY.every((d) => seen.args.includes(d)));
  assert.equal(seen.args[seen.args.indexOf("--permission-mode") + 1], "dontAsk");
  // A failure keeps what it cost.
  const bad = async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: "budget", total_cost_usd: 1.5 }), stderr: "" });
  await assert.rejects(askClaude("P", {}, { cwd: "/r", exec: bad }), (e) => e.cost === 1.5);
});
