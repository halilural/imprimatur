import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTurn } from "../hooks/audit.mjs";

const req = createRequire(import.meta.url);
const { audit, parseAudit, auditPrompt, overlap, pointedAsks } = req("../vscode/audit.js");
const { waitingItems, openSteps } = req("../vscode/waiting.js");

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-audit-"));
  const log = path.join(root, ".claude/imprimatur/waiting/s1.jsonl");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const rec = (r) => JSON.stringify({ session: "s1", ...r }) + "\n";
  fs.writeFileSync(
    log,
    rec({ t: "T1", kind: "verify", text: "0.22.0 değişikliklerini birleştireyim mi?\nEklenti kuruldu, 79 test geçiyor." }) +
      rec({ t: "T2", kind: "verify", text: "#11'i kapatayım mı?" }),
  );
  return { root, log };
}

test("audit: the agent's turn ticks settled steps and adds what it really asks, as short steps", async () => {
  const { root, log } = session();
  let asked = "";
  const res = await audit(log, { message: "PR #18 birleştirildi.\n\n👉 Yeni değişiklikleri de birleştireyim mi?", request: "tamam birleştir", session: "s1" }, async (p) => {
    asked = p;
    return 'Sure:\n{"settled": ["A", "B", "Z"], "asks": ["Yeni değişiklikleri birleştireyim mi?"]}';
  });
  // 👉 lines are the asks, verbatim; the model only settles.
  assert.deepEqual(res, { settled: [1, 2], asks: ["Yeni değişiklikleri de birleştireyim mi?"] });
  assert.match(asked, /A\. 0\.22\.0 değişikliklerini birleştireyim mi\?/);
  assert.match(asked, /<user_request>tamam birleştir<\/user_request>/);
  assert.match(asked, /<new_asks>\n- Yeni değişiklikleri de birleştireyim mi\?/);
  assert.doesNotMatch(asked, /"asks"/);
  const items = waitingItems(root);
  const t1 = items.find((i) => i.t === "T1");
  assert.deepEqual([t1.open, t1.chat[0]], [false, "audit: agent: PR #18 birleştirildi."]);
  assert.equal(items.find((i) => i.t === "T2").open, true);
  assert.deepEqual(openSteps(log).map((s) => s.text), ["#11'i kapatayım mı?", "Yeni değişiklikleri de birleştireyim mi?"]);
});

test("audit: an ask in nearly the same words replaces the old step, even if the model keeps it", async () => {
  const { log } = session();
  const res = await audit(log, { message: "👉 #11'i şimdi kapatayım mı?" }, async () => '{"settled": []}');
  assert.deepEqual(res.settled, [3]);
  assert.deepEqual(openSteps(log).map((s) => s.text), ["0.22.0 değişikliklerini birleştireyim mi?", "Eklenti kuruldu, 79 test geçiyor.", "#11'i şimdi kapatayım mı?"]);
  assert.ok(overlap("Chat senkronu henüz commit'lenmedi; commit edip main'e birleştireyim mi?", "Önceki değişiklikler (chat senkronu) hâlâ commit'lenmedi; commit edip main'e birleştireyim mi?") >= 0.5);
  assert.ok(overlap("İkisini de yapayım mı?", "#11'i kapatayım mı?") < 0.5);
});

test("audit: without 👉 lines the model writes the asks", async () => {
  const { log } = session();
  let asked = "";
  const res = await audit(log, { message: "Kurdum. Paneli açıp rozetlere bakabilirsin." }, async (p) => ((asked = p), 'x\n{"settled": [], "asks": ["Paneli açıp rozetlere bak"]}'));
  assert.deepEqual(res, { settled: [], asks: ["Paneli açıp rozetlere bak"] });
  assert.match(asked, /"asks"/);
  assert.deepEqual(pointedAsks("- 👉'lı mesajla denedim.\n👉 Birleştireyim mi?"), ["Birleştireyim mi?"]);
  assert.ok(openSteps(log).some((s) => s.text === "Paneli açıp rozetlere bak"));
});

test("audit: the review alone (Audit button) only closes; a failed model falls back to the rules", async () => {
  const { root, log } = session();
  assert.doesNotMatch(auditPrompt(openSteps(log), {}), /"asks"/);
  await audit(log, {}, async () => '{"settled": ["B"]}');
  assert.deepEqual(openSteps(log).map((s) => s.n + s.text), ["10.22.0 değişikliklerini birleştireyim mi?", "2#11'i kapatayım mı?"]);
  assert.throws(() => parseAudit("no json", []));
  await auditTurn(log, { message: "Kuruldu.\n👉 Paneli kontrol eder misin?" }, async () => {
    throw new Error("offline");
  });
  assert.ok(waitingItems(root).some((i) => i.open && i.text === "Paneli kontrol eder misin?"));
});
