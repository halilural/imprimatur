// @ts-check
// Markdown preview: the same agent changes, per block. A block (paragraph,
// heading, table row, code block) holding a change gets a class; a changed
// block's old text goes struck through right above it; deleted lines go
// struck through where they were.
"use strict";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * @param {Array<{start: number, end: number}>} blocks source line ranges [start, end) of leaf blocks, in order
 * @param {ReturnType<typeof import("./diff.js").review>} hunks
 * @returns {Array<{cls?: string, before: string[], after: string[]}>} one entry per block
 */
function planBlocks(blocks, hunks) {
  const plan = blocks.map(() => ({ cls: /** @type {string | undefined} */ (undefined), before: /** @type {string[]} */ ([]), after: /** @type {string[]} */ ([]) }));
  const at = (line) => blocks.findIndex((b) => line >= b.start && line < b.end);
  const old = (lines, fresh) =>
    `<div class="agent-review-old ${fresh ? "agent-review-latest" : "agent-review-earlier"}"><del>${lines.map(esc).join("<br>")}</del></div>`;
  for (const h of hunks)
    for (const m of h.marks) {
      if (m.kind === "deleted") {
        // after the block holding the line before the deletion; at the top if none
        let i = m.afterLine < 0 ? -1 : at(m.afterLine);
        if (i < 0 && m.afterLine >= 0) i = blocks.findLastIndex((b) => b.end <= m.afterLine + 1);
        if (i < 0) (plan[0] ?? { before: [] }).before.push(old(m.oldLines, m.fresh));
        else plan[i].after.push(old(m.oldLines, m.fresh));
        continue;
      }
      const i = at(m.line);
      if (i < 0) continue; // blank line or outside any leaf block
      const p = plan[i];
      const kind = m.kind === "added" && (!p.cls || p.cls.includes("added")) ? "added" : "changed";
      const layer = m.fresh || p.cls?.includes("latest") ? "latest" : "earlier";
      p.cls = `agent-review-${kind} agent-review-${layer}`;
      if (m.kind === "changed") p.before.push(old([m.oldText], m.fresh));
    }
  return plan;
}

const LEAF = new Set(["paragraph_open", "heading_open", "tr_open", "fence", "code_block", "html_block", "hr"]);

/**
 * markdown-it plugin. getHunks(env) returns the hunks for the document being
 * rendered (env.currentDocument), or [] when it has no review copy.
 * @param {any} md @param {(env: any, src: string) => ReturnType<typeof import("./diff.js").review>} getHunks
 */
function markdownItPlugin(md, getHunks) {
  md.core.ruler.push("agent_review", (state) => {
    const hunks = getHunks(state.env, state.src);
    if (!hunks.length) return;
    const tokens = state.tokens;
    const idx = [];
    tokens.forEach((t, i) => t.map && LEAF.has(t.type) && idx.push(i));
    const plan = planBlocks(idx.map((i) => ({ start: tokens[i].map[0], end: tokens[i].map[1] })), hunks);
    const html = (content) => Object.assign(new state.Token("html_block", "", 0), { content });
    /** @type {Map<number, any[]>} token index -> tokens to put before / after it */
    const before = new Map();
    const after = new Map();
    idx.forEach((i, k) => {
      const p = plan[k];
      if (p.cls) tokens[i].attrJoin("class", p.cls);
      // A div cannot sit inside a table: rows only get the class.
      if (tokens[i].type === "tr_open") return;
      if (p.before.length) before.set(i, p.before.map(html));
      if (!p.after.length) return;
      // after the whole block: its matching *_close, or itself for single tokens
      let j = i;
      if (tokens[i].type.endsWith("_open")) {
        const close = tokens[i].type.replace("_open", "_close");
        while (j < tokens.length && !(tokens[j].type === close && tokens[j].level === tokens[i].level)) j++;
      }
      after.set(j, [...(after.get(j) ?? []), ...p.after.map(html)]);
    });
    state.tokens = tokens.flatMap((t, i) => [...(before.get(i) ?? []), t, ...(after.get(i) ?? [])]);
  });
  return md;
}

module.exports = { planBlocks, markdownItPlugin };
