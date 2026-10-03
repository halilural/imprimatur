# #7 · feat: agent-review tarihçe düğmesi: ajan düzenlemeleri commit listesi gibi, her birinin farkı

[#7](https://github.com/halilural/imprimatur/issues/7) · Part of [#2](../2/TODO.md) · Sprint 2

## Durum

Sürüyor: tasarım — 2026-10-02

## Yapılacaklar

- DONE: (C) 1. `ARCHITECTURE.md` · agent-review: tarihçe düğmesi hedef hâl — 2026-10-02
- DONE: (C) 2. `historyEdits()` saf fonksiyon: tarihçe satırları + şimdiki metin → düzenleme listesi (no, saat, araç, oturum, +/− satır, önce/sonra); test (29/29) — 2026-10-02
- DONE: (C) 3. Eklenti: durum çubuğunda tarihçe varsa hep görünen düğme ("$(history) N agent edits"), tıklayınca liste (yeniden eskiye), seçince `vscode.diff` (önce ↔ sonra); içerik `agent-review:` şemalı salt-okunur belge; listenin başında "All changes under review" (kopya ↔ şimdi) — 2026-10-02
- DONE: (C) 4. 0.5.0 paketi, kurulum, MT-AR-013 elle test, README — 2026-10-02
- ANSWERED: (kullanıcı, 2026-10-02) "Timeline API'yi extend edemiyor muyuz, internette araştırır mısın?" → kaynaklar açıldı: [Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) (önerilen API marketplace'e çıkamaz; belge "yalnız Insiders" diyor), [vscode.proposed.timeline.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.timeline.d.ts) (`registerTimelineProvider` var), [extensionsProposedApi.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/common/extensionsProposedApi.ts) (kod: `--enable-proposed-api <id>` listesindeki eklentiye kararlı sürümde de izin verilir); bu makinedeki product.json (stable 1.140): `timeline` yalnız ms-vscode.remote-repositories ve GitHub.remotehub'a açık. Sonuç: yerelde olur (tek seferlik argv.json satırı + VS Code'u tamamen kapatıp açma), marketplace'te olmaz; açık kaynak sürümünde düğme kalır
- QUESTION: (2026-10-02) Timeline spike'ı yapalım mı (~30 dk Claude + kullanıcı argv.json'a bir satır ekleyip VS Code'u yeniden başlatır)? Açık değilse eklenti düğmeyle çalışmaya devam eder
- NOTE: (2026-10-02) Kullanıcı reload etti (0.5.0); düğmeyi denemesi bekleniyor
- NOTE: (2026-10-02) Kullanıcı: "şimdi sen değiştir bunu tekrar" → Claude sandbox'ta yeni bir düzenleme yapar (groundwork#8): "Son satır." → "Son paragraf."; düğme "8 agent edits" olmalı, listenin başında groundwork#8
- NOTE: (2026-10-02) Ölçüm: 8 düzenleme, groundwork#8 en üstte (+1 −1). Hata: groundwork#6 ve groundwork#7 aynı saniye, groundwork#6 "+0 −0": proje + global hook paralel koşuyor, yazma öncesi tekrar kontrolü yarışı kaybediyor → okuma tarafında da ayıkla (aynı `before` + 2 sn içinde = tek düzenleme), test
- DONE: (C) Tekrar düzeltmesi 0.5.1: `historyEdits` aynı `before` + 2 sn içindeki satırı tek düzenleme sayar; düğme sayısı da aynı listeden; test 30/30; sandbox ölçümü: 5 gerçek düzenleme (groundwork#5 "Son paragraf" +1 −1 … groundwork#1 pazartesi); kuruldu — 2026-10-02
- ANSWERED: (kullanıcı, 2026-10-02, ekran 17: Git Graph eklentisi) "Bu şekilde olabiliyor mu?" → evet: Webview paneli kararlı API (Git Graph da webview). Öneri: "Agent Edits" paneli: bütün dosyalardaki ajan düzenlemeleri tablo hâlinde (Açıklama · Dosya · Tarih · Oturum · +/−), satıra tıkla → fark penceresi; dosyaya göre süzgeç. Açıklama için kaynak yok (commit mesajı gibi); seçenek: Claude oturum dökümünden (`transcript_path`) o düzenlemeden önceki kullanıcı isteğinin ilk satırı
- ANSWERED: (2026-10-02) Panel yapılsın mı; açıklama sütununa kullanıcının o andaki isteği (oturum dökümünden) yazılsın mı? Varsayılan: evet ikisi de (~1,5–2 saat) → kullanıcı: "Agent Change Graph gibi", "tamam yap bakalım" → [#8](../8/TODO.md)
- 👉 TODO: (K) 5. Gözle: düğme, liste, fark penceresi

## Sorular (kullanıcıya)

## Kararlar

- DECISION: (2026-10-02) Kullanıcı: "önceki değişimleri aşağıda butona basınca görmek ve erişebilmek istiyorum; yani commit commit gibi". VS Code Timeline paneli (git commit'leri gibi) kullanılamaz: `registerTimelineProvider` kararlı API'de yok (vscode.d.ts'te 0 sonuç), yalnız önerilen API, yayınlanan eklenti kullanamaz. Yerine: durum çubuğu düğmesi → QuickPick listesi (git log gibi) → yerleşik `vscode.diff` komutu

## Notlar / engeller
