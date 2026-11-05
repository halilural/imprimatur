// @ts-check
// Generated Markdown made to pass markdownlint (#132): a blank line around headings, fences and
// the start of a list (MD022, MD031, MD032), a bare opening fence given "text" (MD040), a bare
// URL put in <> (MD034) and a line starting "#139" escaped so it is not a heading (MD018).
// Applied where a document's text is made (docs-export.js docMarkdown, decisions.js), so the
// file and what docs-sync compares it with stay the same text. Code inside fences is left alone;
// a second pass changes nothing.
"use strict";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;
const blank = (/** @type {string | undefined} */ l) => l === undefined || !l.trim();
/** A line a list can follow without a blank: another item, an indented continuation, a quote. @param {string} l */
const inList = (l) => ITEM.test(l) || /^\s{2,}\S/.test(l);

/**
 * A line's bare URLs put in <> (MD034), outside code spans: not one that is a link's target or
 * text, an attribute, or already in <>. Trailing punctuation stays outside.
 * @param {string} l
 */
function autolink(l) {
  if (!/https?:\/\//.test(l)) return l;
  return l.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part
    : part.replace(/(^|[^(<[`"'=/\w])(https?:\/\/[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"*_])/g, "$1<$2>"))).join("");
}

/** @param {string} text */
function tidy(text) {
  const lines = String(text).split("\n");
  /** @type {string[]} */
  const out = [];
  /** @type {string | undefined} */
  let open; // the fence that opened the current code block
  const gap = () => {
    if (out.length && !blank(out[out.length - 1])) out.push("");
  };
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const f = FENCE.exec(l);
    if (open) {
      out.push(l);
      // Closed by a fence of the same character, at least as long, with nothing after it.
      if (f && f[1][0] === open[0] && f[1].length >= open.length && !f[2].trim()) {
        open = undefined;
        if (!blank(lines[i + 1])) out.push("");
      }
      continue;
    }
    if (f) {
      gap();
      open = f[1];
      out.push(f[2].trim() ? l : `${l.trimEnd()}text`);
      continue;
    }
    if (HEADING.test(l)) {
      gap();
      out.push(l);
      if (!blank(lines[i + 1])) out.push("");
      continue;
    }
    if (/^ {0,3}#[^#\s]/.test(l)) l = l.replace("#", "\\#");
    l = autolink(l);
    // A list starts after a line that is neither blank nor part of a list nor front matter's close.
    if (ITEM.test(l) && out.length && !blank(out[out.length - 1]) && !inList(out[out.length - 1]) && out[out.length - 1] !== "---") gap();
    out.push(l);
  }
  return out.join("\n");
}

/** The headings outside fences, as [line index, level]. @param {string[]} lines */
function headings(lines) {
  /** @type {Array<[number, number]>} */
  const out = [];
  /** @type {string | undefined} */
  let open;
  lines.forEach((l, i) => {
    const f = FENCE.exec(l);
    if (open) {
      if (f && f[1][0] === open[0] && f[1].length >= open.length && !f[2].trim()) open = undefined;
    } else if (f) open = f[1];
    else {
      const h = /^ {0,3}(#{1,6})(\s|$)/.exec(l);
      if (h) out.push([i, h[1].length]);
    }
  });
  return out;
}

/**
 * A section body's headings shifted so the highest is at `top` (####: a section is ### under its
 * ## chapter; ### in a document whose sections are ##), keeping their order (MD024, MD001);
 * past ###### stays ######. A body already at `top` is returned as it is.
 * @param {string} body @param {number} [top]
 */
function nest(body, top = 4) {
  const lines = String(body).split("\n");
  const hs = headings(lines);
  const min = Math.min(...hs.map(([, n]) => n));
  if (!hs.length || min === top) return String(body);
  for (const [i, n] of hs) lines[i] = lines[i].replace(/^( {0,3})#{1,6}/, (_, sp) => `${sp}${"#".repeat(Math.min(6, n + top - min))}`);
  return lines.join("\n");
}

module.exports = { tidy, nest, autolink };
