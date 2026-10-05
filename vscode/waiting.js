// @ts-check
// Waiting on you: what the agent asked of the user, from the hook's per-session
// logs in .claude/imprimatur/waiting/<session>.jsonl. Every record closes the
// session's earlier open items (the agent went on, so the user decided); an
// "answer" record also carries the user's reply.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const WAITING_DIR = path.join(".claude", "imprimatur", "waiting");

/** Kinds that open an item; "answer", "step" and "done" (closed by hand) only close. */
const OPENS = ["question", "command", "verify", "input"];

/**
 * @typedef {{t: string, session?: string, kind: string, text?: string, detail?: string, prompt?: string, title?: string, answer?: string}} WaitingRecord
 * @typedef {{t: string, session: string, kind: string, text: string, detail?: string, prompt?: string, title?: string,
 *            open: boolean, done?: boolean, answer?: string, answeredAt?: string}} WaitingItem
 */

/**
 * One session's records → its items, oldest first.
 * @param {WaitingRecord[]} records @param {string} session @returns {WaitingItem[]}
 */
function itemsOf(records, session) {
  /** @type {WaitingItem[]} */
  const items = [];
  for (const r of records) {
    for (const it of items) {
      if (!it.open) continue;
      it.open = false;
      it.answeredAt = r.t;
      if (r.kind === "answer" && r.answer) it.answer = r.answer;
      if (r.kind === "done") it.done = true;
    }
    if (OPENS.includes(r.kind))
      items.push({ t: r.t, session, kind: r.kind, text: r.text ?? "", detail: r.detail, prompt: r.prompt, title: r.title, open: true });
  }
  return items;
}

/**
 * Every session's items in a repo: open first, then newest first.
 * @param {string} root repo root @returns {WaitingItem[]}
 */
function waitingItems(root) {
  const dir = path.join(root, WAITING_DIR);
  if (!fs.existsSync(dir)) return [];
  /** @type {WaitingItem[]} */
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const records = fs
      .readFileSync(path.join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    out.push(...itemsOf(records, name.slice(0, -".jsonl".length)));
  }
  return out.sort((a, b) => Number(b.open) - Number(a.open) || Date.parse(b.t) - Date.parse(a.t));
}

module.exports = { WAITING_DIR, itemsOf, waitingItems };
