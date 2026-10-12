// @ts-check
// Best-practice review (#86): recommendations for how this project is built, from
// its own architecture document, decisions and code, each grounded in an official
// source read in the run and in evidence from the repo. Kept as records of the
// repo's BEST task, matched across runs by key (the audit's way, setup-audit.js).
//
// 1. Source map (once, then reused): a model finds the stack's components and, per
//    component, where best practice is read — a public docs MCP, a Context7 library
//    id, official release-notes / changelog / deprecation URLs. Code checks each
//    source and adds a Context7 id the model missed.
// 2. One model call per pillar (deps, security, testing), in parallel, with the
//    map's tools; WebFetch last. A JSON schema; the previous run's keys fed back.
// 3. Gate (code): no official source or no repo evidence → dropped; decision ids
//    must be the repo's.
// 4. Records: new key → open todo; a key found again → refreshed (last seen); a key
//    not found → left as it is (a model may not repeat itself; "applied" is the
//    user's call); a dismissed one is never touched.
"use strict";
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TASK = "BEST";
const TASK_TITLE = "Best practice review";
/** @type {import("./db.js").Actor} */
const ACTOR = { kind: "hook", id: "best-practice" };
const MODEL = "sonnet";

/** Public docs MCP servers (no sign-in) a review may use. */
const CATALOG = {
  context7: { type: "http", url: "https://mcp.context7.com/mcp", what: "versioned library and framework docs (any ecosystem)" },
  "cloudflare-docs": { type: "http", url: "https://docs.mcp.cloudflare.com/mcp", what: "Cloudflare docs and changelog (Workers, D1, Durable Objects, …)" },
  "microsoft-learn": { type: "http", url: "https://learn.microsoft.com/api/mcp", what: "Microsoft docs (Azure, .NET, TypeScript; not VS Code)" },
  "aws-knowledge": { type: "http", url: "https://knowledge-mcp.global.api.aws", what: "AWS docs, What's New, Well-Architected" },
};

const PILLARS = {
  deps: "Dependencies, runtimes and platform versions: what is outdated, deprecated, near end of life, or has a newer recommended way, for each component of the source map.",
  security: "Security: trust boundaries, secrets, child processes and shell use, input validation, webhook signatures, tokens, supply chain (pinned versions, npx).",
  testing: "Testing and CI: unit and integration tests, coverage of risky paths, CI, cross-platform runs, release checks.",
};

/** Why a recommendation was dismissed. decided: a decision record settles it (links.best.decision). */
const REASONS = ["decided", "not-applicable", "accepted-risk", "postponed", "other"];

/**
 * @typedef {{kind: "mcp" | "context7" | "url", ref: string, covers: string[], note?: string, check?: {ok: boolean, why?: string, added?: boolean}}} Source
 * @typedef {{name: string, version: string, evidence: string[], sources: Source[]}} Component
 * @typedef {{components: Component[], missing: Array<{component: string, suggestion: string}>, at?: number, lastRun?: Record<string, number>}} SourceMap
 * @typedef {{key: string, component: string, title: string, why: string, severity: "high" | "medium" | "low", evidence: string[],
 *   source: {url: string, title: string, version_or_date: string}, next_step: string, decision_ids: number[], pillar?: string}} Recommendation
 */

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

/**
 * The child's environment: what claude needs to run and sign in, nothing else of
 * the extension host's (its tokens stay out of reach of injected instructions).
 */
function childEnv(env = process.env) {
  const keep = /^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|USER|USERNAME|LOGNAME|LANG|LC_ALL|TMPDIR|TEMP|TMP|SHELL|SYSTEMROOT|COMSPEC|XDG_CONFIG_HOME|XDG_DATA_HOME|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CONFIG_DIR|AWS_REGION|AWS_PROFILE|CLOUD_ML_REGION|ANTHROPIC_VERTEX_PROJECT_ID)$/;
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => keep.test(k))), IMPRIMATUR_CHILD: "1" };
}

/** Secrets the model may never read, whatever a file or a page tells it. */
const DENY = ["Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/id_rsa*)", "Read(**/id_ed25519*)", "Read(~/.ssh/**)", "Read(~/.aws/**)",
  "Read(~/.config/gh/**)", "Read(**/.npmrc)", "Read(**/.dev.vars*)", "Grep(**/.env*)"];

/**
 * One `claude -p` with a JSON schema, the given tools and MCP servers; no settings
 * files (no hooks run in it), nothing saved, a minimal environment, secrets denied.
 * `fetchDomains` limits WebFetch to those hosts (undefined: any, for finding sources;
 * a review only reads the map's hosts, so an injected instruction cannot send repo
 * content elsewhere). WebSearch only when `search`.
 * @param {string} prompt @param {any} schema
 * @param {{cwd: string, servers?: string[], budget?: number, timeoutMs?: number, exec?: typeof run, fetchDomains?: string[], search?: boolean}} o
 * @returns {Promise<{out: any, cost: number, turns: number}>}
 */
async function askClaude(prompt, schema, { cwd, servers = [], budget = 1.5, timeoutMs = 20 * 60_000, exec = run, fetchDomains, search = false }) {
  const tools = ["Read", "Grep", "Glob", "WebFetch", ...(search ? ["WebSearch"] : [])];
  const mcp = { mcpServers: Object.fromEntries(servers.filter((s) => s in CATALOG).map((s) => [s, { type: CATALOG[/** @type {keyof typeof CATALOG} */ (s)].type, url: CATALOG[/** @type {keyof typeof CATALOG} */ (s)].url }])) };
  const fetchRules = fetchDomains ? fetchDomains.map((d) => `WebFetch(domain:${d})`) : ["WebFetch"];
  const allowed = [...tools.filter((t) => t !== "WebFetch"), ...fetchRules, ...Object.keys(mcp.mcpServers).map((s) => `mcp__${s}`)];
  const args = ["-p", "--model", MODEL, "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", tools.join(","),
    "--allowedTools", ...allowed, "--disallowedTools", ...DENY, "--permission-mode", "dontAsk",
    "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands",
    "--max-budget-usd", String(budget)];
  const r = await exec("claude", args, { cwd, timeout: timeoutMs, env: childEnv(), input: prompt });
  let res;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw Object.assign(new Error(`claude: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 300)}`), { cost: 0 });
  }
  const cost = Number(res.total_cost_usd ?? 0);
  if (res.is_error && !res.structured_output) throw Object.assign(new Error(`claude: ${String(res.result ?? res.subtype ?? "error").slice(0, 300)}`), { cost });
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
 * What the model is told about the project: its decisions and the architecture
 * document's sections (cut), from Imprimatur's database.
 * @param {any} db @param {number} repoId
 */
function projectContext(db, repoId) {
  const decisions = db.recordsByKind(repoId, ["adr", "pdr", "decision"], { limit: 500 })
    .filter((/** @type {any} */ r) => r.status !== "dropped")
    .map((/** @type {any} */ r) => ({ id: r.id, line: `[${r.id}] ${r.kind}: ${r.title}` }));
  const doc = db.docOf(repoId, "architecture");
  const sections = doc ? db.docSections(doc.id).filter((/** @type {any} */ s) => s.status === "current").map((/** @type {any} */ s) => `## ${s.title} (key ${s.key})\n${(s.body ?? "").slice(0, 600)}`) : [];
  return { decisions, sections };
}

// 1. Source map ---------------------------------------------------------------------

const COVERS = ["api", "guides", "release-notes", "changelog", "deprecations", "security", "support-policy"];
const MAP_SCHEMA = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          version: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: { kind: { type: "string", enum: ["mcp", "context7", "url"] }, ref: { type: "string" }, covers: { type: "array", items: { type: "string", enum: COVERS } }, note: { type: "string" } },
              required: ["kind", "ref", "covers"],
            },
          },
        },
        required: ["name", "version", "evidence", "sources"],
      },
    },
    missing: { type: "array", items: { type: "object", properties: { component: { type: "string" }, suggestion: { type: "string" } }, required: ["component", "suggestion"] } },
  },
  required: ["components", "missing"],
};

/** @param {{decisions: Array<{line: string}>, sections: string[]}} ctx */
const mapPrompt = (ctx) => `Build a SOURCE MAP for the repository in the current directory: for each component of its stack, where current best practice is read. Do not give recommendations; only find sources.

1. Find the components: read docs/ARCHITECTURE.md (if there), the manifests and build files of whatever ecosystem this repo uses, and code where needed. Include runtimes, platforms, frameworks, protocols, external APIs and tools the project is built on or for. Skip trivial dev tooling.
2. For each component, list sources in this order of preference, and CHECK each one with the tools before listing it:
   - mcp: a docs MCP server from the catalog below that covers it (call it once to confirm).
   - context7: a Context7 library id — ALWAYS try resolve-library-id for every library, framework, runtime and protocol; prefer the official docs id and the version matching the repo.
   - url: official pages on the vendor's own domain that the above do not cover — release notes, changelog, deprecations, support policy, security advisories (fetch once to confirm).
   Every component needs a source covering release-notes, changelog or deprecations, and one covering api or guides.
3. In "missing", name better tools that exist but are not in the catalog (e.g. an official docs MCP for a vendor).

MCP CATALOG: ${Object.entries(CATALOG).map(([k, v]) => `${k}: ${v.what}`).join("; ")}

PROJECT DECISIONS:
${ctx.decisions.slice(0, 200).map((d) => d.line).join("\n")}
`;

/** A component's base name for a Context7 search: "Node.js runtime (incl. node:sqlite)" → "Node.js". @param {string} name */
const baseName = (name) => name.replace(/\(.*$/, "").replace(/\b(runtime|API|SDK|CLI|platform|protocol|specification)\b.*$/i, "").trim() || name;

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
 * Checks a source: the MCP is one the review has, the Context7 id answers, the URL answers.
 * @param {Source} s @param {{fetchFn?: typeof fetch}} [o] @returns {Promise<{ok: boolean, why?: string}>}
 */
async function checkSource(s, { fetchFn = fetch } = {}) {
  try {
    if (s.kind === "mcp") return s.ref in CATALOG ? { ok: true } : { ok: false, why: "not a catalog server" };
    if (s.kind === "context7") {
      const id = s.ref.startsWith("/") ? s.ref : `/${s.ref}`;
      if (!/^\/[\w.-]+\/[\w.-]+(\/[\w.-]+)?$/.test(id) || id.includes("..")) return { ok: false, why: "not a Context7 id" };
      const r = await fetchFn(`https://context7.com/api/v2/docs/code${id}?query=overview`, { signal: AbortSignal.timeout(20_000) });
      return r.ok ? { ok: true } : { ok: false, why: `context7 ${r.status}` };
    }
    if (!publicHttps(s.ref)) return { ok: false, why: "not a public https URL" };
    // No redirect followed: the model chose the URL; the host only answers whether it is there.
    const r = await fetchFn(s.ref, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (r.ok) return { ok: true };
    const to = r.status >= 300 && r.status < 400 ? r.headers?.get?.("location") : undefined;
    if (to && new URL(to, s.ref).host === new URL(s.ref).host) return { ok: true };
    return { ok: false, why: `http ${r.status}` };
  } catch (e) {
    return { ok: false, why: String(/** @type {any} */ (e)?.message ?? e).slice(0, 80) };
  }
}

/**
 * A Context7 id for a component the model left without one: Context7's search, an
 * exact title match only.
 * @param {string} name @param {{fetchFn?: typeof fetch}} [o] @returns {Promise<string | undefined>}
 */
async function context7For(name, { fetchFn = fetch } = {}) {
  const q = baseName(name);
  try {
    const r = await fetchFn(`https://context7.com/api/v1/search?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return undefined;
    const j = await r.json();
    const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (j.results ?? []).find((/** @type {any} */ x) => norm(x.title ?? "") === norm(q))?.id;
  } catch {
    return undefined;
  }
}

/**
 * Builds the source map: the model proposes, code checks and fills Context7 gaps.
 * @param {string} root @param {{decisions: any[], sections: string[]}} ctx
 * @param {{budget?: number, ask?: typeof askClaude, fetchFn?: typeof fetch}} [o]
 * @returns {Promise<{map: SourceMap, cost: number}>}
 */
async function buildSourceMap(root, ctx, { budget = 1.5, ask = askClaude, fetchFn = fetch } = {}) {
  const { out, cost } = await ask(mapPrompt(ctx), MAP_SCHEMA, { cwd: root, servers: Object.keys(CATALOG), budget, search: true });
  /** @type {SourceMap} */
  const map = {
    components: (Array.isArray(out?.components) ? out.components : []).filter((/** @type {any} */ c) => c && typeof c.name === "string" && Array.isArray(c.sources))
      .map((/** @type {any} */ c) => ({ name: c.name.slice(0, 120), version: String(c.version ?? "").slice(0, 120), evidence: (Array.isArray(c.evidence) ? c.evidence : []).map(String).slice(0, 10),
        sources: c.sources.filter((/** @type {any} */ x) => x && ["mcp", "context7", "url"].includes(x.kind) && typeof x.ref === "string").map((/** @type {any} */ x) => ({ kind: x.kind, ref: x.ref.slice(0, 500), covers: (Array.isArray(x.covers) ? x.covers : []).filter((/** @type {any} */ v) => COVERS.includes(v)), ...(typeof x.note === "string" ? { note: x.note.slice(0, 300) } : {}) })) })),
    missing: (Array.isArray(out?.missing) ? out.missing : []).filter((/** @type {any} */ m) => typeof m?.component === "string" && typeof m?.suggestion === "string").map((/** @type {any} */ m) => ({ component: m.component.slice(0, 120), suggestion: m.suggestion.slice(0, 400) })),
    at: Date.now(),
  };
  for (const c of map.components) {
    for (const s of c.sources) s.check = await checkSource(s, { fetchFn });
    c.sources = c.sources.filter((s) => s.check?.ok);
    if (!c.sources.some((s) => s.kind === "context7")) {
      const id = await context7For(c.name, { fetchFn });
      if (id) c.sources.push({ kind: "context7", ref: id, covers: ["api", "guides"], note: "added by the check (Context7 search)", check: { ok: true, added: true } });
    }
  }
  return { map, cost };
}

// 2. Pillars ------------------------------------------------------------------------

const REC_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "stable kebab-case id: pillar-component-what" },
          component: { type: "string", description: "a component name from the source map" },
          title: { type: "string", description: "one line, imperative" },
          why: { type: "string", description: "2-4 sentences: what the official source says and why it matters here" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "array", items: { type: "string" }, description: "'path:line' or 'docs/ARCHITECTURE.md#section-key'" },
          source: {
            type: "object",
            properties: { url: { type: "string" }, title: { type: "string" }, version_or_date: { type: "string" } },
            required: ["url", "title", "version_or_date"],
          },
          next_step: { type: "string", description: "the concrete change: file and what to change" },
          decision_ids: { type: "array", items: { type: "integer" } },
        },
        required: ["key", "component", "title", "why", "severity", "evidence", "source", "next_step", "decision_ids"],
      },
    },
  },
  required: ["recommendations"],
};

/**
 * @param {string} pillar @param {SourceMap} map @param {{decisions: Array<{line: string}>, sections: string[]}} ctx
 * @param {string[]} keys previous keys of this pillar @param {string} lang
 */
const pillarPrompt = (pillar, map, ctx, keys, lang) => `You review the repository in the current directory for ONE pillar:

PILLAR: ${pillar} — ${PILLARS[/** @type {keyof typeof PILLARS} */ (pillar)]}

Give best-practice recommendations for THIS project as it is built today. Rules:
- Read current guidance from the SOURCE MAP below, in its order: the docs MCP servers, then Context7 (query-docs with the listed id), then the listed URLs with WebFetch. Search the web only if those do not answer.
- Every recommendation cites an OFFICIAL source you read in this session (vendor docs, spec, release notes, changelog), with its version or date. No blogs. No source → leave it out.
- Every recommendation points to evidence you read in this repo (path:line, or an architecture section key). No evidence → leave it out. Nothing generic.
- Say which version it applies to; use the versions in the map.
- Respect the project's decisions: if one already settles the point, skip it; if the official source is newer and goes against it, keep it and put the decision id in decision_ids.
- At most 6, most valuable first. Fewer is fine. Write title, why and next_step in ${lang}.
${keys.length ? `- Earlier runs used these keys; reuse a key when it is the same recommendation: ${keys.join(", ")}` : ""}

SOURCE MAP:
${map.components.map((c) => `- ${c.name} (${c.version}): ${c.sources.map((s) => `${s.kind} ${s.ref} [${s.covers.join(",")}]`).join("; ")}`).join("\n")}

DECISIONS (id kind: title):
${ctx.decisions.slice(0, 200).map((d) => d.line).join("\n")}

ARCHITECTURE DOCUMENT (sections, cut; full text in docs/ARCHITECTURE.md):
${ctx.sections.join("\n\n")}
`;

/**
 * The gate: an official https source and evidence in the repo, or the recommendation
 * goes; decision ids kept only when they are the repo's.
 * @param {Recommendation[]} recs @param {string} root @param {Set<number>} decisionIds
 * @returns {{kept: Recommendation[], dropped: Array<Recommendation & {why: string[]}>}}
 */
function gate(recs, root, decisionIds) {
  /** @type {Recommendation[]} */
  const kept = [];
  /** @type {Array<Recommendation & {why: string[]}>} */
  const dropped = [];
  const str = (/** @type {any} */ v, /** @type {number} */ max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const base = path.resolve(root);
  for (const raw of Array.isArray(recs) ? recs : []) {
    if (!raw || typeof raw !== "object") continue;
    // Model output is untrusted: shapes and sizes fixed here, before anything is written.
    /** @type {Recommendation} */
    const r = {
      key: str(raw.key, 80), component: str(raw.component, 120), title: str(raw.title, 300), why: str(raw.why, 2000), next_step: str(raw.next_step, 1000),
      severity: ["high", "medium", "low"].includes(raw.severity) ? raw.severity : "low",
      evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).filter((/** @type {any} */ e) => typeof e === "string").map((/** @type {string} */ e) => e.slice(0, 300)).slice(0, 10),
      source: { url: str(raw.source?.url, 500), title: str(raw.source?.title, 200), version_or_date: str(raw.source?.version_or_date, 100) },
      decision_ids: (Array.isArray(raw.decision_ids) ? raw.decision_ids : []).filter((/** @type {any} */ id) => Number.isInteger(id) && decisionIds.has(id)),
      pillar: raw.pillar,
    };
    const why = [];
    if (!r.title) why.push("no title");
    if (!publicHttps(r.source.url)) why.push("no public https source");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.key)) why.push("bad key");
    // Every evidence file inside the repo and there; a line number within the file.
    const bad = r.evidence.filter((e) => {
      if (e.startsWith("docs/ARCHITECTURE.md#")) return !fs.existsSync(path.join(base, "docs", "ARCHITECTURE.md"));
      const [, file, line] = /^([^:#]+)(?::(\d+))?/.exec(e) ?? [];
      const abs = file ? path.resolve(base, file) : "";
      if (!abs || !abs.startsWith(base + path.sep)) return true;
      try {
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

// 3. Records -----------------------------------------------------------------------

/** A recommendation's record body (Markdown). @param {Recommendation} r */
function bodyOf(r) {
  return [
    r.why, "",
    `**Next:** ${r.next_step}`,
    `**Evidence:** ${r.evidence.map((e) => `\`${e}\``).join(", ")}`,
    `**Source:** [${r.source.title.replace(/[[\]\\]/g, "")}](${r.source.url.replace(/[()\s<>]/g, (c) => encodeURIComponent(c))}) (${r.source.version_or_date})`,
    ...(r.decision_ids.length ? [`**Touches decisions:** ${r.decision_ids.join(", ")}`] : []),
  ].join("\n");
}

/** @param {Recommendation} r @param {number} at */
const linksOf = (r, at) => ({
  best: { key: r.key, pillar: r.pillar, component: r.component, severity: r.severity, source: r.source, evidence: r.evidence, next_step: r.next_step, decision_ids: r.decision_ids, seen: at },
});

/**
 * The write plan, pure: new keys added, found ones refreshed (open or done, never
 * dismissed), the rest left as they are.
 * @param {Recommendation[]} recs @param {Array<{id: number, status: string, links?: any}>} records
 */
function reconcileBest(recs, records) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  // A key is the pillar's: two pillars may name the same key for different things.
  const id = (/** @type {any} */ b) => `${b.pillar ?? ""}:${b.key}`;
  for (const r of records) if (r.links?.best?.key) byKey.set(id(r.links.best), r);
  /** @type {{add: Recommendation[], refresh: Array<{id: number, r: Recommendation}>, dismissed: number}} */
  const plan = { add: [], refresh: [], dismissed: 0 };
  const seen = new Set();
  for (const r of recs) {
    if (seen.has(id(r))) continue;
    seen.add(id(r));
    const rec = byKey.get(id(r));
    if (!rec) plan.add.push(r);
    else if (rec.status === "dropped") plan.dismissed++;
    else plan.refresh.push({ id: rec.id, r });
  }
  return plan;
}

/** "3 open (1 high, 2 medium) · 2 applied · 1 dismissed". @param {Array<{status: string, links?: any}>} records */
function summaryLine(records) {
  const recs = records.filter((r) => r.links?.best);
  const open = recs.filter((r) => r.status === "open");
  const sev = ["high", "medium", "low"].map((s) => [s, open.filter((r) => r.links.best.severity === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`);
  const done = recs.filter((r) => r.status === "done").length;
  const dropped = recs.filter((r) => r.status === "dropped").length;
  return [`${open.length} open${sev.length ? ` (${sev.join(", ")})` : ""}`, done && `${done} applied`, dropped && `${dropped} dismissed`].filter(Boolean).join(" · ");
}

/** The source map's record: a note of the BEST task, its map in links. @param {any} db @param {number} taskId */
function sourceMapRecord(db, taskId) {
  return db.recordsOf(taskId).find((/** @type {any} */ r) => r.kind === "note" && r.links?.bestSources);
}

/**
 * A whole review of a repo: the source map (built when missing or asked), then the
 * pillars in parallel, the gate, and one write.
 * @param {any} db @param {string} root
 * @param {{pillars?: string[], refreshSources?: boolean, budget?: number, lang?: string, ask?: typeof askClaude, fetchFn?: typeof fetch,
 *   progress?: (msg: string) => void, now?: number}} [o]
 */
async function review(db, root, { pillars = Object.keys(PILLARS), refreshSources = false, budget = 1.5, lang = "English", ask = askClaude, fetchFn = fetch, progress = () => {}, now = Date.now() } = {}) {
  const repo = db.repoOf(root);
  const ctx = projectContext(db, repo.id);
  let task = db.taskByKey(repo.id, TASK);
  let cost = 0;
  /** @type {SourceMap | undefined} */
  let map = task ? sourceMapRecord(db, task.id)?.links.bestSources : undefined;
  if (!map || refreshSources) {
    progress("Building the source map");
    const built = await buildSourceMap(root, ctx, { budget, ask, fetchFn });
    map = built.map;
    cost += built.cost;
    if (!map.components.length) throw new Error("the source map came back empty");
    const t = task ?? db.upsertTask(repo.id, TASK, { title: TASK_TITLE, status: "active" }, ACTOR);
    task = t;
    const old = sourceMapRecord(db, t.id);
    const fields = { title: `Source map: ${map.components.length} components, ${map.components.reduce((n, c) => n + c.sources.length, 0)} sources`, body: mapBody(map), links: { bestSources: map } };
    if (old) db.updateRecord(old.id, fields, ACTOR);
    else db.addRecord(t.id, { kind: "note", ...fields }, ACTOR);
  }
  const before = task ? db.recordsOf(task.id, { dropped: true }) : [];
  progress(`Reviewing ${pillars.join(", ")}`);
  const runs = await Promise.all(pillars.map(async (p) => {
    const keys = before.filter((/** @type {any} */ r) => r.links?.best?.pillar === p).map((/** @type {any} */ r) => r.links.best.key);
    const m = /** @type {SourceMap} */ (map);
    const servers = ["context7", ...new Set(m.components.flatMap((c) => c.sources.filter((s) => s.kind === "mcp").map((s) => s.ref)))];
    // WebFetch only to the map's hosts, no web search: repo content cannot be sent anywhere else.
    const fetchDomains = [...new Set(m.components.flatMap((c) => c.sources.filter((s) => s.kind === "url" && publicHttps(s.ref)).map((s) => new URL(s.ref).hostname)))];
    try {
      const { out, cost: c } = await ask(pillarPrompt(p, m, ctx, keys, lang), REC_SCHEMA, { cwd: root, servers, budget, fetchDomains });
      return { pillar: p, recs: /** @type {Recommendation[]} */ ((Array.isArray(out?.recommendations) ? out.recommendations : []).map((/** @type {any} */ r) => ({ ...r, pillar: p }))), cost: c };
    } catch (e) {
      return { pillar: p, recs: [], cost: Number(/** @type {any} */ (e)?.cost ?? 0), error: e instanceof Error ? e.message : String(e) };
    }
  }));
  cost += runs.reduce((n, r) => n + r.cost, 0);
  if (runs.every((r) => r.error)) throw new Error(`every pillar failed ($${cost.toFixed(2)} spent): ${runs.map((r) => `${r.pillar}: ${r.error}`).join("; ")}`);
  const ran = runs.filter((r) => !r.error).map((r) => r.pillar);
  const { kept, dropped } = gate(runs.flatMap((r) => r.recs), root, new Set(ctx.decisions.map((d) => d.id)));
  const result = db.tx(() => {
    const t = db.taskByKey(repo.id, TASK) ?? db.upsertTask(repo.id, TASK, { title: TASK_TITLE, status: "active" }, ACTOR);
    const plan = reconcileBest(kept, db.recordsOf(t.id, { dropped: true }));
    for (const r of plan.add) db.addRecord(t.id, { kind: "todo", title: r.title.slice(0, 300), body: bodyOf(r), links: linksOf(r, now) }, ACTOR);
    for (const { id, r } of plan.refresh) db.updateRecord(id, { title: r.title.slice(0, 300), body: bodyOf(r), links: linksOf(r, now) }, ACTOR);
    // The run's time on the source map: a recommendation seen before it was not seen now.
    const m = sourceMapRecord(db, t.id);
    // Per pillar, and only those that ran: a failed pillar's recommendations are not "unseen".
    const lastRun = { ...(typeof m?.links.bestSources.lastRun === "object" ? m.links.bestSources.lastRun : {}), ...Object.fromEntries(ran.map((p) => [p, now])) };
    if (m) db.updateRecord(m.id, { links: { ...m.links, bestSources: { ...m.links.bestSources, lastRun } } }, ACTOR);
    const line = summaryLine(db.recordsOf(t.id, { dropped: true }));
    if (t.summary !== line) db.upsertTask(repo.id, TASK, { summary: line }, ACTOR);
    return { added: plan.add.length, refreshed: plan.refresh.length, dismissed: plan.dismissed, summary: line };
  });
  return { ...result, kept: kept.length, dropped, cost, pillars: runs.map((r) => ({ pillar: r.pillar, proposed: r.recs.length, cost: r.cost, ...(r.error ? { error: r.error } : {}) })), components: map.components.length };
}

/** The source map as Markdown, for its record's body. @param {SourceMap} map */
function mapBody(map) {
  const lines = map.components.map((c) => `- **${c.name}** (${c.version}): ${c.sources.map((s) => (s.kind === "url" ? `[${new URL(s.ref).host}${new URL(s.ref).pathname}](${s.ref})` : `${s.kind} \`${s.ref}\``)).join(", ")}`);
  if (map.missing.length) lines.push("", "**Tools that would help:**", ...map.missing.map((m) => `- ${m.component}: ${m.suggestion}`));
  return lines.join("\n");
}

/** The prose language: imprimatur.language / IMPRIMATUR_LANG, else English. */
function proseLang() {
  try {
    return require("./config.js").hookLang() || "English";
  } catch {
    return "English";
  }
}

module.exports = {
  TASK, ACTOR, CATALOG, PILLARS, REASONS, MODEL, askClaude, projectContext, buildSourceMap, checkSource, context7For, baseName, gate, reconcileBest,
  summaryLine, bodyOf, linksOf, review, mapBody, proseLang, sourceMapRecord, run, childEnv, publicHttps, DENY,
};
