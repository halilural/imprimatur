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
 * @typedef {{t: string, session?: string, kind: string, text?: string, detail?: string, prompt?: string, title?: string, answer?: string, item?: string, i?: number, on?: boolean, by?: string, note?: string, why?: string}} WaitingRecord
 * @typedef {{t: string, session: string, kind: string, text: string, detail?: string, prompt?: string, title?: string,
 *            open: boolean, done?: boolean, answer?: string, answeredAt?: string, checked?: number[], notes?: string[], chat?: Record<string, string>,
 *            ticks?: Record<string, {by?: string, note?: string, why?: string, at: string}>, sent?: number[]}} WaitingItem
 */

/**
 * One session's records → its items, oldest first.
 * @param {WaitingRecord[]} records @param {string} session @returns {WaitingItem[]}
 */
function itemsOf(records, session) {
  /** @type {WaitingItem[]} */
  const items = [];
  for (const r of records) {
    if (r.kind === "sent") {
      // Send to Claude: these ticks went to the chat once; not again.
      const it = items.find((x) => x.t === r.item);
      if (it && typeof r.i === "number") it.sent = [...new Set([...(it.sent ?? []), r.i])];
      continue;
    }
    if (r.kind === "check") {
      const it = items.find((x) => x.t === r.item);
      if (it && typeof r.i === "number") {
        // Who ticked a step, why, and when: the list shows it per step.
        const ticks = { ...(it.ticks ?? {}) };
        if (r.on) ticks[r.i] = { by: r.by, note: r.note, why: r.why, at: r.t };
        else delete ticks[r.i];
        it.ticks = ticks;
        const on = new Set(it.checked ?? []);
        if (r.on) on.add(r.i);
        else on.delete(r.i);
        // Ticked by a chat reply (resolve.mjs): the panel says so.
        const chat = new Map(Object.entries(it.chat ?? {}));
        if (r.on && (r.by === "chat" || r.by === "audit")) chat.set(String(r.i), `${r.by === "audit" ? "audit: " : ""}${r.note ?? ""}`);
        else chat.delete(String(r.i));
        it.chat = Object.fromEntries(chat);
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
    if (name.endsWith(".jsonl")) out.push(...itemsOf(readLog(path.join(dir, name)), name.slice(0, -".jsonl".length)));
  }
  return out.sort((a, b) => Number(b.open) - Number(a.open) || Date.parse(b.t) - Date.parse(a.t));
}

/** A session log's records (lines being written are skipped). @param {string} log @returns {WaitingRecord[]} */
function readLog(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/**
 * A step's label for the model: A, B, … Z, AA, AB, … Letters, not numbers, so
 * "let's try 2" in the user's message is not read as step 2. @param {number} n from 1
 */
const stepLabel = (n) => (n > 26 ? stepLabel(Math.floor((n - 1) / 26)) : "") + String.fromCharCode(65 + ((n - 1) % 26));

/**
 * The steps named in a model's answer (labels as whole words), as step numbers.
 * @param {string} text @param {Array<{n: number, label: string}>} steps @returns {number[]}
 */
const labelsIn = (text, steps) => steps.filter((s) => new RegExp(`(^|[^A-Za-z])${s.label}(?![A-Za-z])`).test(text)).map((s) => s.n);

/**
 * A session's open, unticked steps, numbered from 1, labelled A, B, … (for the model).
 * @param {string} log @returns {Array<{n: number, label: string, item: string, i: number, text: string, request?: string, since?: string[]}>}
 */
function openSteps(log) {
  const out = [];
  for (const it of itemsOf(readLog(log), path.basename(log, ".jsonl"))) {
    if (!it.open) continue;
    const ticked = new Set(it.checked ?? []);
    it.text
      .split("\n")
      .filter((l) => l.trim())
      .forEach((text, i) => ticked.has(i) || out.push({ n: out.length + 1, label: stepLabel(out.length + 1), item: it.t, i, text, request: it.prompt, since: it.notes }));
  }
  return out;
}

/**
 * Tick one step in a session's log. @param {string} log
 * @param {{item: string, i: number}} step @param {string} by "chat" (the user's message) or "audit" (the model's review) @param {string} note
 * @param {string} [why] "again": the same ask came again (the step shows as replaced)
 */
function tickStep(log, step, by, note, why) {
  const session = path.basename(log, ".jsonl");
  fs.appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), session, kind: "check", item: step.item, i: step.i, on: true, by, note, why }) + "\n");
}

/**
 * Every step of every item, one row each, newest first (the list keeps its
 * history, like the edits). state: "open"; "done" (ticked: by you, a chat
 * reply or the audit); "replaced" (asked again later); "answered" (a question
 * closed by the next event); "closed" (its item marked done).
 * @param {string} root
 * @returns {Array<{session: string, item: string, i: number, t: string, kind: string, text: string, state: string,
 *   by?: string, note?: string, at?: string, unsent?: boolean, prompt?: string, title?: string, detail?: string, answer?: string, notes?: string[]}>}
 */
function waitingSteps(root) {
  const out = [];
  for (const it of waitingItems(root)) {
    const lines = it.text.split("\n").filter((l) => l.trim());
    lines.forEach((text, i) => {
      const tick = it.ticks?.[i];
      const state = tick ? (tick.why === "again" ? "replaced" : "done") : it.open ? "open" : it.done ? "closed" : "answered";
      out.push({
        session: it.session, item: it.t, i, t: it.t, kind: it.kind, text, state,
        by: tick?.by, note: tick?.note, at: tick?.at ?? it.answeredAt,
        // Ticked in the panel by the user and not sent to the chat yet.
        unsent: !!tick && !tick.by && !(it.sent ?? []).includes(i),
        prompt: it.prompt, title: it.title, detail: it.detail, answer: it.answer, notes: it.notes,
      });
    });
  }
  return out.sort((a, b) => Date.parse(b.t) - Date.parse(a.t) || a.i - b.i);
}

module.exports = { WAITING_DIR, itemsOf, waitingItems, waitingSteps, readLog, openSteps, tickStep, stepLabel, labelsIn };
