// @ts-check
// Waiting on you: what the agent asked of the user, from the hook's per-session
// logs in .claude/imprimatur/waiting/<session>.jsonl. Every record closes the
// session's earlier open questions (the agent went on, so the user decided); an
// "answer" record also carries the user's reply. "verify" items (things to go
// and do) stay open until marked done or every step is ticked; replies are kept
// on them as notes. A "check" record ticks one
// step of an item (the user's own to-do list) and closes nothing.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const WAITING_DIR = path.join(".claude", "imprimatur", "waiting");

/** Kinds that open an item; "answer", "step" and "done" (closed by hand) only close; "check" ticks a step. */
const OPENS = ["question", "command", "verify", "input"];

/**
 * @typedef {{t: string, session?: string, kind: string, text?: string, detail?: string, prompt?: string, title?: string, answer?: string, item?: string, i?: number, on?: boolean}} WaitingRecord
 * @typedef {{t: string, session: string, kind: string, text: string, detail?: string, prompt?: string, title?: string,
 *            open: boolean, done?: boolean, answer?: string, answeredAt?: string, checked?: number[], notes?: string[]}} WaitingItem
 */

/**
 * One session's records → its items, oldest first.
 * @param {WaitingRecord[]} records @param {string} session @returns {WaitingItem[]}
 */
function itemsOf(records, session) {
  /** @type {WaitingItem[]} */
  const items = [];
  for (const r of records) {
    if (r.kind === "check") {
      const it = items.find((x) => x.t === r.item);
      if (it && typeof r.i === "number") {
        const on = new Set(it.checked ?? []);
        if (r.on) on.add(r.i);
        else on.delete(r.i);
        it.checked = [...on].sort((a, b) => a - b);
        const steps = it.text.split("\n").filter((l) => l.trim()).length;
        if (it.kind === "verify" && it.checked.length >= steps) Object.assign(it, { open: false, done: true, answeredAt: r.t });
        else if (it.kind === "verify" && it.done && !r.on) Object.assign(it, { open: true, done: false });
      }
      continue;
    }
    if (r.kind === "done") {
      // Mark as done: the one item named, or (older records) every open one.
      for (const it of items) if (it.open && (!r.item || it.t === r.item)) Object.assign(it, { open: false, done: true, answeredAt: r.t });
      continue;
    }
    for (const it of items) {
      if (!it.open) continue;
      if (it.kind === "verify") {
        if (r.kind === "answer" && r.answer) it.notes = [...(it.notes ?? []), r.answer];
        continue;
      }
      it.open = false;
      it.answeredAt = r.t;
      if (r.kind === "answer" && r.answer) it.answer = r.answer;
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
