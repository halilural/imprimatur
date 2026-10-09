// Markdown records → Imprimatur's database (#59).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { openDb } = req("../vscode/db.js");
const { importRepo, parseTodo, taskStatus, summary } = req("../vscode/import.js");

const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

const TODO = `# #58 · MCP sunucusu

[#58](https://github.com/u/r/issues/58) · Epic [#53](../53/TODO.md)

## Durum

Sürüyor: sunucu hazır — 2026-10-09

## Yapılacaklar

- DONE: (C) server.mjs
  iki dönem, 8 araç
- 👉 TODO: (K) İş makinesinde pull
- FIXME: (C) yol boşluklu
- CANCELED: (C, isteğe bağlı) SDK
- ~~QUESTION~~: eski biçim

## Sorular (kullanıcıya)

- QUESTION: Araçlar genel mi?
- ANSWERED: Panel nerede? → #60'ta (2026-10-09)

## Kararlar

- DECISION: (2026-10-09) SDK yok

## Prova programı (kullanıcı)

Pazartesi: tekrar
Salı: deneme

## Notlar / engeller

- NOTE: (2026-10-09) Cursor yok
`;

function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-59-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  put(root, "docs/todos/58/TODO.md", TODO);
  put(root, "docs/todos/53/TODO.md", "# #53 · Epic\n\n## Durum\n\nSürüyor\n\n## Yapılacaklar\n\n- 👉 TODO: (C) #57\n");
  put(root, "todos/53/TODO.md", "# #53 · old layout copy\n\n## Yapılacaklar\n\n- TODO: (C) old\n");
  put(root, "docs/design/ARCHITECTURE.md", "# Mimari\n\n## Modül\n\nGiriş paragrafı.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n- ARCH: Motor — node:sqlite\n- ARCH: Yer — cihaz başına\n");
  put(root, "docs/testing/app.md", "# app · elle testler\n\n## İçindekiler\n\n- [MT-1 · Kurulum](#mt-1--kurulum)\n\n## Kurulum\n\n### MT-1 · Kurulum\n\n1. Kur\n2. Aç\n");
  put(root, "PRODUCT.md", "# Ürün\n\n## STORY-1 · Kullanıcı görür\n\nAyrıntı\n");
  return root;
}

test("task status from the Durum line", () => {
  assert.equal(taskStatus("Bitti — 2026-10-09"), "done");
  assert.equal(taskStatus("Sürüyor (Sprint 2)"), "active");
  assert.equal(taskStatus("In progress, plan revised"), "active");
  assert.equal(taskStatus("İptal: gerek kalmadı"), "dropped");
  assert.equal(taskStatus(""), "open");
});

test("TODO.md: task, prefixes, owners, 👉, continuation, answered, free sections", () => {
  const { task, records, unparsed } = parseTodo(TODO, "#58");
  assert.deepEqual([task.title, task.epic, task.status], ["MCP sunucusu", "#53", "active"]);
  assert.match(task.summary, /^Sürüyor/);
  const brief = records.map((r) => `${r.kind}/${r.status}/${r.owner ?? "-"}${r.pointer ? "/👉" : ""} ${r.title}`);
  assert.deepEqual(brief, [
    "todo/done/C server.mjs",
    "todo/open/K/👉 İş makinesinde pull",
    "fixme/open/C yol boşluklu",
    "todo/dropped/C SDK",
    "note/done/- Yapılacaklar",
    "question/open/K Araçlar genel mi?",
    "question/done/K Panel nerede?",
    "answer/done/K #60'ta (2026-10-09)",
    "decision/done/- (2026-10-09) SDK yok",
    "note/done/- Prova programı (kullanıcı)",
    "note/done/- (2026-10-09) Cursor yok",
  ]);
  assert.equal(records[0].body, "iki dönem, 8 araç");
  assert.equal(records[4].body, "- ~~QUESTION~~: eski biçim", "an unknown line is kept as a note");
  assert.deepEqual(unparsed, ["- ~~QUESTION~~: eski biçim"]);
  assert.equal(records[9].body, "Pazartesi: tekrar\nSalı: deneme");
});

test("a repo: every source, counts match, a second run adds nothing, a change updates", () => {
  const root = repo();
  const db = openDb({ path: path.join(root, "i.db") });
  const r = importRepo(db, root);
  assert.match(summary(r), /counts match/);
  assert.deepEqual(r.files.map((f) => f.file), [
    "docs/todos/53/TODO.md", "docs/todos/58/TODO.md", "docs/design/ARCHITECTURE.md", "PRODUCT.md", "docs/testing/app.md",
  ], "the new layout wins over todos/");
  const rid = db.repoOf(root).id;
  const t58 = db.taskByKey(rid, "#58");
  assert.equal(db.taskByKey(rid, "#53").id, t58.epic_id);
  const recs = db.recordsOf(t58.id, { dropped: true });
  assert.equal(recs.length, 11);
  assert.equal(recs.find((x) => x.kind === "answer").parent_id, recs.find((x) => x.title === "Panel nerede?").id);
  assert.equal(recs.filter((x) => x.pointer).length, 1);
  assert.equal(recs[0].links.source, "docs/todos/58/TODO.md");
  assert.equal(recs[0].links.md.status, "done", "what Markdown said, for the next run");
  assert.equal(db.versionsOf(recs[0].id)[0].actor_kind, "import");

  const adr = db.recordsOf(db.taskByKey(rid, "ADR").id);
  assert.deepEqual(adr.map((x) => x.title), ["Modül", "Motor — node:sqlite", "Yer — cihaz başına"]);
  assert.match(adr[0].body, /Giriş paragrafı\.[\s\S]*flowchart LR/);
  const tests = db.recordsOf(db.taskByKey(rid, "TEST").id);
  assert.deepEqual(tests.map((x) => x.title), ["MT-1 · Kurulum"], "table of contents and empty sections left out");
  assert.equal(tests[0].kind, "test");
  assert.deepEqual(db.recordsOf(db.taskByKey(rid, "PDR").id).map((x) => `${x.kind} ${x.title}`), ["pdr STORY-1 · Kullanıcı görür"]);

  const again = importRepo(db, root);
  assert.deepEqual([again.added, again.updated], [0, 0]);

  put(root, "docs/todos/58/TODO.md", TODO.replace("- 👉 TODO: (K) İş makinesinde pull", "- DONE: (K) İş makinesinde pull"));
  const third = importRepo(db, root);
  assert.deepEqual([third.added, third.updated], [0, 1]);
  const pull = db.recordsOf(t58.id).find((x) => x.title === "İş makinesinde pull");
  assert.deepEqual([pull.status, pull.pointer], ["done", false]);
  db.close();
});

test("two repos with the same file and text keep separate records", () => {
  const a = repo();
  const b = repo();
  execFileSync("git", ["remote", "add", "origin", "git@github.com:u/a.git"], { cwd: a });
  const db = openDb({ path: path.join(a, "i.db") });
  const ra = importRepo(db, a);
  const rb = importRepo(db, b);
  assert.equal(rb.added, ra.added);
  assert.equal(db.repoOf(a).origin, "git@github.com:u/a.git");
  db.close();
});

test("CLI: dry run writes nothing and reports the count", () => {
  const root = repo();
  const out = execFileSync(process.execPath, [new URL("../scripts/import.mjs", import.meta.url).pathname, "--dry-run", root], {
    encoding: "utf8", env: { ...process.env, IMPRIMATUR_DB: path.join(root, "never.db") },
  });
  assert.match(out, /records \(0 new, 0 updated, 0 gone.*counts match \(dry run/);
  assert.equal(fs.existsSync(path.join(root, "never.db")), false);
});

test("a second run keeps database changes, follows Markdown changes, drops what Markdown lost", () => {
  const root = repo();
  const db = openDb({ path: path.join(root, "i.db") });
  importRepo(db, root);
  const t58 = db.taskByKey(db.repoOf(root).id, "#58");
  const byTitle = (t) => db.recordsOf(t58.id, { dropped: true }).find((x) => x.title === t);
  const agent = { kind: "agent", id: "s" };
  // In the database: an agent closes the FIXME and moves the 👉.
  db.updateRecord(byTitle("yol boşluklu").id, { status: "done", body: "düzeldi" }, agent);
  // In Markdown: the question is reworded, the 👉 removed, a fenced example added.
  put(root, "docs/todos/58/TODO.md", TODO
    .replace("- QUESTION: Araçlar genel mi?", "- QUESTION: Araçlar genel mi olsun?")
    .replace("- 👉 TODO: (K) İş makinesinde pull", "- TODO: (K) İş makinesinde pull")
    .replace("## Kararlar", "## Örnek\n\n```md\n- TODO: (C) bu bir örnek\n## Başlık değil\n```\n\n## Kararlar"));
  const r = importRepo(db, root);
  assert.match(summary(r), /counts match/);
  const fixme = byTitle("yol boşluklu");
  assert.deepEqual([fixme.status, fixme.body], ["done", "düzeldi"], "unchanged in Markdown: the database's change stays");
  assert.equal(byTitle("Araçlar genel mi?").status, "dropped");
  assert.equal(byTitle("Araçlar genel mi olsun?").status, "open");
  assert.equal(byTitle("İş makinesinde pull").pointer, false, "👉 removed in Markdown");
  assert.equal(byTitle("bu bir örnek"), undefined, "a fenced example is not a record");
  assert.match(byTitle("Örnek").body, /```md[\s\S]*## Başlık değil[\s\S]*```/);
  assert.equal(r.dropped, 1);
  db.close();
});

test("headings keep a trailing # that is part of the text; prefixed lines outside parsed sections are not counted", () => {
  const { records, expected } = parseTodo("# #1 · x\n\n- TODO: in the title part\n\n## Durum\n\n- NOTE: in status\n\n## Fix C#\n\n- TODO: (C) a ##\n", "#1");
  assert.deepEqual(records.map((r) => `${r.section}|${r.title}`), ["Fix C#|a ##"]);
  assert.equal(expected, 1);
});
