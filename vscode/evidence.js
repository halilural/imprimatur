// @ts-check
// Evidence before claims (#209): a turn-end reply that says tests pass, a build succeeds, a bug is
// fixed or something is verified, in a turn that ran no command, is a claim without evidence
// (obra/superpowers' verification-before-completion: "no completion claims without fresh
// verification evidence"). Told to the user; it never blocks.
"use strict";
const fs = require("node:fs");

/** Success claims that need a command's output behind them, English and Turkish. */
const CLAIMS = [
  /\b(?:all )?tests? (?:now )?pass(?:es|ed|ing)?\b/i,
  /\bbuild (?:now )?(?:passes|succeeds|is green)\b/i,
  /\b(?:is|are|now) (?:fixed|verified|working)\b/i,
  /\bI (?:fixed|verified|confirmed)\b/i,
  /testler(?:in hepsi)? (?:artık )?geçiyor/i,
  /test(?:in|lerin)? hepsi geçiyor/i,
  /\b(?:düzeldi|düzelttim|doğrulandı|doğruladım)\b/i,
  /build (?:artık )?geçiyor/i,
];

/** The claims a reply makes, as the matched words. @param {string} text */
function claimsIn(text) {
  // Quoted and fenced text is someone else's words or an example, not this reply's claim.
  const own = String(text ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, "");
  return CLAIMS.map((re) => re.exec(own)?.[0]).filter((m) => typeof m === "string");
}

/**
 * The tools this turn called: the transcript's tool uses after the user's last own message
 * (a tool result is not one). Only the transcript's tail is read.
 * @param {string | undefined} file @returns {string[] | undefined} undefined when unreadable
 */
function turnTools(file) {
  if (!file) return undefined;
  let text;
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 2_000_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return undefined;
  }
  /** @type {string[]} */
  let tools = [];
  for (const line of text.split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const content = r?.message?.content;
    if (r?.type === "user" && !r.isMeta) {
      const isResult = Array.isArray(content) && content.some((b) => b?.type === "tool_result");
      if (!isResult) tools = [];
    } else if (r?.type === "assistant" && Array.isArray(content)) {
      for (const b of content) if (b?.type === "tool_use" && typeof b.name === "string") tools.push(b.name);
    }
  }
  return tools;
}

/** Tools whose output can prove a claim: a command, a test or build run, a notebook. */
const PROVING = /^(?:Bash|PowerShell|mcp__.*(?:execute|run|test).*|ctx_execute.*|mcp__plugin_context-mode.*execute.*)$/i;

/**
 * The finding for a reply, or undefined. @param {string} reply @param {string | undefined} transcript
 * @returns {string | undefined}
 */
function evidenceFinding(reply, transcript) {
  const claims = claimsIn(reply);
  if (!claims.length) return undefined;
  const tools = turnTools(transcript);
  if (!tools || tools.some((t) => PROVING.test(t))) return undefined;
  return `this reply claims "${claims[0]}" but this turn ran no command to show it. Run the command that proves it and give its output, or say it is not verified.`;
}

module.exports = { claimsIn, turnTools, evidenceFinding, CLAIMS };
