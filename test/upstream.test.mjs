import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { checkUpstream, readUpstream, DAY } = require("../vscode/upstream.js");
const { scanSetup } = require("../vscode/agent-setup.js");

test("upstream (#140): a skill whose folder changed upstream says so with a compare link; checked once a day; bad names never reach the API", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-"));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  put(".claude/skills/etf/SKILL.md", "---\ndescription: ETF\n---\n");
  put(".claude/skills/etf/SOURCE.txt", "source: https://github.com/acme/Skills (Skills/plugins/etf)\ncommit: 5456da3\n");
  put(".claude/skills/same/SKILL.md", "---\ndescription: Same\n---\n");
  put(".claude/skills/same/SOURCE.txt", "source: https://github.com/acme/other (same)\ncommit: aaaaaaa\n");
  put(".claude/skills/evil/SKILL.md", "x");
  put(".claude/skills/evil/SOURCE.txt", "source: https://github.com/acme/x (../../etc)\ncommit: bbbbbbb\n");
  const file = path.join(home, "upstream.json");
  const calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.startsWith("repos/acme/Skills/commits?")) return [{ sha: "1726f29ffff", commit: { committer: { date: "2026-10-24T00:00:00Z" } } }];
    if (endpoint === "repos/acme/Skills/commits/5456da3") return { sha: "5456da3eeee", commit: { committer: { date: "2026-09-01T00:00:00Z" } } };
    if (endpoint.startsWith("repos/acme/other/commits?")) return [{ sha: "0ld", commit: { committer: { date: "2026-08-01T00:00:00Z" } } }];
    if (endpoint === "repos/acme/other/commits/aaaaaaa") return { sha: "aaaaaaa111", commit: { committer: { date: "2026-09-01T00:00:00Z" } } };
    throw new Error(`unexpected ${endpoint}`);
  };
  const origins = () => scanSetup(home, { global: true, home, managedDir: null }).filter((i) => i.origin).map((i) => i.origin);
  assert.equal(await checkUpstream(origins(), file, { now: 1000, api }), true);
  assert.ok(calls.includes("repos/acme/Skills/commits?per_page=1&path=plugins%2Fetf"), "the repo's own name is dropped from the folder");
  assert.ok(!calls.some((c) => c.includes("etc")), "a path with .. is not sent");
  const rows = Object.fromEntries(scanSetup(home, { global: true, home, managedDir: null, upstream: readUpstream(file) }).filter((i) => i.origin).map((i) => [i.label, i]));
  assert.match(rows.etf.summary, /^upstream changed 2026-10-24 · from github\.com\/acme\/Skills/);
  assert.equal(rows.etf.compare, "https://github.com/acme/Skills/compare/5456da3eeee...1726f29ffff");
  assert.equal(rows.same.compare, undefined, "a newest folder commit older than the installed one is no change");
  assert.ok(rows.same.details.some((d) => d.startsWith("upstream: no change since install")));
  assert.ok(rows.evil.details.some((d) => d.startsWith("upstream: not checked")));
  calls.length = 0;
  assert.equal(await checkUpstream(origins(), file, { now: 1000 + DAY - 1, api }), false);
  assert.equal(calls.length, 0, "checked once a day");
});

test("upstream (#140): a plugin pinned by commit or kept by files in the marketplace is behind when they differ", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-pin-"));
  const put = (rel, v) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), typeof v === "string" ? v : JSON.stringify(v));
  };
  put(".claude/plugins/installed_plugins.json", { plugins: {
    "url@mk": [{ scope: "user", installPath: path.join(home, "c/url"), version: "1.0.0", gitCommitSha: "aaa" }],
    "files@mk": [{ scope: "user", installPath: path.join(home, "c/files/fa4e"), version: "fa4eb54397ee", gitCommitSha: "fa4e" }],
    "same@mk": [{ scope: "user", installPath: path.join(home, "c/same/fa4e"), version: "fa4eb54397ee" }],
  } });
  put(".claude/plugins/known_marketplaces.json", { mk: { source: { source: "github", repo: "acme/mk" }, installLocation: path.join(home, "m") } });
  put("m/.claude-plugin/marketplace.json", { plugins: [
    { name: "url", source: { source: "url", url: "https://github.com/acme/url.git", sha: "bbbbbbbbbbbbbbbb" } },
    { name: "files", source: "./files" }, { name: "same", source: "./same" },
  ] });
  put("m/files/.mcp.json", '{"new":1}');
  put("c/files/fa4e/.mcp.json", '{"old":1}');
  put("m/same/.mcp.json", "{}");
  put("c/same/fa4e/.mcp.json", "{}");
  put("c/same/fa4e/.in_use/123", "");
  const rows = Object.fromEntries(scanSetup(home, { global: true, home, managedDir: null }).filter((i) => i.kind === "installed plugin").map((i) => [i.label, i.summary]));
  assert.match(rows["url@mk"], /update available: commit bbbbbbbbbbbb$/);
  assert.match(rows["files@mk"], /update available: newer files in the marketplace$/);
  assert.doesNotMatch(rows["same@mk"], /update/, "Claude Code's .in_use marker is not a difference");
});

test("upstream (#156): a skill's folder is downloaded with GETs only; paths cannot leave the folder; size is capped", async () => {
  const { fetchSkillFolder } = require("../vscode/upstream.js");
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "skill-dl-"));
  const asked = [];
  const api = async (e) => (asked.push(e), { tree: [
    { type: "blob", path: "skills/etf/SKILL.md" }, { type: "blob", path: "skills/etf/ref/a.md" },
    { type: "blob", path: "skills/other/SKILL.md" }, { type: "tree", path: "skills/etf/ref" }, { type: "blob", path: "skills/etf/../../evil" },
  ] });
  const raw = async (e) => (asked.push(e), `text of ${e}`);
  const got = await fetchSkillFolder({ repo: "acme/s", path: "skills/etf" }, "11afdb9", dest, { api, raw });
  assert.deepEqual(got, ["SKILL.md", "ref/a.md"]);
  assert.equal(asked[0], "repos/acme/s/git/trees/11afdb9?recursive=1");
  assert.match(fs.readFileSync(path.join(dest, "ref/a.md"), "utf8"), /contents\/skills\/etf\/ref\/a\.md\?ref=11afdb9/);
  assert.ok(!fs.existsSync(path.join(dest, "..", "evil")));
  await assert.rejects(fetchSkillFolder({ repo: "acme/s", path: "../x" }, "11afdb9", dest, { api, raw }), /not a plain/);
  await assert.rejects(fetchSkillFolder({ repo: "acme/s", path: "skills/etf" }, "11afdb9", dest, { api, raw: async () => "x".repeat(3 << 20) }), /larger/);
});

test("upstream (#156): a SAFE verdict copies the reviewed files and records the commit; STOP or no verdict copies nothing", () => {
  const { applySkillUpdate, verdictOf } = require("../vscode/upstream.js");
  assert.deepEqual(verdictOf("Three lines.\nVERDICT: SAFE"), { safe: true, reason: "" });
  assert.equal(verdictOf("x\n**VERDICT:** STOP line 12 asks to read ~/.ssh").reason, "line 12 asks to read ~/.ssh");
  assert.equal(verdictOf("VERDICT: SAFE\nlater\nVERDICT: STOP changed my mind").safe, false, "the last verdict counts");
  assert.equal(verdictOf("all good").safe, false, "no verdict is not safe");
  const { summaryOf } = require("../vscode/upstream.js");
  assert.equal(summaryOf("**Where we are**\nSUMMARY: three additions, no scripts\nVERDICT: SAFE"), "three additions, no scripts");
  assert.equal(summaryOf("no summary"), "");
  const from = fs.mkdtempSync(path.join(os.tmpdir(), "apply-from-"));
  const to = fs.mkdtempSync(path.join(os.tmpdir(), "apply-to-"));
  fs.mkdirSync(path.join(from, "ref"));
  fs.writeFileSync(path.join(from, "SKILL.md"), "new");
  fs.writeFileSync(path.join(from, "ref/a.md"), "ref");
  fs.writeFileSync(path.join(to, "SKILL.md"), "old");
  fs.writeFileSync(path.join(to, "SOURCE.txt"), "source: https://github.com/a/b (x)\ncommit: 5456da3\nlicense: MIT\n");
  applySkillUpdate(from, to, ["SKILL.md", "ref/a.md", "../escape.md"], "1726f29abc", "three additions, no scripts", "2026-11-05");
  assert.equal(fs.readFileSync(path.join(to, "SKILL.md"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(to, "ref/a.md"), "utf8"), "ref");
  assert.ok(!fs.existsSync(path.join(to, "..", "escape.md")));
  const src = fs.readFileSync(path.join(to, "SOURCE.txt"), "utf8");
  assert.match(src, /^commit: 1726f29$/m);
  assert.match(src, /^license: MIT$/m);
  assert.match(src, /updated: 2026-11-05 to 1726f29, reviewed by Claude through Imprimatur's Fix it: three additions, no scripts\n$/);
});
