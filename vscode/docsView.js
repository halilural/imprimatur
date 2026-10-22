// @ts-check
// Design documents in the Imprimatur panel (#72): the "Mimari" (architecture), "Ürün"
// (product) and "Sözlük" (glossary: one section per term, alphabetical) tabs. A living document per repo and kind, in sections the agent
// writes through MCP (doc_section_upsert) and the user edits here; records (adr,
// pdr, decision, …) contribute to sections. Pure like tasksView.js: the builders
// take a database connection and return a model or HTML; the panel (graphView.js)
// draws the HTML and sends the user's writes back to applyDocMessage.
"use strict";
const { DOC_KINDS, SECTION_BODY_MAX } = require("./db.js");

const DOC_TABS = /** @type {const} */ (["architecture", "product", "glossary"]);
const TAB_LABEL = { architecture: "Mimari", product: "Ürün", glossary: "Sözlük" };
const WHO_TR = { user: "Sen", agent: "Ajan", hook: "Hook", import: "Eşitleme" };
const FIELD_TR = { title: "başlık", body: "metin", position: "sıra", status: "durum", records: "katkı veren kayıtlar" };

/** Lazily: the extension bundles it; a missing one shows the Markdown as text. @type {any} */
let md;
/** Rendered bodies by text: a redraw that changed nothing renders nothing again. @type {Map<string, string>} */
const rendered = new Map();

/**
 * A section's Markdown as HTML. Raw HTML in it stays text (html: false); links only
 * http(s), mailto and in-page anchors (markdown-it's own check drops javascript: and data:).
 * @param {string | null | undefined} text
 */
function renderMarkdown(text, { steps = false } = {}) {
  const src = String(text ?? "");
  if (!src.trim()) return "";
  const key = (steps ? "S" : "-") + src;
  const hit = rendered.get(key);
  if (hit !== undefined) return hit;
  let out;
  try {
    out = markdown().render(src, { steps });
  } catch {
    md = null;
    out = `<pre>${esc(src)}</pre>`;
  }
  if (md === null) out = `<pre>${esc(src)}</pre>`;
  if (rendered.size > 500) rendered.clear();
  rendered.set(key, out);
  return out;
}

/** A path with no scheme, not absolute: a file beside the documents. */
const RELATIVE = /^(?![a-z][a-z0-9+.-]*:)(?![\\/])\S/i;
/** The prefix of a relative image's src, which the panel replaces with the documents folder's webview URI. */
const DOC_IMG = "imprimatur-doc:";

/** markdown-it, set up once: safe links, relative images, mermaid fences, "- [ ] step" checkboxes. */
function markdown() {
  if (md === undefined) {
    const MarkdownIt = require("markdown-it");
    md = new MarkdownIt({ html: false, linkify: true, typographer: false });
    const valid = md.validateLink.bind(md);
    md.validateLink = (/** @type {string} */ url) => valid(url) && (/^(https?:|mailto:|#)/i.test(url.trim()) || RELATIVE.test(url.trim()));
    md.renderer.rules.fence = mermaidFence(md.renderer.rules.fence);
    // A relative path: an image is a file next to the design documents (the panel turns
    // DOC_IMG into its webview URI); a link to one goes nowhere in the panel, its text stays.
    const image = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const src = tokens[idx].attrGet("src") ?? "";
      if (RELATIVE.test(src)) tokens[idx].attrSet("src", DOC_IMG + src.replace(/^\.\//, ""));
      tokens[idx].attrJoin("class", "mdimg");
      return /** @type {any} */ (image)(tokens, idx, options, env, self);
    };
    const linkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      if (RELATIVE.test(tokens[idx].attrGet("href") ?? "")) tokens[idx].attrs = (tokens[idx].attrs ?? []).filter(([k]) => k !== "href");
      return linkOpen(tokens, idx, options, env, self);
    };
    md.core.ruler.after("inline", "steps", stepRule);
  }
  return md;
}

const STEP = /^\[([ xX])\]\s+/;

/**
 * A list item that starts with "[ ]" or "[x]" is a step: a checkbox carrying its source
 * line (data-line), which the panel ticks by rewriting that line (toggleStep). With
 * env.steps off (design documents) the box only shows.
 * @param {any} state markdown-it's core state
 */
function stepRule(state) {
  const t = state.tokens;
  for (let i = 2; i < t.length; i++) {
    if (t[i].type !== "inline" || t[i - 1].type !== "paragraph_open" || t[i - 2].type !== "list_item_open") continue;
    const first = t[i].children?.[0];
    const m = first?.type === "text" && STEP.exec(first.content);
    if (!m || !t[i].map) continue;
    const on = m[1] !== " ";
    first.content = first.content.slice(m[0].length);
    t[i].content = t[i].content.replace(STEP, "");
    t[i - 2].attrJoin("class", on ? "step on" : "step");
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" class="mdstep" data-line="${t[i].map[0]}"${on ? " checked" : ""}${state.env?.steps ? "" : " disabled"} aria-label="Adım">`;
    t[i].children.unshift(box);
  }
}

/** The steps of a Markdown text: source line and whether ticked. @param {string | null | undefined} text */
function stepsOf(text) {
  const src = String(text ?? "");
  if (!/\[[ xX]\]/.test(src)) return [];
  /** @type {{line: number, done: boolean}[]} */
  const out = [];
  try {
    // The step rule runs in parse: it has marked the steps' list items.
    const t = markdown().parse(src, {});
    for (let i = 2; i < t.length; i++) {
      const cls = t[i - 2].type === "list_item_open" ? t[i - 2].attrGet("class") ?? "" : "";
      if (t[i].type === "inline" && t[i].map && /\bstep\b/.test(cls)) out.push({ line: t[i].map[0], done: /\bon\b/.test(cls) });
    }
  } catch {
    // no markdown-it: no steps
  }
  return out;
}

/**
 * The text with the step on `line` ticked (or not); unchanged when that line is no step.
 * @param {string} text @param {number} line @param {boolean} done
 */
function toggleStep(text, line, done) {
  const src = String(text ?? "");
  if (!stepsOf(src).some((s) => s.line === line)) return src;
  const lines = src.split("\n");
  lines[line] = lines[line].replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/, `$1[${done ? "x" : " "}]`);
  return lines.join("\n");
}

/**
 * A fence renderer that leaves a ```mermaid block as its escaped source in a
 * <div class="mermaid-src" data-key="…"><pre>: the panel draws it as a diagram (graphView.js)
 * into the div's shadow root (a <pre> cannot have one),
 * from a cache by key. Every other fence goes to markdown-it's own renderer.
 * @param {Function} fallback markdown-it's fence rule
 */
function mermaidFence(fallback) {
  return (/** @type {any[]} */ tokens, /** @type {number} */ idx, /** @type {any} */ options, /** @type {any} */ env, /** @type {any} */ self) => {
    const t = tokens[idx];
    if (String(t.info ?? "").trim().split(/\s+/)[0].toLowerCase() !== "mermaid") return fallback(tokens, idx, options, env, self);
    return `<div class="mermaid-src" data-key="${mermaidKey(t.content)}"><pre>${esc(t.content)}</pre></div>\n`;
  };
}

/** A short, stable key of a diagram's source. @param {string} src */
const mermaidKey = (src) => require("node:crypto").createHash("sha1").update(String(src)).digest("hex").slice(0, 16);

const esc = (/** @type {unknown} */ s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "9 Eki 22:40" @param {number} ms */
const when = (ms) => new Date(ms).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * A slug for a new section's key, from its title: Turkish letters folded, at most 48 chars.
 * @param {string} title
 */
function slugify(title) {
  const map = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u" };
  const s = String(title ?? "")
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => /** @type {any} */ (map)[c])
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "bolum";
}

/** The panel's edit state for this kind: a section id, "new", or undefined. @param {unknown} edit @param {string} kind */
function editOf(edit, kind) {
  const m = /^(architecture|product|glossary):(new|\d+)$/.exec(String(edit ?? ""));
  if (!m || m[1] !== kind) return undefined;
  return m[2] === "new" ? "new" : Number(m[2]);
}

/** What one version of a section did, in words. @param {any} v */
function describeSectionVersion(v) {
  const who = /** @type {any} */ (WHO_TR)[v.actor_kind] ?? v.actor_kind;
  const a = v.after ?? {};
  if (!v.before && "key" in a) return { at: v.at, who, kind: v.actor_kind, what: "bölümü yazdı" };
  if (a.status === "superseded") return { at: v.at, who, kind: v.actor_kind, what: "eskimiş saydı" };
  if (a.status === "current" && Object.keys(a).length === 1) return { at: v.at, who, kind: v.actor_kind, what: "yeniden güncel yaptı" };
  const fields = Object.keys(a).map((f) => /** @type {any} */ (FIELD_TR)[f] ?? f);
  return { at: v.at, who, kind: v.actor_kind, what: `${fields.join(", ")} değiştirdi` };
}

/** The repo row of a root, as tasksView finds it. @param {any} db @param {string} root */
const repoOf = (db, root) => require("./tasksView.js").repoOfRoot(db, root);

/**
 * One document tab's model. Reading never creates the document: an empty one shows until
 * the agent or the user writes its first section.
 * @param {any} db @param {string} root @param {string} kind "architecture" | "product" | "glossary"
 * @param {{edit?: string | null, docFlash?: string | null}} [view]
 */
function docModel(db, root, kind, view = {}) {
  const KIND_LABEL = require("./tasksView.js").KIND_LABEL;
  const repo = repoOf(db, root);
  const doc = repo ? db.docFind(repo.id, kind) : undefined;
  const sections = doc ? db.docSections(doc.id) : [];
  const last = doc ? db.docLastChange(doc.id) : undefined;
  // Changed by someone else since the user last read it (#92).
  const unread = new Set(doc ? db.unreadSections(repo.id).filter((/** @type {any} */ s) => s.doc_id === doc.id).map((/** @type {any} */ s) => s.id) : []);
  const edit = editOf(view.edit, kind);
  let n = 0;
  const shape = (/** @type {any} */ s) => {
    const current = s.status === "current";
    return {
      // Terms are not numbered: the glossary reads alphabetically.
      id: s.id, key: s.key, title: s.title, status: s.status, n: current && kind !== "glossary" ? ++n : null,
      body: s.body ?? "", html: renderMarkdown(s.body),
      contributors: s.contributors.map((/** @type {any} */ r) => ({
        id: r.id, kind: r.kind, label: /** @type {any} */ (KIND_LABEL)[r.kind] ?? r.kind, title: r.title, task: r.task_key, status: r.status,
      })),
      updated: s.updated_at,
      versions: db.sectionVersions(s.id).map(describeSectionVersion),
      editing: edit === s.id,
      flash: !!view.docFlash && view.docFlash === s.key,
      unread: unread.has(s.id),
    };
  };
  const current = sections.filter((/** @type {any} */ s) => s.status === "current").map(shape);
  const superseded = sections.filter((/** @type {any} */ s) => s.status !== "current").map(shape);
  return {
    kind, label: /** @type {any} */ (TAB_LABEL)[kind], title: doc?.title ?? /** @type {any} */ (DOC_KINDS)[kind],
    repoName: repo?.name ?? root.split(/[\\/]/).pop(),
    last: last ? { at: last.at, who: /** @type {any} */ (WHO_TR)[last.actor_kind] ?? last.actor_kind, actor: last.actor } : undefined,
    current, superseded, adding: edit === "new", empty: !sections.length, unread: [...unread],
    // The repo's docs/ file someone wrote by hand: the export leaves it alone (#72).
    manual: require("./docs-export.js").fileState(root, kind) === "manual"
      ? `docs/${/** @type {any} */ (require("./docs-export.js").FILES)[kind]}` : undefined,
  };
}

// ---- HTML: each block has a data-k key; the page swaps only the blocks that changed ----

/** @param {ReturnType<typeof docModel>} m @param {any} s */
function editorHtml(m, s) {
  const id = s ? s.id : "new";
  const g = m.kind === "glossary";
  return `<div class="deditor" data-k="ed"><input class="dtitle" data-draft="doct-${m.kind}-${id}" value="${esc(s?.title ?? "")}" placeholder="${g ? "Terim" : "Bölüm başlığı"}" aria-label="${g ? "Terim" : "Bölüm başlığı"}">
<textarea data-draft="doc-${m.kind}-${id}" rows="${g ? 6 : 14}" placeholder="${g ? "Tanımı (Markdown): ne demek, nerede geçer, neyle karışmasın" : "Markdown (### alt başlık, listeler, kod, tablo)"}" aria-label="${g ? "Terimin tanımı (Markdown)" : "Bölüm metni (Markdown)"}">${esc(s?.body ?? "")}</textarea>
<div class="acts"><button class="primary" data-act="docSave" data-kind="${m.kind}" data-id="${id}">Kaydet</button><button class="ghost" data-act="docCancel" data-kind="${m.kind}" data-id="${id}">Vazgeç</button><span class="hint">Ctrl+Enter kaydeder · Esc kutudan çıkar</span></div></div>`;
}

/** @param {ReturnType<typeof docModel>} m @param {any} s */
function sectionHtml(m, s) {
  const { kindChip, icon } = require("./tasksView.js");
  const q = esc([s.title, s.body, ...s.contributors.map((/** @type {any} */ r) => `${r.title} ${r.task}`)].join(" "));
  const acts = s.editing ? "" : `<div class="dacts">${s.unread ? `<button class="primary" data-act="read" data-ids="${s.id}">Okudum</button>` : ""}<button class="ghost" data-act="docEdit" data-kind="${m.kind}" data-id="${s.id}">Düzenle</button><button class="link" data-act="docStatus" data-id="${s.id}" data-status="${s.status === "current" ? "superseded" : "current"}">${s.status === "current" ? "Eskimiş say" : "Güncel yap"}</button></div>`;
  const body = s.editing ? editorHtml(m, s) : s.html ? `<div class="md">${s.html}</div>` : `<p class="empty">${m.kind === "glossary" ? "Tanımı henüz yazılmadı." : "Bu bölüm henüz boş."}</p>`;
  // Folded by default: the section text is the point, the records are its trail.
  const contrib = s.contributors.length
    ? `<details class="contrib"><summary>Dayandığı kayıtlar · ${s.contributors.length}</summary><div class="rchips">${s.contributors.map((/** @type {any} */ r) => `<a href="#" class="rchip${r.status === "dropped" ? " gone" : ""}" data-act="showRecord" data-id="${r.id}" title="Görevler'de göster">${kindChip(r.kind, r.label)}<span class="rt">${esc(r.title)}</span><span class="mono dim">${esc(r.task)}</span></a>`).join("")}</div></details>`
    : "";
  const hist = s.versions.length
    ? `<details class="hist"><summary>Geçmiş · ${s.versions.length}</summary>${s.versions.map((/** @type {any} */ v) => `<div class="ev"><span class="when">${esc(when(v.at))}</span><span class="who w-${esc(v.kind)}">${esc(v.who)}</span><span class="what">${esc(v.what)}</span></div>`).join("")}</details>`
    : "";
  return `<article class="dsec${s.status !== "current" ? " old" : ""}${s.flash ? " flash" : ""}${s.unread ? " unread" : ""}" id="sec-${esc(s.key)}" data-k="s${s.id}" data-nav tabindex="0" data-q="${q}">
<div class="dsec-h"><h2>${s.n ? `<span class="num">${s.n}.</span>` : s.status === "current" ? "" : `${icon("file", 14)}`}${esc(s.title)}${s.unread ? ' <span class="upill">Okunmadı</span>' : ""}</h2>${acts}</div>${body}${contrib}${hist}</article>`;
}

/** @param {ReturnType<typeof docModel>} m */
function docHtml(m) {
  const { icon } = require("./tasksView.js");
  const g = m.kind === "glossary";
  const toc = `<aside class="dtoc" data-k="toc" data-scroll="dtoc" aria-label="${g ? "Terimler" : "İçindekiler"}"><div class="lbl" data-k="h">${g ? `Terimler · ${m.current.length}` : "İçindekiler"}</div><ol data-k="list">${m.current.map((s) => `<li data-k="t${s.id}" data-q="${esc(`${s.title} ${s.body}`)}"><a href="#sec-${esc(s.key)}" data-act="docGo" data-key="${esc(s.key)}">${s.n ? `<span class="num">${s.n}</span>` : ""}<span>${esc(s.title)}</span>${s.unread ? '<span class="udot" title="Okunmadı" aria-label="Okunmadı"></span>' : ""}</a></li>`).join("") || `<li data-k="none" class="dim">${g ? "Terim yok" : "Bölüm yok"}</li>`}</ol>${m.superseded.length ? `<a href="#sec-__old" class="dold" data-k="old" data-act="docGo" data-key="__old">${g ? "Eskimiş terimler" : "Eskimiş bölümler"} · ${m.superseded.length}</a>` : ""}<button class="dashed" data-k="new" data-act="docEdit" data-kind="${m.kind}" data-id="new">${icon("plus")} ${g ? "Yeni terim" : "Yeni bölüm"}</button></aside>`;
  const head = `<section class="dhead" data-k="head"><span class="lbl">${esc(m.label)} · ${esc(m.repoName)}</span><h1>${esc(m.title)}</h1><p class="lead">${m.last ? `Son güncelleme · ${esc(when(m.last.at))} · ${esc(m.last.who)}` : "Henüz güncellenmedi"}</p>${m.manual ? `<p class="dnote">${esc(m.manual)} elle yazılmış, üzerine yazılmadı</p>` : ""}${m.unread?.length ? `<p class="dunread"><span class="upill">${m.unread.length} okunmadı</span><button class="link" data-act="read" data-ids="${m.unread.join(",")}">Hepsini okudum</button></p>` : ""}</section>`;
  const empty = m.empty && !m.adding && g
    ? `<div class="card dempty emptyhero" data-k="empty">${require("./mascot.js").mascot(56)}<div><p>Sözlük henüz boş. Ajan, projede yeni bir terim ortaya çıktığında ya da bir terimin anlamı değiştiğinde onu <span class="mono">doc_section_upsert</span> ile burada yazar.</p><p class="dim">Sen de soldan "Yeni terim" ile ekleyebilirsin. Sözlük repoya docs/GLOSSARY.md olarak da yazılır.</p></div></div>`
    : m.empty && !m.adding
    ? `<div class="card dempty emptyhero" data-k="empty">${require("./mascot.js").mascot(56)}<div><p>Bu doküman henüz boş. Ajan, bir ${m.kind === "architecture" ? "ADR" : "PDR"} ya da karar eklediğinde ilgili bölümü <span class="mono">doc_section_upsert</span> ile burada yazar ve kaydı bağlar.</p><p class="dim">Sen de soldan "Yeni bölüm" ile bir bölüm ekleyebilirsin. Doküman repoya docs/${m.kind === "architecture" ? "ARCHITECTURE" : "PRODUCT"}.md olarak da yazılır.</p></div></div>`
    : "";
  const adding = m.adding ? `<section class="dsec adding" data-k="new"><div class="dsec-h"><h2>${g ? "Yeni terim" : "Yeni bölüm"}</h2></div>${editorHtml(m, undefined)}</section>` : "";
  const sections = m.current.map((s) => sectionHtml(m, s)).join("");
  const old = m.superseded.length
    ? `<details class="dolds" id="sec-__old" data-k="old"${m.superseded.some((s) => s.editing || s.flash) ? " open" : ""}><summary>${g ? "Eskimiş terimler" : "Eskimiş bölümler"} · ${m.superseded.length}</summary>${m.superseded.map((s) => sectionHtml(m, s)).join("")}</details>`
    : "";
  return `<div class="doc" data-k="doc-${m.kind}">${toc}<main class="dpage" data-k="page" data-navgroup="doc">${head}${empty}${adding}${sections}${old}</main></div>`;
}

/**
 * A write from a document tab, as the user: a section saved, a new one, its status.
 * @param {any} db @param {any} m the page's message @param {{kind: "user", id?: string}} actor @param {string | undefined} root the panel's repo
 */
function applyDocMessage(db, m, actor, root) {
  const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v.replace(/\r\n/g, "\n") : undefined);
  const body = text(m.body);
  if (body !== undefined && body.length > SECTION_BODY_MAX) throw new Error(`Imprimatur: the section is ${body.length} chars; the limit is ${SECTION_BODY_MAX}`);
  const title = text(m.title)?.trim();
  if (title !== undefined && title.length > 300) throw new Error("Imprimatur: the section title is over 300 chars");
  switch (m?.type) {
    case "docSave": {
      const s = db.sectionById(Number(m.id));
      if (!s) throw new Error(`Imprimatur: no section ${m.id}`);
      return db.upsertSection(s.doc_id, s.key, { ...(title && { title }), ...(body !== undefined && { body: body.trim() ? body : null }) }, actor);
    }
    case "docNew": {
      if (!DOC_TABS.includes(m.kind)) throw new Error(`Imprimatur: bad document kind ${m.kind}`);
      if (!title) throw new Error("Imprimatur: a new section needs a title");
      if (!root) throw new Error("Imprimatur: no repo open");
      const repo = repoOf(db, root) ?? db.repoOf(root);
      const doc = db.docOf(repo.id, m.kind);
      const base = slugify(title);
      let key = base;
      for (let i = 2; db.docSection(doc.id, key); i++) key = `${base}-${i}`;
      return db.upsertSection(doc.id, key, { title, body: body?.trim() ? body : null }, actor);
    }
    case "docStatus": {
      const s = db.sectionById(Number(m.id));
      if (!s) throw new Error(`Imprimatur: no section ${m.id}`);
      if (m.status !== "current" && m.status !== "superseded") throw new Error(`Imprimatur: bad section status ${m.status}`);
      return db.upsertSection(s.doc_id, s.key, { status: m.status }, actor);
    }
    default:
      throw new Error(`Imprimatur: unknown document message ${m?.type}`);
  }
}

/** Styles of the document tabs: VS Code theme colours only, like the other tabs. */
const DOCS_CSS = `
  .doc { display: flex; align-items: stretch; margin: 0 -12px; border-top: 1px solid var(--line); min-height: calc(100vh - var(--appbar-h, 52px)); }
  .dtoc { flex: 1 1 220px; max-width: 280px; min-width: 0; padding: 18px 12px; background: var(--vscode-sideBar-background); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - var(--appbar-h, 52px)); overflow: auto; position: sticky; top: var(--appbar-h, 52px); box-sizing: border-box; }
  .dtoc ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .dtoc li a { display: flex; gap: 8px; padding: 5px 8px; border-radius: 6px; color: var(--vscode-foreground) !important; font-weight: 600; }
  .dtoc li a:hover { background: var(--acc-soft); text-decoration: none !important; }
  .dtoc .num { flex: none; min-width: 18px; color: var(--acc); font-weight: 700; }
  /* A narrow panel: the contents sit above the page and scroll away with it, or a sticky
     one would cover the section a click scrolls to. */
  @media (max-width: 760px) {
    .doc { flex-direction: column; }
    .dtoc { position: static; max-width: none; max-height: none; border-right: 0; border-bottom: 1px solid var(--line); }
  }
  .dold { padding: 4px 8px; font-size: 12px; font-weight: 600; }
  .dpage { flex: 999 1 520px; min-width: 0; max-width: 980px; padding: 22px 30px 48px; display: flex; flex-direction: column; gap: 18px; box-sizing: border-box; }
  .dhead { display: flex; flex-direction: column; gap: 4px; }
  .dnote { margin: 4px 0 0; font-weight: 600; color: var(--vscode-editorWarning-foreground, var(--acc)); }
  .dempty { display: flex; gap: 16px; } .dempty > div { display: flex; flex-direction: column; gap: 6px; } .dempty p { margin: 0; }
  .dsec { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 18px 22px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--card); box-shadow: var(--shadow); scroll-margin-top: calc(var(--appbar-h, 52px) + 12px); }
  body.vscode-high-contrast .dsec, body.vscode-high-contrast-light .dsec { border-color: var(--vscode-contrastBorder); }
  .dsec.old { opacity: .85; } .dsec.adding { border-color: var(--acc); }
  .dsec.unread { border-left: 4px solid var(--vscode-editorInfo-foreground, var(--acc)); }
  .upill { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; vertical-align: 2px; color: var(--vscode-editorInfo-foreground, var(--acc)); border: 1px solid currentColor; }
  .udot { flex: none; width: 8px; height: 8px; margin: 6px 0 0 auto; border-radius: 50%; background: var(--vscode-editorInfo-foreground, var(--acc)); }
  .dunread { display: flex; align-items: center; gap: 10px; margin: 4px 0 0; } .dunread .upill { margin-left: 0; }
  .dsec-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .dsec-h h2 { font-size: 17px !important; } .dsec-h .num { color: var(--acc); }
  .dacts { display: flex; gap: 6px; align-items: center; }
  .md { font-family: var(--vscode-markdown-font-family, var(--vscode-font-family)); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
  .md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
  .md h1, .md h2, .md h3, .md h4 { font-size: 15px; margin: 14px 0 6px; font-weight: 700; }
  .md code { font-family: var(--vscode-editor-font-family); font-size: 12.5px; padding: 1px 4px; border-radius: 4px; background: var(--vscode-textCodeBlock-background); }
  .mermaid-src > pre { white-space: pre-wrap; }
  .md pre { padding: 10px 12px; border-radius: 6px; background: var(--vscode-textCodeBlock-background); overflow-x: auto; } .md pre code { padding: 0; background: none; }
  .md blockquote { margin: 8px 0; padding: 4px 12px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--acc)); background: var(--vscode-textBlockQuote-background); }
  /* A wide table scrolls inside its section instead of running out of it. */
  .md table { display: block; max-width: 100%; width: max-content; overflow-x: auto; border-collapse: collapse; margin: 8px 0; }
  .md th, .md td { border: 1px solid var(--line); padding: 4px 10px; text-align: left; vertical-align: top; min-width: 60px; max-width: 420px; overflow-wrap: break-word; }
  .md img { max-width: 100%; height: auto; border-radius: 6px; border: 1px solid var(--line); }
  .md a { color: var(--vscode-textLink-foreground); }
  .md li.step { list-style: none; margin-left: -20px; } .md li.step > p { margin: 2px 0; }
  .md input.mdstep { margin: 0 8px 0 0; width: 15px; height: 15px; vertical-align: -2px; accent-color: var(--acc); cursor: pointer; } .md input.mdstep:disabled { cursor: default; }
  .md li.step.on { color: var(--vscode-descriptionForeground); } .md li.step.on > p, .md li.step.on { text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 50%, transparent); }
  .rchips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 8px; }
  .rchip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 8px 2px 2px; border: 1px solid var(--line); border-radius: 12px; color: var(--vscode-foreground) !important; font-size: 12px; }
  .rchip:hover { background: var(--vscode-list-hoverBackground); text-decoration: none !important; } .rchip.gone .rt { text-decoration: line-through; }
  .rchip .rt { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
  .contrib summary, .hist summary, .dolds summary { cursor: pointer; font-weight: 600; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .dolds summary { font-size: 14px; padding: 6px 0; } .dolds > .dsec { margin-top: 10px; }
  .deditor { display: flex; flex-direction: column; gap: 8px; }
  .deditor input, .deditor textarea { padding: 7px 10px; border-radius: 6px; font: inherit; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  .deditor input { font-weight: 700; } .deditor textarea { resize: vertical; min-height: 160px; font-family: var(--vscode-editor-font-family); font-size: 13px; line-height: 1.5; }
  .deditor .acts { align-items: center; flex-wrap: wrap; }
`;

module.exports = { DOC_IMG, DOC_TABS, TAB_LABEL, DOCS_CSS, SECTION_BODY_MAX, docModel, docHtml, applyDocMessage, renderMarkdown, stepsOf, toggleStep, mermaidKey, slugify, editOf, describeSectionVersion };
