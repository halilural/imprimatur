// @ts-check
// The agent's words for a tool call: the text it wrote in the same message as
// the call (same message.id in the Claude Code transcript). The hook cannot
// read them (the transcript gets them only after the call starts), so the
// graph looks them up here, by the call's tool_use id, when it renders. The
// same read keeps what Edit and Write calls asked for and which calls failed:
// the graph rebuilds an edit's real result from them (review-state.js).
"use strict";
const fs = require("node:fs");

/** @type {Map<string, {offset: number, texts: Map<string, string>, byTool: Map<string, string>, calls: Map<string, [number, number]>, failed: Set<string>}>} */
const cache = new Map();

/**
 * First sentence of the first line, at most 120 characters; a short opener
 * ("Deneyelim.", "Done.") takes the next sentence along. @param {string} text
 */
function sentence(text) {
  const parts = text.trim().split("\n")[0].split(/(?<=[.!?…:])\s/);
  let out = parts[0].trim();
  for (let i = 1; i < parts.length && out.length < 25; i++) out += ` ${parts[i].trim()}`;
  return out.length > 120 ? `${out.slice(0, 119)}…` : out;
}

/**
 * Read what the transcript gained since the last call (whole lines only).
 * ponytail: the first call reads the whole transcript; fine for a few MB.
 * @param {string} transcript
 */
function update(transcript) {
  let c = cache.get(transcript);
  const size = fs.statSync(transcript).size;
  if (!c || size < c.offset) cache.set(transcript, (c = { offset: 0, texts: new Map(), byTool: new Map(), calls: new Map(), failed: new Set() }));
  if (size === c.offset) return c;
  const buf = Buffer.alloc(size - c.offset);
  const fd = fs.openSync(transcript, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, c.offset);
  } finally {
    fs.closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return c;
  const base = c.offset;
  c.offset += end + 1;
  // Line by line with each line's place in the file: a call's input is read
  // again from there when asked for (a Write holds a whole file; not kept here).
  for (let at = 0; at < end; ) {
    const nl = buf.indexOf(0x0a, at);
    const stop = nl < 0 || nl > end ? end : nl;
    const from = at;
    at = stop + 1;
    const line = buf.subarray(from, stop).toString("utf8");
    const failure = line.includes('"is_error":true');
    if (!line.includes('"assistant"') && !failure) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "user" && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) if (b?.type === "tool_result" && b.is_error && b.tool_use_id) c.failed.add(b.tool_use_id);
      continue;
    }
    const id = r.message?.id;
    if (r.type !== "assistant" || !id || !Array.isArray(r.message.content)) continue;
    for (const b of r.message.content) {
      if (b.type === "text" && b.text?.trim()) c.texts.set(id, sentence(b.text));
      if (b.type === "tool_use" && b.id) c.byTool.set(b.id, id);
      if (b.type === "tool_use" && b.id && (b.name === "Edit" || b.name === "Write")) c.calls.set(b.id, [base + from, stop - from]);
    }
  }
  return c;
}

/**
 * The agent's words that came with a tool call, if it wrote any.
 * @param {string | undefined} transcript @param {string | undefined} toolUseId
 * @returns {string | undefined}
 */
function narrationOf(transcript, toolUseId) {
  if (!transcript || !toolUseId) return undefined;
  try {
    const c = update(transcript);
    const msg = c.byTool.get(toolUseId);
    return msg ? c.texts.get(msg) : undefined;
  } catch {
    return undefined; // transcript gone or unreadable: the summary stands in
  }
}

/**
 * What an Edit or Write call asked for, and whether it failed (denied, or its
 * old text not found): undefined when the transcript does not have it.
 * @param {string | undefined} transcript @param {string | undefined} toolUseId
 * @returns {{name: string, input: any, failed: boolean} | undefined}
 */
function toolCallOf(transcript, toolUseId) {
  if (!transcript || !toolUseId) return undefined;
  try {
    const c = update(transcript);
    const at = c.calls.get(toolUseId);
    if (!at) return undefined;
    const buf = Buffer.alloc(at[1]);
    const fd = fs.openSync(transcript, "r");
    try {
      fs.readSync(fd, buf, 0, at[1], at[0]);
    } finally {
      fs.closeSync(fd);
    }
    const b = JSON.parse(buf.toString("utf8")).message.content.find((x) => x.type === "tool_use" && x.id === toolUseId);
    return b && { name: b.name, input: b.input, failed: c.failed.has(toolUseId) };
  } catch {
    return undefined;
  }
}

module.exports = { narrationOf, toolCallOf };
