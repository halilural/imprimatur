# #52 · Eski Imprimatur kayıtlarını arşivle

[#52](https://github.com/halilural/imprimatur/issues/52)

## Durum

Bitti — 2026-10-07 (0.32.0, main'e birleşti)

## Yapılacaklar

- DONE: (C) `vscode/archive.js` `archiveRepo`, `archiveDue`: eski düzenleme kabul + log'dan arşive; tümü eski / silinmiş dosya → log + kopya arşive; açık maddesi olmayan eski waiting log'ları; calls / descriptions budanır; yarışta dokunmaz
- DONE: (C) `vscode/extension.js`: açılışta (30 sn) ve saatte bir, günde bir kez; `imprimatur.archiveNow`; `imprimatur.archive.afterDays` (7, 0 = kapalı)
- DONE: (C) Testler (`test/archive.test.mjs`); gerçek verinin kopyası: 7 günle bugün yalnız silinmiş dosyalar, 3 günle interview 78 → 3 satır, groundwork 62 → 0
- DONE: (C) README, ARCHITECTURE, 0.32.0
- DONE: (C) İnceleme: silinmiş dosya da yalnız eskiyse (dal değişimi), önce arşiv sonra silme, git işlemi sürerken ve iki pencerede birden çalışmaz, "#n" ham satırla kayar, boş waiting log'una dokunulmaz; 143/143; main'e birleştir, kur
- 👉 TODO: (K) İlk otomatik çalıştırma: pencere açıldıktan 30 sn sonra; Output → Imprimatur'da "archive …" satırları
- TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Kararlar

- DECISION: (2026-10-07) Arşivle, silme (kullanıcı)
- DECISION: (2026-10-07) 7 gün (kullanıcı)
- DECISION: (2026-10-07) İncelemedeki eski düzenleme de: kabul edilmiş sayılır ve arşivlenir (kullanıcı)
- DECISION: (2026-10-07) Günde bir otomatik + elle komut (kullanıcı)
- DECISION: (2026-10-07) Açık bekleyen istek otomatik kapatılmaz: kullanıcının yapacağı iş
- DECISION: (2026-10-07) Geri yükleme komutu yok: `zcat` ile okunur

## Notlar / engeller

- NOTE: Veri repo başına 2–4 MB; asıl kazanç grafiğin ve listenin sadeleşmesi
