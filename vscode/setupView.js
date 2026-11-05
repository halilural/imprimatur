// @ts-check
// The Imprimatur side bar (activity bar icon), under the launcher (launcherView.js):
// "Agent setup": every file that shapes the agent, per repo
// and global, grouped by tool, marked new / changed / removed since the user
// last looked (Mark all as seen). Read only: it never edits the files.
"use strict";
const vscode = require("vscode");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { scanSetup, changesSince, snapshotOf, flatItems } = require("./agent-setup.js");
const { readUpstream, checkUpstream, staleOf } = require("./upstream.js");
const { recordVersions, versionLine } = require("./version-history.js");
const { checklistOf } = require("./setup-checklist.js");
/** The last click on a suggestion, for a double click (#143). */
let lastClick = { url: "", at: 0 };
/** @type {vscode.OutputChannel | undefined} Fix it's answers (#156). */
let fixOutput;
const { DriftScanner, driftLabel, DEFAULT_EXCLUDE } = require("./setup-drift.js");
const { SetupHistory, historyLines } = require("./setup-history.js");
const { trustGate } = require("./trust.js");
const { withScopes, inEffectFor, effectTree } = require("./setup-scope.js");
const { readSources, mergeSettings, mergedTree } = require("./setup-merged.js");

/** "For <active file>" (#28): what is in effect for the file, from the scope holding it. @param {any[]} scopes @param {string | undefined} file */
function forFileNode(scopes, file) {
  if (!file) return undefined;
  const repo = scopes.filter((s) => !s.global && !path.relative(s.root, file).startsWith("..") && !path.isAbsolute(path.relative(s.root, file))).sort((a, b) => b.root.length - a.root.length)[0];
  const glob = scopes.find((s) => s.global);
  const e = inEffectFor(file, { root: repo?.root ?? path.dirname(file), items: repo?.items ?? [], globalItems: glob?.items ?? [], hooks: repo?.merged?.hooks });
  return effectTree(e, path.basename(file));
}
const { checkHealth } = require("./setup-health.js");
const { recommendationsRow } = require("./setup-audit-tree.js");

const SEEN_KEY = "imprimatur.setupSeen";
const ICONS = {
  "Claude Code": "sparkle",
  Cursor: "symbol-event",
  "GitHub Copilot": "copilot",
  "Codex / AGENTS.md": "hubot",
  Gemini: "star-empty",
  Windsurf: "symbol-misc",
  Cline: "symbol-misc",
  Aider: "symbol-misc",
  "Git hooks": "git-commit",
  Other: "file",
};
/** A tool's files are grouped by kind (Skills, Agents, …) once it has this many and more than one kind. */
const GROUP_FROM = 4;
const KIND_NAMES = {
  settings: "Settings", "hook script": "Hook scripts", skill: "Skills", command: "Commands", agent: "Agents", rules: "Rules",
  "MCP servers": "MCP servers", "output style": "Output styles", plugin: "Plugins", prompt: "Prompts", "chat mode": "Chat modes",
  "git hook": "Git hooks", "commit rules": "Commit rules", ignore: "Ignore files", file: "Files",
};
/** Kinds in the order they show: what decides behaviour first. */
const KIND_ORDER = ["rules", "settings", "hook script", "skill", "agent", "command", "MCP servers", "plugin", "output style", "prompt", "chat mode", "ignore", "git hook", "commit rules", "file"];
const KIND_ICONS = { settings: "settings-gear", "hook script": "zap", skill: "mortar-board", command: "terminal", agent: "person", rules: "book", "MCP servers": "plug", "git hook": "git-commit", "commit rules": "checklist", ignore: "eye-closed" };

/**
 * @typedef {{type: "graph"} | {type: "scope", scope: Scope} | {type: "tool", scope: Scope, tool: string} | {type: "kind", scope: Scope, tool: string, kind: string}
 *   | {type: "file", scope: Scope, item: ReturnType<typeof scanSetup>[number], state?: string} | {type: "detail", text: string}
 *   | {type: "removed", scope: Scope, rel: string} | PlainNode
 *   | {type: "health"} | {type: "problem", scope: Scope, problem: ReturnType<typeof checkHealth>[number]}} Node
 * @typedef {{type: "group" | "leaf", label: string, description?: string, tooltip?: string, markdown?: boolean, icon?: string, color?: string, abs?: string,
 *   line?: number, context?: string, recordId?: number, command?: string, args?: any[], expanded?: boolean, children?: any[]}} PlainNode
 *   "For <file>", "Effective settings" and "Recommendations" rows, built by setup-scope.js / setup-merged.js / setup-audit-tree.js
 * @typedef {{id: string, label: string, root: string, global: boolean, merged?: ReturnType<typeof mergeSettings>,
 *   items: Array<ReturnType<typeof scanSetup>[number] & {scope?: {label: string}}>, state: Record<string, string>, removed: string[], health: ReturnType<typeof checkHealth>}} Scope
 */

/** A plain group / leaf row. @param {PlainNode} node @returns {vscode.TreeItem} */
function plainItem(node) {
  const T = vscode.TreeItemCollapsibleState;
  const it = new vscode.TreeItem(node.label, node.type === "group" ? (node.expanded || node.label.startsWith("For ") ? T.Expanded : T.Collapsed) : T.None);
  it.description = node.description;
  it.tooltip = node.markdown && node.tooltip ? new vscode.MarkdownString(node.tooltip) : node.tooltip;
  if (node.icon) it.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
  if (node.context) it.contextValue = node.context;
  if (node.command) it.command = { command: node.command, title: node.label, ...(node.args ? { arguments: node.args } : {}) };
  else if (node.type === "leaf" && node.abs) {
    const line = Math.max(0, (node.line ?? 1) - 1);
    it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(node.abs), ...(node.line ? [{ selection: new vscode.Range(line, 0, line, 0) }] : [])] };
  }
  return it;
}

class SetupView {
  /**
   * @param {vscode.ExtensionContext} ctx
   * @param {() => string[]} roots repo roots in the window
   * @param {() => {edits: number, waiting: number}} counts for the graph row
   */
  constructor(ctx, roots, counts) {
    this.ctx = ctx;
    this.roots = roots;
    this.counts = counts;
    /** @type {vscode.EventEmitter<Node | undefined>} */
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    /** @type {Scope[]} */
    this.scopes = [];
    /** @type {ReturnType<typeof installChecksNow> | undefined} the install checks of the last scan (#81) */
    this.installs = undefined;
    /** The checklist (#142) and who hears its count (the launcher). */
    this.checklist = checklistOf([], 0);
    /** @type {((count: number) => void) | undefined} */
    this.onScanned = undefined;
    /** @type {vscode.TreeView<Node> | undefined} */
    this.view = undefined;
    this.graph = { edits: 0, waiting: 0 };
    // Drift across repos (#31) and git history (#32): filled in after the scan, async.
    this.drift = new DriftScanner();
    this.history = new SetupHistory({
      allowed: trustGate(() => vscode.workspace.isTrusted, (msg) => console.log(`Imprimatur: ${msg}`)),
      lang: () => vscode.workspace.getConfiguration("imprimatur").get("language") || require("./config.js").hookLang() || "English",
    });
    this.extrasBusy = false;
    this.extrasAgain = false;
    /** @type {any} the Recommendations row (#77), from the AUDIT records */
    this.audit = undefined;
    this.auditing = false;
  }

  /**
   * Suggested for this repo (#143): plugins that fit its stack, from the last refresh; a stale
   * one is refreshed in the background (the catalog, gh for repo facts) and the view redrawn.
   * @param {string | undefined} root @returns {any}
   */
  suggestionsRow(root) {
    if (!root) return undefined;
    const c = suggestContext(root, this.ctx);
    const sg = require("./suggest.js");
    const claude = require("./fix-runner.js").claudeBin();
    if (claude && !this.suggesting) {
      this.suggesting = true;
      sg.refreshSuggestions({ root, projectDir: c.projectDir, components: c.components, installed: c.installed, file: c.file, claude, home: c.home,
        partsOf: c.partsOf, marketRepoOf: c.marketRepoOf, connected: c.connected, relevanceOf: c.relevanceOf, entries: c.entries, trusted: vscode.workspace.isTrusted })
        .then((ran) => ran && this.refresh())
        .catch(() => {})
        .finally(() => (this.suggesting = false));
    }
    const s = sg.readSuggestions(c.file);
    // Claude's verdicts (Ask Claude, the sparkle) apply by plugin, on top of the candidates.
    const ranked = sg.readSuggestions(c.rankedFile);
    /** @type {Map<string, {verdict: string, why: string, n: number}>} */
    const verdicts = new Map((ranked?.picks ?? []).map((/** @type {any} */ v, /** @type {number} */ n) => [v.id, { ...v, n }]));
    const hidden = hiddenSuggestions(this.ctx, root);
    // Technologies a recent prompt named and nothing installed covered (#144), this week, first.
    const asked = require("./on-demand.js").recentOnDemand(root).filter((x) => Date.now() - x.at < require("./on-demand.js").WEEK)
      .flatMap((x) => x.candidates.map((/** @type {any} */ cd) => ({ id: cd.id, name: String(cd.id).split("@")[0], description: cd.what, what: cd.what, installs: cd.installs, reads: cd.reads, flags: cd.flags ?? [], fits: [],
        source: "prompt", trigger: `a prompt on ${new Date(x.at).toISOString().slice(0, 10)} named ${x.key}, and nothing installed covers it` })));
    const all = [...asked, ...(s?.items ?? []).filter((/** @type {any} */ i) => !asked.some((a) => a.id === i.id))].filter((/** @type {any} */ i) => !c.installed.includes(i.id) && !hidden.has(i.id));
    const skipped = all.filter((/** @type {any} */ i) => verdicts.get(i.id)?.verdict === "skip");
    const items = all.filter((/** @type {any} */ i) => verdicts.get(i.id)?.verdict !== "skip")
      .map((/** @type {any} */ i, /** @type {number} */ n) => ({ i, n, v: verdicts.get(i.id) }))
      .sort((a, b) => (a.v ? a.v.n : 1000 + a.n) - (b.v ? b.v.n : 1000 + b.n));
    const extra = [
      ...(skipped.length ? [{ type: "leaf", label: `${skipped.length} Claude said to skip`, description: skipped.map((/** @type {any} */ i) => i.name).join(", "), icon: "circle-slash",
        tooltip: skipped.map((/** @type {any} */ i) => `${i.name}: ${verdicts.get(i.id)?.why}`).join("\n") }] : []),
      ...(hidden.size ? [{ type: "leaf", label: `${hidden.size} hidden by you`, description: "click to show them again", icon: "eye-closed", command: "imprimatur.setup.restoreSuggestions", args: [root] }] : []),
    ];
    if (!items.length)
      return { type: extra.length ? "group" : "leaf", label: "Suggested for this repo", context: "suggestions", icon: "extensions", children: extra,
        description: s ? "nothing fits beyond what is installed" : "looking…" };
    const k = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
    const stale = ranked && ranked.fingerprint !== s?.fingerprint;
    const SOURCE = { prompt: "named in a prompt", repo: "this repo turns it on", rule: "rule", words: "stack match" };
    return { type: "group", label: "Suggested for this repo", context: "suggestions", icon: "extensions",
      description: `${items.length} plugin${items.length === 1 ? "" : "s"}${ranked ? ` · Claude's verdicts of ${new Date(ranked.at).toISOString().slice(0, 10)}${stale ? " (the list changed since: ask again)" : ""}` : ""}`,
      tooltip: "Plugins for this repo, each with what put it here: the repo's own .claude/settings.json, a rule (a file, a dependency or a command this repo shows, matched against the marketplaces' relevance rules and Anthropic's claude-code-setup table), or its stack's words. The sparkle asks Claude to order them and say install, study or skip. Vetted by the rules of #128.",
      children: [...items.map(({ i, v }) => {
        const what = i.what ?? sg.whatOf(i.description);
        const trigger = i.trigger ?? `its name or purpose mentions ${(i.fits ?? []).join(", ")}`;
        const study = v?.verdict === "study";
        const facts = [`${k(i.installs)} installs`, i.gh && `★ ${k(i.gh.stars)}`, i.gh?.pushed && `pushed ${i.gh.pushed}`, i.gh && (i.gh.license || "no license"), !i.repo && "kept in the marketplace"].filter(Boolean).join(" · ");
        /** @param {string} label @param {string} description @param {string} icon */
        const line = (label, description, icon) => ({ type: "leaf", label, description, icon, tooltip: `${label}: ${description}` });
        // The page opens on a double click of the plugin's row; its lines say what it is.
        const open = typeof i.page === "string" && i.page.startsWith("https://github.com/") ? { command: "imprimatur.setup.openOnDoubleClick", args: [i.page] } : {};
        const tag = v ? v.verdict : /** @type {any} */ (SOURCE)[i.source] ?? "stack match";
        return {
          type: "group", label: i.name, icon: study ? "book" : i.flags.length ? "warning" : "extensions", color: i.flags.length && !study ? "problemsWarningIcon.foreground" : undefined,
          description: `${tag} · ${what}`,
          tooltip: `${i.id}\n\n${i.description}\n\nWhy here: ${trigger}${v ? `\nClaude: ${v.verdict}, ${v.why}` : ""}\nIt brings: ${i.brings?.length ? i.brings.join(", ") : i.reads}.${i.flags.length ? `\n\n⚠ ${i.flags.join("\n⚠ ")}` : ""}${i.repo ? `\n\ngithub.com/${i.repo}` : ""}`,
          context: study ? "suggestionStudy" : "suggestion", installId: i.id, repoRoot: root, flags: i.flags, reads: i.reads, study: study ? v?.why : undefined, ...open,
          children: [
            line("What it is", what || "no description", "info"),
            line("Why here", trigger, "lightbulb"),
            ...(v ? [line(`Claude: ${v.verdict}`, v.why, study ? "book" : "sparkle")] : []),
            line("It brings", i.brings?.length ? i.brings.join(", ") : i.reads, "package"),
            ...i.flags.map((/** @type {string} */ f) => ({ ...line("Check", f, "warning"), color: "problemsWarningIcon.foreground" })),
            line("Adoption", facts, "graph"),
          ],
        };
      }), ...extra] };
  }

  /** The open recommendations Claude Code loads, in every scanned scope, for Fix it (#156). */
  openFindings() {
    const db = require("./records.js").dbOf();
    if (!db) return [];
    return this.scopes.flatMap((s) => {
      const repo = db.repoByRoot(s.root);
      const task = repo && require("./recs.js").recsTask(db, repo.id);
      return task ? db.recordsOf(task.id).filter((/** @type {any} */ r) => r.status === "open" && ((r.links?.audit && r.links.audit.effect !== "inactive") || r.links?.best)) : [];
    });
  }

  /** The AUDIT records of the window's repos and of the home, as the Recommendations row (#77). */
  loadAudit() {
    try {
      const records = require("./records.js");
      const db = records.dbOf();
      if (!db) return void (this.audit = undefined);
      // RECS (#87): the old AUDIT / BEST records move into it the first time it is read.
      this.audit = recommendationsRow(this.scopes.map((s) => {
        const repo = db.repoByRoot(s.root);
        const task = repo && require("./recs.js").recsTask(db, repo.id);
        return { label: s.label, root: s.root, records: task ? db.recordsOf(task.id, { dropped: true }) : [], summary: task?.summary };
      }));
    } catch (e) {
      console.log(`Imprimatur: audit records: ${e instanceof Error ? e.message : e}`);
      this.audit = undefined;
    }
  }

  /** Drift and history for the scanned repos; redraws when they arrive. */
  async extras() {
    if (this.extrasBusy) return void (this.extrasAgain = true);
    this.extrasBusy = true;
    try {
      const cfg = vscode.workspace.getConfiguration("imprimatur.setup");
      const repos = this.scopes.filter((s) => !s.global);
      await this.drift.scan(repos.map((s) => s.root), { driftRoots: cfg.get("driftRoots") ?? ["~/projects"], exclude: cfg.get("driftExclude") ?? DEFAULT_EXCLUDE });
      for (const s of repos) await this.history.refresh(s.root, s.items.map((i) => i.rel));
      this.changed.fire(undefined);
    } catch {
    } finally {
      this.extrasBusy = false;
      if (this.extrasAgain) {
        this.extrasAgain = false;
        this.extras();
      }
    }
  }

  /** A file row's tooltip, with drift and history (and the last change explained, when known). @param {Extract<Node, {type: "file"}>} node @param {string} [explained] */
  fileTooltip(node, explained) {
    const { item, state } = node;
    const d = node.scope.global ? undefined : this.drift.driftFor(item.rel, item.abs);
    const lines = [`**${item.rel}** · ${item.tool} ${item.kind}${item.scope ? ` · ${item.scope.label}` : ""}${state ? ` · _${state} since you last looked_` : ""}`, item.summary];
    if (d) lines.push(`${driftLabel(d)}: ${d.others.map((v) => `${v.repos.join(", ")} (\`${v.hash.slice(0, 7)}\`)`).join(" · ")}`);
    // Git history only for a file in the repo: a plugin, a session row or auto memory has none.
    if (inRepo(node)) lines.push(historyLines(this.history.info(node.scope.root, item.rel), explained).join("  \n"));
    return new vscode.MarkdownString(lines.join("\n\n"));
  }

  /** Hover on a file: explain its last change (lazy, cached; not in an untrusted folder). @param {vscode.TreeItem} it @param {Node} node */
  async resolveTreeItem(it, node) {
    if (node.type === "file" && !it.tooltip) it.tooltip = this.fileTooltip(node, inRepo(node) ? await this.history.explain(node.scope.root, node.item.rel) : undefined);
    return it;
    /** @type {string | undefined} the active editor's file, for "For <file>" */
    this.activeFile = undefined;
  }

  /** Rescan every scope (cheap: a folder walk and small reads). */
  scan() {
    this.graph = this.counts();
    const seen = /** @type {Record<string, Record<string, string>>} */ (this.ctx.globalState.get(SEEN_KEY) ?? {});
    const home = os.homedir();
    const defs = [...this.roots().map((r) => ({ id: r, label: path.basename(r), root: r, global: false })), { id: "~", label: "Global (~)", root: home, global: true }];
    const upstreamFile = path.join(this.ctx.globalStorageUri.fsPath, "upstream.json");
    const upstream = readUpstream(upstreamFile);
    this.scopes = defs.map((d) => {
      const items = withScopes(scanSetup(d.root, { global: d.global, upstream }), { global: d.global });
      // First look at a scope: remember it, mark nothing.
      if (!seen[d.id]) {
        seen[d.id] = snapshotOf(items);
        this.ctx.globalState.update(SEEN_KEY, seen);
      }
      const merged = d.global ? undefined : mergeSettings(readSources({ root: d.root, home }));
      return { ...d, items, merged, ...changesSince(items, seen[d.id]), health: checkHealth(items, { root: d.root, global: d.global }) };
    });
    // Version history of plugins and hand-installed skills (#140): kept here, shown on the row.
    const versions = recordVersions(path.join(this.ctx.globalStorageUri.fsPath, "versions.json"),
      this.scopes.flatMap((s) => flatItems(s.items).flatMap((i) => (i.kind === "installed plugin"
        ? [{ key: `${s.id} ${i.rel}`, value: i.hash, since: i.details.find((d) => d.startsWith("installed "))?.slice(10) }]
        : i.origin ? [{ key: `${s.id} ${i.rel}`, value: i.origin.commit }] : []))),
      new Date().toISOString().slice(0, 10));
    for (const s of this.scopes)
      for (const i of flatItems(s.items)) {
        const line = versionLine(versions[`${s.id} ${i.rel}`]);
        if (line) i.details.push(line);
      }
    // Hand-installed skills' upstream (#140): checked in the background at most once a day, then shown.
    const origins = this.scopes.flatMap((s) => flatItems(s.items).flatMap((i) => (i.origin ? [i.origin] : [])));
    if (!this.checkingUpstream && staleOf(origins, upstream, Date.now()).length) {
      this.checkingUpstream = true;
      checkUpstream(origins, upstreamFile)
        .then((checked) => checked && this.refresh())
        .catch(() => {})
        .finally(() => (this.checkingUpstream = false));
    }
    const fresh = this.scopes.reduce((n, s) => n + Object.keys(s.state).length + s.removed.length, 0);
    this.loadAudit();
    // The checklist (#142): what needs doing, from the scan, the health check and the audit.
    this.installs = installChecksNow();
    this.budget = budgetRow(this.scopes.find((s) => !s.global)?.root);
    this.suggestions = this.suggestionsRow(this.scopes.find((s) => !s.global)?.root);
    const repoRoot = this.scopes.find((s) => !s.global)?.root;
    let baseline;
    try {
      baseline = repoRoot ? { root: repoRoot, items: require("./baseline.js").baselineOf(repoRoot, { trusted: vscode.workspace.isTrusted }) } : undefined;
    } catch {}
    let docs;
    try {
      const db = require("./records.js").dbOf();
      const repo = repoRoot && db?.repoByRoot(repoRoot);
      if (repo) docs = { noChapter: db.sectionsPerChapter(repo.id).filter((/** @type {any} */ c) => (c.kind === "architecture" || c.kind === "product") && !c.chapter).reduce((/** @type {number} */ a, /** @type {any} */ c) => a + c.n, 0) };
    } catch {}
    let agentRows = [];
    try {
      if (repoRoot) agentRows = require("./agent-files.js").agentRows(require("./agent-files.js").agentFiles(repoRoot));
    } catch {}
    this.checklist = checklistOf(this.scopes, /** @type {any} */ (this.audit)?.open ?? 0, this.installs, baseline, docs, agentRows);
    this.onScanned?.(this.checklist.count);
    this.extras();
    if (this.view) this.view.badge = fresh ? { value: fresh, tooltip: `${fresh} agent setup change${fresh === 1 ? "" : "s"} since you last looked` } : undefined;
  }

  refresh() {
    this.scan();
    this.changed.fire(undefined);
  }

  /** Only the graph row's counts (after an agent edit or a waiting record). */
  refreshCounts() {
    this.graph = this.counts();
    this.changed.fire(undefined);
  }

  /** Mark all as seen: the current setup becomes the reference. */
  markSeen() {
    const seen = /** @type {Record<string, Record<string, string>>} */ (this.ctx.globalState.get(SEEN_KEY) ?? {});
    for (const s of this.scopes) seen[s.id] = snapshotOf(s.items);
    this.ctx.globalState.update(SEEN_KEY, seen).then(() => this.refresh());
  }

  /** @param {Node} [node] @returns {Node[]} */
  getChildren(node) {
    if (!node) {
      const forFile = forFileNode(this.scopes, this.activeFile);
      return [/** @type {Node} */ (this.checklist.node), ...(this.budget ? [/** @type {Node} */ (this.budget)] : []), ...(this.suggestions ? [/** @type {Node} */ (this.suggestions)] : []), ...healthRoot(this.scopes), ...(this.audit ? [/** @type {Node} */ (this.audit)] : []), ...(forFile ? [/** @type {Node} */ (forFile)] : []), ...this.scopes.map((scope) => /** @type {Node} */ ({ type: "scope", scope }))];
    }
    if (node.type === "group") return node.children;
    if (node.type === "health") return healthChildren(this.scopes);
    if (node.type === "scope") {
      const tools = [...new Set(node.scope.items.map((i) => i.tool))];
      return [
        ...tools.map((tool) => /** @type {Node} */ ({ type: "tool", scope: node.scope, tool })),
        ...(node.scope.merged ? [/** @type {Node} */ (mergedTree(node.scope.merged))] : []),
        ...node.scope.removed.map((rel) => /** @type {Node} */ ({ type: "removed", scope: node.scope, rel })),
      ];
    }
    const fileNode = (item) => /** @type {Node} */ ({ type: "file", scope: node.scope, item, state: node.scope.state[item.rel] });
    if (node.type === "tool") {
      const files = node.scope.items.filter((i) => i.tool === node.tool);
      const kinds = [...new Set(files.map((f) => f.kind))].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
      if (files.length < GROUP_FROM || kinds.length < 2) return files.map(fileNode);
      return kinds.map((kind) => /** @type {Node} */ ({ type: "kind", scope: node.scope, tool: node.tool, kind }));
    }
    if (node.type === "kind") return node.scope.items.filter((i) => i.tool === node.tool && i.kind === node.kind).map(fileNode);
    if (node.type === "file") return [...node.item.details.map((text) => /** @type {Node} */ ({ type: "detail", text })), ...(node.item.children ?? []).map(fileNode)];
    return [];
  }

  /** @param {Node} node @returns {vscode.TreeItem} */
  getTreeItem(node) {
    const T = vscode.TreeItemCollapsibleState;
    if (node.type === "group" || node.type === "leaf") return plainItem(node);
    if (node.type === "graph") {
      const { edits, waiting } = this.graph;
      const it = new vscode.TreeItem("Agent Change Graph", T.None);
      it.iconPath = new vscode.ThemeIcon("git-merge");
      it.description = [edits && `${edits} under review`, waiting && `${waiting} waiting on you`].filter(Boolean).join(" · ");
      it.command = { command: "imprimatur.openGraph", title: "Open Agent Change Graph" };
      return it;
    }
    if (node.type === "scope") {
      const n = Object.keys(node.scope.state).length + node.scope.removed.length;
      const it = new vscode.TreeItem(node.scope.label, node.scope.global ? T.Collapsed : T.Expanded);
      it.iconPath = new vscode.ThemeIcon(node.scope.global ? "home" : "repo");
      it.description = `${node.scope.items.length} files${n ? ` · ${n} changed` : ""}`;
      it.tooltip = node.scope.global ? `${node.scope.root}: applies to every repo` : node.scope.root;
      if (!node.scope.items.length && !node.scope.global) it.description = "no agent setup";
      return it;
    }
    if (node.type === "tool") {
      const files = node.scope.items.filter((i) => i.tool === node.tool);
      const n = files.filter((f) => node.scope.state[f.rel]).length;
      const it = new vscode.TreeItem(node.tool, T.Collapsed);
      it.iconPath = new vscode.ThemeIcon(ICONS[node.tool] ?? "file");
      it.description = `${files.length}${n ? ` · ${n} changed` : ""}`;
      return it;
    }
    if (node.type === "kind") {
      const files = node.scope.items.filter((i) => i.tool === node.tool && i.kind === node.kind);
      const n = files.filter((f) => node.scope.state[f.rel]).length;
      // Small groups open, big ones (18 skills) stay folded.
      const it = new vscode.TreeItem(KIND_NAMES[node.kind] ?? node.kind, files.length > 6 ? T.Collapsed : T.Expanded);
      it.iconPath = new vscode.ThemeIcon(KIND_ICONS[node.kind] ?? "folder");
      it.description = `${files.length}${n ? ` · ${n} changed` : ""}`;
      it.id = `${node.scope.id}|${node.tool}|${node.kind}`;
      return it;
    }
    if (node.type === "file") {
      const { item, state } = node;
      const it = new vscode.TreeItem(item.label, item.details.length || item.children?.length ? T.Collapsed : T.None);
      const drift = node.scope.global ? undefined : this.drift.driftFor(item.rel, item.abs);
      // When it applies (#28), unless the summary already says it (.mdc).
      const when = item.scope && !item.summary.startsWith(item.scope.label) ? `${item.scope.label} · ` : "";
      it.description = `${state ? `${state} · ` : ""}${when}${drift ? `${driftLabel(drift)} · ` : ""}${item.summary}`;
      const explained = node.scope.global ? undefined : this.history.explained(node.scope.root, item.rel);
      // A committed repo file not yet explained gets its tooltip on hover (resolveTreeItem).
      // A file with problems builds its tooltip now: the problems are appended to it (markHealth).
      const problems = (node.scope.health ?? []).filter((p) => p.file === item.abs);
      const lazy = !problems.length && inRepo(node) && !explained && this.history.info(node.scope.root, item.rel);
      it.tooltip = lazy ? undefined : this.fileTooltip(node, explained);
      it.contextValue = `setupFile${drift ? "-drift" : ""}${node.scope.global ? "" : "-repo"}${item.update ? "-update" : ""}${item.compare ? "-upstream" : ""}`;
      it.iconPath = state
        ? new vscode.ThemeIcon(KIND_ICONS[item.kind] ?? "file", new vscode.ThemeColor(state === "new" ? "gitDecoration.addedResourceForeground" : "gitDecoration.modifiedResourceForeground"))
        : new vscode.ThemeIcon(KIND_ICONS[item.kind] ?? "file");
      // A session row (#139) may have no file: an MCP server's instructions, a tool count.
      if (item.abs) {
        it.resourceUri = vscode.Uri.file(item.abs);
        it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(item.abs)] };
      }
      markHealth(it, node.scope.health.filter((p) => p.file === item.abs));
      return it;
    }
    if (node.type === "health" || node.type === "problem") return healthItem(node, this.scopes);
    if (node.type === "removed") {
      const it = new vscode.TreeItem(node.rel, T.None);
      it.description = "removed since you last looked";
      it.iconPath = new vscode.ThemeIcon("trash", new vscode.ThemeColor("gitDecoration.deletedResourceForeground"));
      return it;
    }
    const it = new vscode.TreeItem(node.text, T.None);
    it.iconPath = new vscode.ThemeIcon("debug-breakpoint-log");
    return it;
  }
}

/** Whether a row is a file inside its repo, so git knows it. @param {any} node */
const inRepo = (node) => !node.scope.global && !!node.item.abs && path.resolve(node.item.abs).startsWith(path.resolve(node.scope.root) + path.sep);

/** IMP-DOC-001..005 are about the database's documents; 006 (agent file length) is a file finding. @param {any} r */
const isDocFinding = (r) => /^IMP-DOC-00[1-5]$/.test(r.links?.audit?.rule ?? "");

/**
 * Fix it on documentation findings (#131): after the user confirms, a background `claude -p`
 * with Imprimatur's MCP server (docs-backfill's tools plus record_update and task_upsert) links
 * decisions to sections, adds the alternatives the records show and writes missing sections;
 * then the audit runs again, so what is left stays open.
 * @param {SetupView} provider @param {any[]} findings @param {string} repo
 */
async function fixDocs(provider, findings, repo) {
  const db = require("./records.js").dbOf();
  const r0 = db?.repoByRoot(repo);
  if (!db || !r0) return void vscode.window.showInformationMessage("Imprimatur: this folder has no records.");
  const bf = require("./docs-backfill.js");
  const bp = require("./best-practice.js");
  // A missing number needs no model: the export's own numbering gives it, and the audit runs again.
  if (findings.some((f) => /without a number/.test(f.title))) {
    require("./decisions.js").numbered(db, r0.id);
    await runAudit(provider);
    const rules = new Set(findings.map((f) => f.links?.audit?.rule));
    findings = provider.openFindings().filter((/** @type {any} */ f) => isDocFinding(f) && rules.has(f.links.audit.rule));
    if (!findings.length) return void vscode.window.showInformationMessage("Imprimatur: the unnumbered decisions got their numbers; nothing else to fix.");
  }
  const prompt = bf.fixPrompt(db, r0.id, repo, findings);
  const server = bf.registeredServer();
  if (!server) return void vscode.window.showWarningMessage("Imprimatur: Claude Code has no imprimatur MCP server registered (~/.claude.json); run npm run setup in the Imprimatur checkout, then Fix it again.");
  const bin = require("./fix-runner.js").claudeBin();
  if (!vscode.workspace.isTrusted || !bin) {
    await vscode.env.clipboard.writeText(prompt);
    return void vscode.window.showInformationMessage("Imprimatur: Claude cannot run here (no CLI or untrusted folder); the fix prompt is on the clipboard.");
  }
  const go = await vscode.window.showWarningMessage(`Run Claude in the background to fix ${findings.length} documentation finding${findings.length === 1 ? "" : "s"}?`,
    { modal: true, detail: `It changes no file: it writes Imprimatur's records and document sections through Imprimatur's MCP tools: doc_get, doc_section_upsert, search, task_get, task_list, and record_update on the listed decisions only (body and links), with Read/Glob/Grep on the repo; sonnet, at most $3. Alternatives are added only where the records show one; none is invented. The audit runs again after it.\n\n${prompt.slice(0, 1200)}` }, "Run");
  if (go !== "Run") return;
  if (provider.fixing) return void vscode.window.showInformationMessage("Imprimatur: a Fix it is already running.");
  provider.fixing = true;
  const out = (fixOutput ??= vscode.window.createOutputChannel("Imprimatur Fix it"));
  out.appendLine(`\n=== ${new Date().toLocaleString()} · Fix it: documentation (in ${repo})\n${prompt}\n---`);
  // Tool search off: deferred MCP tools are hidden behind ToolSearch, which --tools leaves out (docs-backfill.js).
  const env = { ...bp.childEnv(), ENABLE_TOOL_SEARCH: "false" };
  // shortcut: not cancellable (bp.run has no kill); the run stops at its turn, budget and time caps.
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Imprimatur: Claude is fixing the documentation findings…" },
    () => bp.run(bin, bf.claudeArgs(server, ["record_update"], { IMPRIMATUR_RECORD_UPDATE: bf.fixRecordIds(db, r0.id, findings).join(",") }), { cwd: repo, timeout: bf.TIMEOUT_MS, env, input: prompt }));
  provider.fixing = false;
  let res = /** @type {any} */ ({});
  try {
    res = JSON.parse(r.stdout);
  } catch {}
  const answer = String(res.result ?? r.stderr ?? "").trim();
  out.appendLine(answer || r.stdout);
  await runAudit(provider);
  const failed = r.code !== 0 || res.is_error;
  const pick = await (failed ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(
    `Imprimatur: ${failed ? "documentation fix stopped" : "documentation fix finished"}: ${(answer.split("\n").find((l) => l.trim()) ?? "").slice(0, 200)}`, "Show answer");
  if (pick) out.show();
}

/**
 * Fix it (#156): after the user confirms, Claude Code's CLI runs the fix in the background
 * (`claude -p`: user settings only, no MCP, no commands, edits only the target files) under a
 * progress notification, then shows the agent's answer; its edits are tracked for review.
 * Untrusted workspace or no CLI: the prompt goes to the clipboard.
 * @param {SetupView} provider @param {any} node a checklist row or a recommendation row
 */
async function fixWithClaude(provider, node) {
  const prompts = require("./fix-prompts.js");
  const runner = require("./fix-runner.js");
  const db = require("./records.js").dbOf();
  const repo = provider.scopes.find((s) => !s.global)?.root ?? os.homedir();
  /** @type {{prompt: string, label: string, edit: string[], editDirs: string[], read: string[], whole?: string[], audit?: boolean, records?: any[], apply?: {from: string, to: string, files: string[], commit: string}}} */
  let fix = { prompt: "", label: "", edit: [], editDirs: [], read: [] };
  const kind = node?.fix?.kind;
  // Documentation findings live in the database (docs/*.md is generated): an MCP run, not a file diff.
  const docs = kind === "findings" ? provider.openFindings().filter(isDocFinding)
    : !kind && node?.recordId && db ? [db.record(node.recordId)].filter((r) => r && isDocFinding(r)) : [];
  if (docs.length && (kind !== "findings" || provider.openFindings().every(isDocFinding))) return fixDocs(provider, docs, repo);
  if (kind === "health") fix = { prompt: prompts.healthPrompt(node.fix.problem), label: path.basename(node.fix.problem.file), edit: [node.fix.problem.file], editDirs: [], read: [] };
  else if (kind === "findings") {
    // shortcut: a mixed list fixes the file findings only; each docs finding has its own Fix it.
    const open = provider.openFindings().filter((/** @type {any} */ r) => !isDocFinding(r));
    const files = open.map((/** @type {any} */ r) => r.links?.audit?.file).filter(Boolean);
    if (open.length) fix = { prompt: prompts.findingsPrompt(open), label: `${open.length} recommendations`, edit: files, editDirs: [], read: [], audit: true, records: open };
  } else if (!kind && node?.recordId && db) {
    const r = db.record(node.recordId);
    if (r) fix = { prompt: prompts.findingPrompt(r), label: r.title.slice(0, 40), edit: r.links?.audit?.file ? [r.links.audit.file] : [], editDirs: [], read: [], audit: true, records: [r] };
  }
  if (kind === "agents") {
    // #133: CLAUDE.md into AGENTS.md; each file handed back whole, shown as diffs before writing.
    const af = require("./agent-files.js").agentFiles(repo);
    const files = [af.claudeFile, af.agentsFile, af.docsRule];
    fix = { prompt: prompts.agentsPrompt(af), label: "CLAUDE.md → AGENTS.md", edit: files, editDirs: [], read: [], whole: files };
  }
  const skill = kind === "skill" ? node.fix.item : undefined;
  if (skill && !prompts.skillUpdatePrompt(skill)) return void vscode.window.showWarningMessage("Imprimatur: this skill's SOURCE.txt is not a plain GitHub source; review the change by hand.");
  if (!skill && !fix.prompt) return void vscode.window.showInformationMessage("Imprimatur: nothing to fix here.");
  const bin = runner.claudeBin();
  if (!vscode.workspace.isTrusted || !bin) {
    const text = skill ? prompts.skillUpdatePrompt(skill, "(download it from the compare page)") : fix.prompt;
    await vscode.env.clipboard.writeText(text);
    return void vscode.window.showInformationMessage(`Imprimatur: ${!bin ? "no Claude Code CLI here" : "this folder is not trusted, so Fix it does not run an agent"}; the fix prompt is on the clipboard.`);
  }
  if (skill) {
    // The new version is downloaded here, with GET requests only: the agent gets no shell.
    const dir = path.dirname(skill.abs);
    const to = /\.\.\.([0-9a-f]+)$/.exec(skill.compare)?.[1] ?? "";
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), `imprimatur-skill-${skill.label}-`));
    let files;
    try {
      files = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Imprimatur: downloading ${skill.label} at ${to.slice(0, 7)}…` },
        () => require("./upstream.js").fetchSkillFolder(skill.origin, to, dest));
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      return void vscode.window.showErrorMessage(`Imprimatur: could not download ${skill.label}: ${e instanceof Error ? e.message : e}`);
    }
    // The agent only reviews: Claude Code does not let it edit ~/.claude/skills, and Imprimatur copies on a SAFE verdict.
    fix = { prompt: prompts.skillUpdatePrompt(skill, dest), label: skill.label, edit: [], editDirs: [], read: [dest], apply: { from: dest, to: dir, files, commit: to } };
  }
  let args;
  try {
    // Read only: the agent proposes edits; Imprimatur shows and applies them (fix-edits.js).
    args = runner.claudeArgs(fix.prompt, { addDirs: runner.outside(repo, [...fix.edit, ...fix.editDirs.map((d) => path.join(d, "x")), ...fix.read.map((d) => path.join(d, "x"))]) });
  } catch (e) {
    // A target path with rule characters in it cannot be limited safely: no run.
    for (const d of fix.read) fs.rmSync(d, { recursive: true, force: true });
    await vscode.env.clipboard.writeText(fix.prompt);
    return void vscode.window.showWarningMessage(`Imprimatur: ${e instanceof Error ? e.message : e}. Fix it did not run; the prompt is on the clipboard.`);
  }
  const may = [...fix.edit.map((f) => f.replace(os.homedir(), "~")), ...fix.editDirs.map((d) => `${d.replace(os.homedir(), "~")}/`)];
  const scope = fix.apply
    ? `It only reviews the new version; no commands, no web. If it says SAFE, Imprimatur copies the files into ${fix.apply.to.replace(os.homedir(), "~")}/ and updates SOURCE.txt.`
    : `It only reads: no edits, no commands, no web. It proposes changes to ${may.join(", ") || "nothing"}, and you see the diff before anything is applied.`;
  const go = await vscode.window.showWarningMessage(`Run Claude in the background to ${fix.apply ? "review" : "fix"} ${fix.label}?`, { modal: true, detail: `${scope}\n\n${fix.prompt.slice(0, 1200)}` }, "Run");
  if (go !== "Run") {
    for (const d of fix.read) fs.rmSync(d, { recursive: true, force: true });
    return;
  }
  if (provider.fixing) return void vscode.window.showInformationMessage("Imprimatur: a Fix it is already running.");
  provider.fixing = true;
  const out = (fixOutput ??= vscode.window.createOutputChannel("Imprimatur Fix it"));
  out.appendLine(`\n=== ${new Date().toLocaleString()} · Fix it: ${fix.label} (in ${repo})\n${fix.prompt}\n---`);
  const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Imprimatur: Claude is ${fix.apply ? "reviewing" : "looking at"} ${fix.label}…`, cancellable: true },
    (_p, token) => new Promise((resolve) => {
      const { spawn } = require("node:child_process");
      // stdin closed: -p reads it when it is a pipe.
      const child = spawn(bin, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: process.env });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => ((stdout += d), out.append(String(d))));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill(), 20 * 60 * 1000);
      token.onCancellationRequested(() => child.kill());
      child.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e.message) }));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    }));
  provider.fixing = false;
  const r = /** @type {{code: number, stdout: string, stderr: string}} */ (res);
  if (r.stderr) out.appendLine(`\n[stderr] ${r.stderr.trim()}`);
  // A reviewed skill: copied here on SAFE, before the download goes.
  /** @type {string | undefined} */
  let applied;
  if (r.code === 0 && fix.apply) {
    const up = require("./upstream.js");
    const v = up.verdictOf(r.stdout);
    if (v.safe) {
      try {
        const note = up.summaryOf(r.stdout) || "SAFE verdict; the full review is in the Imprimatur Fix it output";
        up.applySkillUpdate(fix.apply.from, fix.apply.to, fix.apply.files, fix.apply.commit, note, new Date().toISOString().slice(0, 10));
        applied = `updated ${fix.label} to ${fix.apply.commit.slice(0, 7)}`;
      } catch (e) {
        applied = `could not copy ${fix.label}: ${e instanceof Error ? e.message : e}`;
      }
    } else {
      for (const d of fix.read) fs.rmSync(d, { recursive: true, force: true });
      provider.refresh();
      const pick = await vscode.window.showWarningMessage(`Imprimatur: ${fix.label} was not taken in: ${v.reason.slice(0, 200)}`, "Show answer");
      if (pick) out.show();
      return;
    }
  }
  for (const d of fix.read) fs.rmSync(d, { recursive: true, force: true });
  if (r.code !== 0) {
    provider.refresh();
    const pick = await vscode.window.showErrorMessage(`Imprimatur: Fix it stopped (${r.code === null ? "cancelled" : `exit ${r.code}`}). ${r.stderr.trim().split("\n")[0].slice(0, 160)}`, "Show output");
    if (pick) out.show();
    return;
  }
  // Proposed edits: shown as diffs, applied when the user says so.
  if (!fix.apply) {
    const edits = require("./fix-edits.js");
    const plan = edits.planEdits(edits.parseEdits(r.stdout), fix.edit, undefined, { whole: fix.whole ?? [] });
    // Findings Claude says are wrong or intended: dismissed with its reason when the user applies.
    const said = edits.parseDismissals(r.stdout, fix.records?.length ?? 0).map((d) => ({ ...d, rec: /** @type {any[]} */ (fix.records)[d.n - 1] }));
    // "other" (not fixed by an edit) is work for the user, not a false alarm: it stays open.
    const drops = said.filter((d) => d.reason !== "other");
    const yours = said.filter((d) => d.reason === "other");
    const skippedNote = plan.skipped.length ? `\n\nLeft out: ${plan.skipped.map((x) => `${x.file.replace(os.homedir(), "~")} (${x.why})`).join("; ")}` : "";
    const dropNote = (drops.length ? `\n\nDismiss ${drops.length}:\n${drops.map((d) => `• ${d.rec.title.slice(0, 80)} (${d.reason}): ${d.why}`).join("\n")}` : "")
      + (yours.length ? `\n\nNeeds you (stays open):\n${yours.map((d) => `• ${d.rec.title.slice(0, 80)}: ${d.why}`).join("\n")}` : "");
    if (!plan.files.size && !drops.length) {
      const pick = await vscode.window.showInformationMessage(`Imprimatur: Claude proposed no change for ${fix.label}.${(dropNote + skippedNote).replace(/\n+/g, " ")}`, "Show answer");
      if (pick) out.show();
      return;
    }
    const shown = fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-fix-"));
    let k = 0;
    for (const [file, c] of plan.files) {
      const proposed = path.join(shown, `${++k}-${path.basename(file)}`);
      fs.writeFileSync(proposed, c.after);
      // A file to be created is shown against an empty one.
      const now = c.created ? path.join(shown, `${k}-empty-${path.basename(file)}`) : file;
      if (c.created) fs.writeFileSync(now, "");
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(now), vscode.Uri.file(proposed), `Fix it: ${path.basename(file)} (${c.created ? "new" : "now"} ↔ proposed)`, { preview: false });
    }
    const files = [...plan.files.keys()].map((f) => f.replace(os.homedir(), "~"));
    const what = [files.length && `change ${files.length} file${files.length === 1 ? "" : "s"}`, drops.length && `dismiss ${drops.length} finding${drops.length === 1 ? "" : "s"}`].filter(Boolean).join(" and ");
    const ok = await vscode.window.showWarningMessage(`Apply Claude's fix: ${what}?`,
      { modal: true, detail: `${files.join("\n")}${dropNote}${skippedNote}\n\n${files.length ? "The diffs are open. " : ""}Nothing has changed yet.` }, "Apply");
    let wrote = 0;
    if (ok === "Apply")
      for (const [file, c] of plan.files) {
        // A file that changed since Claude read it is left alone; one to create must still be missing.
        // A whole-file target (#133) is in the repo with no link on its way, and a new one is
        // created with O_EXCL: a planted link cannot carry the write out of the repo.
        if (fix.whole?.includes(file) && !require("./agent-files.js").safeTarget(repo, file)) continue;
        try {
          if (c.created) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, c.after, { flag: "wx" });
          } else {
            if (fs.readFileSync(file, "utf8") !== c.before) continue;
            fs.writeFileSync(file, c.after);
          }
          wrote++;
        } catch {}
      }
    fs.rmSync(shown, { recursive: true, force: true });
    let dropped = 0;
    if (ok === "Apply" && drops.length && db) {
      const recsMod = require("./recs.js");
      for (const d of drops) {
        const cur = db.record(d.rec.id);
        const link = recsMod.sourceOf(cur) === "audit" ? "audit" : "best";
        if (!cur || cur.status !== "open" || !cur.links?.[link]) continue;
        db.updateRecord(cur.id, { status: "dropped", links: { ...cur.links, [link]: { ...cur.links[link], reason: link === "audit" ? d.reason : d.reason === "local" ? "not-applicable" : d.reason === "plugin" ? "other" : d.reason } },
          body: `${cur.body ?? ""}\n\n_Dismissed (${d.reason}, by Claude through Fix it, applied by the user):_ ${d.why}` }, { kind: "user" });
        dropped++;
      }
    }
    if (!wrote && !dropped) return void vscode.window.showInformationMessage(`Imprimatur: nothing applied${ok === "Apply" ? " (the files changed meanwhile)" : ""}.`);
    applied = [wrote && `applied ${wrote} change${wrote === 1 ? "" : "s"}`, dropped && `dismissed ${dropped} finding${dropped === 1 ? "" : "s"}`,
      yours.length && `${yours.length} need${yours.length === 1 ? "s" : ""} you: ${yours.map((d) => d.rec.title.slice(0, 50)).join("; ")}`].filter(Boolean).join(", ");
  }
  // The run has no MCP: the audit runs here, so the counts show what is left.
  if (fix.audit) await runAudit(provider);
  else provider.refresh();
  const first = applied ?? r.stdout.trim().split("\n").find((l) => l.trim()) ?? "Done.";
  const pick = await vscode.window.showInformationMessage(`Imprimatur: Fix it finished: ${first.slice(0, 200)}`, "Show answer");
  if (pick === "Show answer") out.show();
}

/**
 * The context budget row (#29): what the repo's last session loaded into context, biggest
 * first, with estimated tokens; a large item is marked and its tooltip says how to shrink it.
 * @param {string | undefined} root @returns {any}
 */
function budgetRow(root) {
  if (!root) return undefined;
  const sc = require("./session-context.js");
  const a = require("./agent-setup.js");
  const home = os.homedir();
  const b = sc.sessionBudget(path.join(home, ".claude", "projects", a.projectSlug(a.gitRootOf(root))), home, a.configuredHooks(root, home));
  if (!b) return undefined;
  const n = (/** @type {number} */ t) => `~${t.toLocaleString("en-US")} tokens`;
  // A plugin row can be turned off for this repo; a group named like a plugin that is not installed is claude.ai's synced skills.
  const installed = Object.keys(JSON.parse(safeRead(path.join(home, ".claude", "plugins", "installed_plugins.json")) || "{}").plugins ?? {});
  const rows = b.rows.map((r) => {
    const id = r.plugin ? installed.find((x) => x.split("@")[0] === r.plugin) : undefined;
    if (r.plugin && !id && r.kind === "listings") r.suggestion = `These skills are synced from claude.ai: turn off the ones this work never needs in claude.ai's skill settings to save ~${r.tokens.toLocaleString("en-US")} tokens a session.`;
    return {
    ...(id ? { context: "budgetPlugin", pluginId: id, repoRoot: root, tokens: r.tokens } : {}),
    type: "leaf", label: r.label, description: `${n(r.tokens)} · ${r.kind} · ${r.detail}`, abs: r.abs || undefined,
    icon: r.tokens >= sc.LARGE ? "warning" : r.suggestion ? "lightbulb" : "circle-small", color: r.tokens >= sc.LARGE ? "problemsWarningIcon.foreground" : undefined,
    tooltip: `${r.label}: ${n(r.tokens)} (${r.kind}). ${r.detail}.${r.tokens >= sc.LARGE ? " Large: it alone takes a noticeable part of every session." : ""}${r.suggestion ? `\n\n${r.suggestion}` : ""}`,
  };
  });
  for (const u of b.uncounted) rows.push({ type: "leaf", label: `Not counted: ${u}`, icon: "question", tooltip: "Not in the transcript, so not guessed. Claude Code's /context shows the exact numbers." });
  return { type: "group", label: "Context budget", description: `${n(b.total)} a session (estimate)`, icon: "dashboard", children: rows,
    tooltip: "What the last session in this repo loaded into the model's context, item by item. Tokens are estimated as characters ÷ 4; /context in Claude Code has the exact count." };
}

/**
 * What suggestions for a repo need (#143): its stack from the project review's source map,
 * the installed plugins, the servers its last session had, the marketplaces' local copies, and
 * the two cache files (the word match, refreshed daily; Claude's picks, kept until the stack changes).
 * @param {string} root @param {vscode.ExtensionContext} ctx
 */
function suggestContext(root, ctx) {
  const as = require("./agent-setup.js");
  const db = require("./records.js").dbOf();
  const repo = db?.repoByRoot(root);
  const task = repo && require("./recs.js").recsTask(db, repo.id);
  /** @type {Array<{name: string}>} */
  const components = task ? require("./best-practice.js").sourceMapRecord(db, task.id)?.links?.bestSources?.components ?? [] : [];
  const home = os.homedir();
  const installed = Object.keys(JSON.parse(safeRead(path.join(home, ".claude", "plugins", "installed_plugins.json")) || "{}").plugins ?? {});
  const markets = JSON.parse(safeRead(path.join(home, ".claude", "plugins", "known_marketplaces.json")) || "{}");
  /** What a plugin kept in its marketplace brings, read from the local copy. @param {any} p */
  const partsOf = (p) => {
    const loc = markets[p.marketplaceName]?.installLocation;
    if (typeof p.source !== "string" || !loc) return undefined;
    const dir = path.join(loc, p.source);
    if (!path.resolve(dir).startsWith(path.resolve(loc))) return undefined;
    const mcp = JSON.parse(safeRead(path.join(dir, ".mcp.json")) || "{}");
    /** @param {string} sub @param {(n: string) => boolean} keep */
    const names = (sub, keep) => {
      try {
        return fs.readdirSync(path.join(dir, sub)).filter(keep).map((n) => n.replace(/\.md$/, ""));
      } catch {
        return [];
      }
    };
    return { hooks: as.pluginHookDefs(dir).length, mcp: Object.keys(mcp.mcpServers ?? mcp), brings: as.pluginContents(dir),
      names: [...names("skills", (n) => !n.startsWith(".")), ...names("agents", (n) => n.endsWith(".md")), ...names("commands", (n) => n.endsWith(".md"))] };
  };
  /** The marketplaces' own relevance blocks (Claude Code's plugin suggestions), by plugin id, from their local copies. */
  const relevanceOf = /** @type {Record<string, any>} */ ({});
  /** The official marketplace's entries by name (source, category), for the technologies index (#144). */
  const entries = /** @type {Record<string, any>} */ ({});
  for (const [name, m] of Object.entries(markets)) {
    const list = JSON.parse(safeRead(path.join(String(/** @type {any} */ (m)?.installLocation ?? ""), ".claude-plugin", "marketplace.json")) || "{}").plugins;
    for (const e of Array.isArray(list) ? list : []) {
      if (typeof e?.name !== "string") continue;
      if (e.relevance) relevanceOf[`${e.name}@${name}`] = e.relevance;
      if (name === "claude-plugins-official") entries[e.name] = { source: e.source, category: e.category, author: e.author?.name };
    }
  }
  const marketRepoOf = (/** @type {string} */ n) => String(markets[n]?.source?.repo ?? "");
  // Servers and connectors the last session already had: a plugin for the same one is not suggested.
  const projectDir = path.join(home, ".claude", "projects", as.projectSlug(as.gitRootOf(root)));
  const connected = [...(require("./session-context.js").connectedServers?.(projectDir, home) ?? [])];
  const slug = as.projectSlug(root);
  return { components, installed, connected, partsOf, marketRepoOf, relevanceOf, entries, home, projectDir,
    file: path.join(ctx.globalStorageUri.fsPath, `suggestions-${slug}.json`), rankedFile: path.join(ctx.globalStorageUri.fsPath, `suggestions-claude-${slug}.json`) };
}

/**
 * Ask Claude (#143): Claude, with no tools, orders the candidates the rules and the stack found
 * and says install, study or skip for each, with a reason; it adds none, so the list itself stays
 * deterministic. Its verdicts are kept with the candidates they were made for, and a second ask
 * gets them back. After a confirmation; a background run.
 * @param {SetupView} provider
 */
async function rankSuggestions(provider) {
  const root = provider.scopes.find((s) => !s.global)?.root;
  const runner = require("./fix-runner.js");
  const sg = require("./suggest.js");
  const bin = runner.claudeBin();
  if (!root) return;
  if (!bin || !vscode.workspace.isTrusted) return void vscode.window.showInformationMessage(`Imprimatur: ${!bin ? "no Claude Code CLI here" : "this folder is not trusted, so no agent runs"}.`);
  const c = suggestContext(root, provider.ctx);
  const s = sg.readSuggestions(c.file);
  const candidates = (s?.items ?? []).filter((/** @type {any} */ i) => !c.installed.includes(i.id));
  if (!candidates.length) return void vscode.window.showInformationMessage("Imprimatur: no suggestions to order yet for this repo.");
  const last = sg.readSuggestions(c.rankedFile);
  if (last?.fingerprint === s.fingerprint) {
    const again = await vscode.window.showInformationMessage(`Imprimatur: the suggestions have not changed since Claude's verdicts of ${new Date(last.at).toISOString().slice(0, 10)}.`, "Ask again");
    if (again !== "Ask again") return;
  }
  const pkg = JSON.parse(safeRead(path.join(root, "package.json")) || "{}");
  const about = [typeof pkg.description === "string" ? pkg.description : "", safeRead(path.join(root, "README.md")).slice(0, 2500)].filter(Boolean).join("\n");
  const prompt = sg.rankPrompt({ about, components: c.components, installed: c.installed, candidates, previous: last?.picks ?? [] });
  const tokens = Math.round(prompt.length / 4);
  const go = await vscode.window.showWarningMessage(`Ask Claude about the ${candidates.length} suggestions for ${path.basename(root)}?`, { modal: true,
    detail: `Claude (Sonnet) runs in the background with no tools: it reads the repo's README opening, its stack and the ${candidates.length} candidates with what put each one there (about ${tokens.toLocaleString("en-US")} tokens). It orders them and says install, study or skip for each; it adds none. Nothing is installed.` }, "Ask");
  if (go !== "Ask") return;
  const out = (fixOutput ??= vscode.window.createOutputChannel("Imprimatur Fix it"));
  out.appendLine(`\n=== ${new Date().toLocaleString()} · Ask Claude about the suggestions for ${path.basename(root)}\n---`);
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Imprimatur: Claude is judging the suggestions for ${path.basename(root)}…`, cancellable: true },
    (_p, token) => runner.runClaude(bin, runner.rankArgs(), { cwd: root, input: prompt, token, onData: (d) => out.append(d) }));
  if (r.code !== 0) {
    const pick = await vscode.window.showErrorMessage(`Imprimatur: Claude stopped (${r.code === null ? "cancelled" : `exit ${r.code}`}). ${r.stderr.trim().split("\n")[0].slice(0, 160)}`, "Show output");
    if (pick) out.show();
    return;
  }
  let picks;
  try {
    picks = sg.parseRanked(r.stdout, new Set(candidates.map((/** @type {any} */ i) => i.id)));
  } catch (e) {
    const pick = await vscode.window.showErrorMessage(`Imprimatur: Claude's answer could not be read: ${e instanceof Error ? e.message : e}`, "Show output");
    if (pick) out.show();
    return;
  }
  fs.mkdirSync(path.dirname(c.rankedFile), { recursive: true });
  fs.writeFileSync(c.rankedFile, JSON.stringify({ at: Date.now(), fingerprint: s.fingerprint, picks }, null, 1));
  provider.refresh();
  const n = (/** @type {string} */ v) => picks.filter((p) => p.verdict === v).length;
  vscode.window.showInformationMessage(`Imprimatur: Claude says install ${n("install")}, study ${n("study")}, skip ${n("skip")}: Agent Setup → Suggested for this repo.`);
}

/** The key of the suggestions the user hid (#143): {"*": ids hidden everywhere, [repo root]: ids hidden there}. */
const HIDDEN = "imprimatur.suggestions.hidden";

/** The plugins hidden for a repo: there, or everywhere. @param {vscode.ExtensionContext} ctx @param {string} root @returns {Set<string>} */
function hiddenSuggestions(ctx, root) {
  const h = /** @type {Record<string, string[]>} */ (ctx.globalState.get(HIDDEN) ?? {});
  return new Set([...(h["*"] ?? []), ...(h[root] ?? [])]);
}

/**
 * Hides a suggestion (#143), for this repo or every repo; the row's "hidden by you" line brings them back.
 * @param {SetupView} provider @param {any} node a suggestion row @param {boolean} everywhere
 */
async function hideSuggestion(provider, node, everywhere) {
  const id = node?.installId;
  const root = node?.repoRoot;
  if (typeof id !== "string" || typeof root !== "string") return;
  const h = /** @type {Record<string, string[]>} */ ({ ...(provider.ctx.globalState.get(HIDDEN) ?? {}) });
  const key = everywhere ? "*" : root;
  h[key] = [...new Set([...(h[key] ?? []), id])];
  await provider.ctx.globalState.update(HIDDEN, h);
  provider.refresh();
}

/** Shows a repo's hidden suggestions again, the ones hidden everywhere among them. @param {SetupView} provider @param {string} root */
async function restoreSuggestions(provider, root) {
  const h = /** @type {Record<string, string[]>} */ ({ ...(provider.ctx.globalState.get(HIDDEN) ?? {}) });
  const ids = [...hiddenSuggestions(provider.ctx, root)];
  if (!ids.length) return;
  const ok = await vscode.window.showInformationMessage(`Show ${ids.length} hidden suggestion${ids.length === 1 ? "" : "s"} again?`, { modal: true, detail: ids.join("\n") }, "Show");
  if (ok !== "Show") return;
  delete h[root];
  h["*"] = (h["*"] ?? []).filter((id) => !ids.includes(id));
  await provider.ctx.globalState.update(HIDDEN, h);
  provider.refresh();
}

/**
 * A baseline item (#141), after a confirmation: a plugin installed (its marketplace added first
 * when Claude Code does not know it) or turned on at user scope with Claude Code's CLI in a
 * terminal; a skill downloaded from its GitHub repo (GET only) into ~/.claude/skills with a
 * SOURCE.txt that names its source, commit and license and that Imprimatur installed it.
 * @param {SetupView} provider @param {{root: string, item: any}} arg
 */
async function installBaseline(provider, arg) {
  const it = arg?.item;
  if (!it || typeof arg.root !== "string") return;
  const warn = it.warn ? `\n\n⚠ ${it.warn}.` : "";
  if (it.kind === "skill") {
    const repo = String(it.repo ?? "");
    const name = repo.split("/")[1] ?? "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w.-]+$/.test(name)) return;
    const dest = path.join(os.homedir(), ".claude", "skills", name);
    if (fs.existsSync(dest)) return void vscode.window.showInformationMessage(`Imprimatur: ~/.claude/skills/${name} already exists; it is left as it is.`);
    const ok = await vscode.window.showWarningMessage(`Install the ${name} skill for every repo?`, { modal: true,
      detail: `${it.why}.${warn}\n\nDownloads github.com/${repo} at its newest commit into ~/.claude/skills/${name} (GET requests only), with a SOURCE.txt for the upstream check (#140). Read SKILL.md after: a skill's text goes straight into the agent's context.` }, "Install");
    if (ok !== "Install") return;
    try {
      const up = require("./upstream.js");
      const gh = (/** @type {string} */ e) => new Promise((resolve, reject) => require("node:child_process").execFile("gh", ["api", e], { timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out)))));
      const meta = /** @type {any} */ (await gh(`repos/${repo}`));
      const head = /** @type {any} */ (await gh(`repos/${repo}/commits/${encodeURIComponent(meta.default_branch ?? "HEAD")}`));
      const sha = String(head.sha ?? "");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `imprimatur-baseline-${name}-`));
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Imprimatur: downloading ${name}…` }, () => up.fetchSkillFolder({ repo, path: "" }, sha, tmp));
      if (!fs.existsSync(path.join(tmp, "SKILL.md"))) throw new Error("the repo has no SKILL.md at its root");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(tmp, dest, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.writeFileSync(path.join(dest, "SOURCE.txt"), `source: https://github.com/${repo}\ncommit: ${sha.slice(0, 7)}\nlicense: ${String(meta.license?.spdx_id ?? "unknown")}\ninstalled: ${new Date().toISOString().slice(0, 10)} by Imprimatur's baseline (#141)\n`);
      provider.refresh();
      vscode.window.showInformationMessage(`Imprimatur: ${name} is in ~/.claude/skills from the next Claude Code session.`, "Open SKILL.md").then((p) => p && vscode.window.showTextDocument(vscode.Uri.file(path.join(dest, "SKILL.md"))));
    } catch (e) {
      vscode.window.showErrorMessage(`Imprimatur: could not install ${name}: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }
  const id = String(it.target ?? it.id ?? "");
  if (!/^[\w.-]+@[\w.-]+$/.test(id)) return;
  const markets = JSON.parse(safeRead(path.join(os.homedir(), ".claude", "plugins", "known_marketplaces.json")) || "{}");
  const market = id.split("@")[1];
  const add = !markets[market] && /^[\w.-]+\/[\w.-]+$/.test(String(it.market ?? "")) ? `claude plugin marketplace add ${it.market} && ` : "";
  const cmd = it.state === "enable" ? `claude plugin enable ${id} --scope user` : `${add}claude plugin install ${id} --scope user`;
  const ok = await vscode.window.showWarningMessage(`${it.state === "enable" ? "Turn on" : "Install"} ${id} for every repo?`, { modal: true,
    detail: `${it.why}.${warn}\n\nRuns in a terminal: ${cmd}\nA repo that should not have it: the row's menu → Not in This Repo. Restart Claude Code sessions afterwards.` }, it.state === "enable" ? "Turn on" : "Install");
  if (!ok) return;
  const t = vscode.window.createTerminal({ name: `Imprimatur baseline: ${id}`, cwd: arg.root });
  t.show();
  t.sendText(cmd);
}

/** Opts this repo out of a baseline item (#141). @param {SetupView} provider @param {any} node a baseline row */
function baselineOut(provider, node) {
  if (typeof node?.repoRoot !== "string" || typeof node?.baselineKey !== "string") return;
  require("./baseline.js").setOptOut(node.repoRoot, node.baselineKey, true);
  provider.refresh();
}

/** Brings a baseline item back into this repo: a pick among the ones it is out of. @param {SetupView} provider @param {{root: string, items: any[]}} arg */
async function baselineBack(provider, arg) {
  const own = (arg?.items ?? []).filter((b) => require("./baseline.js").optedOut(arg.root).includes(b.key));
  const byRepo = (arg?.items ?? []).filter((b) => !own.includes(b));
  if (!own.length)
    return void vscode.window.showInformationMessage(`Imprimatur: ${byRepo.map((b) => b.label).join(", ")} ${byRepo.length === 1 ? "is" : "are"} turned off in this repo's .claude settings (enabledPlugins); turn ${byRepo.length === 1 ? "it" : "them"} on there.`);
  const pick = await vscode.window.showQuickPick(own.map((b) => ({ label: b.label, description: b.why, key: b.key })), { placeHolder: "Bring back into this repo's baseline" });
  if (!pick) return;
  require("./baseline.js").setOptOut(arg.root, pick.key, false);
  provider.refresh();
}

/**
 * Install a suggested plugin for one repo (#143), after a confirmation that shows the vetting:
 * Claude Code's own `claude plugin install --scope project`, in a terminal in that repo.
 * @param {any} node a Suggested row
 */
async function installSuggestion(node) {
  const id = node?.installId;
  const root = node?.repoRoot;
  if (typeof id !== "string" || !/^[\w.-]+@[\w.-]+$/.test(id) || typeof root !== "string") return;
  const ok = await vscode.window.showWarningMessage(`Install ${id} for ${path.basename(root)}?`, { modal: true,
    detail: `${node.study ? `Claude said to study it, not install it: ${node.study}\n\n` : ""}It brings: ${node.reads}.${node.flags?.length ? `\n\n⚠ ${node.flags.join("\n⚠ ")}` : ""}\n\nRuns: claude plugin install ${id} --scope project (in ${root}). Restart Claude Code sessions there afterwards.` }, "Install");
  if (ok !== "Install") return;
  const t = vscode.window.createTerminal({ name: `Install ${id}`, cwd: root });
  t.show();
  t.sendText(`claude plugin install ${id} --scope project`);
}

/** A file's text, "" when it cannot be read. @param {string} f */
function safeRead(f) {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

/**
 * Turn a plugin off for one repo (#29): enabledPlugins[id] = false in the repo's
 * .claude/settings.local.json (not committed; other repos keep it), after a confirmation.
 * @param {SetupView} provider @param {any} node a Context budget row with pluginId
 */
async function turnOffPlugin(provider, node) {
  const id = node?.pluginId;
  const root = node?.repoRoot;
  if (typeof id !== "string" || !/^[\w.-]+@[\w.-]+$/.test(id) || typeof root !== "string") return;
  const file = path.join(root, ".claude", "settings.local.json");
  const text = safeRead(file);
  let settings = {};
  try {
    settings = text ? JSON.parse(text) : {};
  } catch {
    return void vscode.window.showErrorMessage(`Imprimatur: ${file} is not valid JSON; fix it first.`);
  }
  const ok = await vscode.window.showWarningMessage(`Turn ${id} off in ${path.basename(root)}?`, { modal: true,
    detail: `Writes "enabledPlugins": { "${id}": false } to .claude/settings.local.json in this repo (not committed). Other repos keep it. Saves about ${Number(node.tokens || 0).toLocaleString("en-US")} tokens a session here, from the next Claude Code session. To turn it back on, delete that line.` }, "Turn off");
  if (ok !== "Turn off") return;
  /** @type {any} */ (settings).enabledPlugins = { .../** @type {any} */ (settings).enabledPlugins, [id]: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  provider.refresh();
  vscode.window.showInformationMessage(`Imprimatur: ${id} is off in ${path.basename(root)} from the next Claude Code session.`);
}

/** The install checks now (#81): the CLI, the plugin or npm run setup, the database. */
function installChecksNow() {
  const records = require("./records.js");
  const db = records.dbOf();
  return require("./install-check.js").installChecks({ claudeBin: require("./fix-runner.js").claudeBin(), plugin: require("./versions.js").imprimaturPlugin(),
    dbError: db ? undefined : records.lastError ?? "unavailable" });
}

/** An install check's fix: a terminal line, a page, or a command. @param {{kind: string, value: string, title: string}} fix */
function runInstallFix(fix) {
  if (fix?.kind === "terminal") {
    const t = vscode.window.createTerminal({ name: `Imprimatur: ${fix.title}` });
    t.show();
    t.sendText(fix.value);
  } else if (fix?.kind === "url" && /^https:\/\//.test(fix.value)) vscode.env.openExternal(vscode.Uri.parse(fix.value));
  else if (fix?.kind === "command") vscode.commands.executeCommand(fix.value);
}

/** Imprimatur: Check Setup (#81): says what is missing, or that nothing is. @param {SetupView} provider */
async function checkSetup(provider) {
  provider.refresh();
  const missing = (provider.installs ?? installChecksNow()).filter((c) => !c.ok);
  if (!missing.length)
    return void vscode.window.showInformationMessage("Imprimatur is set up: the Claude Code CLI, the hooks, the MCP server and the database are all in place.");
  const pick = await vscode.window.showWarningMessage(`Imprimatur: ${missing.length} thing${missing.length === 1 ? "" : "s"} missing: ${missing.map((c) => `${c.label} (${c.why})`).join("; ")}`,
    ...missing.flatMap((c) => (c.fix ? [c.fix.title] : [])).filter((t, k, a) => a.indexOf(t) === k), "Show Checklist");
  if (pick === "Show Checklist") return void vscode.commands.executeCommand("imprimatur.setup.focus");
  const fix = missing.find((c) => c.fix?.title === pick)?.fix;
  if (fix) runInstallFix(fix);
}

/**
 * Updates a plugin that is behind its marketplace (#140) in a terminal, at the scope it was
 * installed and in its repo for project and local scope: Claude Code's own update, after a
 * marketplace refresh. @param {any} item a SetupItem with update
 */
function updatePlugin(item) {
  const u = item?.update;
  // The id and scope go into a shell line: only plain names.
  if (!u || !/^[\w.-]+@[\w.-]+$/.test(u.id) || !/^(user|project|local)$/.test(u.scope)) return;
  const t = vscode.window.createTerminal({ name: `Update ${u.id}`, cwd: u.cwd || undefined });
  t.show();
  t.sendText(`claude plugin marketplace update ${u.id.split("@")[1]} && claude plugin update ${u.id} --scope ${u.scope} && echo "Updated: restart Claude Code sessions to load it."`);
}

// Kinds from the wider scan (#27): auto memory, @imports, managed policy, Cursor hooks.
Object.assign(KIND_NAMES, { "installed plugin": "Installed plugins", "synced skill": "Skills synced from claude.ai",
  "loaded instructions": "Instructions loaded", "hook output": "Hooks: what they added and how long they took", "MCP instructions": "MCP server instructions",
  tools: "Tools by server", listings: "Skills and agents listed", "model and mode": "Model, mode and context",
  "data sources": "Data sources: memory the agent can read (not vetted)" });
Object.assign(KIND_ICONS, { "installed plugin": "extensions", "synced skill": "cloud", "loaded instructions": "book", "hook output": "zap",
  "MCP instructions": "plug", tools: "tools", listings: "list-unordered", "model and mode": "hubot", "data sources": "database" });
KIND_ORDER.splice(KIND_ORDER.indexOf("plugin") + 1, 0, "installed plugin", "synced skill");
KIND_ORDER.push("loaded instructions", "hook output", "MCP instructions", "tools", "listings", "data sources", "model and mode");
Object.assign(KIND_NAMES, { memory: "Auto memory", import: "Imports", "managed policy": "Managed policy", hooks: "Hooks" });
Object.assign(KIND_ICONS, { memory: "notebook", import: "references", "managed policy": "shield", hooks: "zap" });
KIND_ORDER.splice(KIND_ORDER.indexOf("settings"), 0, "managed policy");
KIND_ORDER.splice(KIND_ORDER.indexOf("hook script"), 0, "hooks", "memory");

/**
 * Health (#30): one "Health (n)" row on top while any scope has a problem.
 * @param {Scope[]} scopes @returns {Node[]}
 */
function healthRoot(scopes) {
  return scopes.some((s) => s.health.length) ? [{ type: "health" }] : [];
}

/** The problems, errors first. @param {Scope[]} scopes @returns {Node[]} */
function healthChildren(scopes) {
  const all = scopes.flatMap((scope) => scope.health.map((problem) => /** @type {Node} */ ({ type: "problem", scope, problem })));
  return all.sort((a, b) => (a.type === "problem" && b.type === "problem" ? (a.problem.level === b.problem.level ? 0 : a.problem.level === "error" ? -1 : 1) : 0));
}

/** @param {Node & {type: "health" | "problem"}} node @param {Scope[]} [scopes] */
function healthItem(node, scopes) {
  const T = vscode.TreeItemCollapsibleState;
  if (node.type === "health") {
    const it = new vscode.TreeItem("Health", T.Collapsed);
    it.iconPath = new vscode.ThemeIcon("pulse");
    it.id = "imprimatur.setup.health";
    if (scopes) {
      const all = scopes.flatMap((s) => s.health);
      const errors = all.filter((p) => p.level === "error").length;
      it.label = `Health (${all.length})`;
      it.description = [errors && `${errors} error${errors === 1 ? "" : "s"}`, all.length - errors && `${all.length - errors} warning${all.length - errors === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
      it.iconPath = new vscode.ThemeIcon(errors ? "error" : "warning", new vscode.ThemeColor(errors ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"));
    }
    return it;
  }
  const { problem, scope } = node;
  const rel = path.relative(scope.root, problem.file);
  const it = new vscode.TreeItem(path.basename(problem.file), T.None);
  it.description = problem.message;
  it.tooltip = `${rel.startsWith("..") ? problem.file : rel}: ${problem.message}`;
  it.iconPath = new vscode.ThemeIcon(problem.level === "error" ? "error" : "warning", new vscode.ThemeColor(problem.level === "error" ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"));
  const line = Math.max(0, (problem.line ?? 1) - 1);
  it.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(problem.file), { selection: new vscode.Range(line, 0, line, 0) }] };
  return it;
}

/** A file row with problems: error/warning icon, problems in the tooltip. @param {vscode.TreeItem} it @param {Scope["health"]} problems */
function markHealth(it, problems) {
  if (!problems.length) return;
  const error = problems.some((p) => p.level === "error");
  it.iconPath = new vscode.ThemeIcon(error ? "error" : "warning", new vscode.ThemeColor(error ? "problemsErrorIcon.foreground" : "problemsWarningIcon.foreground"));
  const md = /** @type {vscode.MarkdownString | undefined} */ (it.tooltip);
  if (!(md instanceof vscode.MarkdownString)) return;
  md.appendMarkdown(`\n\n${problems.map((p) => `${p.level === "error" ? "$(error)" : "$(warning)"} ${p.message}`).join("\n\n")}`);
  md.supportThemeIcons = true;
}

/**
 * @param {vscode.ExtensionContext} ctx @param {() => string[]} roots
 * @param {() => {edits: number, waiting: number}} counts
 */
function registerSetupView(ctx, roots, counts) {
  const provider = new SetupView(ctx, roots, counts);
  const view = vscode.window.createTreeView("imprimatur.setup", { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;
  provider.scan();
  // Agent files anywhere in the window: rescan when one changes (debounced).
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @param {vscode.Uri} [uri] */
  const soon = (uri) => {
    // .claude/imprimatur is Imprimatur's own data, written on every agent edit: not setup.
    if (uri?.fsPath.includes(`${path.sep}.claude${path.sep}imprimatur${path.sep}`)) return;
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 500);
  };
  const pattern = "{**/CLAUDE.md,**/CLAUDE.local.md,**/AGENTS.md,**/GEMINI.md,**/CONVENTIONS.md,.claude/**,.cursor/**,.cursorrules,.github/**,.mcp.json,.husky/**,.windsurf/**,.windsurfrules,.clinerules,.clinerules/**,commitlint.config.*,.pre-commit-config.yaml}";
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  // The prompt hook writes the technologies it brought up (#144) outside the workspace, in the repo's data folder.
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const od = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(require("./data-dir.js").dataDir(f.uri.fsPath)), "on-demand.json"));
    const redraw = () => soon();
    ctx.subscriptions.push(od, od.onDidCreate(redraw), od.onDidChange(redraw));
  }
  ctx.subscriptions.push(
    view,
    watcher,
    watcher.onDidCreate(soon),
    watcher.onDidChange(soon),
    watcher.onDidDelete(soon),
    view.onDidChangeVisibility((e) => e.visible && soon()),
    vscode.window.onDidChangeWindowState((s) => s.focused && view.visible && soon()),
    vscode.commands.registerCommand("imprimatur.setup.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("imprimatur.setup.openOnDoubleClick", (url) => {
      // A tree has no double-click event: a second click on the same row within half a second is one.
      const now = Date.now();
      if (lastClick.url === url && now - lastClick.at < 500 && typeof url === "string" && url.startsWith("https://github.com/")) {
        lastClick = { url: "", at: 0 };
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else lastClick = { url, at: now };
    }),
    vscode.commands.registerCommand("imprimatur.setup.installBaseline", (arg) => installBaseline(provider, arg)),
    vscode.commands.registerCommand("imprimatur.setup.writeAgentFiles", async () => {
      const root = provider.scopes.find((s) => !s.global)?.root;
      if (!root || !vscode.workspace.isTrusted) return;
      const written = require("./agent-files.js").writeMissing(root);
      provider.refresh();
      if (written.length) {
        vscode.window.showInformationMessage(`Imprimatur: wrote ${written.map((f) => path.relative(root, f)).join(", ")} from the templates.`, "Open").then((p) => p && vscode.window.showTextDocument(vscode.Uri.file(written[0])));
      }
    }),
    vscode.commands.registerCommand("imprimatur.setup.baselineOut", (node) => baselineOut(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.baselineBack", (arg) => baselineBack(provider, arg)),
    vscode.commands.registerCommand("imprimatur.setup.rankSuggestions", () => rankSuggestions(provider)),
    vscode.commands.registerCommand("imprimatur.setup.hideSuggestion", (node) => hideSuggestion(provider, node ?? view.selection[0], false)),
    vscode.commands.registerCommand("imprimatur.setup.hideSuggestionEverywhere", (node) => hideSuggestion(provider, node ?? view.selection[0], true)),
    vscode.commands.registerCommand("imprimatur.setup.restoreSuggestions", (root) => typeof root === "string" && restoreSuggestions(provider, root)),
    vscode.commands.registerCommand("imprimatur.setup.installSuggestion", (node) => installSuggestion(node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.turnOffPlugin", (node) => turnOffPlugin(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.installFix", (fix) => runInstallFix(fix)),
    vscode.commands.registerCommand("imprimatur.checkSetup", () => checkSetup(provider)),
    vscode.commands.registerCommand("imprimatur.setup.fixWithClaude", (node) => fixWithClaude(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.showUpstream", (node) => {
      const url = (node ?? view.selection[0])?.item?.compare;
      if (typeof url === "string" && url.startsWith("https://github.com/")) vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand("imprimatur.setup.updatePlugin", (node) => updatePlugin((node ?? view.selection[0])?.item)),
    vscode.commands.registerCommand("imprimatur.setup.markSeen", () => provider.markSeen()),
    vscode.commands.registerCommand("imprimatur.setup.compareVariant", (node) => compareVariant(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.explainLastChange", (node) => explainLastChange(provider, node ?? view.selection[0])),
    vscode.commands.registerCommand("imprimatur.setup.audit", () => recommendationsMenu(provider)),
    vscode.commands.registerCommand("imprimatur.setup.auditAgent", () => runAudit(provider)),
    vscode.commands.registerCommand("imprimatur.setup.dismissFinding", (node) => setFinding(provider, node ?? view.selection[0], "dropped")),
    vscode.commands.registerCommand("imprimatur.setup.reopenFinding", (node) => setFinding(provider, node ?? view.selection[0], "open")),
    vscode.commands.registerCommand("imprimatur.setup.applyFinding", (node) => setFinding(provider, node ?? view.selection[0], "done")),
  );
  followActiveEditor(ctx, provider);
  return provider;
}

/**
 * "Audit agent setup" (#77): agnix over each repo of the window and the home's agent
 * folders; the findings land in each root's AUDIT task. agnix runs a downloaded binary:
 * not in an untrusted folder.
 * @param {SetupView} provider
 */
async function runAudit(provider) {
  if (!vscode.workspace.isTrusted) return void vscode.window.showInformationMessage("Imprimatur: the audit runs agnix (fetched with npx); trust this folder first.");
  if (provider.auditing) return;
  const db = require("./records.js").dbOf();
  if (!db) return void vscode.window.showErrorMessage(`Imprimatur: no database for the audit records (${require("./records.js").lastError ?? "unknown"}).`);
  const { locateAgnixAsync, runAgnixAsync, explainRulesAsync, auditRoot, pathsOf, describeSummary } = require("./setup-audit.js");
  provider.auditing = true;
  try {
    const lines = await vscode.window.withProgress({ location: { viewId: "imprimatur.setup" }, title: "Auditing the agent setup" }, async () => {
      const bin = await locateAgnixAsync();
      const rules = new Map();
      const out = [];
      for (const s of provider.scopes) {
        const scope = { root: s.root, global: s.global };
        const paths = pathsOf(scope);
        const report = paths.length ? await runAgnixAsync(bin, s.root, { paths }) : { files_checked: 0, diagnostics: [] };
        // Rules explained here, not in auditRoot: its spawnSync would block the extension host.
        await explainRulesAsync(bin, report, rules);
        out.push(describeSummary(auditRoot(db, scope, { bin, rules, report })));
      }
      return out;
    });
    for (const l of lines) console.log(`Imprimatur audit: ${l}`);
    provider.refresh();
    const open = provider.audit?.open ?? 0;
    vscode.window.showInformationMessage(`Imprimatur: agent setup audited, ${open} open recommendation${open === 1 ? "" : "s"}. See Recommendations in Agent setup.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Imprimatur audit failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    provider.auditing = false;
  }
}

/**
 * Dismiss a finding (with why; it never comes back) or reopen one.
 * @param {SetupView} provider @param {any} node @param {"open" | "dropped"} status
 */
async function setFinding(provider, node, status) {
  if (!node?.recordId) return void vscode.window.showInformationMessage("Imprimatur: pick a recommendation first.");
  const db = require("./records.js").dbOf();
  if (!db) return;
  if (await require("./recs-ui.js").setRecommendation(db, node.recordId, status)) provider.refresh();
}

/**
 * The lightbulb (#87): what to run — the agent setup audit (agnix, quick, free), the
 * project review (Claude, a minute or two), or both.
 * @param {SetupView} provider
 */
async function recommendationsMenu(provider) {
  const pick = await vscode.window.showQuickPick([
    { label: "$(hubot) Audit the agent setup", description: "agnix · fast, free", id: "audit" },
    { label: "$(repo) Review the project", description: "Claude · ISO 25010 + NIST SSDF · 1–2 min", id: "review" },
    { label: "$(checklist) Both", id: "both" },
  ], { title: "Recommendations" });
  if (!pick) return;
  if (pick.id !== "review") await runAudit(provider);
  if (pick.id !== "audit") await vscode.commands.executeCommand("imprimatur.bestPractices.run");
}

/** Diff this repo's copy of a drifted file with a variant from another repo (#31). @param {SetupView} provider @param {Node | undefined} node */
async function compareVariant(provider, node) {
  if (node?.type !== "file") return void vscode.window.showInformationMessage("Imprimatur: pick an agent file in Agent setup first.");
  const d = provider.drift.driftFor(node.item.rel, node.item.abs);
  if (!d) return void vscode.window.showInformationMessage(`Imprimatur: ${node.item.rel} is the same in every repo that has it.`);
  const pick =
    d.others.length === 1
      ? d.others[0]
      : (await vscode.window.showQuickPick(d.others.map((v) => ({ label: v.repos.join(", "), description: v.hash.slice(0, 7), v })), { title: `Compare ${node.item.rel} with` }))?.v;
  const other = pick && provider.drift.pathOf(node.item.rel, pick.hash);
  if (!pick || !other) return;
  await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(other), vscode.Uri.file(node.item.abs), `${node.item.rel}: ${pick.repos[0]} ↔ ${node.scope.label}`);
}

/** "Explain last change": one sentence on the file's last commit (#32). @param {SetupView} provider @param {Node | undefined} node */
async function explainLastChange(provider, node) {
  if (node?.type !== "file" || node.scope.global) return void vscode.window.showInformationMessage("Imprimatur: pick an agent file of a repo in Agent setup first.");
  const { root } = node.scope;
  if (!provider.history.info(root, node.item.rel)) return void vscode.window.showInformationMessage(`Imprimatur: ${node.item.rel} is not committed yet.`);
  if (!provider.history.explained(root, node.item.rel) && !vscode.workspace.isTrusted)
    return void vscode.window.showInformationMessage("Imprimatur: explaining a change asks a model (claude); trust this folder first.");
  const text = await vscode.window.withProgress({ location: { viewId: "imprimatur.setup" } }, () => provider.history.explain(root, node.item.rel));
  provider.changed.fire(undefined);
  vscode.window.showInformationMessage(text ? `${node.item.label}: ${text}` : `Imprimatur: could not explain the last change of ${node.item.rel}.`);
}

/**
 * "For <file>" follows the active editor (debounced: switching tabs fast
 * redraws once). Only files on disk count.
 * @param {vscode.ExtensionContext} ctx @param {SetupView} provider
 */
function followActiveEditor(ctx, provider) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const update = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const file = doc?.uri.scheme === "file" ? doc.uri.fsPath : undefined;
    if (file === provider.activeFile) return;
    provider.activeFile = file;
    provider.changed.fire(undefined);
  };
  update();
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      clearTimeout(timer);
      timer = setTimeout(update, 300);
    }),
    { dispose: () => clearTimeout(timer) },
  );
}

module.exports = { registerSetupView };
