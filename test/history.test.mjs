import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const req = createRequire(import.meta.url);
const { scanHistory, scanTodos, todoAsks, turnsOf, slugOf, scannedBefore, FILES_SESSION } = req("../vscode/history.js");
const { waitingSteps, waitingItems, openSteps } = req("../vscode/waiting.js");
const records = req("../vscode/records.js");

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

/** A repo and a fake ~/.claude/projects with one transcript per session. */
function project(sessions) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-"));
  const root = path.join(tmp, "repo");
  const home = path.join(tmp, "projects");
  fs.mkdirSync(root);
  for (const [id, { cwd = root, records }] of Object.entries(sessions)) {
    const dir = path.join(home, slugOf(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify({ cwd, ...r })).join("\n") + "\n");
  }
  return { root, home };
}

const user = (text, t) => ({ type: "user", timestamp: t, message: { role: "user", content: text } });
const said = (text, t, id = t) => ({ type: "assistant", timestamp: t, message: { id, role: "assistant", content: [{ type: "text", text }] } });
const tool = (t) => ({ type: "user", timestamp: t, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });

test("history: turns are the user's prompts and the agent's final message; tool results and side chains are not turns", () => {
  const { root, home } = project({
    s1: {
      records: [
        { type: "ai-title", aiTitle: "Fix the build" },
        user("<ide_opened_file>x</ide_opened_file>build kırık", ago(50)),
        said("Bakıyorum.", ago(49), "m1"),
        tool(ago(48)),
        { ...said("subagent words", ago(47), "sub"), isSidechain: true },
        said("Düzelttim.", ago(46), "m2"),
        said("👉 Test eder misin?", ago(46), "m2"),
      ],
    },
  });
  const tx = turnsOf(path.join(home, slugOf(root), "s1.jsonl"));
  assert.equal(tx.title, "Fix the build");
  assert.equal(tx.cwd, root);
  assert.deepEqual(tx.turns.map((t) => [t.request, t.message]), [["build kırık", "Düzelttim.\n👉 Test eder misin?"]]);
});

test("history: a past session's 👉 asks become steps, the user's later words settle them through the audit", async () => {
  const { root, home } = project({
    s1: {
      records: [
        user("deploy et", ago(60)),
        said("Deploy bitti.\n\n👉 Staging'de girişi dener misin?", ago(59)),
        user("denedim çalışıyor, şimdi README'yi güncelle", ago(30)),
        said("README güncellendi.\n\n👉 Değişikliği commit edeyim mi?", ago(29)),
      ],
    },
  });
  let asked = "";
  const res = await scanHistory(root, { home, ask: async (p) => ((asked = p), 'A settled: "denedim çalışıyor"\n{"settled": ["A"]}') });
  assert.equal(res.sessions, 1);
  // The model saw the step with what the user wrote since.
  assert.match(asked, /A\. Staging'de girişi dener misin\?/);
  assert.match(asked, /the user wrote since: denedim çalışıyor/);
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  assert.deepEqual(openSteps(log).map((s) => s.text), ["Değişikliği commit edeyim mi?"]);
  // The new item keeps the turn's own time, not the scan's.
  const open = waitingSteps(root).find((s) => s.state === "open");
  assert.ok(Date.now() - Date.parse(open.t) > 20 * 60_000);
  assert.equal(open.prompt, "denedim çalışıyor, şimdi README'yi güncelle");
});

test("history: sessions already logged, scanned, too old or from another project are skipped", async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const { root, home } = project({
    logged: { records: [user("a", ago(10)), said("👉 X?", ago(9))] },
    old: { records: [user("b", old), said("👉 Y?", old)] },
    other: { cwd: "/somewhere/else", records: [user("c", ago(10)), said("👉 Z?", ago(9))] },
    fresh: { records: [user("d", ago(10)), said("👉 W?", ago(9))] },
  });
  fs.mkdirSync(path.join(root, ".claude/imprimatur/waiting"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/imprimatur/waiting/logged.jsonl"), "");
  let calls = 0;
  const ask = async () => (calls++, '{"settled": []}');
  assert.equal(scannedBefore(root), false);
  assert.equal((await scanHistory(root, { home, ask })).sessions, 1);
  assert.equal(scannedBefore(root), true);
  assert.deepEqual(waitingSteps(root).map((s) => s.text), ["W?"]);
  // A second scan reads nothing again.
  assert.equal((await scanHistory(root, { home, ask })).sessions, 0);
  assert.equal(calls, 1); // the fresh session's 👉 ask, written out by the model
});

test("history: without the model, the final message's 👉 lines are still recorded", async () => {
  const { root, home } = project({ s1: { records: [user("a", ago(10)), said("Bitti.\n👉 Bakar mısın?", ago(9))] } });
  await scanHistory(root, { home, ask: async () => { throw new Error("no claude"); } });
  assert.deepEqual(waitingSteps(root).map((s) => [s.text, s.state]), [["Bakar mısın?", "open"]]);
});

test("history: (K) records in the database become steps; done or dropped ones are ticked on the next scan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-history-"));
  const file = path.join(root, "imprimatur.db");
  process.env.IMPRIMATUR_DB = file;
  records.reset();
  const db = req("../vscode/db.js").openDb({ path: file });
  const actor = { kind: "user", id: "k" };
  const t = db.upsertTask(db.repoOf(root).id, "#7", { title: "Panel" });
  const add = (kind, owner, title, status) => db.addRecord(t.id, { kind, owner, title, status }, actor);
  const r5 = add("todo", "K", "5. Gözle: düğme, liste");
  const r6 = add("question", "K", "6. Gözle → #6");
  add("todo", "C", "Claude'un işi");
  add("todo", "K", "Reload Window");
  add("todo", "K", "eski", "done");
  const sorted = (a) => [...a].sort((x, y) => x.text.localeCompare(y.text));
  assert.deepEqual(sorted(todoAsks(root)), [
    { task: "#7", text: "5. Gözle: düğme, liste" }, { task: "#7", text: "6. Gözle → #6" }, { task: "#7", text: "Reload Window" },
  ]);
  assert.deepEqual(scanTodos(root), { added: 3, ticked: 0 });
  assert.deepEqual(scanTodos(root), { added: 0, ticked: 0 });
  db.updateRecord(r5.id, { status: "done" }, actor);
  db.updateRecord(r6.id, { status: "dropped" }, actor);
  add("todo", "K", "Yeni iş");
  assert.deepEqual(scanTodos(root), { added: 1, ticked: 2 });
  const steps = waitingSteps(root).filter((s) => s.session === FILES_SESSION);
  assert.deepEqual(steps.map((s) => [s.text, s.state, s.by]).sort(), [
    ["5. Gözle: düğme, liste", "done", "file"],
    ["6. Gözle → #6", "done", "file"],
    ["Reload Window", "open", undefined],
    ["Yeni iş", "open", undefined],
  ]);
  assert.equal(waitingItems(root)[0].title, "#7 · Panel");
  db.close();
});

test("history: rescan writes again what only the scan wrote; sessions a hook or you touched are kept", async () => {
  const { root, home } = project({
    a: { records: [user("x", ago(10)), said("Done.\n👉 Check it?", ago(9))] },
    b: { records: [user("y", ago(10)), said("👉 Merge it?", ago(9))] },
  });
  const ask = async () => '{"settled": []}';
  await scanHistory(root, { home, ask });
  // b went on after setup: the hook wrote a turn end.
  fs.appendFileSync(path.join(root, ".claude/imprimatur/waiting/b.jsonl"), JSON.stringify({ t: ago(1), session: "b", kind: "step" }) + "\n");
  assert.equal((await scanHistory(root, { home, ask })).sessions, 0);
  const res = await scanHistory(root, { home, ask, again: true });
  assert.equal(res.sessions, 1);
  assert.deepEqual(waitingSteps(root).map((s) => s.text).sort(), ["Check it?", "Merge it?"]);
});
