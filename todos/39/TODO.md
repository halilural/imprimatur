# #39 · Graph şeritleri göreve göre (oturuma göre değil)

[#39](https://github.com/halilural/imprimatur/issues/39) · Part of [#2](https://github.com/halilural/imprimatur/issues/2)

## Durum

Yapıldı (0.30.0, bu makineye kuruldu), kullanıcının bakması bekleniyor — 2026-10-06

## Yapılacaklar

- DONE: (C) `ARCHITECTURE.md`: «Görev şeritleri» hedef hâl (sıra: dosya → dal → aynı turdaki TODO.md → istekteki anahtar → No task)
- DONE: (C) `hooks/baseline.mjs`: düzenleme anındaki dal tarihçe satırında (`branch`)
- DONE: (C) `vscode/graph.js`: `tasksOf` (dosya → dal → aynı tur → anahtar), şerit = görev, `sessions` listesi
- DONE: (C) `vscode/graphView.js`: Task sütunu (rozet issue/Jira/TODO.md'ye gider + TODO.md başlığı), şeritler sütun paylaşır (git gibi, çakışmayan görevler aynı sütunda), Waiting renkleri `sessions`'tan
- DONE: (C) Testler 106/106: tek oturumda iki görev iki şerit, iki oturumda tek görev tek şerit, dal, Jira, tur, No task, hook dal kaydı
- DONE: (C) Gerçek veri: investment 1 oturum → 7 görev + 3 No task düzenlemesi; imprimatur 82 düzenleme, 7 görev, 40 No task (TODO.md tutulmayan eski turlar: README, market-research); Chromium'da çizim ve rozet tıklaması hatasız
- DONE: (C) `ARCHITECTURE.md` son hâl: yapılanla eşleşiyor (sütun paylaşımı eklendi)
- 👉 TODO: (K) Paneli aç: şeritler görevlere göre doğru ayrılıyor mu

## Sorular (kullanıcıya)

- ANSWERED: Görev bulma sırası dosya → dal → aynı turdaki TODO.md → anahtar → görevsiz uygun mu? — "tamam geldi onay yap" (2026-10-06)

## Kararlar

- DECISION: (2026-10-06) Birim düzenleme + tur, oturum değil: bir oturumda birden çok iş yapılıyor (kullanıcı)
- DECISION: (2026-10-06) (4) model yerine metindeki anahtar: Haiku yalnız farkı görüyor, görevi bilemez; isteğin/açıklamanın andığı `#n` deterministik

## Notlar / engeller

- NOTE: Dal `feat/39-task-lanes`, `fix/37-tick-reliable` üstünde (o da #36 üstünde)
