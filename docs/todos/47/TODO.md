# #47 · Eski yanlış veri kendiliğinden düzelsin

[#47](https://github.com/halilural/imprimatur/issues/47)

## Durum

Bitti — 2026-10-07 (0.30.5, main'e birleşti)

## Yapılacaklar

- DONE: (C) `vscode/calls.js`: bitmiş çağrılar `calls.jsonl`'da kalıcı (transcript silinse de outside ayrımı ve dal)
- DONE: (C) `vscode/narration.js` `callInfo`: gitBranch, bitmiş çağrılar
- DONE: (C) `vscode/graph.js`: satırın dalı `editBranch(transcript dalı, kayıtlı dal)` (eski Bash satırları, dalı olmayan satırlar)
- DONE: (C) `vscode/todo-done.js`: önbellek sürümlü (`rules`); eski önbellek baştan okunur; grafik açılınca da kapanış
- DONE: (C) Testler 130/130 (`test/self-heal.test.mjs`); gerçek veride #37 adımı kendiliğinden kapandı, calls.jsonl doldu
- DONE: (C) İnceleme (önbellek yerinde güncellenir, 512 KB üstü Write saklanmaz, okuma yarışında çökmez), main'e birleştir, kur
- 👉 TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish` (eklentiyi kurar; veri ilk grafik açılışında düzelir)

## Kararlar

- DECISION: (2026-10-07) Onarım betiği yok, veri yeniden yazılmaz: düzeltme okuma anında, kalıcı bilgi ayrı dosyada (kullanıcı: "hepsi kendiliginden duzelsin")
- DECISION: (2026-10-07) `cleanupPeriodDays`'e dokunulmaz: gereken bilgi calls.jsonl'da
- DECISION: (2026-10-07) #45 öncesi hata veren Bash komutlarının düzenlemeleri geri gelmez (yazdıkları kaydedilmemiş)

## Notlar / engeller

- NOTE: Kaynak: #45 / #46 sonrası "varolan yanlış veriler nasıl düzeliyor?"
