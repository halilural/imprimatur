# #34 · Adımlar açık yazılsın, iş numarası ve TODO.md satırı tıklanabilir olsun

[#34](https://github.com/halilural/imprimatur/issues/34) · Part of [#2](https://github.com/halilural/imprimatur/issues/2)

## Durum

Yapıldı (0.29.0), kullanıcının gözle bakması bekleniyor — 2026-10-05

## Yapılacaklar

- DONE: (C) Haiku adımları kendi başına anlaşılır yazar (`text` + `why`), `task` verir; 👉 satırları aynı sayıda açılır, rutin olanlar düşer
- DONE: (C) `vscode/tasks.js`: anahtar, oturumun TODO.md'si, bağlantı, satır; panelde rozet ve 📄
- DONE: (C) Testler (103), gerçek Haiku ile üç deneme tutarlı
- 👉 TODO: (K) Paneli aç: yeni adımlarda rozet ve 📄 doğru yere gidiyor mu; mevcut sığ maddeler için Audit ya da Rescan

## Kararlar

- DECISION: (2026-10-05) Jira adresi ayar değil, TODO.md'deki anahtarı içeren ilk bağlantıdan; `#n` için origin'in GitHub issue'su.
- DECISION: (2026-10-05) TODO.md'den gelen iş numarası yalnız adım o dosyada geçiyorsa (çok konulu oturumlar yanlış etiketlenmesin).
