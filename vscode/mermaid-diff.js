// @ts-check
// Mermaid flowchart diff for the preview: compare the agent's version of a
// diagram with the copy and color what changed, in one merged diagram (the
// Flow Lens / GoJS pattern): added green, changed orange, removed red dashed
// and kept visible. Only the rendered source changes, never the file.
// ponytail: flowchart/graph only; `A & B --> C` and other diagram types are
// left as they are.
"use strict";

const OPEN = ["(((", "((", "([", "[(", "[[", "[/", "[\\", "{{", "(", "[", "{", ">"];
const CLOSE = { "(((": ")))", "((": "))", "([": "])", "[(": ")]", "[[": "]]", "[/": "/]", "[\\": "\\]", "{{": "}}", "(": ")", "[": "]", "{": "}", ">": "]" };
const ID = /^[A-Za-z_][\w-]*/;
const ARROW = /^\s*(<?(?:-{2,}|={2,}|-\.+-)(?:>|x|o)?)\s*(?:\|([^|]*)\|)?\s*/;
const TEXT_ARROW = /^\s*--\s*([^-|>]+?)\s*(-->|---)\s*/;
const SKIP = /^\s*(%%|classDef\b|class\b|style\b|linkStyle\b|subgraph\b|end\b|direction\b|click\b|flowchart\b|graph\b)/;

/** Read one node reference at s[i]: id and, if given, its label. */
function readNode(s, i) {
  const m = ID.exec(s.slice(i));
  if (!m) return undefined;
  let j = i + m[0].length;
  const open = OPEN.find((o) => s.startsWith(o, j));
  if (!open) return { id: m[0], label: undefined, end: j };
  const close = CLOSE[open];
  const k = s.indexOf(close, j + open.length);
  if (k < 0) return { id: m[0], label: undefined, end: j };
  let label = s.slice(j + open.length, k).trim();
  if (label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1);
  return { id: m[0], label, end: k + close.length };
}

/**
 * Nodes (id -> label) and edges (in source order, as Mermaid counts them for
 * linkStyle) of a flowchart. undefined for other diagram types.
 * @param {string} src
 */
function parseFlowchart(src) {
  const lines = src.split(/\r?\n/);
  const first = lines.find((l) => l.trim() && !l.trim().startsWith("%%"));
  if (!first || !/^\s*(flowchart|graph)\b/.test(first)) return undefined;
  /** @type {Map<string, string>} */
  const nodes = new Map();
  /** @type {Array<{from: string, to: string, label: string}>} */
  const edges = [];
  const see = (n) => {
    if (n.label !== undefined || !nodes.has(n.id)) nodes.set(n.id, n.label ?? nodes.get(n.id) ?? n.id);
  };
  for (const raw of lines) {
    const line = raw.replace(/;\s*$/, "");
    if (!line.trim() || SKIP.test(line)) {
      // a subgraph title is not a node, but `subgraph X["t"]` names one: skip it
      continue;
    }
    let i = line.length - line.trimStart().length;
    let prev = readNode(line, i);
    if (!prev) continue;
    see(prev);
    i = prev.end;
    for (;;) {
      const rest = line.slice(i);
      const a = TEXT_ARROW.exec(rest) ?? ARROW.exec(rest);
      if (!a) break;
      const label = (TEXT_ARROW.test(rest) ? a[1] : a[2] ?? "").trim();
      i += a[0].length;
      const next = readNode(line, i);
      if (!next) break;
      see(next);
      edges.push({ from: prev.id, to: next.id, label });
      prev = next;
      i = next.end;
    }
  }
  return { nodes, edges };
}

const STYLE = {
  added: "stroke:#2ea043,stroke-width:4px",
  changed: "stroke:#d29922,stroke-width:4px",
  removed: "stroke:#f85149,stroke-width:2px,stroke-dasharray:5 3,color:#f85149",
};

/**
 * Lines to append to the new diagram so the changes show, or [] when nothing
 * the diff understands changed (or it is not a flowchart).
 * @param {string} oldSrc @param {string} newSrc
 * @returns {{lines: string[], added: number, changed: number, removed: number}}
 */
function mermaidDiff(oldSrc, newSrc) {
  const none = { lines: [], added: 0, changed: 0, removed: 0 };
  const a = parseFlowchart(oldSrc);
  const b = parseFlowchart(newSrc);
  if (!a || !b) return none;
  const addedNodes = [...b.nodes.keys()].filter((id) => !a.nodes.has(id));
  const changedNodes = [...b.nodes.keys()].filter((id) => a.nodes.has(id) && a.nodes.get(id) !== b.nodes.get(id));
  const removedNodes = [...a.nodes.keys()].filter((id) => !b.nodes.has(id));
  const key = (e) => `${e.from}->${e.to}`;
  const oldEdges = new Map(a.edges.map((e) => [key(e), e]));
  const newKeys = new Set(b.edges.map(key));
  const out = [];
  const linkStyles = [];
  b.edges.forEach((e, i) => {
    const before = oldEdges.get(key(e));
    if (!before) linkStyles.push(`linkStyle ${i} ${STYLE.added}`);
    else if (before.label !== e.label) linkStyles.push(`linkStyle ${i} ${STYLE.changed}`);
  });
  const removedEdges = a.edges.filter((e) => !newKeys.has(key(e)));
  const ghost = (id) => `ar_removed_${id}`;
  for (const id of removedNodes) out.push(`  ${ghost(id)}["${a.nodes.get(id).replace(/"/g, "'")}"]`);
  let n = b.edges.length;
  for (const e of removedEdges) {
    const from = b.nodes.has(e.from) ? e.from : ghost(e.from);
    const to = b.nodes.has(e.to) ? e.to : ghost(e.to);
    out.push(`  ${from} -.->${e.label ? `|${e.label.replace(/\|/g, "/")}|` : ""} ${to}`);
    linkStyles.push(`linkStyle ${n++} ${STYLE.removed}`);
  }
  if (!addedNodes.length && !changedNodes.length && !removedNodes.length && !linkStyles.length) return none;
  out.push(`  classDef arAdded ${STYLE.added}`, `  classDef arChanged ${STYLE.changed}`, `  classDef arRemoved ${STYLE.removed}`);
  if (addedNodes.length) out.push(`  class ${addedNodes.join(",")} arAdded`);
  if (changedNodes.length) out.push(`  class ${changedNodes.join(",")} arChanged`);
  if (removedNodes.length) out.push(`  class ${removedNodes.map(ghost).join(",")} arRemoved`);
  out.push(...linkStyles.map((l) => `  ${l}`));
  return {
    lines: out,
    added: addedNodes.length + b.edges.filter((e) => !oldEdges.has(key(e))).length,
    changed: changedNodes.length + b.edges.filter((e) => oldEdges.get(key(e)) && oldEdges.get(key(e)).label !== e.label).length,
    removed: removedNodes.length + removedEdges.length,
  };
}

/** Mermaid blocks of a Markdown text, in order. @param {string} md */
function mermaidBlocks(md) {
  return [...md.matchAll(/^ {0,3}(`{3,}|~{3,})\s*mermaid[^\n]*\n([\s\S]*?)^ {0,3}\1\s*$/gm)].map((m) => m[2]);
}

/** The old block that shares the most lines with this one (the diagram before the edit). */
function matchOld(oldBlocks, src) {
  const lines = new Set(src.split("\n").map((l) => l.trim()).filter(Boolean));
  let best;
  let score = 0;
  for (const o of oldBlocks) {
    const s = o.split("\n").filter((l) => lines.has(l.trim())).length;
    if (s > score) [best, score] = [o, s];
  }
  return best;
}

module.exports = { parseFlowchart, mermaidDiff, mermaidBlocks, matchOld };
