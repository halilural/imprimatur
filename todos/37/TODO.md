# #37 · Waiting on you ve Edits'te tik bazen tutmuyor

[#37](https://github.com/halilural/imprimatur/issues/37) · Part of [#2](https://github.com/halilural/imprimatur/issues/2) · PR [#38](https://github.com/halilural/imprimatur/pull/38)

## Durum

Gecikme düzeltmesi yapıldı (0.29.4, bu makineye kuruldu), ölçüm bekleniyor — 2026-10-06

## Yapılacaklar

- DONE: (C) Sebep: her ajan düzenlemesinde panel 3 kez sıfırdan yükleniyordu (`webview.html`), yükleme sırasındaki tık kayboluyordu; kutunun yanına tık satırı açıyordu
- DONE: (C) Panel bir kez yüklenir, sonra yerinde güncellenir; tık sürerken güncelleme bekler; durum hücresinin tamamı tikler
- DONE: (C) npm test 103/103; jsdom ile tık + güncelleme senaryoları hatasız
- DONE: (C) Gecikme: tık dosya izleyicisini bekliyordu, sonra 369 KB sayfa (293 KB'ı waiting detayları) baştan çiziliyordu; tıktan önceki güncelleme kutuyu bir an boşaltabiliyordu. Şimdi tık anında yeniden çizer (edits listesi önbellekten), yalnız değişen satırlar değişir, kutu log onu gösterene kadar işaretli kalır (0.29.4)
- 👉 TODO: (K) Ajan çalışırken Waiting on you'da 4-5 kutuyu tikle: anında işaretleniyor mu
- TODO: (C) `/tmp/imprimatur-perf.log`'daki ölçümleri oku (tık → çizildi ms); 300 ms üstü varsa nedenini bul
- TODO: (K) İş makinesinde de aynı deneme (kurulum: pull + `npm run setup`)

## Sorular (kullanıcıya)

## Kararlar

## Notlar / engeller

- NOTE: PR #38, PR #36'nın üstünde; önce #36 birleşmeli
