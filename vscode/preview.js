// @ts-check
// Markdown preview: the same agent changes, per block. A block (paragraph,
// heading, table row, code block) holding a change gets a class; a changed
// block's old text goes struck through right above it; deleted lines go
// struck through where they were.
"use strict";
const { mermaidDiff, mermaidBlocks, matchOld } = require("./mermaid-diff.js");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Block markers (list bullet, number, heading, quote) left out of the old text. */
const stripMarker = (line) => line.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>)\s+/, "").trim();

/**
 * @param {Array<{start: number, end: number}>} blocks source line ranges [start, end) of leaf blocks, in order
 * @param {ReturnType<typeof import("./diff.js").review>} hunks
 * @param {{fmt?: (line: string) => string, link?: (start: number, end: number) => string | undefined}} [opts]
 *   fmt: old line to HTML (default: escaped text); link: href of an Accept button for a line range
 * @returns {Array<{cls?: string, before: string[], after: string[]}>} one entry per block
 */
function planBlocks(blocks, hunks, opts = {}) {
  const fmt = opts.fmt ?? esc;
  const button = (start, end) => {
    const href = opts.link?.(start, end);
    return href ? `<a class="imprimatur-accept" data-ar="${start}-${end}" href="${href}" title="Accept this change">✓ Accept</a>` : "";
  };
  const plan = blocks.map(() => ({ cls: /** @type {string | undefined} */ (undefined), id: /** @type {string | undefined} */ (undefined), before: /** @type {string[]} */ ([]), after: /** @type {string[]} */ ([]) }));
  const at = (line) => blocks.findIndex((b) => line >= b.start && line < b.end);
  // data-ar ties a button to everything it clears in the preview: its old boxes and its block
  const old = (lines, fresh, id) =>
    `<div class="imprimatur-old ${fresh ? "imprimatur-latest" : "imprimatur-earlier"}" data-ar="${id}"><del>${lines.filter((l) => l.trim()).map((l) => fmt(stripMarker(l))).join("<br>")}</del></div>`;
  for (const h of hunks)
    for (const m of h.marks) {
      if (m.kind === "deleted") {
        // after the block holding the line before the deletion; at the top if none
        let i = m.afterLine < 0 ? -1 : at(m.afterLine);
        if (i < 0 && m.afterLine >= 0) i = blocks.findLastIndex((b) => b.end <= m.afterLine + 1);
        const line = Math.max(m.afterLine, 0);
        const bar = button(line, line + 1);
        const box = bar + old(m.oldLines, m.fresh, `${line}-${line + 1}`);
        if (i < 0) (plan[0] ?? { before: [] }).before.push(box);
        else plan[i].after.push(box);
        continue;
      }
      const i = at(m.line);
      if (i < 0) continue; // blank line or outside any leaf block
      const p = plan[i];
      p.id = `${blocks[i].start}-${blocks[i].end}`;
      if (!p.cls) {
        const bar = button(blocks[i].start, blocks[i].end);
        if (bar) p.before.push(bar);
      }
      const kind = m.kind === "added" && (!p.cls || p.cls.includes("added")) ? "added" : "changed";
      const layer = m.fresh || p.cls?.includes("latest") ? "latest" : "earlier";
      p.cls = `imprimatur-${kind} imprimatur-${layer}`;
      if (m.kind === "changed") p.before.push(old([m.oldText], m.fresh, p.id));
    }
  return plan;
}

const LEAF = new Set(["paragraph_open", "heading_open", "tr_open", "fence", "code_block", "html_block", "hr"]);

/**
 * markdown-it plugin. VS Code parses (and caches the tokens) without knowing
 * the document; only renderer.render gets env.currentDocument. So the marks are
 * added at render time, on copies of the cached tokens.
 * getHunks(env) returns the hunks for the document being rendered, [] for none.
 * link(env, start, end), when given, is the href of an Accept button for that line range.
 * @param {any} md @param {(env: any) => ReturnType<typeof import("./diff.js").review>} getHunks
 * @param {(env: any, start: number, end: number) => string | undefined} [link]
 * @param {(env: any) => string | undefined} [getBase] the copy's text, for Mermaid diagram diffs
 */
function markdownItPlugin(md, getHunks, link, getBase) {
  const render = md.renderer.render.bind(md.renderer);
  const INLINE = { imprimaturInline: true }; // our own renderInline calls: no marks there
  md.renderer.render = (tokens, options, env) => {
    if (env?.imprimaturInline) return render(tokens, options, env);
    let hunks = [];
    let base;
    try {
      hunks = getHunks(env);
      base = getBase?.(env);
    } catch {
      // a broken copy must never break the preview
    }
    if (!hunks.length && !base) return render(tokens, options, env);
    const opts = { fmt: (line) => md.renderInline(line, INLINE), link: link && ((start, end, rerender) => link(env, start, end, rerender)), base };
    let marked = tokens;
    try {
      marked = annotate(tokens, hunks, opts);
    } catch (e) {
      // A bug in the marks must never blank the preview: show it unmarked.
      console.error("imprimatur preview:", e);
    }
    return render(marked, options, env);
  };
  return md;
}

/**
 * Mermaid fences the agent changed: a copy of the token with color lines
 * appended, and a legend (with an Accept button) to put above it.
 */
function diagramDiff(t, opts, Token, html) {
  if (!opts?.base || t.type !== "fence" || t.info.trim().split(/\s+/)[0] !== "mermaid") return undefined;
  const old = matchOld(mermaidBlocks(opts.base), t.content);
  if (old === undefined || old.trim() === t.content.trim()) return undefined;
  const d = mermaidDiff(old, t.content);
  if (!d.lines.length) return undefined;
  const copy = Object.assign(new Token(t.type, t.tag, t.nesting), t);
  copy.content = `${t.content.replace(/\s*$/, "")}\n${d.lines.join("\n")}\n`;
  // A diagram's colors live in the rendered SVG: its accept needs a real re-render.
  const href = t.map && opts.link?.(t.map[0], t.map[1], true);
  const button = href ? `<a class="imprimatur-accept" href="${href}" title="Accept this diagram's changes">✓ Accept</a>` : "";
  const legend = html(
    `<div class="imprimatur-diagram">${button}Agent changes in this diagram: ` +
      `<span class="imprimatur-d-added">■ added ${d.added}</span> ` +
      `<span class="imprimatur-d-changed">■ changed ${d.changed}</span> ` +
      `<span class="imprimatur-d-removed">■ removed ${d.removed}</span></div>`,
  );
  return { copy, legend };
}

/** New token list with the marks; the input tokens are not changed. @param {any[]} tokens */
function annotate(tokens, hunks, opts) {
  const Token = tokens[0]?.constructor;
  if (!Token) return tokens;
  const idx = [];
  tokens.forEach((t, i) => t.map && LEAF.has(t.type) && idx.push(i));
  const plan = planBlocks(idx.map((i) => ({ start: tokens[i].map[0], end: tokens[i].map[1] })), hunks, opts);
  const html = (content) => Object.assign(new Token("html_block", "", 0), { content });
  /** @type {Map<number, any>} */
  const replaced = new Map();
  /** @type {Map<number, any[]>} token index -> tokens to put before / after it */
  const before = new Map();
  const after = new Map();
  tokens.forEach((t, i) => {
    const dd = diagramDiff(t, opts, Token, html);
    if (!dd) return;
    replaced.set(i, dd.copy);
    before.set(i, [dd.legend]);
  });
  // A table cannot hold a button: one Accept above a table with marked rows.
  tokens.forEach((t, i) => {
    if (t.type !== "table_open" || !t.map || !opts?.link) return;
    let j = i;
    while (j < tokens.length && tokens[j].type !== "table_close") j++;
    const marked = idx.some((x, k) => x > i && x < j && plan[k].cls);
    const href = marked && opts.link(t.map[0], t.map[1]);
    if (href) before.set(i, [...(before.get(i) ?? []), html(`<a class="imprimatur-accept" href="${href}" title="Accept this table's changes">✓ Accept table</a>`)]);
  });
  idx.forEach((i, k) => {
    const p = plan[k];
    if (p.cls) {
      // A tight list does not render its items' paragraphs: the class goes on the item.
      let at = i;
      if (tokens[i].hidden && tokens[i].type === "paragraph_open") {
        let li = i - 1;
        while (li >= 0 && !(tokens[li].type === "list_item_open" && tokens[li].level === tokens[i].level - 1)) li--;
        if (li >= 0) at = li;
      }
      const src = replaced.get(at) ?? tokens[at];
      const copy = Object.assign(new Token(src.type, src.tag, src.nesting), src);
      copy.attrs = src.attrs ? src.attrs.map((a) => [...a]) : null;
      const has = (copy.attrGet("class") ?? "").split(" ");
      if (!p.cls.split(" ").every((c) => has.includes(c))) copy.attrJoin("class", p.cls);
      copy.attrSet("data-ar", p.id);
      replaced.set(at, copy);
    }
    // A div cannot sit inside a table: rows only get the class.
    if (tokens[i].type === "tr_open") return;
    if (p.before.length) before.set(i, [...(before.get(i) ?? []), ...p.before.map(html)]);
    if (!p.after.length) return;
    // after the whole block: its matching *_close, or itself for single tokens
    let j = i;
    if (tokens[i].type.endsWith("_open")) {
      const close = tokens[i].type.replace("_open", "_close");
      while (j < tokens.length && !(tokens[j].type === close && tokens[j].level === tokens[i].level)) j++;
    }
    after.set(j, [...(after.get(j) ?? []), ...p.after.map(html)]);
  });
  return tokens.flatMap((t, i) => [...(before.get(i) ?? []), replaced.get(i) ?? t, ...(after.get(i) ?? [])]);
}

/** Block types that are one unit of review when all new (CommonMark leaf and container blocks, GFM tables). */
const UNITS = new Set(["table_open", "blockquote_open", "list_item_open", "fence", "code_block", "html_block", "paragraph_open", "heading_open", "hr"]);

/**
 * Line ranges of the Markdown blocks in a text, from the same markdown-it the
 * preview uses. Lists are not units: their items are.
 * @param {any} md markdown-it instance @param {string} text
 */
function markdownBlocks(md, text) {
  return md
    .parse(text, {})
    .filter((t) => t.map && UNITS.has(t.type))
    .map((t) => ({ start: t.map[0], end: t.map[1] }));
}

module.exports = { planBlocks, markdownItPlugin, annotate, markdownBlocks };
