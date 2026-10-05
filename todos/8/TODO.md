# #8 · feat: Agent Change Graph paneli (Git Graph gibi, ajan düzenlemeleri)

[#8](https://github.com/halilural/imprimatur/issues/8) · Part of [#2](../2/TODO.md) · Sprint 2

## Durum

Sürüyor: tasarım — 2026-10-02

## Yapılacaklar

- DONE: (C) 1. `ARCHITECTURE.md` · agent-review: Agent Change Graph hedef hâl — 2026-10-02
- DONE: (C) 2. Hook: tarihçe satırına `prompt` (oturum dökümünün son 512 KB'ındaki son `last-prompt` kaydı, ilk satır, ≤ 200 karakter); test
- DONE: (C) 3. `graphRows()` saf fonksiyon: bütün tarihçe dosyaları → satırlar (dosya, no, saat, oturum, şerit, istek, +/−), yeniden eskiye; test
- DONE: (C) 4. Webview paneli "Agent Change Graph": SVG şeritler (oturum başına renk), tablo, dosya süzgeci, satıra tıkla → fark; ajan düzenleyince yenile; komut + tarihçe listesinden ve durum çubuğundan açılır
- DONE: (C) 5. 0.6.0 paketi, kurulum, MT-AR-014, README
- NOTE: (2026-10-02) Uygulandı 0.6.0: hook `prompt` (test), `graph.js` graphRows (test), `graphView.js` webview (CSP + nonce, SVG şerit, süzgeç, tıkla → `vscode.diff`), komut + tarihçe listesinin başı, ajan düzenleyince yenilenir; testler 33/33; kuruldu; README, ARCHITECTURE, MT-AR-014. Eski tarihçe satırlarında istek yok (açıklama yerine "Edit <dosya>")
- DONE: (C) 7. Açıklama = ajanın bu turdaki sözü / Bash açıklaması, yoksa başlık + ilk değişen satır; istek tooltip'te; oturum sütunu oturum başlığı (kullanıcı, 2026-10-05: "olur" anlamsız) — 0.19.0, 71/71
- DONE: (K) 6. Gözle: panel, şeritler, açıklama, tıklayınca fark — kullanımda doğrulandı (2026-10-05)

## Sorular (kullanıcıya)

## Kararlar

- DECISION: (2026-10-02) Kullanıcı: "Git Graph yerine Agent Change Graph gibi" + "tamam yap bakalım". Webview kararlı API. Git dallarının karşılığı Claude oturumları (her oturum bir şerit). Açıklama: oturum dökümündeki `last-prompt` kaydı (döküm biçimi gerçek dosyada okundu: `{type: "last-prompt", lastPrompt, sessionId}`); döküm yoksa boş

## Notlar / engeller

- NOTE: (2026-10-02) `last-prompt` kaydı bir tur geride kalabilir (tur içinde gelen ara mesajlar henüz yazılmamış olabilir); açıklama "o düzenlemeden önceki son istek" olarak okunur
