# #45 · Veri denetiminde bulunan kayıt ve görev eşleştirme hataları

[#45](https://github.com/halilural/imprimatur/issues/45)

## Durum

Devam ediyor — 2026-10-07

## Yapılacaklar

- 👉 TODO: (C) `hooks/baseline.mjs`: Bash `PostToolUseFailure`'da da kaydet; eski pending'leri süpür; `$VAR/yol` yakalanmasın
- TODO: (C) `scripts/setup.mjs`: `PostToolUseFailure [Bash] → baseline.mjs` hook'u
- TODO: (C) `vscode/tasks.js`: adımın görevi = metnin başındaki anahtar, yoksa maddenin görevi; `normKey` ("80" → "#80")
- TODO: (C) `vscode/audit.js`: model görevini normalize et; asks aynı anahtarla başlıyorsa görev o
- TODO: (C) `vscode/waiting.js`, `vscode/todo-done.js`: adım bazında görev; bilinmeyen kayıt türü kapatmaz
- TODO: (C) `vscode/graph.js`: silinmiş dosyayı gösterme; `vscode/review-state.js`: `latestBefore` sondan oku
- TODO: (C) Testler, README / ARCHITECTURE, sürüm
- TODO: (C) main'e birleştir, `npm run setup`
- TODO: (K) İş makinesinde pull + `npm run setup`

## Kararlar

- DECISION: (2026-10-07) Tek iş: denetimin bütün bulguları burada (kullanıcı)
- DECISION: (2026-10-07) "verify" türündeki soru maddeleri değişmiyor: yanlışlıkla kapanan istek, açık kalandan kötü (audit ilkesi); tekrar eden sorular 10-05 verisinden, "again" mantığı o zamandan beri var
- DECISION: (2026-10-07) İnceleme birikimi (kabul edilmemiş dosyalar) kod sorunu değil; kapsam dışı

## Notlar / engeller

- NOTE: Denetim betikleri oturum scratchpad'inde; bulgular issue'da
