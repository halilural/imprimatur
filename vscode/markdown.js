// @ts-check
// Markdown to safe HTML for the panel (renderMarkdown: links, `path:line` file references, Mermaid,
// screenshots, task-list steps) and slugify for section keys. Kept from the old docsView.js (#202).
"use strict";
/** Lazily: the extension bundles it; a missing one shows the Markdown as text. @type {any} */
let md;

/** Rendered bodies by text: a redraw that changed nothing renders nothing again. @type {Map<string, string>} */
const rendered = new Map();

/**
 * A section's Markdown as HTML. Raw HTML in it stays text (html: false); links only
 * http(s), mailto and in-page anchors (markdown-it's own check drops javascript: and data:).
 * @param {string | null | undefined} text
 */
function renderMarkdown(text, { steps = false, anyPath = false } = {}) {
  const src = String(text ?? "");
  if (!src.trim()) return "";
  const key = (steps ? "S" : "-") + (anyPath ? "A" : "-") + src;
  const hit = rendered.get(key);
  if (hit !== undefined) return hit;
  let out;
  try {
    out = markdown().render(src, { steps, anyPath });
  } catch {
    md = null;
    out = `<pre>${esc(src)}</pre>`;
  }
  if (md === null) out = `<pre>${esc(src)}</pre>`;
  if (rendered.size > 500) rendered.clear();
  rendered.set(key, out);
  return out;
}

/**
 * A file reference in inline code (#96): `dir/file.ext`, `file.ext:12`, `file.ext:12-20`, or
 * `:12` for the file named last in the same text (env.lastFile). A bare name with no line
 * (`imprimatur.db`) is no reference: it reads as a word more often than as a file.
 * @param {string} text @param {any} env
 * @returns {{file: string, line?: number} | undefined}
 */
function fileRef(text, env = {}) {
  // anyPath (the Exercises tab, of no repo): a path from the home (~/) or the root (/) too.
  const m = (env.anyPath ? /^((?:~\/|\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:-\d+)?)?$/ : /^((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?:-\d+)?)?$/).exec(text.trim());
  if (m && !m[1].split("/").includes("..") && (m[2] || m[1].includes("/"))) {
    env.lastFile = m[1];
    return { file: m[1], ...(m[2] && { line: Number(m[2]) }) };
  }
  const n = /^:(\d+)(?:-\d+)?$/.exec(text.trim());
  return n && env.lastFile ? { file: env.lastFile, line: Number(n[1]) } : undefined;
}

/** A path with no scheme, not absolute: a file beside the documents. */
const RELATIVE = /^(?![a-z][a-z0-9+.-]*:)(?![\\/])\S/i;

/** The prefix of a relative image's src, which the panel replaces with the documents folder's webview URI. */
const DOC_IMG = "imprimatur-doc:";

/**
 * An agent trial's screenshot (#159): `shot:<issue>/<date>/<file>` in a record body is a file in
 * the repo's data folder (skills/issues/screenshots.mjs keeps it there); the panel replaces this
 * prefix with that folder's webview URI. Local, so a private repo's images show in VS Code.
 */
const SHOT_IMG = "imprimatur-shot:";

/** A screenshot path: segments of word characters, no "..", no leading slash. */
const SHOT = /^shot:((?:[\w@-][\w@.-]*\/)*[\w@-][\w@.-]*)$/;

const shotOf = (/** @type {string} */ src) => {
  const m = SHOT.exec(src.trim());
  return m && !m[1].split("/").includes("..") ? m[1] : null;
};

/** markdown-it, set up once: safe links, relative images, mermaid fences, "- [ ] step" checkboxes. */
function markdown() {
  if (md === undefined) {
    const MarkdownIt = require("markdown-it");
    md = new MarkdownIt({ html: false, linkify: true, typographer: false });
    const valid = md.validateLink.bind(md);
    md.validateLink = (/** @type {string} */ url) =>
      (valid(url) && (/^(https?:|mailto:|#)/i.test(url.trim()) || RELATIVE.test(url.trim()))) || shotOf(url) !== null;
    md.renderer.rules.fence = mermaidFence(md.renderer.rules.fence);
    // `path/file.js:120` opens the file at that line (#96); `:338` the file named last before it.
    const code = md.renderer.rules.code_inline;
    md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
      const html = /** @type {any} */ (code)(tokens, idx, options, env, self);
      const ref = fileRef(tokens[idx].content, env);
      return ref ? `<a href="#" class="fref" data-act="${env.anyPath ? "exOpen" : "openFile"}" data-file="${esc(ref.file)}" data-line="${ref.line ?? ""}" title="Open in the editor">${html}</a>` : html;
    };
    // A relative path: an image is a file next to the design documents (the panel turns
    // DOC_IMG into its webview URI); a link to one goes nowhere in the panel, its text stays.
    const image = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const src = tokens[idx].attrGet("src") ?? "";
      const shot = shotOf(src);
      if (shot) tokens[idx].attrSet("src", SHOT_IMG + shot);
      else if (RELATIVE.test(src)) tokens[idx].attrSet("src", DOC_IMG + src.replace(/^\.\//, ""));
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
    box.content = `<input type="checkbox" class="mdstep" data-line="${t[i].map[0]}"${on ? " checked" : ""}${state.env?.steps ? "" : " disabled"} aria-label="Step">`;
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
 * <div class="mermaid-src" data-key="…"><pre>: the old panel drew it as a diagram; the new one shows the source (#202)
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
  return s || "section";
}

module.exports = { renderMarkdown, slugify, stepsOf, toggleStep, fileRef, mermaidKey, DOC_IMG, SHOT_IMG };
