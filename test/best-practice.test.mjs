// #86/#87 project best-practice review and the Recommendations container — no model, no network.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const best = require("../vscode/best-practice.js");
const recs = require("../vscode/recs.js");
const { bestGroups } = require("../vscode/best-tree.js");
const { openDb } = require("../vscode/db.js");

const URL1 = "https://nodejs.org/api/sqlite.html";
const rec = (key, extra = {}) => ({
  key, category: "compatibility", subcategory: "co-existence", component: "Node.js", title: `Do ${key}`, why: "Because the docs say so.", severity: "medium",
  evidence: ["package.json:1"], source: { url: URL1, title: "node:sqlite", version_or_date: "v22" }, next_step: "Change it.", decision_ids: [], ...extra,
});
function repo(files = { "package.json": '{"engines":{"node":">=22"}}\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "best-repo-"));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  }
  return root;
}
const db0 = () => openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "best-db-")), "imprimatur.db") });

test("best: the taxonomy is ISO/IEC 25010:2023 + NIST SSDF; six core categories", () => {
  assert.deepEqual(best.CORE, ["security", "reliability", "maintainability", "compatibility", "performance-efficiency", "ssdf"]);
  assert.equal(Object.keys(best.CATEGORIES).length, 10);
  assert.ok(best.CATEGORIES.maintainability.subs.some(([n]) => n === "testability"));
  assert.deepEqual(best.recSchema("compatibility").properties.recommendations.items.properties.subcategory.enum, ["co-existence", "interoperability"]);
});

test("best: the gate — a subcategory of the category, a fetched public https source, evidence inside the repo", () => {
  const root = repo();
  const fetched = new Set([best.normUrl(URL1)]);
  const { kept, dropped } = best.gate([
    rec("ok", { decision_ids: [5, 99] }),
    rec("bad-sub", { subcategory: "testability" }),
    rec("unfetched", { source: { url: "https://nodejs.org/other", title: "x", version_or_date: "1" } }),
    rec("local", { source: { url: "https://localhost/x", title: "x", version_or_date: "1" } }),
    rec("up", { evidence: ["../../etc/passwd"] }), rec("line", { evidence: ["package.json:99"] }),
    { key: "odd", category: "compatibility", title: null, evidence: "package.json", source: null },
    rec("big", { why: "x".repeat(5000) }),
  ], root, new Set([5]), fetched);
  assert.deepEqual(kept.map((r) => r.key), ["ok", "big"]);
  assert.deepEqual(kept[0].decision_ids, [5]);
  assert.equal(kept[1].why.length, 2000);
  assert.deepEqual(dropped.map((d) => [d.key, d.why[0]]), [
    ["bad-sub", "not a subcategory of the category"], ["unfetched", "source not among the pages fetched"], ["local", "no public https source"],
    ["up", "evidence not in the repo: ../../etc/passwd"], ["line", "evidence not in the repo: package.json:99"], ["odd", "not a subcategory of the category"],
  ]);
});

test("best: the same fix from two categories is one, the more severe, the other a tag; keys are per category", () => {
  const merged = best.dedupe([rec("a", { severity: "low" }), rec("b", { category: "flexibility", subcategory: "installability", severity: "high" }), rec("c", { evidence: ["x.js:1"] })]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].category, "flexibility");
  assert.deepEqual(merged[0].tags, ["compatibility"]);
  const plan = best.reconcileBest([rec("k"), rec("k", { category: "security", subcategory: "integrity" }), rec("k")], [
    { id: 1, status: "dropped", links: { best: { key: "k", category: "compatibility" } } },
  ]);
  assert.deepEqual(plan.add.map((r) => r.category), ["security"]);
  assert.equal(plan.dismissed, 1);
});

test("best: Context7 ids by a strict title match; links from an MCP answer, relative ones resolved; public https only", async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ results: [
    { id: "/typefox/vscode-messenger", title: "VS Code Messenger", trustScore: 9 },
    { id: "/websites/code_visualstudio_api", title: "Visual Studio Code Extension API", trustScore: 9 },
  ] }) });
  assert.equal(await best.context7For("Visual Studio Code Extension API", { fetchFn }), "/websites/code_visualstudio_api");
  assert.equal(await best.context7For("VS Code", { fetchFn }), undefined, "no loose match");
  assert.deepEqual(best.linksIn('see [pending I/O](/changelog/post/x/) and https://developers.cloudflare.com/d1/ and https://127.0.0.1/a', "https://developers.cloudflare.com"),
    ["https://developers.cloudflare.com/d1/", "https://developers.cloudflare.com/changelog/post/x/"]);
});

test("best: the child — repo tools only, no web, secrets denied, model and effort, the shared part as a system file, the prompt on stdin", async () => {
  let seen;
  const exec = async (cmd, args, opts) => {
    seen = { args, opts };
    return { code: 0, stdout: JSON.stringify({ structured_output: { ok: 1 }, total_cost_usd: 0.3, num_turns: 2 }), stderr: "" };
  };
  const r = await best.askClaude("PROMPT", { type: "object" }, { cwd: "/r", exec, model: "haiku", effort: "low", maxTurns: 5, system: "/tmp/ctx.txt" });
  assert.equal(r.cost, 0.3);
  const a = seen.args.join(" ");
  assert.equal(seen.opts.input, "PROMPT");
  assert.ok(!seen.args.includes("PROMPT"));
  assert.ok(!/WebFetch|WebSearch/.test(a), "no web");
  assert.match(a, /--model haiku --effort low --max-turns 5/);
  assert.match(a, /--append-system-prompt-file \/tmp\/ctx\.txt/);
  assert.ok(best.DENY.every((d) => seen.args.includes(d)));
  assert.equal(seen.args[seen.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.deepEqual(Object.keys(best.childEnv({ PATH: "/b", HOME: "/h", GITHUB_TOKEN: "x" })).sort(), ["HOME", "IMPRIMATUR_CHILD", "PATH"]);
  const bad = async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: "max turns", total_cost_usd: 1.5 }), stderr: "" });
  await assert.rejects(best.askClaude("P", {}, { cwd: "/r", exec: bad }), (e) => e.cost === 1.5);
  assert.equal(await best.authKind({ exec: async () => ({ code: 0, stdout: '{"authMethod":"claude.ai","apiProvider":"firstParty"}', stderr: "" }) }), "subscription");
});

test("recs: the old AUDIT and BEST records move into RECS once; moves are versioned and synced", () => {
  const db = db0();
  try {
    const root = repo();
    const r = db.repoOf(root);
    const a = db.upsertTask(r.id, "AUDIT", { title: "old audit", status: "active" });
    const b = db.upsertTask(r.id, "BEST", { title: "old best", status: "active" });
    const x = db.addRecord(a.id, { kind: "fixme", title: "f", links: { audit: { fp: "1", level: "warning", group: "project", effect: "active" } } }, { kind: "hook" });
    db.addRecord(b.id, { kind: "todo", title: "t", links: { best: { key: "k", category: "security", severity: "high" } } }, { kind: "hook" });
    const t = recs.recsTask(db, r.id);
    assert.equal(t.key, "RECS");
    assert.equal(db.recordsOf(t.id, { dropped: true }).length, 2);
    assert.equal(db.taskByKey(r.id, "AUDIT").status, "dropped");
    assert.equal(db.versionsOf(x.id).at(-1).after.includes?.("RECS") ?? JSON.stringify(db.versionsOf(x.id).at(-1)).includes("RECS"), true);
    assert.equal(recs.summaryLine(db.recordsOf(t.id, { dropped: true })), "Agent setup: 1 open (1 warning) | Project: 1 open (1 high)");
    assert.equal(recs.recsTask(db, r.id).id, t.id, "once");
    assert.equal(recs.recsTask(db, db.repoOf(repo()).id), undefined, "not created unless asked");
  } finally {
    db.close();
  }
});

test("best: a review — map once (haiku), docs fetched by code, one call per category, gate, records in RECS; the page shows both producers", async () => {
  const db = db0();
  const root = repo({ "package.json": '{"engines":{"node":">=22"}}\n', "cloud/wrangler.jsonc": '{\n "compatibility_date": "2026-07-15"\n}\n' });
  const calls = [];
  const ask = async (prompt, schema, o) => {
    calls.push({ model: o.model, effort: o.effort, system: o.system, map: "components" in schema.properties });
    if ("components" in schema.properties) return { out: { components: [
      { name: "Node.js", docs_name: "Node.js", version: ">=22", evidence: ["package.json:1"], vendor: "other", changelog_url: "https://nodejs.org/en/blog/" },
      { name: "Cloudflare Workers", docs_name: "Cloudflare Workers", version: "2026-07-15", evidence: ["cloud/wrangler.jsonc:2"], vendor: "cloudflare", changelog_url: "" },
    ] }, cost: 0.1 };
    const cat = /CATEGORY: [^—]+— ([^.]+)\./.exec(prompt)[1];
    if (cat === "Compatibility") return { out: { recommendations: [
      rec("node-floor", { category: undefined }),
      rec("worker-date", { component: "Cloudflare Workers", subcategory: "interoperability", evidence: ["cloud/wrangler.jsonc:2"], source: { url: "https://developers.cloudflare.com/changelog/post/x/", title: "x", version_or_date: "2026-10-01" } }),
      rec("made-up", { source: { url: "https://example.org/not-fetched", title: "x", version_or_date: "1" }, evidence: ["cloud/wrangler.jsonc:1"] }),
    ] }, cost: 0.3 };
    return { out: { recommendations: [] }, cost: 0.2 };
  };
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u.includes("/libs/search")) return { ok: true, json: async () => ({ results: [{ id: "/nodejs/node", title: "Node.js", trustScore: 9 }] }) };
    if (u.includes("/v2/context")) return { ok: true, text: async () => `### sqlite\nSource: ${URL1}\nnode:sqlite needs 22.13` };
    if (u.includes("docs.mcp.cloudflare.com")) {
      const body = JSON.parse(init.body);
      const result = body.method === "tools/list" ? { tools: [{ name: "search_cloudflare_documentation", inputSchema: { properties: { query: {} } } }] }
        : body.method === "tools/call" ? { content: [{ type: "text", text: "Pending I/O … [changelog](/changelog/post/x/)" }] } : {};
      return { ok: true, headers: { get: () => "sid" }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) };
    }
    if (u.includes("nodejs.org/en/blog")) return { ok: true, text: async () => "<html><body>Node 22.13 released</body></html>" };
    return { ok: false, status: 404, text: async () => "" };
  };
  try {
    // An agent setup finding already there: the page shows both.
    const r0 = db.repoOf(root);
    const t0 = recs.recsTask(db, r0.id, { create: true });
    db.addRecord(t0.id, { kind: "fixme", title: "CC-HK-010: no timeout", links: { audit: { fp: "a", rule: "CC-HK-010", level: "warning", category: "claude-hooks", group: "project", effect: "active", file: path.join(root, "package.json"), line: 1 } } }, { kind: "hook" });
    const lookup = async () => [{ address: "93.184.216.34" }];
    let r = await best.review(db, root, { categories: ["compatibility", "security"], ask, fetchFn, now: 1000, stagger: 0, lookup });
    assert.deepEqual(calls.map((c) => [c.model, c.map]), [["haiku", true], ["sonnet", false], ["sonnet", false]]);
    assert.ok(calls.slice(1).every((c) => c.effort === "medium" && c.system), "the shared part goes as a system file");
    assert.equal(r.added, 2);
    assert.deepEqual(r.dropped.map((d) => d.key), ["made-up"]);
    const t = db.taskByKey(r0.id, "RECS");
    const all = () => db.recordsOf(t.id, { dropped: true });
    const map = best.sourceMapRecord(db, t.id).links.bestSources;
    assert.equal(map.components[0].context7, "/nodejs/node");
    assert.deepEqual(map.lastRun, { compatibility: 1000, security: 1000 });
    const worker = all().find((x) => x.links?.best?.key === "worker-date");
    assert.deepEqual([worker.links.best.category, worker.links.best.subcategory, worker.links.best.std], ["compatibility", "interoperability", "ISO 25010"]);
    assert.match(t.summary ?? db.taskByKey(r0.id, "RECS").summary, /Agent setup: 1 open \(1 warning\) \| Project: 2 open \(2 medium\)/);
    // Second run: the map is reused; the same keys refreshed.
    calls.length = 0;
    r = await best.review(db, root, { categories: ["compatibility"], ask, fetchFn, now: 2000, stagger: 0, lookup });
    assert.equal(calls.filter((c) => c.map).length, 0);
    assert.deepEqual([r.added, r.refreshed], [0, 2]);
    // The groups and the page.
    const groups = bestGroups(all());
    assert.equal(groups[0].label, "Open");
    assert.equal(groups[0].children[0].label, "Compatibility · ISO 25010");
    assert.deepEqual(groups[0].children[0].children.map((g) => g.label), ["co-existence", "interoperability"]);
    const { tasksPage, tasksHtml } = require("../vscode/tasksView.js");
    const html = tasksHtml(tasksPage(db, root, { sel: t.id, filter: "active" }, { home: fs.mkdtempSync(path.join(os.tmpdir(), "h-")) }));
    assert.match(html, /Agent setup/);
    assert.match(html, /Project <span class="dim">· ISO\/IEC 25010 \+ NIST SSDF/);
    assert.match(html, /data-act="recDismiss"/);
    assert.match(html, /Source map/);
    const { recommendationsRow } = require("../vscode/setup-audit-tree.js");
    const row = recommendationsRow([{ label: "repo", root, records: all() }]);
    assert.equal(row.label, "Recommendations (3)");
    assert.deepEqual(row.children[0].children.map((c) => c.label), ["Agent setup", "Project"]);
  } finally {
    db.close();
  }
});

test("best: a model-proposed page is fetched only on a public host; redirects by hand, same host only", async () => {
  assert.equal(best.privateIp("10.0.0.5"), true);
  assert.equal(best.privateIp("169.254.169.254"), true);
  assert.equal(best.privateIp("::1"), true);
  assert.equal(best.privateIp("93.184.216.34"), false);
  const pub = async () => [{ address: "93.184.216.34" }];
  const priv = async () => [{ address: "127.0.0.1" }];
  const seen = [];
  const fetchFn = async (u, init) => {
    seen.push([u, init.redirect]);
    if (u.endsWith("/a")) return { status: 302, ok: false, headers: { get: () => "/b" } };
    if (u.endsWith("/x")) return { status: 302, ok: false, headers: { get: () => "https://evil.example/" } };
    return { status: 200, ok: true, text: async () => "page" };
  };
  assert.equal(await best.fetchPublic("https://docs.example.com/a", { fetchFn, lookup: pub }), "page");
  assert.deepEqual(seen.map((s) => s[1]), ["manual", "manual"]);
  assert.equal(await best.fetchPublic("https://docs.example.com/x", { fetchFn, lookup: pub }), "", "another host");
  assert.equal(await best.fetchPublic("https://docs.example.com/", { fetchFn, lookup: priv }), "", "resolves private");
});

test("recs: a read writes nothing; a finding written again under the old task moves in as a dropped duplicate, last in order", () => {
  const db = db0();
  try {
    const r = db.repoOf(repo());
    const t = recs.recsTask(db, r.id, { create: true });
    const rec1 = db.addRecord(t.id, { kind: "fixme", title: "f", links: { audit: { fp: "same", level: "warning", group: "project", effect: "active" } } }, { kind: "hook" });
    const stamp = db.changeStamp();
    assert.equal(recs.recsTask(db, r.id).id, t.id);
    assert.equal(db.changeStamp(), stamp, "nothing to move: no write");
    // An older release audited again into AUDIT.
    const a = db.upsertTask(r.id, "AUDIT", { status: "active" });
    const again = db.addRecord(a.id, { kind: "fixme", title: "f", links: { audit: { fp: "same", level: "warning", group: "project", effect: "active" } } }, { kind: "hook" });
    recs.recsTask(db, r.id);
    const moved = db.record(again.id);
    assert.equal(moved.task_id, t.id);
    assert.equal(moved.status, "dropped");
    assert.equal(moved.links.audit.duplicate, true);
    assert.ok(moved.position > db.record(rec1.id).position, "last in the task");
    assert.equal(recs.summaryLine(db.recordsOf(t.id, { dropped: true })), "Agent setup: 1 open (1 warning)", "the duplicate is not counted");
    const { reconcile } = require("../vscode/setup-audit.js");
    assert.ok(reconcile, "audit reconcile exists");
  } finally {
    db.close();
  }
});

test("best: evidence through a link that leaves the repo is not evidence; the tree opens files inside the repo only", () => {
  const root = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "x\n");
  fs.symlinkSync(outside, path.join(root, "link"));
  const { kept, dropped } = best.gate([rec("via-link", { evidence: ["link/secret.txt:1"] })], root, new Set(), new Set([best.normUrl(URL1)]));
  assert.equal(kept.length, 0);
  assert.match(dropped[0].why[0], /evidence not in the repo/);
  const { bestRow } = require("../vscode/setup-audit-tree.js");
  const row = bestRow({ id: 1, status: "open", title: "t", links: { best: { evidence: ["../../etc/passwd:1"], severity: "low" } } }, root);
  assert.equal(row.abs, undefined);
});

test("best: a category out of turns is asked once more without tools, so it is not lost", async () => {
  const db = db0();
  const root = repo();
  const calls = [];
  const ask = async (prompt, schema, o) => {
    calls.push({ tools: o.tools, maxTurns: o.maxTurns, map: "components" in schema.properties });
    if ("components" in schema.properties) return { out: { components: [{ name: "Node.js", docs_name: "Node.js", version: ">=22", evidence: ["package.json:1"], vendor: "other", changelog_url: "" }] }, cost: 0.1 };
    if (o.tools === undefined) throw Object.assign(new Error("claude: error_max_turns"), { cost: 0.5, subtype: "error_max_turns" });
    return { out: { recommendations: [rec("node-floor")] }, cost: 0.1 };
  };
  const fetchFn = async (u) => (String(u).includes("/libs/search") ? { ok: true, json: async () => ({ results: [{ id: "/nodejs/node", title: "Node.js", trustScore: 9 }] }) }
    : { ok: true, text: async () => `Source: ${URL1}\nx` });
  try {
    const r = await best.review(db, root, { categories: ["compatibility"], ask, fetchFn, stagger: 0, lookup: async () => [{ address: "93.184.216.34" }] });
    assert.deepEqual(calls.filter((c) => !c.map).map((c) => [c.maxTurns, c.tools?.length ?? "repo"]), [[20, "repo"], [2, 0]]);
    assert.equal(r.added, 1);
    assert.equal(r.categories[0].retried, true);
    assert.equal(r.categories[0].cost, 0.6);
  } finally {
    db.close();
  }
});
