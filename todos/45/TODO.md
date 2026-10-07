# #45 · Veri denetiminde bulunan kayıt ve görev eşleştirme hataları

[#45](https://github.com/halilural/imprimatur/issues/45)

## Durum

Bitti — 2026-10-07 (0.30.3, main'e birleşti)

## Yapılacaklar

- DONE: (C) `hooks/baseline.mjs`: Bash `PostToolUseFailure`'da da kaydet; eski pending'leri süpür; `$VAR/yol` yakalanmasın
- DONE: (C) `scripts/setup.mjs`: `PostToolUseFailure [Bash] → baseline.mjs` hook'u
- DONE: (C) `vscode/tasks.js`: adımın görevi = metnin başındaki anahtar, yoksa maddenin görevi; `normKey` ("80" → "#80")
- DONE: (C) `vscode/audit.js`: model görevini normalize et; asks aynı anahtarla başlıyorsa görev o
- DONE: (C) `vscode/waiting.js`, `vscode/todo-done.js`: adım bazında görev; bilinmeyen kayıt türü kapatmaz
- DONE: (C) `vscode/graph.js`: silinmiş dosyayı gösterme; `vscode/review-state.js`: `latestBefore` sondan oku
- DONE: (C) Testler 121/121 (`test/data-audit.test.mjs`), README / ARCHITECTURE, 0.30.3; gerçek veride metin anahtarı ≠ görev: 0
- DONE: (C) main'e birleştir, `npm run setup`
- 👉 TODO: (K) İş makinesinde pull + `npm run setup`

## Kararlar

- DECISION: (2026-10-07) Tek iş: denetimin bütün bulguları burada (kullanıcı)
- DECISION: (2026-10-07) "verify" türündeki soru maddeleri değişmiyor: yanlışlıkla kapanan istek, açık kalandan kötü (audit ilkesi); tekrar eden sorular 10-05 verisinden, "again" mantığı o zamandan beri var
- DECISION: (2026-10-07) `leadKey`: `#N` her zaman, Jira biçimi yalnızca ardından `:` gelirse ("UTF-8 …" görev değil; inceleme bulgusu)
- DECISION: (2026-10-07) İnceleme birikimi (kabul edilmemiş dosyalar) kod sorunu değil; kapsam dışı

## Notlar / engeller

- NOTE: Denetim betikleri oturum scratchpad'inde; bulgular issue'da
