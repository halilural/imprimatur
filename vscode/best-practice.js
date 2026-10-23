// @ts-check
// Project best-practice review (#86, #87): recommendations for how the repo is built,
// by ISO/IEC 25010:2023 quality characteristics and NIST SSDF (SP 800-218), each
// grounded in official documentation fetched in the run and in evidence from the
// repo. Records of the repo's Recommendations task (RECS, recs.js), next to the agent
// setup audit's.
//
// A pipeline, not an agent loop (spike/best-fast: ~600 s → ~120 s):
// 1. Source map (reused until asked again): Haiku lists the stack from the repo only;
//    code finds each component's Context7 id (REST search, strict title match) and
//    checks its changelog URL.
// 2. Fetch (code, in parallel): per component × category, Context7 /v2/context, the
//    vendor's public docs MCP (JSON-RPC over HTTP), changelog pages.
// 3. Judge: one Sonnet call per category, effort medium, only Read/Grep on the repo,
//    no web; the shared bundle (decisions, architecture, stack, key files numbered) in
//    the system prompt so the calls after the first read it from the prompt cache.
// 4. Gate (code): shapes, an https source among the URLs fetched, evidence inside the
//    repo, a subcategory of the category; the same fix across categories kept once.
// 5. Records: key per category; new → open todo, found → refreshed, not found → left
//    (the user says applied), dismissed → never touched.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const recs = require("./recs.js");

const TASK = recs.TASK;
/** @type {import("./db.js").Actor} */
const ACTOR = { kind: "hook", id: "best-practice" };
const MODEL = "sonnet";
const MAP_MODEL = "haiku";

/**
 * The taxonomy: ISO/IEC 25010:2023 product quality (2023: usability → interaction
 * capability, portability → flexibility, safety added) and NIST SSDF for the process.
 * core: reviewed by default; the rest when asked. subs: [name, one-line meaning].
 */
const CATEGORIES = {
  security: { std: "ISO 25010", name: "Security", core: true, query: "security best practices, authentication, secrets, input validation, permissions", subs: [
    ["confidentiality", "data reachable only by those allowed"], ["integrity", "data and code cannot be changed without permission"], ["non-repudiation", "actions can be proven"],
    ["accountability", "actions can be traced to who did them"], ["authenticity", "identities are what they claim"], ["resistance", "withstands attacks"]] },
  reliability: { std: "ISO 25010", name: "Reliability", core: true, query: "error handling, retries, data integrity, transactions, recovery, backups", subs: [
    ["faultlessness", "works without faults in normal use"], ["availability", "there when needed"], ["fault tolerance", "keeps working despite faults"], ["recoverability", "recovers data and state after a failure"]] },
  maintainability: { std: "ISO 25010", name: "Maintainability", core: true, query: "testing best practices, code organization, logging and diagnostics, configuration", subs: [
    ["modularity", "parts change without affecting others"], ["reusability", "parts usable elsewhere"], ["analysability", "faults and impact of changes can be diagnosed"],
    ["modifiability", "changes without defects"], ["testability", "tests can be set up and run"]] },
  compatibility: { std: "ISO 25010", name: "Compatibility", core: true, query: "supported versions, deprecations, breaking changes, protocol versions, upgrade guide", subs: [
    ["co-existence", "works alongside other software and versions"], ["interoperability", "exchanges information with other systems correctly"]] },
  "performance-efficiency": { std: "ISO 25010", name: "Performance efficiency", core: true, query: "performance best practices, caching, latency, memory, limits", subs: [
    ["time behaviour", "response and processing times"], ["resource utilization", "CPU, memory, I/O used"], ["capacity", "limits it can handle"]] },
  ssdf: { std: "NIST SSDF", name: "Development process (SSDF)", core: true, query: "CI, release, signing, dependency pinning and updates, supply chain, vulnerability disclosure", subs: [
    ["PO prepare the organization", "roles, requirements, toolchains"], ["PS protect the software", "code, build and release integrity; dependencies verified"],
    ["PW produce well-secured software", "secure design, coding, review, testing, CI"], ["RV respond to vulnerabilities", "finding, triaging and fixing vulnerabilities"]] },
  flexibility: { std: "ISO 25010", name: "Flexibility", core: false, query: "installation, packaging, cross-platform, scaling, configuration across environments", subs: [
    ["adaptability", "works in other environments"], ["scalability", "handles growth"], ["installability", "installs and uninstalls cleanly"], ["replaceability", "can replace or be replaced"]] },
  "interaction-capability": { std: "ISO 25010", name: "Interaction capability", core: false, query: "user experience guidelines, accessibility, UX best practices", subs: [
    ["appropriateness recognizability", "users see if it fits"], ["learnability", "easy to learn"], ["operability", "easy to operate"], ["user error protection", "prevents user mistakes"],
    ["user engagement", "pleasant to use"], ["inclusivity", "usable by people with different needs"], ["user assistance", "helps users"], ["self-descriptiveness", "explains itself"]] },
  "functional-suitability": { std: "ISO 25010", name: "Functional suitability", core: false, query: "correct behavior, edge cases, API contract", subs: [
    ["functional completeness", "covers what is needed"], ["functional correctness", "gives correct results"], ["functional appropriateness", "helps reach the goal"]] },
  safety: { std: "ISO 25010", name: "Safety", core: false, query: "safe defaults, fail safe, hazard", subs: [
    ["operational constraint", "stays within safe limits"], ["risk identification", "identifies risks"], ["fail safe", "fails into a safe state"], ["hazard warning", "warns of hazards"], ["safe integration", "stays safe when integrated"]] },
};
const CORE = Object.keys(CATEGORIES).filter((k) => CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (k)].core);

/** Public docs MCP servers (no sign-in), by vendor; called from code, not by the model. */
const VENDOR_MCP = {
  cloudflare: { url: "https://docs.mcp.cloudflare.com/mcp", base: "https://developers.cloudflare.com" },
  microsoft: { url: "https://learn.microsoft.com/api/mcp", base: "https://learn.microsoft.com" },
  aws: { url: "https://knowledge-mcp.global.api.aws", base: "https://docs.aws.amazon.com" },
};

/**
 * @typedef {{name: string, docs_name: string, version: string, evidence: string[], vendor: string, changelog_url: string, context7?: string}} Component
 * @typedef {{components: Component[], at: number, lastRun?: Record<string, number>}} SourceMap
 * @typedef {{component: string, cat: string, kind: "context7" | "mcp" | "url", ref: string, urls: string[], text: string}} Excerpt
 * @typedef {{key: string, component: string, title: string, why: string, severity: "high" | "medium" | "low", evidence: string[], subcategory: string,
 *   source: {url: string, title: string, version_or_date: string}, next_step: string, decision_ids: number[], category: string, tags?: string[]}} Recommendation
 */

// Child processes ------------------------------------------------------------------------

/**
 * A child process's result, never rejected; `input` goes to its stdin (a long prompt
 * as one argument hits the OS's argument limit).
 * @param {string} cmd @param {string[]} args @param {any} [opts] @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(cmd, args, opts = {}) {
  const { input, ...rest } = opts;
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", ...rest }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** The child's environment: what claude needs to run and sign in, none of the host's tokens. */
function childEnv(env = process.env) {
  const keep = /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|USER|USERNAME|LOGNAME|LANG|LC_ALL|TMPDIR|TEMP|TMP|SHELL|SYSTEMROOT|COMSPEC|XDG_CONFIG_HOME|XDG_DATA_HOME|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CONFIG_DIR|AWS_REGION|AWS_PROFILE|CLOUD_ML_REGION|ANTHROPIC_VERTEX_PROJECT_ID)$/;
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => keep.test(k))), IMPRIMATUR_CHILD: "1" };
}

/** Secrets the model may never read, whatever a file tells it. */
const DENY = ["Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)", "Read(**/id_ed25519*)", "Read(~/.ssh/**)", "Read(~/.aws/**)",
  "Read(~/.config/gh/**)", "Read(**/.npmrc)", "Read(**/.dev.vars*)", "Grep(**/.env*)"];
const REPO_TOOLS = ["Read", "Glob", "Grep"];

/**
 * One `claude -p` with a JSON schema; only the repo tools (no web, no MCP), secrets
 * denied, dontAsk, no settings files (no hooks), a minimal env, the prompt on stdin.
 * @param {string} prompt @param {any} schema
 * `tools: []`: no tool at all (an answer from the prompt alone).
 * @param {{cwd: string, model?: string, effort?: string, maxTurns?: number, system?: string, budget?: number, exec?: typeof run, timeoutMs?: number, tools?: string[]}} o
 * @returns {Promise<{out: any, cost: number, turns: number}>}
 */
async function askClaude(prompt, schema, { cwd, model = MODEL, effort = "medium", maxTurns = 20, system, budget = 1.5, exec = run, timeoutMs = 10 * 60_000, tools = REPO_TOOLS }) {
  const args = ["-p", "--model", model, "--effort", effort, "--max-turns", String(maxTurns), "--output-format", "json", "--json-schema", JSON.stringify(schema),
    "--tools", tools.join(","), ...(tools.length ? ["--allowedTools", ...tools] : []), "--disallowedTools", ...DENY, "--permission-mode", "dontAsk",
    "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands",
    "--max-budget-usd", String(budget), ...(system ? ["--append-system-prompt-file", system] : [])];
  const r = await exec("claude", args, { cwd, timeout: timeoutMs, env: childEnv(), input: prompt });
  let res;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new Error(`claude: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300)}`), { cost: 0 });
  }
  const cost = Number(res.total_cost_usd ?? 0);
  if (res.is_error && !res.structured_output) throw Object.assign(new Error(`claude: ${String(res.result ?? res.subtype ?? "error").slice(0, 300)}`), { cost, subtype: res.subtype });
  let out = res.structured_output;
  if (out === undefined) {
    try {
      out = JSON.parse(String(res.result ?? ""));
    } catch {
      throw Object.assign(new Error("claude: the answer was not the expected JSON"), { cost });
    }
  }
  return { out, cost, turns: Number(res.num_turns ?? 0) };
}

/**
 * How claude is signed in, for what a run costs: "subscription" (claude.ai: counts
 * against the plan's limits), "api-key" (billed), "cloud" (Bedrock/Vertex), or "unknown".
 * @param {{exec?: typeof run}} [o] @returns {Promise<"subscription" | "api-key" | "cloud" | "unknown">}
 */
async function authKind({ exec = run } = {}) {
  const r = await exec("claude", ["auth", "status"], { timeout: 15_000, env: childEnv() });
  try {
    const s = JSON.parse(r.stdout);
    if (s.apiProvider && s.apiProvider !== "firstParty") return "cloud";
    if (s.authMethod === "claude.ai") return "subscription";
    if (/api.?key/i.test(String(s.authMethod))) return "api-key";
  } catch {}
  return "unknown";
}

// Project context ------------------------------------------------------------------------

/** Decisions and the architecture document's sections (cut), from Imprimatur's database. @param {any} db @param {number} repoId */
function projectContext(db, repoId) {
  const decisions = db.recordsByKind(repoId, ["adr", "pdr", "decision"], { limit: 500 })
    .filter((/** @type {any} */ r) => r.status !== "dropped")
    .map((/** @type {any} */ r) => ({ id: r.id, line: `[${r.id}] ${r.kind}: ${r.title}` }));
  const doc = db.docOf(repoId, "architecture");
  const sections = doc ? db.docSections(doc.id).filter((/** @type {any} */ s) => s.status === "current").map((/** @type {any} */ s) => `## ${s.title} (key ${s.key})\n${(s.body ?? "").slice(0, 600)}`) : [];
  return { decisions, sections };
}

/** Manifests, build and CI files of any ecosystem, shown to the model numbered (cites path:line). */
const KEY_FILE = /(^|\/)(package\.json|pnpm-workspace\.yaml|tsconfig\.json|[^/]*\.toml|[^/]*\.jsonc|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|go\.mod|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|Gemfile|[^/]*\.csproj|Dockerfile|docker-compose[^/]*\.ya?ml|hooks\.json|plugin\.json)$|^\.github\/workflows\/[^/]+\.ya?ml$/;

/** The repo's files (git ls-files) and its key files, numbered and capped. @param {string} root */
function repoBundle(root) {
  let files = [];
  try {
    files = require("node:child_process").execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n").filter(Boolean);
  } catch {}
  const key = files.filter((f) => KEY_FILE.test(f) && !/(^|\/)(node_modules|vendor|dist|build|\.claude\/worktrees)\//.test(f) && f.split("/").length <= 3).slice(0, 25);
  let budget = 60_000;
  const shown = [];
  for (const f of key) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(root, f), "utf8").split("\n").slice(0, 150).map((l, i) => `${i + 1}: ${l}`).join("\n");
    } catch {}
    if (!text || text.length > budget) continue;
    budget -= text.length;
    shown.push(`=== ${f} (numbered)\n${text}`);
  }
  return { list: files.length > 3000 ? `${files.slice(0, 3000).join(" ")} … (${files.length} files)` : files.join(" "), key: shown };
}

// 1. Source map --------------------------------------------------------------------------

const MAP_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "usual product name: 'Node.js', 'esbuild', 'Cloudflare Workers'" },
          docs_name: { type: "string", description: "name of its official documentation, e.g. 'Visual Studio Code Extension API'" },
          version: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          vendor: { type: "string", enum: ["cloudflare", "microsoft", "aws", "other"] },
          changelog_url: { type: "string", description: "official changelog / release-notes / deprecations URL you know, or empty" },
        },
        required: ["name", "docs_name", "version", "evidence", "vendor", "changelog_url"],
      },
    },
  },
  required: ["components"],
};
const MAP_PROMPT = `List the components of this repository's stack: runtimes, platforms, frameworks, protocols, external APIs and libraries it is built on or for. Skip trivial dev tooling and AI or docs tools it merely calls. Read docs/ARCHITECTURE.md if there and the manifests. For each: its usual product name, the name of its official documentation, the version or range used, where in the repo (path:line), the vendor, and the official changelog / release-notes URL if you know it (do not fetch). At most 14.`;

/** An https URL on a public host name (no IP literal, no localhost or internal names). @param {string} u */
function publicHttps(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.toLowerCase();
    return url.protocol === "https:" && h.includes(".") && !/^[\d.]+$/.test(h) && !h.includes(":") && !h.startsWith("[")
      && !/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(h);
  } catch {
    return false;
  }
}

/**
 * A component's Context7 id by REST search: the exact title, else (a name of 3+ words) a
 * title with every word of it; a wrong id is worse than none.
 * @param {string} name @param {{fetchFn?: typeof fetch}} [o] @returns {Promise<string | undefined>}
 */
async function context7For(name, { fetchFn = fetch } = {}) {
  try {
    const r = await fetchFn(`https://context7.com/api/v2/libs/search?libraryName=${encodeURIComponent(name)}&query=${encodeURIComponent("best practices")}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return undefined;
    const j = await r.json();
    const norm = (/** @type {any} */ s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const list = Array.isArray(j.results) ? j.results : [];
    // Every word in the title only for names specific enough (3+ words): "VS Code" would match "VS Code Messenger".
    const hit = list.find((/** @type {any} */ x) => norm(x.title) === norm(name)) ?? (words.length >= 3 ? list.find((/** @type {any} */ x) => words.every((w) => String(x.title ?? "").toLowerCase().includes(w))) : undefined);
    const id = hit && Number(hit.trustScore ?? 0) >= 5 ? String(hit.id ?? "") : "";
    return /^\/[\w.-]+\/[\w.-]+(\/[\w.-]+)?$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The source map: Haiku lists the stack from the repo; code finds Context7 ids and keeps
 * a changelog URL only when public https.
 * @param {string} root @param {{ask?: typeof askClaude, fetchFn?: typeof fetch}} [o] @returns {Promise<{map: SourceMap, cost: number}>}
 */
async function buildSourceMap(root, { ask = askClaude, fetchFn = fetch } = {}) {
  const { out, cost } = await ask(MAP_PROMPT, MAP_SCHEMA, { cwd: root, model: MAP_MODEL, effort: "low", maxTurns: 14 });
  const str = (/** @type {any} */ v, /** @type {number} */ n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  /** @type {Component[]} */
  const components = (Array.isArray(out?.components) ? out.components : []).filter((/** @type {any} */ c) => c && typeof c.name === "string").slice(0, 20).map((/** @type {any} */ c) => ({
    name: str(c.name, 120), docs_name: str(c.docs_name, 120) || str(c.name, 120), version: str(c.version, 120),
    evidence: (Array.isArray(c.evidence) ? c.evidence : []).map(String).slice(0, 6), vendor: ["cloudflare", "microsoft", "aws"].includes(c.vendor) ? c.vendor : "other",
    changelog_url: publicHttps(str(c.changelog_url, 500)) ? str(c.changelog_url, 500) : "",
  }));
  await Promise.all(components.map(async (c) => {
    c.context7 = (await context7For(c.docs_name, { fetchFn })) ?? (c.docs_name !== c.name ? await context7For(c.name, { fetchFn }) : undefined);
  }));
  return { map: { components, at: Date.now() }, cost };
}

// 2. Fetch -------------------------------------------------------------------------------

/**
 * One call of a public docs MCP server's search tool over streamable HTTP
 * (initialize, initialized, tools/list, tools/call); its text.
 * @param {string} url @param {string} query @param {{fetchFn?: typeof fetch}} [o]
 */
async function mcpSearch(url, query, { fetchFn = fetch } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
  const post = async (/** @type {any} */ body, /** @type {string | undefined} */ sid) => {
    const r = await fetchFn(url, { method: "POST", headers: { ...headers, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    const data = text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop();
    return { sid: r.headers?.get?.("mcp-session-id") ?? sid, json: data ? JSON.parse(data) : undefined };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "imprimatur", version: "1" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, init.sid);
  const tool = list.json?.result?.tools?.find((/** @type {any} */ x) => /search/i.test(x.name));
  if (!tool) return "";
  const arg = Object.keys(tool.inputSchema?.properties ?? { query: 1 })[0] ?? "query";
  const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: { [arg]: query } } }, init.sid);
  return (call.json?.result?.content ?? []).map((/** @type {any} */ c) => (typeof c.text === "string" ? c.text : "")).join("\n");
}

/** Links in a text: absolute https ones, and the base's paths (an MCP answer's relative links). @param {string} text @param {string} [base] */
function linksIn(text, base) {
  const abs = [...text.matchAll(/https:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ""));
  const rel = base ? [...text.matchAll(/(?:\]\(|"|\s)(\/[a-z0-9][^\s"'<>)\]]*)/gi)].map((m) => `${base}${m[1]}`.replace(/[.,;:]+$/, "")) : [];
  return [...new Set([...abs, ...rel])].filter(publicHttps);
}

/** An address a host may not be sent to: loopback, private, link-local, unique-local. @param {string} ip */
function privateIp(ip) {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip.replace(/^::ffff:/i, ""));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** Whether a host name resolves only to public addresses. @param {string} host @param {{lookup?: (h: string) => Promise<Array<{address: string}>>}} [o] */
async function resolvesPublic(host, { lookup = (h) => require("node:dns").promises.lookup(h, { all: true }) } = {}) {
  try {
    const addrs = await lookup(host);
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch {
    return false;
  }
}

/**
 * GET a model-proposed page safely: a public https URL that resolves to public
 * addresses only; redirects followed by hand, at most 3, only on the same host.
 * @param {string} url @param {{fetchFn?: typeof fetch, lookup?: any}} [o] @returns {Promise<string>} the body, or "" when refused
 */
async function fetchPublic(url, { fetchFn = fetch, lookup } = {}) {
  let u = url;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  for (let hop = 0; hop < 4; hop++) {
    if (!publicHttps(u) || new URL(u).hostname !== host || !(await resolvesPublic(host, lookup ? { lookup } : {}))) return "";
    const r = await fetchFn(u, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (r.status >= 300 && r.status < 400) {
      const to = r.headers?.get?.("location");
      if (!to) return "";
      u = new URL(to, u).href;
      continue;
    }
    return r.ok ? await r.text() : "";
  }
  return "";
}

/** HTML to plain text, enough for a changelog page. @param {string} h */
const htmlText = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/**
 * The documentation for a review, fetched by code in parallel (8 at a time): per
 * component × category, Context7 and the vendor's docs MCP; changelogs once, for
 * compatibility and the process.
 * @param {SourceMap} map @param {string[]} cats @param {{fetchFn?: typeof fetch, cap?: number, lookup?: any}} [o] @returns {Promise<Excerpt[]>}
 */
async function fetchDocs(map, cats, { fetchFn = fetch, cap = 2500, lookup } = {}) {
  /** @type {Excerpt[]} */
  const out = [];
  /** @type {Array<() => Promise<void>>} */
  const jobs = [];
  for (const c of map.components) {
    for (const cat of cats) {
      const q = CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (cat)].query;
      if (c.context7) jobs.push(async () => {
        const r = await fetchFn(`https://context7.com/api/v2/context?libraryId=${encodeURIComponent(c.context7 ?? "")}&query=${encodeURIComponent(q)}&type=txt`, { signal: AbortSignal.timeout(30_000) });
        const text = r.ok ? await r.text() : "";
        // Context7 names each snippet's original page: that is what a recommendation cites.
        const urls = [...new Set([...text.matchAll(/Source: (https:\/\/\S+)/g)].map((m) => m[1]))].filter(publicHttps);
        if (text) out.push({ component: c.name, cat, kind: "context7", ref: c.context7 ?? "", urls, text: text.slice(0, cap) });
      });
      const mcp = VENDOR_MCP[/** @type {keyof typeof VENDOR_MCP} */ (c.vendor)];
      if (mcp) jobs.push(async () => {
        const text = await mcpSearch(mcp.url, `${c.name} ${q}`, { fetchFn });
        if (text) out.push({ component: c.name, cat, kind: "mcp", ref: mcp.url, urls: linksIn(text, mcp.base), text: text.slice(0, cap) });
      });
    }
    // The changelog URL is the model's: fetched only on a public host, same-host redirects.
    if (c.changelog_url) jobs.push(async () => {
      const text = htmlText(await fetchPublic(c.changelog_url, { fetchFn, lookup }));
      if (text) for (const cat of ["compatibility", "ssdf"].filter((x) => cats.includes(x))) out.push({ component: c.name, cat, kind: "url", ref: c.changelog_url, urls: [c.changelog_url], text: text.slice(0, cap * 2) });
    });
  }
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < jobs.length) await jobs[next++]().catch(() => {});
  }));
  return out;
}

// 3. Judge -------------------------------------------------------------------------------

/** The recommendation schema of a category: its subcategories as an enum. @param {string} cat */
function recSchema(cat) {
  const c = CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (cat)];
  return {
    type: "object",
    properties: {
      recommendations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "string", description: "stable kebab-case id: component-what" },
            subcategory: { type: "string", enum: c.subs.map((s) => s[0]) },
            component: { type: "string" },
            title: { type: "string", description: "one line, imperative" },
            why: { type: "string", description: "2-4 sentences: what the documentation says and why it matters here" },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            evidence: { type: "array", items: { type: "string" }, description: "'path:line' or 'docs/ARCHITECTURE.md#section-key'" },
            source: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, version_or_date: { type: "string" } }, required: ["url", "title", "version_or_date"] },
            next_step: { type: "string", description: "the concrete change: file and what to change" },
            decision_ids: { type: "array", items: { type: "integer" } },
          },
          required: ["key", "subcategory", "component", "title", "why", "severity", "evidence", "source", "next_step", "decision_ids"],
        },
      },
    },
    required: ["recommendations"],
  };
}

/** The part every category call shares (the system prompt; cached after the first call). */
function sharedPrompt(/** @type {{decisions: Array<{line: string}>, sections: string[]}} */ ctx, /** @type {SourceMap} */ map, /** @type {ReturnType<typeof repoBundle>} */ repo) {
  return [
    "You review a software repository against official documentation excerpts fetched just now, one quality category at a time (ISO/IEC 25010:2023, NIST SSDF).",
    "", "DECISIONS of the project (id kind: title):", ...ctx.decisions.slice(0, 200).map((d) => d.line),
    "", "ARCHITECTURE DOCUMENT (sections, cut; full text in docs/ARCHITECTURE.md):", ...ctx.sections,
    "", "STACK:", ...map.components.map((c) => `- ${c.name} ${c.version} (${c.evidence.join(", ")})`),
    "", "REPOSITORY FILES (git ls-files):", repo.list, "", ...repo.key,
  ].join("\n");
}

/** @param {string} cat @param {Excerpt[]} docs @param {string[]} keys previous keys of this category @param {string} lang */
function categoryPrompt(cat, docs, keys, lang) {
  const c = CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (cat)];
  return `CATEGORY: ${c.std} — ${c.name}. Subcategories: ${c.subs.map(([n, m]) => `${n} (${m})`).join("; ")}.

Give best-practice recommendations for THIS project in this category only, each under the subcategory it fits best, from the DOCUMENTATION EXCERPTS below and the repository in your instructions.
- source.url must be one of the URLs listed with the excerpts (the page the excerpt came from), with its version or date if shown. None fits → leave it out.
- Evidence: "path:line" (e.g. "package.json:9") or "docs/ARCHITECTURE.md#<section key>". The key files are given numbered; use Read or Grep at most 3 times, only to check a line elsewhere. Do not explore.
- Respect the decisions: skip what one settles; if the documentation is newer and goes against one, keep it and list the decision id.
- At most 5, most valuable first; fewer or none is fine. Nothing generic. Write title, why and next_step in ${lang}.
${keys.length ? `- Earlier runs used these keys; reuse a key when it is the same recommendation: ${keys.join(", ")}` : ""}

DOCUMENTATION EXCERPTS (${c.name}):
${docs.map((d) => `\n=== ${d.component} · ${d.kind} ${d.ref}\nURLs: ${d.urls.slice(0, 10).join(" ")}\n${d.text}`).join("\n") || "(none fetched)"}`;
}

// 4. Gate --------------------------------------------------------------------------------

/** A URL compared without query, fragment or trailing slash. @param {string} u */
const normUrl = (u) => u.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * The gate: shapes and sizes fixed, an https source among the URLs fetched, every
 * evidence file inside the repo (a line within the file), a subcategory of the category,
 * decision ids the repo's. Dropped items say why; nothing throws.
 * @param {any[]} recsIn @param {string} root @param {Set<number>} decisionIds @param {Set<string>} [fetched] normalized URLs fetched
 * @returns {{kept: Recommendation[], dropped: Array<Recommendation & {why: string[]}>}}
 */
function gate(recsIn, root, decisionIds, fetched) {
  /** @type {Recommendation[]} */
  const kept = [];
  /** @type {Array<Recommendation & {why: string[]}>} */
  const dropped = [];
  const str = (/** @type {any} */ v, /** @type {number} */ max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const base = path.resolve(root);
  for (const raw of Array.isArray(recsIn) ? recsIn : []) {
    if (!raw || typeof raw !== "object") continue;
    const category = String(raw.category ?? "");
    const cat = CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (category)];
    /** @type {Recommendation} */
    const r = {
      key: str(raw.key, 80), category, subcategory: str(raw.subcategory, 80), component: str(raw.component, 120), title: str(raw.title, 300), why: str(raw.why, 2000),
      next_step: str(raw.next_step, 1000), severity: ["high", "medium", "low"].includes(raw.severity) ? raw.severity : "low",
      evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).filter((/** @type {any} */ e) => typeof e === "string").map((/** @type {string} */ e) => e.slice(0, 300)).slice(0, 10),
      source: { url: str(raw.source?.url, 500), title: str(raw.source?.title, 200), version_or_date: str(raw.source?.version_or_date, 100) },
      decision_ids: (Array.isArray(raw.decision_ids) ? raw.decision_ids : []).filter((/** @type {any} */ id) => Number.isInteger(id) && decisionIds.has(id)),
    };
    const why = [];
    if (!cat) why.push("unknown category");
    else if (!cat.subs.some((s) => s[0] === r.subcategory)) why.push("not a subcategory of the category");
    if (!r.title) why.push("no title");
    if (!publicHttps(r.source.url)) why.push("no public https source");
    else if (fetched && !fetched.has(normUrl(r.source.url))) why.push("source not among the pages fetched");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.key)) why.push("bad key");
    const bad = r.evidence.filter((e) => {
      if (e.startsWith("docs/ARCHITECTURE.md#")) return !fs.existsSync(path.join(base, "docs", "ARCHITECTURE.md"));
      const [, file, line] = /^([^:#]+)(?::(\d+))?/.exec(e) ?? [];
      const abs = file ? path.resolve(base, file) : "";
      if (!abs || !abs.startsWith(base + path.sep)) return true;
      try {
        // A link inside the repo may point outside it: the real path must stay inside too.
        if (!fs.realpathSync(abs).startsWith(fs.realpathSync(base) + path.sep)) return true;
        if (!line) return !fs.statSync(abs).isFile();
        return Number(line) > fs.readFileSync(abs, "utf8").split("\n").length;
      } catch {
        return true;
      }
    });
    if (!r.evidence.length) why.push("no evidence");
    else if (bad.length) why.push(`evidence not in the repo: ${bad.join(", ")}`);
    if (why.length) dropped.push({ ...r, why });
    else kept.push(r);
  }
  return { kept, dropped };
}

/**
 * The same fix found by two categories is one recommendation: its first evidence and
 * component the same → the more severe kept, the others' categories as tags.
 * @param {Recommendation[]} list @returns {Recommendation[]}
 */
function dedupe(list) {
  const rank = { high: 0, medium: 1, low: 2 };
  /** @type {Map<string, Recommendation>} */
  const by = new Map();
  for (const r of [...list].sort((a, b) => rank[a.severity] - rank[b.severity])) {
    const k = `${r.component.toLowerCase()}|${(r.evidence[0] ?? "").toLowerCase()}`;
    const have = by.get(k);
    if (!have) by.set(k, { ...r, tags: [] });
    else if (have.category !== r.category && !have.tags?.includes(r.category)) have.tags = [...(have.tags ?? []), r.category];
  }
  return [...by.values()];
}

// 5. Records -----------------------------------------------------------------------------

/** A recommendation's record body (Markdown); the source link escaped. @param {Recommendation} r */
function bodyOf(r) {
  const c = CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (r.category)];
  return [
    r.why, "",
    `**Next:** ${r.next_step}`,
    `**Category:** ${c ? `${c.std} · ${c.name} → ${r.subcategory}` : r.category}${r.tags?.length ? ` (also ${r.tags.join(", ")})` : ""}`,
    `**Evidence:** ${r.evidence.map((e) => `\`${e.replace(/`/g, "")}\``).join(", ")}`,
    `**Source:** [${r.source.title.replace(/[[\]\\]/g, "")}](${r.source.url.replace(/[()\s<>]/g, (ch) => encodeURIComponent(ch))}) (${r.source.version_or_date})`,
    ...(r.decision_ids.length ? [`**Touches decisions:** ${r.decision_ids.join(", ")}`] : []),
  ].join("\n");
}

/** @param {Recommendation} r @param {number} at */
const linksOf = (r, at) => ({
  best: {
    key: r.key, category: r.category, subcategory: r.subcategory, std: CATEGORIES[/** @type {keyof typeof CATEGORIES} */ (r.category)]?.std, tags: r.tags ?? [],
    component: r.component, severity: r.severity, source: r.source, evidence: r.evidence, next_step: r.next_step, decision_ids: r.decision_ids, seen: at,
  },
});

/** A record's identity: category and key (two categories may name the same key). @param {any} b */
const idOf = (b) => `${b.category ?? b.pillar ?? ""}:${b.key}`;

/**
 * The write plan, pure: new keys added, found ones refreshed (open or done), dismissed
 * left, the rest left.
 * @param {Recommendation[]} list @param {Array<{id: number, status: string, links?: any}>} records
 */
function reconcileBest(list, records) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const r of records) if (r.links?.best?.key && !r.links.best.duplicate) byKey.set(idOf(r.links.best), r);
  /** @type {{add: Recommendation[], refresh: Array<{id: number, r: Recommendation}>, dismissed: number}} */
  const plan = { add: [], refresh: [], dismissed: 0 };
  const seen = new Set();
  for (const r of list) {
    if (seen.has(idOf(r))) continue;
    seen.add(idOf(r));
    const rec = byKey.get(idOf(r));
    if (!rec) plan.add.push(r);
    else if (rec.status === "dropped") plan.dismissed++;
    else plan.refresh.push({ id: rec.id, r });
  }
  return plan;
}

/** The source map's record: a note of RECS with links.bestSources. @param {any} db @param {number} taskId */
function sourceMapRecord(db, taskId) {
  return db.recordsOf(taskId).find((/** @type {any} */ r) => r.kind === "note" && r.links?.bestSources);
}

/** The source map as Markdown, for its record. @param {SourceMap} map */
function mapBody(map) {
  return map.components.map((c) => `- **${c.name}** (${c.version}): ${[c.context7 && `Context7 \`${c.context7}\``, VENDOR_MCP[/** @type {keyof typeof VENDOR_MCP} */ (c.vendor)] && `${c.vendor} docs MCP`, c.changelog_url && `[changelog](${c.changelog_url})`].filter(Boolean).join(", ") || "no source"}`).join("\n");
}

/**
 * A whole review: source map (built when missing or asked), fetch, one call per
 * category (staggered for the prompt cache), gate, dedupe, one write.
 * @param {any} db @param {string} root
 * @param {{categories?: string[], refreshSources?: boolean, budget?: number, lang?: string, ask?: typeof askClaude, fetchFn?: typeof fetch,
 *   progress?: (msg: string) => void, now?: number, stagger?: number, lookup?: any}} [o]
 */
async function review(db, root, { categories = CORE, refreshSources = false, budget = 1.5, lang = "English", ask = askClaude, fetchFn = fetch, progress = () => {}, now = Date.now(), stagger = 4000, lookup } = {}) {
  const t0 = Date.now();
  const cats = categories.filter((c) => c in CATEGORIES);
  if (!cats.length) throw new Error("no category to review");
  const repo = db.repoOf(root);
  const ctx = projectContext(db, repo.id);
  const timings = /** @type {Record<string, number>} */ ({});
  let cost = 0;
  let task = recs.recsTask(db, repo.id, { create: true, actor: ACTOR });
  /** @type {SourceMap | undefined} */
  let map = sourceMapRecord(db, task.id)?.links.bestSources;
  if (!map?.components?.length || refreshSources) {
    progress("Mapping the stack");
    const t = Date.now();
    const built = await buildSourceMap(root, { ask, fetchFn });
    timings.map = Date.now() - t;
    cost += built.cost;
    map = built.map;
    if (!map.components.length) throw new Error("the stack came back empty");
    const old = sourceMapRecord(db, task.id);
    const fields = { title: `Source map: ${map.components.length} components`, body: mapBody(map), links: { bestSources: map } };
    if (old) db.updateRecord(old.id, fields, ACTOR);
    else db.addRecord(task.id, { kind: "note", ...fields }, ACTOR);
  }
  const m = /** @type {SourceMap} */ (map);
  progress(`Fetching documentation for ${m.components.length} components`);
  let t = Date.now();
  const docs = await fetchDocs(m, cats, { fetchFn, lookup });
  timings.fetch = Date.now() - t;
  const fetched = new Set(docs.flatMap((d) => d.urls).map(normUrl));
  const system = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-best-")), "context.txt");
  fs.writeFileSync(system, sharedPrompt(ctx, m, repoBundle(root)), { mode: 0o600 });
  const before = db.recordsOf(task.id, { dropped: true });
  progress(`Reviewing ${cats.length} categories`);
  t = Date.now();
  let runs;
  try {
    runs = await Promise.all(cats.map(async (cat, i) => {
      // The first call writes the shared prompt to the cache; the others read it.
      if (i && stagger) await new Promise((r) => setTimeout(r, stagger));
      const keys = before.filter((/** @type {any} */ r) => r.links?.best?.category === cat).map((/** @type {any} */ r) => r.links.best.key);
      const prompt = categoryPrompt(cat, docs.filter((d) => d.cat === cat), keys, lang);
      const asRecs = (/** @type {any} */ out) => (Array.isArray(out?.recommendations) ? out.recommendations : []).map((/** @type {any} */ r) => ({ ...r, category: cat }));
      let spent = 0;
      try {
        const { out, cost: c } = await ask(prompt, recSchema(cat), { cwd: root, model: MODEL, effort: "medium", maxTurns: 20, system, budget });
        return { cat, recs: asRecs(out), cost: c };
      } catch (e) {
        spent = Number(/** @type {any} */ (e)?.cost ?? 0);
        // Out of turns checking the repo: once more without tools, from what it was given
        // (the key files are in the prompt), so the category is not lost.
        if (/** @type {any} */ (e)?.subtype === "error_max_turns" || /max_turns/.test(String(/** @type {any} */ (e)?.message))) {
          try {
            const { out, cost: c } = await ask(`${prompt}\n\nAnswer now from the files and excerpts given; do not read anything else.`, recSchema(cat), { cwd: root, model: MODEL, effort: "medium", maxTurns: 2, system, budget, tools: [] });
            return { cat, recs: asRecs(out), cost: spent + c, retried: true };
          } catch (e2) {
            return { cat, recs: [], cost: spent + Number(/** @type {any} */ (e2)?.cost ?? 0), error: e2 instanceof Error ? e2.message : String(e2) };
          }
        }
        return { cat, recs: [], cost: spent, error: e instanceof Error ? e.message : String(e) };
      }
    }));
  } finally {
    fs.rmSync(path.dirname(system), { recursive: true, force: true });
  }
  timings.judge = Date.now() - t;
  cost += runs.reduce((n, r) => n + r.cost, 0);
  if (runs.every((r) => r.error)) throw new Error(`every category failed ($${cost.toFixed(2)} used): ${runs.map((r) => `${r.cat}: ${r.error}`).join("; ")}`);
  const ran = runs.filter((r) => !r.error).map((r) => r.cat);
  const { kept, dropped } = gate(runs.flatMap((r) => r.recs), root, new Set(ctx.decisions.map((d) => d.id)), fetched);
  const final = dedupe(kept);
  const result = db.tx(() => {
    task = recs.recsTask(db, repo.id, { create: true, actor: ACTOR });
    const plan = reconcileBest(final, db.recordsOf(task.id, { dropped: true }));
    for (const r of plan.add) db.addRecord(task.id, { kind: "todo", title: r.title, body: bodyOf(r), links: linksOf(r, now) }, ACTOR);
    for (const { id, r } of plan.refresh) db.updateRecord(id, { title: r.title, body: bodyOf(r), links: linksOf(r, now) }, ACTOR);
    // When each category last ran: a recommendation seen before that was not seen now.
    const mr = sourceMapRecord(db, task.id);
    if (mr) db.updateRecord(mr.id, { links: { ...mr.links, bestSources: { ...mr.links.bestSources, lastRun: { ...(mr.links.bestSources.lastRun ?? {}), ...Object.fromEntries(ran.map((c) => [c, now])) } } } }, ACTOR);
    const summary = recs.writeSummary(db, db.taskById(task.id), ACTOR);
    return { added: plan.add.length, refreshed: plan.refresh.length, dismissed: plan.dismissed, summary };
  });
  timings.total = Date.now() - t0;
  return {
    ...result, kept: final.length, merged: kept.length - final.length, dropped, cost, timings, excerpts: docs.length, components: m.components.length,
    categories: runs.map((r) => ({ category: r.cat, proposed: r.recs.length, cost: r.cost, ...(/** @type {any} */ (r).retried ? { retried: true } : {}), ...(r.error ? { error: r.error } : {}) })),
  };
}

/** The prose language: the repo's "lang" (.claude/imprimatur.json), IMPRIMATUR_LANG, config.json, else English. @param {string} [root] */
function proseLang(root) {
  try {
    return require("./config.js").repoLang(root) || "English";
  } catch {
    return "English";
  }
}

module.exports = {
  TASK, ACTOR, MODEL, MAP_MODEL, CATEGORIES, CORE, VENDOR_MCP, DENY, run, childEnv, askClaude, authKind, projectContext, repoBundle, MAP_SCHEMA,
  publicHttps, privateIp, resolvesPublic, fetchPublic, context7For, buildSourceMap, mcpSearch, linksIn, fetchDocs, recSchema, sharedPrompt, categoryPrompt, normUrl, gate, dedupe,
  bodyOf, linksOf, reconcileBest, sourceMapRecord, mapBody, review, proseLang,
};
