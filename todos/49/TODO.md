# #49 · Eski hook'la yazılmış satırlar çağrılarına bağlansın (interview, groundwork)

[#49](https://github.com/halilural/imprimatur/issues/49)

## Durum

Bitti — 2026-10-07 (0.30.7, main'e birleşti)

## Yapılacaklar

- DONE: (C) `vscode/narration.js`: çağrıların zamanı, dosyası, komutu, açıklaması; oturum başlığı (`usesOf`, `titleOf`)
- DONE: (C) `vscode/calls.js` `linkIn`: toolUseId'siz satır → oturum transcript'indeki çağrı (dosya + zaman); bağlantı ve başlık `calls.jsonl`'da; Bash açıklaması (`said`) kalıcı
- DONE: (C) `historyEdits` `link`; grafik ve eklenti kullanır; başlık transcript'ten
- DONE: (C) Test 132/132; gerçek veri: interview 77/79 bağlandı, açıklama 75/80; groundwork 62/62, açıklama 62/62, görevsiz 31 → 20
- DONE: (C) İnceleme: Windows büyük-küçük harf, aynı adlı başka dosya, tutulan bağlantıların çağrıları, eksik transcript önbelleği, satırın kendi başlığı korunur, araç bilinmezse Edit önce; test transcript'leri geçici dizinde (133/133); main'e birleştir, kur
- 👉 TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`
- TODO: (K) interview'de grafiği aç: "Waiting on you" geçmişi ilk açılışta taranır (son 30 gün)

## Kararlar

- DECISION: (2026-10-07) Veri yeniden yazılmaz; bağlantı ayrı dosyada (kullanıcı: "hepsi kendiliginden duzelsin")
- DECISION: (2026-10-07) Açıklama için model çağrısı yok: ajanın sözü ya da Bash açıklaması yeter
- DECISION: (2026-10-07) Başlık kaydı olmayan oturum (dirtywork fff30086) başlıksız kalır

## Notlar / engeller

- NOTE: interview'in 7 incelenmemiş dosyası kullanıcının kabulünü bekliyor (veri hatası değil)
