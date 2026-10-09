# #57 · Imprimatur veritabanı: node:sqlite, cihaz bazlı, kayıtların asıl kaynağı

[#57](https://github.com/halilural/imprimatur/issues/57) · Epic [#53](../53/TODO.md)

## Durum

Bitti — 2026-10-09 (`vscode/db.js`, main'e birleşti; henüz kimse kullanmıyor, ilk kullanıcı #58)

## Yapılacaklar

- DONE: (C) `ARCHITECTURE.md`: «Kayıt veritabanı (hedef hâl)»: motor, yer, eşzamanlılık, şema, sürüm, erişim katmanı, gecikme
- DONE: (C) `vscode/db.js`: `openDb`, pragmalar, `MIGRATIONS` (user_version), `/mnt/c` reddi, yazma API'si + sürüm satırı
- DONE: (C) `test/db.test.mjs`: şema, sürüm satırları, tek 👉 (yalnız açık kayıtta), aynı görevde `parent_id`, 12 sürecin yeni dosyayı aynı anda açması, 12 eşzamanlı yazıcı × 40 kayıt; 156/156
- DONE: (C) Ölçüm (10k kayıt, medyan): `recordsOf` 0,27 ms, `openAsks` 0,35 ms, `tasksOf` 0,17 ms, açılış 0,24 ms. Sıkı hedef `IMPRIMATUR_PERF=1` ile; normal koşuda 5 kat pay
- DONE: (C) İnceleme: WAL'e ilk geçişte SQLITE_BUSY (busy_timeout beklemez → 5 sn yeniden dene), ROLLBACK asıl hatayı örtmüyor, açılış hatasında bağlantı kapanıyor, açık maddeler indeksi `(owner, created_at)` (önce 1,2 ms), alt süreçlere zaman sınırı; main'e birleştir

## Sorular (kullanıcıya)

## Notlar / engeller

- NOTE: (2026-10-09) Bu makinede sistem Node'u 22.13.0: `node:sqlite` bayraksız ama "experimental" uyarısı basıyor; `db.js` yalnız bu uyarıyı susturur.

## Kararlar

- DECISION: (2026-10-09) Kayıt silinmez, `dropped` olur: sürüm geçmişi tam kalır, yabancı anahtarlar kopmaz.
- DECISION: (2026-10-09) Her satırda rastgele `uid`: bulut senkronu (#61) için şimdiden; yerelde `id` kullanılır.
- DECISION: (2026-10-09) Yazmalar `BEGIN IMMEDIATE`: okuma→yazma kilit yükseltmesindeki SQLITE_BUSY'yi busy_timeout beklemez.
