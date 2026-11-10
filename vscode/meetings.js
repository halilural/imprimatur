// @ts-check
// The Meetings page's model (#169; the new panel's More, #202): every meeting record of the repo,
// newest first, with the task it hangs on, its decisions and to-dos, and its note.
"use strict";
const { scopeRepos } = require("./inbox.js");

/**
 * The Meetings page (#169): every meeting of the repo (or all repos), newest first, each
 * with the task it hangs on, its decisions and to-dos, and the note. A place of its own,
 * not a tab of the task page. @param {any} db @param {string} root @param {any} view
 */
function meetingsModel(db, root, view = {}) {
  // This repo only: the sticky "every repo" scope has no switch on this page, so it would mix repos in silently.
  const repos = scopeRepos(db, root, false);
  const meetings = db.meetingsOf(repos.map((/** @type {any} */ r) => r.id)).map((/** @type {any} */ m) => {
    const d = new Date(m.created_at);
    return {
      ...m,
      title: meetingTitle(m.title, m.body),
      gist: meetingGist(m.body),
      dd: d.getDate(),
      mon: d.toLocaleDateString("en-GB", { month: "short" }),
      month: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      decisions: m.children.filter((/** @type {any} */ k) => k.kind === "decision"),
      todos: m.children.filter((/** @type {any} */ k) => k.kind === "todo").sort((/** @type {any} */ a, /** @type {any} */ b) => Number(b.owner === "K") - Number(a.owner === "K")),
    };
  });
  return { meetings };
}

/** Titles a meeting app writes when it has none of its own. */
const GENERIC_MEETING = /^(toplantı|meeting|yarıda kalan kayıt.*)$/i;

/**
 * The meeting's own name: a generic title gives way to the note's first bold line
 * ("**Payments weekly**"), which is where meeting apps put the real one.
 * @param {string} title @param {string | null} body
 */
function meetingTitle(title, body) {
  if (!GENERIC_MEETING.test(title.trim())) return title;
  const bold = /^\s*\*\*(?!Başlık\*\*)(.+?)\*\*\s*$/m.exec(body ?? "");
  return bold ? bold[1].trim() : title;
}

/** The first sentence of the note's summary ("## Özet" / "## Summary"), plain text. @param {string | null} body */
function meetingGist(body) {
  const sec = /^##\s*(?:Özet|Summary)\s*\n+([\s\S]*?)(?:\n##\s|$)/im.exec(body ?? "");
  if (!sec) return "";
  const text = sec[1].replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  const one = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return one.length > 180 ? `${one.slice(0, 177)}…` : one;
}

module.exports = { meetingsModel, meetingTitle, meetingGist };
