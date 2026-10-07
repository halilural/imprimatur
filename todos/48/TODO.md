# #48 · 0.30.5 eklentisi açılmıyor: paket dosya listesinde calls.js ve todo-done.js yok

[#48](https://github.com/halilural/imprimatur/issues/48)

## Durum

Bitti — 2026-10-07 (0.30.6, main'e birleşti)

## Yapılacaklar

- DONE: (C) `vscode/package.json` `files`: `calls.js`, `todo-done.js`
- DONE: (C) `test/package.test.mjs`: paketteki her dosyanın yerel `require`'ları da pakette (eski listeyle 3 eksik yakalıyor)
- DONE: (C) main'e birleştir, kur, vsix içeriği doğrulandı
- 👉 TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Kararlar

- DECISION: (2026-10-07) Paket listesi elle kalır; testi bozulursa yeni dosya eklenmemiş demektir

## Notlar / engeller

- NOTE: Belirti: Agent Setup "There is no data provider", `command 'imprimatur.setup.refresh' not found` (investment, dirtywork); log: `Cannot find module './calls.js'`
