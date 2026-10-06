# #37 · Waiting on you ve Edits'te tik bazen tutmuyor

[#37](https://github.com/halilural/imprimatur/issues/37) · Part of [#2](https://github.com/halilural/imprimatur/issues/2) · PR [#38](https://github.com/halilural/imprimatur/pull/38)

## Durum

Yapıldı (0.29.3, bu makineye kuruldu), kullanıcının denemesi bekleniyor — 2026-10-06

## Yapılacaklar

- DONE: (C) Sebep: her ajan düzenlemesinde panel 3 kez sıfırdan yükleniyordu (`webview.html`), yükleme sırasındaki tık kayboluyordu; kutunun yanına tık satırı açıyordu
- DONE: (C) Panel bir kez yüklenir, sonra yerinde güncellenir; tık sürerken güncelleme bekler; durum hücresinin tamamı tikler
- DONE: (C) npm test 103/103; jsdom ile tık + güncelleme senaryoları hatasız
- 👉 TODO: (K) Reload Window, ajan çalışırken Waiting on you'da birkaç kutuyu tikle: her tık tek seferde tutuyor mu
- TODO: (K) İş makinesinde de aynı deneme (kurulum: pull + `npm run setup`)

## Sorular (kullanıcıya)

## Kararlar

## Notlar / engeller

- NOTE: PR #38, PR #36'nın üstünde; önce #36 birleşmeli
