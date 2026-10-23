// @ts-check
// Process checks (#56): what dev-workflow used to copy into every repo as
// .claude/hooks/*.sh, run once from Imprimatur's global hook (hooks/process.mjs).
// A repo turns them on with a committed .claude/imprimatur.json; without the
// file nothing here runs. Each check is "block" (stop the tool or the turn),
// "warn" (tell the agent, go on) or false (off); a missing key takes DEFAULTS.
//
//   SessionStart        whereWeLeftOff  the repo's unfinished tasks and their 👉, from the database
//   PreToolUse Bash     hookBypass      git --no-verify, commit -n, HUSKY=0
//   PreToolUse edits    mainGuard       on main, only the allowed paths are edited
//                       designFirst     on a <type>/<n>-… branch, code before the task has an ADR or PDR
//   PostToolUse edits   docsToc         docs/**/*.md changed: run the repo's TOC script
//                       unopenedSources a docs/market-research file with sources marked "not opened" / "açılmadı"
//   PostToolUse Bash    issueCreate     after gh issue create: epic, board, milestone, Imprimatur task
//                       issueFields     …and checks the new issue's milestone and board item
//   PostToolUse MCP     sweep           a task set done: its GitHub issue still open (not while tracker sync, #70, runs)
//   Stop                status          the answer has no "Neredeyiz" section
//   SessionStart, Bash  branchFinish    (after git merge/switch/checkout/pull) merged branches left behind
//   PostToolUse MCP,    docUpdate       an ADR/PDR/decision added or changed (record_add/record_update) that no design
//   Stop, next event                    document section links, or whose sections did not change after it (#74; a
//                                       decision only once linked): told to the agent at its next tool call or session start
//   SessionStart        (always)        a repo never backfilled: its documents and glossary written once, in the
//                                       background (docs-backfill.js), with or without .claude/imprimatur.json
//   SessionStart,       docSync         the design documents and their Markdown files synced (docs-sync.js, #73):
//   PostToolUse edits                   adoptions, edits taken in and conflicts told to the agent

"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CONFIG = path.join(".claude", "imprimatur.json");

/** What a key left out of the file means. */
const DEFAULTS = {
  whereWeLeftOff: true,
  hookBypass: "block",
  mainGuard: { mode: "block", branch: "main", allow: ["^docs/"] },
  designFirst: "warn",
  docsToc: { mode: "warn", script: "scripts/docs-toc.mjs" },
  unopenedSources: "warn",
  issueCreate: "warn",
  issueFields: "warn",
  sweep: "warn",
  status: { mode: "block", word: "neredeyiz" },
  branchFinish: "warn",
  docUpdate: "warn",
  docSync: "warn",
};

/** The git root at or above a directory, by its .git entry (no git process). @param {string} dir */
function repoOf(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/**
 * The repo's process settings, or undefined when it has no .claude/imprimatur.json.
 * A check is {mode, …}: mode "block" | "warn" | false.
 * @param {string} root @returns {Record<string, any> | undefined}
 */
function settingsOf(root) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG), "utf8"));
  } catch {
    return undefined;
  }
  // Only the repo's language (#80, config.js repoLang): the checks stay off.
  if (raw && typeof raw === "object" && Object.keys(raw).length && Object.keys(raw).every((k) => k === "lang")) return undefined;
  const given = raw?.process ?? {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = key in given ? given[key] : def;
    const base = typeof def === "object" ? def : { mode: def };
    if (v === false || v === "off") out[key] = { ...base, mode: false };
    else if (v === true) out[key] = { ...base, mode: base.mode === true ? true : base.mode };
    else if (typeof v === "string") out[key] = { ...base, mode: v };
    else out[key] = { ...base, ...v };
  }
  return out;
}

/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

/** @param {string[]} args @param {string} cwd */
const gh = (args, cwd) => {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 10000 });
  return r.status === 0 ? r.stdout : undefined;
};

/** Text for the agent: a block message or a warning, each a short line with its rule. @param {string} name @param {string} text */
const say = (name, text) => `Imprimatur (${name}): ${text}`;

const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
/**
 * Does a shell command skip git hooks? Per simple command (split on newlines, ;, &, |):
 * a git call with --no-verify, a git commit with -n (alone or in a flag group: -an),
 * or HUSKY=0 before git. Heredoc bodies and quoted text are not commands.
 * @param {string} command
 */
function bypasses(command) {
  const text = String(command ?? "")
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(\n|$)/g, "\n")
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  return text.split(/[\n;&|]+/).some((part) => {
    const words = part.trim().split(/\s+/);
    let i = 0;
    let husky = false;
    // Leading assignments: HUSKY=0 git …
    while (i < words.length && /^\w+=/.test(words[i])) husky ||= /^HUSKY=0$/.test(words[i++]);
    if (words[i] !== "git") return false;
    const rest = words.slice(i + 1);
    if (husky || rest.includes("--no-verify")) return true;
    const sub = rest.find((w) => !w.startsWith("-"));
    return sub === "commit" && rest.some((w) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w));
  });
}
const ISSUE_CREATE = /(^|[;&|(]|\$\()\s*gh\s+issue\s+create|gh\s+api\s+\S*repos\/\S+\/issues\b.*-f\s+title=/;

/**
 * A tool's path relative to the repo: relative paths against the hook's cwd, links resolved.
 * undefined for a path that is not a POSIX path (C:\\…). @param {string} root @param {string | undefined} cwd @param {string} file
 */
function relOf(root, cwd, file) {
  if (/^[A-Za-z]:[\\/]/.test(file)) return undefined;
  const abs = path.resolve(cwd ?? root, file);
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      // A new file: its folder's real path.
      try {
        return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
      } catch {
        return p;
      }
    }
  };
  return path.relative(real(root), real(abs));
}

/** Repos whose own scripts the user allowed (by the VS Code command): a file outside every repo. */
const TRUSTED = () => path.join(path.dirname(require("./db.js").dbPath()), "trusted-repos.json");

/** @param {string} root */
function isTrusted(root) {
  try {
    return JSON.parse(fs.readFileSync(TRUSTED(), "utf8")).includes(fs.realpathSync(root));
  } catch {
    return false;
  }
}

/** Adds a repo to the trusted list. @param {string} root */
function trust(root) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(TRUSTED(), "utf8"));
  } catch {}
  const real = fs.realpathSync(root);
  if (list.includes(real)) return;
  fs.mkdirSync(path.dirname(TRUSTED()), { recursive: true });
  fs.writeFileSync(TRUSTED(), JSON.stringify([...list, real], null, 2) + "\n");
}

/** A repo script path from settings: an existing file inside the repo (links resolved), never a flag. @param {string} root @param {any} rel */
function scriptIn(root, rel) {
  if (typeof rel !== "string" || !rel || rel.startsWith("-")) return undefined;
  try {
    const real = fs.realpathSync(path.resolve(root, rel));
    const inside = path.relative(fs.realpathSync(root), real);
    return !inside.startsWith("..") && !path.isAbsolute(inside) && fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** JSON from a command's output, or undefined. @param {string | undefined} text */
const parse = (text) => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

/** Per-session notes of the checks (.claude/imprimatur/process.json): warned once, issues opened. */
const STATE = path.join(".claude", "imprimatur", "process.json");
/** @param {string} root */
const readState = (root) => parse(fs.existsSync(path.join(root, STATE)) ? fs.readFileSync(path.join(root, STATE), "utf8") : "") ?? {};
/** @param {string} root @param {any} state */
const writeState = (root, state) => {
  // Only the latest sessions are kept.
  const keep = Object.fromEntries(Object.entries(state).slice(-20));
  fs.mkdirSync(path.dirname(path.join(root, STATE)), { recursive: true });
  fs.writeFileSync(path.join(root, STATE), JSON.stringify(keep));
};
/** True the first time a session asks for this key. @param {string} root @param {string | undefined} session @param {string} key */
function once(root, session, key) {
  if (!session) return true;
  const state = readState(root);
  const seen = state[session]?.once ?? [];
  if (seen.includes(key)) return false;
  writeState(root, { ...state, [session]: { ...state[session], once: [...seen, key] } });
  return true;
}
/** @param {string} root @param {string | undefined} session @param {string} list @param {string} value */
function remember(root, session, list, value) {
  if (!session) return;
  const state = readState(root);
  writeState(root, { ...state, [session]: { ...state[session], [list]: [...new Set([...(state[session]?.[list] ?? []), value])] } });
}
/** The session's list, emptied. @param {string} root @param {string | undefined} session @param {string} list @returns {string[]} */
function take(root, session, list) {
  if (!session) return [];
  const state = readState(root);
  const got = state[session]?.[list] ?? [];
  if (got.length) writeState(root, { ...state, [session]: { ...state[session], [list]: [] } });
  return got;
}

/** Every session's list, emptied (SessionStart: what earlier sessions left). @param {string} root @param {string} list @returns {string[]} */
function takeAll(root, list) {
  const state = readState(root);
  const got = [...new Set(Object.values(state).flatMap((v) => /** @type {any} */ (v)?.[list] ?? []))];
  if (got.length) writeState(root, Object.fromEntries(Object.entries(state).map(([k, v]) => [k, { .../** @type {any} */ (v), [list]: [] }])));
  return got;
}

/**
 * The ADR or PDR a record_add or record_update call wrote, from the database: the new
 * record's id is in the tool's answer ("Added [12] adr/…", or its structured record), else
 * found by kind and title. A change of status or 👉 alone is not a design change.
 * @param {string} name @param {any} input @param {any} records @param {string} root
 */
function designRecordOf(name, input, records, root) {
  try {
    const db = records.dbOf?.();
    if (!db) return undefined;
    const ti = input.tool_input ?? {};
    let id;
    if (name === "record_update") {
      if (!["title", "body", "kind"].some((k) => k in ti)) return undefined;
      id = Number(ti.id);
    } else {
      const r = input.tool_response;
      const text = typeof r === "string" ? r : JSON.stringify(r ?? "");
      id = Number(/Added \[(\d+)\]/.exec(text)?.[1] ?? /"record"\s*:\s*\{[^{}]*?"id"\s*:\s*(\d+)/.exec(text)?.[1] ?? NaN);
      if (!Number.isInteger(id) && /^(adr|pdr|decision)$/.test(ti.kind ?? "")) {
        const repo = records.repoId(root);
        id = repo === undefined ? undefined : db.recordsByKind(repo, [ti.kind], { limit: 50 }).find((/** @type {any} */ x) => x.title === String(ti.title ?? "").trim())?.id;
      }
    }
    const rec = Number.isInteger(id) ? db.record(id) : undefined;
    return rec && DESIGN_KINDS.includes(rec.kind) ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** Records whose change the design documents follow (#72; decision, #74). */
const DESIGN_KINDS = ["adr", "pdr", "decision"];

/**
 * The remembered "id:verb" notes whose record still exists and the documents have not
 * followed (#74): an ADR or PDR no section links ("unlinked"), or one whose sections all
 * changed last before the record did ("stale"). A decision is followed only once a section
 * links it: not every decision is a design one.
 * @param {any} records @param {string[]} notes
 * @returns {Array<{id: number, kind: string, verb: string, note: string, why: "unlinked" | "stale", sections: string[]}>}
 */
function unlinked(records, notes) {
  if (!notes.length) return [];
  try {
    const db = records.dbOf?.();
    if (!db) return [];
    const out = [];
    for (const note of new Set(notes)) {
      const [id, verb] = note.split(":");
      const rec = db.record(Number(id));
      if (!rec || rec.status === "dropped" || !DESIGN_KINDS.includes(rec.kind)) continue;
      const secs = db.sectionsOfRecord(rec.id).filter((/** @type {any} */ s) => s.status === "current");
      const base = { id: rec.id, kind: rec.kind, verb: verb || "added", note };
      if (!secs.length) {
        if (rec.kind !== "decision") out.push({ ...base, why: /** @type {const} */ ("unlinked"), sections: [] });
      } else if (Math.max(...secs.map((/** @type {any} */ s) => s.updated_at)) < rec.updated_at) {
        out.push({ ...base, why: /** @type {const} */ ("stale"), sections: secs.map((/** @type {any} */ s) => `${s.doc_kind}/${s.key}`) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** @param {{id: number, kind: string, verb: string, why: string, sections: string[]}} l */
const docLine = (l) => {
  const label = l.kind === "adr" ? "ADR" : l.kind === "pdr" ? "PDR" : "Decision";
  if (l.why === "stale") {
    return `${label} #${l.id} ${l.verb}, but the section it is linked to (${l.sections.join(", ")}) has not changed since: update the section text from the record with doc_section_upsert.`;
  }
  const arch = l.kind === "adr";
  return `${label} #${l.id} ${l.verb}, but the ${arch ? "architecture" : "product"} document was not updated: write the relevant section and link the record with doc_section_upsert {kind: "${arch ? "architecture" : "product"}", key, title, body, records: [${l.id}]}.`;
};

/**
 * Branches already in main, other than main and the one checked out, touched in the last 14
 * days, that someone committed on: the merge happened, the delete did not.
 * @param {string} root @param {string} main @param {typeof git} run
 */
function leftBranches(root, main, run) {
  const current = run(["symbolic-ref", "--short", "HEAD"], root);
  const since = Date.now() / 1000 - 14 * 86400;
  return (run(["for-each-ref", "--merged", main, "--format=%(refname:short) %(committerdate:unix)", "refs/heads"], root) ?? "")
    .split("\n")
    .map((l) => l.split(" "))
    .filter(([name, at]) => name && name !== main && name !== current && Number(at) > since)
    .map(([name]) => name)
    // A branch nobody committed on is new, not merged (a --ff-only merge leaves both at one commit).
    .filter((name) => /^commit/m.test(run(["reflog", "show", "--format=%gs", name], root) ?? ""));
}

/** The issue a branch is for: feat/56-process → 56. @param {string | undefined} branch */
const issueOfBranch = (branch) => /^[a-z]+\/(\d+)-/.exec(branch ?? "")?.[1];

/**
 * Runs the checks for one hook event.
 * @param {string} event Claude Code's hook_event_name
 * @param {any} input the hook's JSON input
 * @param {{records?: any, git?: typeof git, gh?: typeof gh}} [deps] for tests
 * @returns {{block?: string, context?: string[], notice?: string[]}} block: stop with this reason;
 *   context: lines for the agent; notice: lines for the user (Stop)
 */
function check(event, input, deps = {}) {
  const run = deps.git ?? git;
  const ghRun = deps.gh ?? gh;
  const root = repoOf(input.cwd ?? process.cwd());
  if (!root) return {};
  // The design documents written once for a repo that never had them (docs-backfill.js):
  // every known repo, with or without .claude/imprimatur.json.
  if (event === "SessionStart") {
    try {
      const records = deps.records ?? require("./records.js");
      const id = records.repoId(root);
      if (id !== undefined) require("./docs-backfill.js").maybeStart(records.dbOf(), id, root, deps.backfill);
      // Past sessions' analyses, once per repo (analysis-backfill.js).
      if (id !== undefined) require("./analysis-backfill.js").maybeStart(records.dbOf(), id, root, deps.analysisBackfill);
    } catch {}
  }
  // A task's analysis (analysis.js): the Markdown file just written, or the plan the agent
  // leaves plan mode with; every known repo, with or without .claude/imprimatur.json.
  if (event === "PostToolUse" && (/^(Edit|Write|MultiEdit)$/.test(input.tool_name ?? "") || input.tool_name === "ExitPlanMode")) {
    try {
      const records = deps.records ?? require("./records.js");
      const id = records.repoId(root);
      const a = require("./analysis.js");
      const ti = input.tool_input ?? {};
      const plan = input.tool_name === "ExitPlanMode";
      const file = plan ? undefined : ti.file_path && path.resolve(input.cwd ?? root, ti.file_path);
      const rel = plan ? `plan:${String(input.session_id ?? "").slice(0, 8) || "x"}` : file && a.relPath(root, file);
      // A file over 1 MB is left to the backfill: the hook stays quick.
      const small = (/** @type {string} */ f) => fs.statSync(f).size <= 1_000_000;
      const text = plan ? (typeof ti.plan === "string" ? ti.plan : undefined) : rel && /\.mdx?$/i.test(rel) && small(file) ? fs.readFileSync(file, "utf8") : undefined;
      if (id !== undefined && rel && text !== undefined) {
        const session = input.session_id || undefined;
        const branch = (deps.git ?? git)(["symbolic-ref", "--short", "HEAD"], root);
        a.onEdit(records.dbOf(), id, root, { rel, text, session, branch, at: Date.now(), actor: { kind: "hook", id: session } }, deps.analysis);
      }
    } catch {}
  }
  // The repo's language (#80, .claude/imprimatur.json "lang"): what the agent writes here. Said
  // with or without process settings: "lang" alone does not turn the checks on.
  const ownLang = event === "SessionStart" ? require("./config.js").ownLang(root) : undefined;
  const langLine = ownLang && say("repoLang", `write this repo's records, design documents, code comments and commit messages in ${ownLang}; replies to the user stay in the user's language.`);
  const s = settingsOf(root);
  if (!s) return langLine ? { context: [langLine] } : {};
  /** @type {string[]} */ const context = langLine ? [langLine] : [];
  /** @type {string[]} */ const notice = [];
  /** @type {string | undefined} */ let block;
  /** A finding: block, or tell. @param {{mode: any}} c @param {string} name @param {string} text @param {string[]} [to] */
  const found = (c, name, text, to = context) => {
    if (c.mode === "block" && !block) block = say(name, text);
    else if (c.mode) to.push(say(name, text));
  };
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const branch = () => run(["symbolic-ref", "--short", "HEAD"], root);


  if (event === "SessionStart" && s.whereWeLeftOff.mode) {
    const records = deps.records ?? require("./records.js");
    const id = records.repoId(root);
    const tasks = id === undefined ? [] : records.dbOf().whereWeLeftOff(id);
    // Claude Code cuts SessionStart context at 10,000 characters to a 2,000-character preview:
    // short lines, and well under the cap.
    const cut = (t, n) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const lines = ["Where we left off (Imprimatur; read and write records with the imprimatur MCP tools; task_get for a task's records):"];
    let size = lines[0].length;
    for (const t of tasks.slice(0, 15)) {
      const line = `- ${t.key}${t.title ? ` ${cut(t.title, 80)}` : ""} [${t.status}]${t.pointer_title ? ` 👉 ${cut(t.pointer_title, 100)}` : ""}${t.open_records ? ` (${t.open_records} open)` : ""}`;
      if (size + line.length > 4000) break;
      lines.push(line);
      size += line.length + 1;
    }
    context.push(tasks.length ? lines.join("\n") : "No unfinished tasks in Imprimatur for this repo. Record work with the imprimatur MCP tools (task_upsert, record_add, pointer_set).");
    // Design documents that need attention (#74): records no section links, conflicts with the file.
    try {
      const problem = id === undefined ? undefined : require("./docs-sync.js").health(records.dbOf(), id).problem;
      if (problem) context.push(problem);
    } catch {}
  }

  // Design documents ↔ their files (#73): at session start (a hand-written file adopted, a
  // file edited outside a session taken in), and right after the agent edits one of the files.
  const edited = event === "PostToolUse" && EDITS.test(tool) && (ti.file_path || ti.notebook_path) ? relOf(root, input.cwd, ti.file_path ?? ti.notebook_path) : undefined;
  const docEdit = edited !== undefined && Object.keys(require("./docs-export.js").FILES).some((k) => path.relative(root, require("./docs-export.js").fileOf(root, k)) === edited);
  if (s.docSync.mode && (event === "SessionStart" || docEdit) && require("./docs-export.js").syncOn(root)) {
    try {
      const records = deps.records ?? require("./records.js");
      const db = records.dbOf();
      const { syncDocs, describe } = require("./docs-sync.js");
      const busy = (db ? syncDocs(db, root) : []).filter((r) => r.adopted || r.imported.length || r.superseded.length || r.conflicts.length || r.skipped);
      if (busy.length) found(s.docSync, "docSync", `design documents synced with their files: ${describe(busy, root).join(" · ")}`);
    } catch (e) {
      found(s.docSync, "docSync", `design documents not synced: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Merged branches left behind go to the agent, who can delete them: at session start, and
  // after a command that merges or switches branches. (A Stop warning reaches only the user.)
  const branchMove = event === "PostToolUse" && tool === "Bash" && /\bgit\s+(merge|switch|checkout|pull)\b/.test(ti.command ?? "");
  if (s.branchFinish.mode && (event === "SessionStart" || branchMove)) {
    const main = s.mainGuard.branch ?? "main";
    const left = leftBranches(root, main, run);
    if (left.length) found(s.branchFinish, "branchFinish", `merged into ${main} but not deleted: ${left.join(", ")}. Delete them: git branch -d ${left.join(" ")}.`);
  }

  if (event === "PreToolUse" && tool === "Bash" && s.hookBypass.mode && bypasses(ti.command)) {
    found(s.hookBypass, "hookBypass", "git hooks are not skipped (--no-verify, -n, HUSKY=0). If a hook rejects wrongly, fix the hook.");
  }

  if (event === "PreToolUse" && EDITS.test(tool) && (ti.file_path || ti.notebook_path)) {
    const rel = relOf(root, input.cwd, ti.file_path ?? ti.notebook_path);
    const inside = rel !== undefined && !rel.startsWith("..") && !path.isAbsolute(rel);
    const ignored = () => run(["check-ignore", "-q", rel], root) !== undefined;
    if (inside && (s.mainGuard.mode || s.designFirst.mode)) {
      const b = branch();
      const allowed = (s.mainGuard.allow ?? []).some((re) => new RegExp(re).test(rel.split(path.sep).join("/")));
      if (s.mainGuard.mode && b === s.mainGuard.branch && !allowed && !ignored()) {
        found(s.mainGuard, "mainGuard", `on ${b}, only ${(s.mainGuard.allow ?? []).join(", ") || "nothing"} is edited. Create a branch first: git switch -c <type>/<issue>-<short-name>. File: ${rel}`);
      }
      const n = issueOfBranch(b);
      if (s.designFirst.mode && n && !allowed) {
        const records = deps.records ?? require("./records.js");
        // Only code (not Markdown), and only when the database knows the task: no answer is no warning.
        const known = !/\.(md|mdx|txt)$/i.test(rel) && records.repoId(root) !== undefined && records.task?.(root, `#${n}`) !== undefined;
        // The task's own ADR/PDR, or one anywhere in the repo that names the issue (links.issue,
        // or "#n" in its text): imported design records live under the ADR and PDR tasks.
        const names = (r) => Number(r.links?.issue) === Number(n) || new RegExp(`#${n}(?!\\d)`).test(`${r.title}\n${r.body ?? ""}`);
        const designed = known && (records.recordsOf(root, `#${n}`).some((r) => r.kind === "adr" || r.kind === "pdr")
          || (records.dbOf()?.recordsByKind(records.repoId(root), ["adr", "pdr"]) ?? []).some(names));
        if (known && !designed && once(root, input.session_id, `design #${n}`)) {
          found(s.designFirst, "designFirst", `#${n} has no ADR or PDR record yet. A change in behaviour starts with its design: record_add kind "pdr" (what the user sees) or "adr" (how it is built), then the code. File: ${rel}`);
        }
      }
    }
  }

  if (event === "PostToolUse" && EDITS.test(tool) && ti.file_path && relOf(root, input.cwd, ti.file_path) !== undefined) {
    const rel = /** @type {string} */ (relOf(root, input.cwd, ti.file_path)).split(path.sep).join("/");
    // The TOC script is the repo's code: it runs only in repos the user trusted (outside the repo).
    const script = s.docsToc.mode && /^docs\/.*\.md$/.test(rel) ? scriptIn(root, s.docsToc.script) : undefined;
    if (script && isTrusted(root)) {
      const r = spawnSync(process.execPath, ["--", script], { cwd: root, encoding: "utf8", timeout: 10000 });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      if (out) context.push(say("docsToc", out));
    } else if (script && once(root, input.session_id, "untrusted")) {
      context.push(say("docsToc", `not run: this repo is not trusted to run ${s.docsToc.script}. The user can trust it with "Imprimatur: Turn On Process Checks for This Repo".`));
    }
    if (s.unopenedSources.mode && /^docs\/market-research\//.test(rel)) {
      try {
        if (/açılmadı|not opened/i.test(fs.readFileSync(path.join(root, rel), "utf8"))) {
          found(s.unopenedSources, "unopenedSources", `${path.basename(rel)} has sources marked "not opened" ("açılmadı"). Open them now (WebFetch); only an HTTP error is written, as "açılamadı: 403".`);
        }
      } catch {}
    }
  }

  if (event === "PostToolUse" && tool === "Bash" && ISSUE_CREATE.test(ti.command ?? "")) {
    if (s.issueCreate.mode) {
      found(s.issueCreate, "issueCreate", "new issue: link it under its epic (sub-issue + 'Part of #N'), add it to the board with Status and Sprint, set priority and milestone, and open its Imprimatur task (task_upsert, then record_add / pointer_set).");
    }
    // Its fields are set in the next steps: checked at the turn's end (Stop).
    const out = typeof input.tool_response === "string" ? input.tool_response : `${input.tool_response?.stdout ?? ""}`;
    const n = /\/issues\/(\d+)/.exec(out)?.[1];
    if (s.issueFields.mode && n) remember(root, input.session_id, "created", n);
  }

  // GitHub sync running (#70) and none of this repo's pushes stuck: the extension closes the issue.
  const trackerOn = () => {
    try {
      const records = deps.records ?? require("./records.js");
      return require("./tracker.js").githubSyncCovers(records.dbOf(), records.repoId(root));
    } catch {
      return false;
    }
  };
  if (event === "PostToolUse" && require("./config.js").imprimaturTool(tool) === "task_upsert" && s.sweep.mode && ti.status === "done" && /^#\d+$/.test(ti.key ?? "") && !trackerOn()) {
    if (parse(ghRun(["issue", "view", ti.key.slice(1), "--json", "state"], root))?.state === "OPEN") {
      found(s.sweep, "sweep", `${ti.key} is done in Imprimatur but its GitHub issue is open: close it (gh issue close ${ti.key.slice(1)} -c "…") and move its board item to Done.`);
    }
  }

  // Design documents (#72): an ADR or PDR the session added or changed is remembered; at Stop
  // the ones no document section links wait, and the agent hears of them at its next tool call
  // or session start (a Stop warning reaches only the user). "block" stops the Stop instead.
  if (s.docUpdate.mode) {
    const records = deps.records ?? require("./records.js");
    const name = require("./config.js").imprimaturTool(tool);
    if (event === "PostToolUse" && (name === "record_add" || name === "record_update")) {
      const rec = designRecordOf(name, input, records, root);
      if (rec) remember(root, input.session_id, "design", `${rec.id}:${name === "record_add" ? "added" : "updated"}`);
    }
    if (event === "Stop" && !input.stop_hook_active) {
      const left = unlinked(records, take(root, input.session_id, "design"));
      if (left.length && s.docUpdate.mode === "block") found(s.docUpdate, "docUpdate", left.map(docLine).join(" "));
      else for (const l of left) remember(root, input.session_id, "docTell", l.note);
    }
    if (event === "SessionStart" || event === "PreToolUse" || event === "PostToolUse") {
      // A new session hears what earlier ones left; a running one, its own.
      const notes = event === "SessionStart" ? takeAll(root, "docTell") : take(root, input.session_id, "docTell");
      for (const l of unlinked(records, notes)) found(s.docUpdate, "docUpdate", docLine(l));
    }
  }

  if (event === "Stop" && !input.stop_hook_active) {
    const msg = input.last_assistant_message ?? "";
    if (s.status.mode && msg && !msg.toLocaleLowerCase("tr").includes(String(s.status.word).toLocaleLowerCase("tr"))) {
      found(s.status, "status", `the answer has no "${s.status.word}" section: add what finished, open work and the next step.`, notice);
    }
    if (s.issueFields.mode) {
      for (const n of take(root, input.session_id, "created")) {
        const info = parse(ghRun(["issue", "view", n, "--json", "milestone,projectItems"], root));
        if (!info) continue;
        const missing = [!info.milestone && "milestone", !info.projectItems?.length && "board item", info.projectItems?.length && !info.projectItems.some((p) => p.status?.name) && "board Status"].filter(Boolean);
        if (missing.length) found(s.issueFields, "issueFields", `#${n}, opened this turn, has no ${missing.join(", ")}.`, notice);
      }
    }
  }
  return { ...(block && { block }), ...(context.length && { context }), ...(notice.length && { notice }) };
}

/**
 * What Claude Code reads back from a hook: exit code, stdout (JSON) and stderr.
 * @param {string} event @param {ReturnType<typeof check>} r
 * @returns {{code: number, stdout?: string, stderr?: string}}
 */
function reply(event, r) {
  // A block keeps the warnings: they go after its reason.
  if (r.block) return { code: 2, stderr: [r.block, ...(r.context ?? []), ...(r.notice ?? [])].join("\n") };
  const lines = [...(r.context ?? []), ...(r.notice ?? [])];
  if (!lines.length) return { code: 0 };
  // Stop has no context to add: a warning goes to the user.
  if (event === "Stop") return { code: 0, stdout: JSON.stringify({ systemMessage: lines.join("\n") }) };
  return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join("\n") } }) };
}

/** A repo's settings file with every check at its default, for "Turn On Process Checks". @param {{allow?: string[], branch?: string}} [o] */
function starterSettings({ allow, branch } = {}) {
  return {
    process: {
      ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, typeof v === "object" ? v.mode ?? v : v])),
      mainGuard: { mode: "block", branch: branch ?? DEFAULTS.mainGuard.branch, allow: allow ?? DEFAULTS.mainGuard.allow },
      docsToc: { mode: "warn", script: DEFAULTS.docsToc.script },
      status: { mode: "block", word: DEFAULTS.status.word },
    },
  };
}

module.exports = { check, reply, settingsOf, starterSettings, repoOf, issueOfBranch, bypasses, trust, isTrusted, scriptIn, DEFAULTS, CONFIG };
