# #34 · Adımlar açık yazılsın, iş numarası ve TODO.md satırı tıklanabilir olsun

[#34](https://github.com/halilural/imprimatur/issues/34) · Part of [#2](https://github.com/halilural/imprimatur/issues/2)

## Durum

Bitti — 2026-10-07 (0.29.0; kullanıcı panelde doğruladı)

## Yapılacaklar

- DONE: (C) Haiku adımları kendi başına anlaşılır yazar (`text` + `why`), `task` verir; 👉 satırları aynı sayıda açılır, rutin olanlar düşer
- DONE: (C) `vscode/tasks.js`: anahtar, oturumun TODO.md'si, bağlantı, satır; panelde rozet ve 📄
- DONE: (C) Testler (103), gerçek Haiku ile üç deneme tutarlı
- DONE: (K) Paneli aç: rozet ve 📄 doğru yere gidiyor (kullanıcı, 2026-10-07)

## Kararlar

- DECISION: (2026-10-05) Jira adresi ayar değil, TODO.md'deki anahtarı içeren ilk bağlantıdan; `#n` için origin'in GitHub issue'su.
- DECISION: (2026-10-05) TODO.md'den gelen iş numarası yalnız adım o dosyada geçiyorsa (çok konulu oturumlar yanlış etiketlenmesin).
