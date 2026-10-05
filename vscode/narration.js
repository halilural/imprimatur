// @ts-check
// The agent's words for a tool call: the text it wrote in the same message as
// the call (same message.id in the Claude Code transcript). The hook cannot
// read them (the transcript gets them only after the call starts), so the
// graph looks them up here, by the call's tool_use id, when it renders.
"use strict";
const fs = require("node:fs");

/** @type {Map<string, {offset: number, texts: Map<string, string>, byTool: Map<string, string>}>} */
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
  if (!c || size < c.offset) cache.set(transcript, (c = { offset: 0, texts: new Map(), byTool: new Map() }));
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
  c.offset += end + 1;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const id = r.message?.id;
    if (r.type !== "assistant" || !id || !Array.isArray(r.message.content)) continue;
    for (const b of r.message.content) {
      if (b.type === "text" && b.text?.trim()) c.texts.set(id, sentence(b.text));
      if (b.type === "tool_use" && b.id) c.byTool.set(b.id, id);
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

module.exports = { narrationOf };
