// #185: the migration's dry run asks the model for one target per item and reads its JSON back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptFor, parseAnswer, TARGETS } from "../scripts/migrate-pocock.mjs";

test("migrate dry run: the prompt names every target and the items; a JSON answer is read, a bad target left out", () => {
  const p = promptFor("imprimatur", "sections", [{ key: "architecture/storage", title: "Storage", body: "SQLite, one file per device." }]);
  for (const t of ["project:mission", "capability", "spec", "adr", "glossary", "out-of-scope", "drop"]) assert.ok(p.includes(t), t);
  assert.match(promptFor("r", "PDRs", [{ key: "pdr/1", title: "T", body: "", issue: "#7 open" }]), /"issue":"#7 open"/);
  assert.match(p, /"key":"architecture\/storage"/);
  const a = parseAnswer('Here: [{"key":"a","target":"adr","reason":"hard to reverse"},{"key":"b","target":"maybe","reason":"x"}]');
  assert.deepEqual(a.map((x) => x.key), ["a"]);
  assert.equal(parseAnswer("no json"), undefined);
  assert.equal(TARGETS.length, 10);
});
