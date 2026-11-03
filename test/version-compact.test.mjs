// #121: compaction drops only what other stored values say; hydrating gives back what was written.
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { compactRecord, hydrateRecord, compactSection, hydrateSection } = require("../vscode/version-compact.js");

let seed = 11;
const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
const FIELDS = ["title", "body", "status", "owner", "links", "pointer"];
const value = (k) => (k === "pointer" ? rnd(2) === 0 : k === "links" ? (rnd(3) ? { issue: rnd(5) } : null) : `${k}-${rnd(4)}`);

/** A record's real history: a create, then updates of a few fields each (before = the old values). */
function history(n) {
  let id = 1;
  const row = Object.fromEntries(FIELDS.map((k) => [k, value(k)]));
  const created = { ...row };
  const vs = [{ id: id++, op: "create", before: null, after: created }];
  for (let i = 0; i < n; i++) {
    const keys = FIELDS.filter(() => rnd(3) === 0);
    if (!keys.length) continue;
    const before = {};
    const after = {};
    for (const k of keys) {
      before[k] = row[k];
      after[k] = value(k);
      row[k] = after[k];
    }
    vs.push({ id: id++, op: "update", before, after });
  }
  return { vs, row };
}
const apply = (vs, changes) =>
  vs.map((v) => {
    const c = changes.find((x) => x.id === v.id);
    return c ? { ...v, ...("before" in c && { before: c.before }), ...("after" in c && { after: c.after }) } : v;
  });

test("records: compact then hydrate gives back every version, also after more changes and a second run", () => {
  for (let round = 0; round < 400; round++) {
    const { vs, row } = history(rnd(8));
    const compacted = apply(vs, compactRecord(vs, row));
    assert.deepEqual(hydrateRecord(compacted, row), vs, `round ${round}`);
    // More changes come after the compaction, then it runs again.
    let more = compacted;
    const r = { ...row };
    let id = vs.length + 1;
    const truth = [...vs];
    for (let i = rnd(4); i > 0; i--) {
      const k = FIELDS[rnd(FIELDS.length)];
      const v = { id: id++, op: "update", before: { [k]: r[k] }, after: { [k]: value(k) } };
      r[k] = v.after[k];
      truth.push(v);
      more = [...more, v];
    }
    const again = apply(more, compactRecord(more, r));
    assert.deepEqual(hydrateRecord(again, r), truth, `round ${round}, second run`);
  }
});

test("records: an unchanged create becomes a key list; a changed record keeps its create", () => {
  const { vs, row } = history(0);
  const [c] = compactRecord(vs, row);
  assert.deepEqual(c.after, { "@row": FIELDS });
  assert.deepEqual(compactRecord(vs, { ...row, title: "edited outside a version" }), [], "the record no longer holds a created value: kept");
});

test("sections: the latest body equal to the section's goes; it comes back from the next version or the section", () => {
  const vs = [
    { id: 1, before: null, after: { key: "a", title: "A", body: "one" } },
    { id: 2, before: { body: "one" }, after: { body: "two" } },
  ];
  const section = { body: "two" };
  const c = compactSection(vs, section);
  assert.deepEqual(c, [{ id: 2, after: { "@body": 1 } }]);
  const compacted = apply(vs, c);
  assert.deepEqual(hydrateSection(compacted, section), vs);
  // Edited later: version 2's body now comes from version 3's before.
  const later = [...compacted, { id: 3, before: { body: "two" }, after: { body: "three" } }];
  assert.deepEqual(hydrateSection(later, { body: "three" }).map((v) => v.after.body), ["one", "two", "three"]);
  assert.deepEqual(compactSection(vs, { body: "changed elsewhere" }), []);
});

test("db: compactVersions shrinks the tables and every history view reads the same as before", async () => {
  const fs = (await import("node:fs")).default;
  const os = (await import("node:os")).default;
  const path = (await import("node:path")).default;
  const { openDb } = require("../vscode/db.js");
  const db = openDb({ path: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imprimatur-121-")), "i.db") });
  const AGENT = { kind: "agent", id: "t" };
  const IMPORT = { kind: "import", id: "t" };
  const repo = db.repoOf("/r121", { name: "r" });
  const task = db.upsertTask(repo.id, "#1", { title: "T", status: "active" }, AGENT);
  const big = "x".repeat(2000);
  const kept = [];
  for (let i = 0; i < 30; i++) kept.push(db.addRecord(task.id, { kind: "note", title: `imported ${i}`, body: big + i }, IMPORT));
  const edited = db.addRecord(task.id, { kind: "todo", title: "edited", body: big }, AGENT);
  for (let i = 0; i < 5; i++) db.updateRecord(edited.id, { body: `${big} v${i}`, ...(i % 2 && { status: i === 3 ? "done" : "open" }) }, AGENT);
  const doc = db.docOf(repo.id, "architecture");
  db.upsertSection(doc.id, "a", { title: "A", body: big }, AGENT);
  db.upsertSection(doc.id, "a", { body: big + " two" }, AGENT);
  const secId = db.docSection(doc.id, "a").id;
  const views = () => JSON.stringify({
    versions: [...kept.map((r) => db.versionsOf(r.id)), db.versionsOf(edited.id)],
    task: db.taskVersions(task.id),
    agent: db.agentChanges(repo.id),
    section: db.sectionVersions(secId),
  });
  const before = views();
  const r = db.compactVersions();
  assert.ok(r.records >= 30 && r.sections === 1, JSON.stringify(r));
  assert.ok(r.bytesAfter < r.bytesBefore / 2, JSON.stringify(r));
  assert.equal(views(), before, "every history reads as before");
  assert.deepEqual(db.compactVersions().records, 0, "a second run finds nothing more");
  // Changes after the compaction keep reading right.
  db.updateRecord(kept[0].id, { title: "changed later" }, AGENT);
  db.upsertSection(doc.id, "a", { body: "three" }, AGENT);
  const v0 = db.versionsOf(kept[0].id);
  assert.equal(v0[0].after.title, "imported 0", "the create comes back from the record and the later change's before");
  assert.equal(v0[1].before.title, "imported 0");
  assert.deepEqual(db.sectionVersions(secId).map((v) => v.after.body), ["three", big + " two", big]);
});
