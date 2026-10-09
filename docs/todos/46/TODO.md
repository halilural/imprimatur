# #46 · Grafik: Bash dalı, kayıt dışı değişiklikler ve boş satırlar

[#46](https://github.com/halilural/imprimatur/issues/46)

## Durum

Bitti — 2026-10-07 (0.30.4, main'e birleşti)

## Yapılacaklar

- DONE: (C) `hooks/baseline.mjs`: Bash'te dal PreToolUse'da da okunur, pending'de saklanır; önce/sonra farklıysa main olmayan
- DONE: (C) `vscode/narration.js`: `toolCallOf` (Edit/Write girdisi, başarısız mı)
- DONE: (C) `vscode/review-state.js` `historyEdits`: `toolCall` ile gerçek after; fark ayrı "outside" düzenlemesi (n + 0.5)
- DONE: (C) `vscode/graph.js`: outside satırı ebeveyninin görevinde; boş düzenleme gizli; `vscode/extension.js` aynı veriyi kullanır
- DONE: (C) Testler 127/127 (`test/graph-truth.test.mjs`), ARCHITECTURE, 0.30.4; gerçek veride outside satırı: dirtywork 5, investment 2 (çoğu docs TOC hook'unun Edit sonrası yazdığı içindekiler)
- DONE: (C) main'e birleştir, kur
- 👉 TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Kararlar

- DECISION: (2026-10-07) Tek iş: grafik denetiminin üç bulgusu (kullanıcı: "bunlarin hepsini de yap")
- DECISION: (2026-10-07) Bash düzenlemesinin gerçek after'ı bilinemez (transcript'te yalnız komut var): yalnız Edit/Write düzeltilir
- DECISION: (2026-10-07) "No task" şeridindeki main düzenlemeleri doğru: görev anahtarı yok

- DECISION: (2026-10-07) İnceleme: yalnız satır sonu / boşluk farkı outside sayılmaz; iki görev dalı arasında geçişte sonraki dal; transcript önbelleği girdiyi değil satırın yerini tutar (bellek); paralel oturumun aynı dosyayı düzenlemesi outside görünebilir (bilinen sınır)

## Notlar / engeller

- NOTE: Kaynak: grafik denetimi, todos/45'in devamı
