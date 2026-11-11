// @ts-check
// Do what was approved (#210): when the user's last message approves ("hepsini yap", "devam",
// "do all", "go on", "yes"), a reply that ends the turn asking again (👉 lines) has not done the
// work. The Stop hook sends the agent back once to do it.
"use strict";
const fs = require("node:fs");

/** Short approvals, Turkish and English: the whole message, give or take punctuation. */
const APPROVAL = /^\s*(?:(?:okey|ok|okay|tamam|evet|olur|peki)[\s,.!]*)?(?:hepsini(?: de)? yap(?:alım)?|hepsini|yap(?:alım)?|devam(?: et| edelim)?|uygula|do (?:it|all|them|everything)|go (?:on|ahead)|continue|yes|okey|ok|okay|tamam|evet|olur)[\s,.!]*$/i;

/** The user's last own message in a transcript (tool results are not), from its tail. @param {string | undefined} file */
function lastUserText(file) {
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
  let last;
  for (const line of text.split("\n")) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.type !== "user" || r.isMeta) continue;
    const c = r.message?.content;
    if (typeof c === "string") last = c;
    else if (Array.isArray(c) && !c.some((b) => b?.type === "tool_result")) last = c.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  }
  return last;
}

/** Strong approvals: a message that starts with one approves, whatever follows ("hepsini yap, neden soruyorsun?"). */
const LEADING = /^\s*(?:(?:okey|ok|okay|tamam|evet)[\s,.!]*)?(?:hepsini(?: de)? yap|hepsini uygula|devam et|do (?:it all|all|everything)|go ahead)\b/i;

/** Whether a message approves: a short approval alone, or one that starts with a strong approval. @param {string | undefined} text */
const isApproval = (text) => !!text && ((text.trim().length <= 40 && APPROVAL.test(text.trim())) || LEADING.test(text));

/** The 👉 asks a reply ends its turn with. @param {string} reply */
const asksIn = (reply) => String(reply ?? "").split("\n").filter((l) => l.includes("👉"));

/**
 * The finding for a reply, or undefined: the user approved and the reply asks again.
 * @param {string} reply @param {string | undefined} transcript
 */
function reaskFinding(reply, transcript) {
  const asks = asksIn(reply);
  if (!asks.length || !isApproval(lastUserText(transcript))) return undefined;
  return `the user approved ("${String(lastUserText(transcript)).trim()}") and this reply asks again (${asks.length} 👉 line${asks.length === 1 ? "" : "s"}). Do the approved items now; ask only a new decision that is the user's, in one line.`;
}

module.exports = { isApproval, lastUserText, asksIn, reaskFinding, APPROVAL };
