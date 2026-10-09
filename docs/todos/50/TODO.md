# #50 · Grafik hover'ı Markdown düzenlemesini review görünümünde göstersin

[#50](https://github.com/halilural/imprimatur/issues/50)

## Durum

Bitti — 2026-10-07 (0.31.0, main'e birleşti)

## Yapılacaklar

- DONE: (C) `vscode/preview.js` `reviewHtml` (önizlemenin işaretleri, Accept düğmesi yok), `scopeCss`
- DONE: (C) `vscode/extension.js` `renderEdit`; `vscode/graphView.js`: hover istek/yanıt, işaretli bloklar ± 1 blok, stil
- DONE: (C) Testler 136/136; gerçek veri: dirtywork açık 40 düzenlemeden 39'u işlendi, en yavaşı 18 ms
- DONE: (C) İnceleme: içerik değişince yeniden konum, 150 ms bekleme + önbellek, HTML temizleme (script/style/form/iframe/on*/javascript:), CSP form-action/base-uri; 137/137; main'e birleştir, kur
- 👉 TODO: (K) Grafikte bir Markdown düzenlemesinin durum hücresine gel: review görünümü
- TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Kararlar

- DECISION: (2026-10-07) Satır diff'i önce görünür, işlenmiş hali gelince yerini alır (hover gecikmez)
- DECISION: (2026-10-07) Yalnız değişen bloklar ve çevresinde birer blok: bütün belge hover'a sığmaz
- DECISION: (2026-10-07) Kod bloğu içindeki değişiklik önizlemede de işaretlenmez (#28): o düzenlemede satır diff'i kalır

## Notlar / engeller

- NOTE: Kullanıcı ekran görüntüsü: "#47 eski yanlış veri…" satırının hover'ı ham Markdown
