import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTurn } from "../hooks/audit.mjs";

const req = createRequire(import.meta.url);
const { audit, parseAudit, auditPrompt, overlap, pointedAsks } = req("../vscode/audit.js");
const { waitingItems, openSteps, waitingSteps } = req("../vscode/waiting.js");

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
  // 👉 lines are the asks; the model writes them out clearly, as many as there are.
  assert.deepEqual(res, { settled: [1, 2], asks: ["Yeni değişiklikleri birleştireyim mi?"], whys: [""], task: undefined });
  assert.match(asked, /A\. 0\.22\.0 değişikliklerini birleştireyim mi\?/);
  assert.match(asked, /<user_request>tamam birleştir<\/user_request>/);
  assert.match(asked, /<new_asks>\n- Yeni değişiklikleri de birleştireyim mi\?/);
  assert.match(asked, /the new_asks rewritten: exactly 1 entry,/);
  const items = waitingItems(root);
  const t1 = items.find((i) => i.t === "T1");
  assert.deepEqual([t1.open, t1.chat[0]], [false, "audit: agent: PR #18 birleştirildi."]);
  assert.equal(items.find((i) => i.t === "T2").open, true);
  assert.deepEqual(openSteps(log).map((s) => s.text), ["#11'i kapatayım mı?", "Yeni değişiklikleri birleştireyim mi?"]);
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
  assert.deepEqual(res, { settled: [], asks: ["Paneli açıp rozetlere bak"], whys: [""], task: undefined });
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

test("audit: asks are self-contained, with a why and the task; a rewrite that loses a 👉 line keeps them verbatim", async () => {
  const { root, log } = session();
  let asked = "";
  await audit(log, { message: "Mail hazır.\n👉 Tim'e takip mailini gönder", request: "LATD-13937 için follow-up", session: "s1" }, async (p) => (
    (asked = p),
    '{"settled": [], "asks": [{"text": "LATD-13937: Tim\'e !2690 review\'u için takip mailini gönder", "why": "Review iki gündür bekliyor."}], "task": "LATD-13937"}'
  ));
  assert.match(asked, /<task_hint>LATD-13937<\/task_hint>/);
  assert.match(asked, /make sense on its own a week later/);
  const step = waitingSteps(root).find((s) => s.text.startsWith("LATD-13937"));
  assert.deepEqual([step.why, step.task], ["Review iki gündür bekliyor.", "LATD-13937"]);
  // The model dropped a line: the agent's own words stay.
  const res = await audit(log, { message: "👉 A yap\n👉 B yap" }, async () => '{"settled": [], "asks": ["A ve B"]}');
  assert.deepEqual(res.asks, ["A yap", "B yap"]);
  // A routine 👉 line next to a real ask is left out.
  const res2 = await audit(log, { message: "👉 Tim'e yaz\n👉 Reload Window" }, async () => '{"settled": [], "asks": [{"text": "LATD-1: Tim\'e yaz"}, {"text": ""}]}');
  assert.deepEqual(res2.asks, ["LATD-1: Tim'e yaz"]);
});

test("audit: the model's JSON may be fenced and spread over lines", () => {
  const out = 'A: open, nobody answered\n```json\n{\n  "settled": [],\n  "asks": [{"text": "LATD-1: x", "why": "y"}],\n  "task": "LATD-1"\n}\n```';
  assert.deepEqual(parseAudit(out, []), { settled: [], asks: ["LATD-1: x"], whys: ["y"], task: "LATD-1", count: 1 });
});
