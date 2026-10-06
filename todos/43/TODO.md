# #43 · Başka oturumda biten görevin maddeleri kapanmıyor

[#43](https://github.com/halilural/imprimatur/issues/43)

## Durum

İncelemede — 2026-10-06 (0.30.2, PR açık)

## Yapılacaklar

- DONE: (C) `vscode/waiting.js`: bütün adımları tiklenen her madde kapanır; `openSteps` adımın görevini taşır
- DONE: (C) `vscode/todo-done.js`: Durum'u `Bitti` olan TODO.md'nin görevine bağlı, ondan önce açılmış maddeleri tikle (bütün oturumlar)
- DONE: (C) `hooks/waiting.mjs`: Stop'ta TODO kapanışını çalıştır
- DONE: (C) `hooks/resolve.mjs`: mesajın andığı görevin diğer oturumlardaki adımları da modele, her biri kendi log'una
- DONE: (C) Testler 111/111: TODO Bitti kapanışı (önce/sonra, başka görev, mtime önbelleği), "13977" mesajı başka oturumu tikliyor, modelsiz yol dokunmuyor, Stop uçtan uca

- DONE: (C) Oturumun kendi log'u yoksa da resolve başlıyor (LATD örneğinde 01259035'in log'u yoktu, resolve hiç çalışmamış olabilir)
- DONE: (C) README, `ARCHITECTURE.md`, 0.30.2
- 👉 TODO: (K) PR'ı birleştir; iş makinesinde pull + eklentiyi kur; LATD reposunda bir sonraki tur sonunda LATD-13977 maddeleri kendiliğinden kapanıyor mu bak

## Kararlar

- DECISION: (2026-10-06) TODO kapanışı Stop'ta: yeni hook kaydı yok, iş makinesinde yalnızca pull yeter
- DECISION: (2026-10-06) Yalnızca TODO.md'nin son değişikliğinden önce açılan maddeler kapanır: bitişten sonra sorulan şey açık kalır
- DECISION: (2026-10-06) `imprimatur done --task` CLI kapsam dışı

## Notlar / engeller

- NOTE: Kaynak: başka bir repoda LATD-13977, 3 oturuma yayılmış maddeler
