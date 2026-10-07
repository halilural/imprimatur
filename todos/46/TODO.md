# #46 · Grafik: Bash dalı, kayıt dışı değişiklikler ve boş satırlar

[#46](https://github.com/halilural/imprimatur/issues/46)

## Durum

Devam ediyor — 2026-10-07

## Yapılacaklar

- 👉 TODO: (C) `hooks/baseline.mjs`: Bash'te dal PreToolUse'da da okunur, pending'de saklanır; önce/sonra farklıysa main olmayan
- TODO: (C) `vscode/narration.js`: `toolCallOf` (Edit/Write girdisi, başarısız mı)
- TODO: (C) `vscode/review-state.js` `historyEdits`: `toolCall` ile gerçek after; fark ayrı "outside" düzenlemesi (n + 0.5)
- TODO: (C) `vscode/graph.js`: outside satırı ebeveyninin görevinde; boş düzenleme gizli; `vscode/extension.js` aynı veriyi kullanır
- TODO: (C) Testler, README / ARCHITECTURE, sürüm
- TODO: (C) main'e birleştir, kur
- TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Kararlar

- DECISION: (2026-10-07) Tek iş: grafik denetiminin üç bulgusu (kullanıcı: "bunlarin hepsini de yap")
- DECISION: (2026-10-07) Bash düzenlemesinin gerçek after'ı bilinemez (transcript'te yalnız komut var): yalnız Edit/Write düzeltilir
- DECISION: (2026-10-07) "No task" şeridindeki main düzenlemeleri doğru: görev anahtarı yok

## Notlar / engeller

- NOTE: Kaynak: grafik denetimi, todos/45'in devamı
