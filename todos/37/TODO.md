# #37 · Waiting on you ve Edits'te tik bazen tutmuyor

[#37](https://github.com/halilural/imprimatur/issues/37) · Part of [#2](https://github.com/halilural/imprimatur/issues/2) · PR [#38](https://github.com/halilural/imprimatur/pull/38)

## Durum

Gerçek ölçümden sonra ikinci düzeltme (0.30.1, kuruldu), yeni ölçüm bekleniyor — 2026-10-06

## Yapılacaklar

- DONE: (C) Sebep: her ajan düzenlemesinde panel 3 kez sıfırdan yükleniyordu (`webview.html`), yükleme sırasındaki tık kayboluyordu; kutunun yanına tık satırı açıyordu
- DONE: (C) Panel bir kez yüklenir, sonra yerinde güncellenir; tık sürerken güncelleme bekler; durum hücresinin tamamı tikler
- DONE: (C) npm test 103/103; jsdom ile tık + güncelleme senaryoları hatasız
- DONE: (C) Gecikme: tık dosya izleyicisini bekliyordu, sonra 369 KB sayfa (293 KB'ı waiting detayları) baştan çiziliyordu; tıktan önceki güncelleme kutuyu bir an boşaltabiliyordu. Şimdi tık anında yeniden çizer (edits listesi önbellekten), yalnız değişen satırlar değişir, kutu log onu gösterene kadar işaretli kalır (0.29.4)
- TODO: (K) Ajan çalışırken Waiting on you'da kutuları tikle ve Edits'te Accept'e bas: anında görünüyor mu
- DONE: (C) Ölçüm (Chromium, investment verisi): eski yol tam yükleme 66-184 ms; tık → çizildi ~150 ms (120'si tık sonrası bekleme), bekleme kaldırılınca 57-80 ms; panelde parse 5-20 ms + yama 2-7 ms; eklentide sayfa üretimi 38-53 ms (önbellekli edits), tam sayfa 71-165 ms (0.29.5)
- DONE: (C) VS Code belgeleri: `webview.html` sayfayı ve script durumunu sıfırlar, güncelleme postMessage ile; durum için getState/setState (retainContextWhenHidden pahalı); kendi yazdığın dosya için izleyiciyi bekleme (belgede gecikme sayısı yok)
- DONE: (C) Gerçek panel ölçümü (perf.log): tik 454 / 3847 / 171 ms; panelin işi < 20 ms. 3847 ms'de iki tık aynı anda onaylandı: güncelleme bir sonraki tıka kadar bekledi (tahmin: bırakma olayı panele ulaşmadı, basılı sayıldı)
- DONE: (C) Edits'te Accept: ✓ tıklayınca anında (Waiting kutusu gibi), güncelleme onaylar; basılı beklemesi en fazla 300 ms; log'a eklenti tarafı da (mesajın beklediği süre + iş) (0.30.1)
- 👉 TODO: (C) Kullanıcı birkaç tik/Accept yapınca `/tmp/imprimatur-perf.log` oku: "host waited" yüksekse eklenti başka yenilemelerle meşgul, onu çöz
- TODO: (K) İş makinesinde de aynı deneme (kurulum: pull + `npm run setup`)

## Sorular (kullanıcıya)

## Kararlar

## Notlar / engeller

- NOTE: Belgeler: https://code.visualstudio.com/api/extension-guides/webview (html reset, getState/setState), vscode.d.ts (postMessage yalnız görünür webview'e ulaşır; FileSystemWatcher olayları birleştirilebilir)

- NOTE: PR #38, PR #36'nın üstünde; önce #36 birleşmeli
