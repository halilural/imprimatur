// @ts-check
// The agent's words for a tool call: the text it wrote in the same message as
// the call (same message.id in the Claude Code transcript). The hook cannot
// read them (the transcript gets them only after the call starts), so the
// graph looks them up here, by the call's tool_use id, when it renders. The
// same read keeps what Edit and Write calls asked for and which calls failed:
// the graph rebuilds an edit's real result from them (review-state.js), and
// the branch each call was made on (the transcript's gitBranch); calls.js keeps
// them past the transcript's lifetime.
"use strict";
const fs = require("node:fs");

/** @type {Map<string, {offset: number, texts: Map<string, string>, byTool: Map<string, string>, calls: Map<string, [number, number]>, failed: Set<string>, done: Set<string>, branch: Map<string, string>, uses: Array<{id: string, name: string, at: number, file?: string, command?: string, cwd?: string, said?: string}>, title?: string}>} */
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
  if (!c || size < c.offset) cache.set(transcript, (c = { offset: 0, texts: new Map(), byTool: new Map(), calls: new Map(), failed: new Set(), done: new Set(), branch: new Map(), uses: [] }));
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
    // Calls with a result (finished): their ids, without parsing big tool outputs.
    if (line.includes('"tool_result"')) for (const m of line.matchAll(/"tool_use_id":"([^"]+)"/g)) c.done.add(m[1]);
    const failure = line.includes('"is_error":true');
    const titled = line.includes('"ai-title"');
    if (!line.includes('"assistant"') && !failure && !titled) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "ai-title" && typeof r.aiTitle === "string") {
      c.title = r.aiTitle.trim().split("\n")[0].slice(0, 80);
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
      if (b.type === "tool_use" && b.id && typeof r.gitBranch === "string" && r.gitBranch) c.branch.set(b.id, r.gitBranch);
      // Edits' calls with their time and target: older history rows are matched to them (calls.js).
      if (b.type === "tool_use" && b.id && ["Edit", "Write", "Bash"].includes(b.name))
        c.uses.push({ id: b.id, name: b.name, at: Date.parse(r.timestamp), file: b.input?.file_path, command: typeof b.input?.command === "string" ? b.input.command.slice(0, 4000) : undefined, cwd: r.cwd,
          said: typeof b.input?.description === "string" ? b.input.description.trim().split("\n")[0].slice(0, 120) : undefined });
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

/**
 * What the transcript knows of a call: whether it finished (has a result),
 * the branch it was made on, and for Edit / Write what it asked for.
 * @param {string | undefined} transcript @param {string | undefined} toolUseId
 * @returns {{done: boolean, branch?: string, name?: string, input?: any, failed: boolean, said?: string} | undefined}
 */
function callInfo(transcript, toolUseId) {
  if (!transcript || !toolUseId) return undefined;
  try {
    const c = update(transcript);
    if (!c.byTool.has(toolUseId)) return undefined;
    const call = toolCallOf(transcript, toolUseId);
    const said = c.uses.find((u) => u.id === toolUseId)?.said;
    return { done: c.done.has(toolUseId), branch: c.branch.get(toolUseId), failed: c.failed.has(toolUseId), ...(said && { said }), ...(call && { name: call.name, input: call.input }) };
  } catch {
    return undefined;
  }
}

/**
 * The transcript's Edit, Write and Bash calls, oldest first: id, time, the
 * file an Edit / Write names, a Bash command (cut at 4000 characters), the cwd.
 * @param {string | undefined} transcript
 */
function usesOf(transcript) {
  if (!transcript) return [];
  try {
    return update(transcript).uses;
  } catch {
    return [];
  }
}

/** The session's title Claude gave it (its latest). @param {string | undefined} transcript */
function titleOf(transcript) {
  if (!transcript) return undefined;
  try {
    return update(transcript).title;
  } catch {
    return undefined;
  }
}

module.exports = { narrationOf, toolCallOf, callInfo, usesOf, titleOf };
