# #51 · Grafik her yenilemede bütün geçmişi diff'liyor

[#51](https://github.com/halilural/imprimatur/issues/51)

## Durum

Bitti — 2026-10-07 (0.31.1, main'e birleşti)

## Yapılacaklar

- DONE: (C) `vscode/graph.js` `fileEdits`: dosya başına önbellek (log, kopya, dosya / editör metni, calls.jsonl); `descriptionsOf` önbellekli
- DONE: (C) `vscode/diff.js` `diff(…, {words: false})`, `review(…, opts)`: satır aralığı yeten yerlerde kelime diff'i yok
- DONE: (C) `vscode/tasks.js`: `sessionTodos`, TODO.md metinleri ve satır kelimeleri mtime'la önbellekte
- DONE: (C) `vscode/extension.js`: waiting/ + açıklama değişikliği 1 sn sonra (en geç 3 sn) tek tam yenileme
- DONE: (C) Testler 140/140 (`test/perf-cache.test.mjs`); ölçüm: tam yenileme dirtywork 430 → 34 ms, graphRows 150-500 → ~3 ms
- DONE: (C) İnceleme (waiting yenilemesi bayat sözü göstermesin: tam yenileme; en geç 3 sn), main'e birleştir, kur
- 👉 TODO: (K) Pencereleri yeniden yükle, extension host CPU'suna bak (beklenen: boşta ~%0, ajan çalışırken kısa sıçramalar)
- TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Kararlar

- DECISION: (2026-10-07) Önbellek anahtarı boyut + mtime (içerik hash'i değil): değişmeyen dosya hiç okunmaz
- DECISION: (2026-10-07) Todo Tree'nin maliyeti (markdown liste satırlarını aday yapan regex) bu reponun dışında: dev-workflow ayarı

## Notlar / engeller

- NOTE: Kaynak: başka bir oturumun ölçümü (CPU profili, extension host'lar)
