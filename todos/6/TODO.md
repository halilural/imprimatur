# #6 · test: agent-review elle testleri (MT-AR-001…012)

[#6](https://github.com/halilural/imprimatur/issues/6) · Part of [#2](../2/TODO.md) · Sprint 2 · testler: [agent-review.md](../../docs/testing/imprimatur.md)

## Durum

İncelemede: kullanıcı bakıyor, Claude değişiklikleri yapıyor — 2026-10-02

## Yapılacaklar

- DONE: (C) Elle test dosyası ve deneme dosyası yazıldı ([#5](../5/TODO.md), 065f02f) — 2026-10-02
- DONE: (K) MT-AR-003 tek kelime: editörde geçti (ekran 10) — 2026-10-02
- FIXME: (K) MT-AR-012 önizleme (0.4.0): ekran 11, editörde işaret var, önizlemede hiç yok → kalıyor
- NOTE: (2026-10-02) Neden (markdownEngine.ts okundu): VS Code core kuralların koştuğu `parse`'ı `currentDocument: undefined` ile çağırıyor ve token'ları belge başına önbellekliyor; dosya yalnız `renderer.render(tokens, …, env)`'de belli. Eklenti dosyayı bulamayıp sessiz kaldı. Testte `md.render(src)` iki adımı aynı env'le koştuğu için yakalanmadı
- DONE: (C) MT-AR-012 düzeltmesi 0.4.1: işaretler `renderer.render`'da, önbellekteki token'ların kopyasına; açık belgenin kaydedilmemiş metni kullanılır; testler VS Code gibi (parse belgesiz, render belgeli) + "önbellek değişmez" testi, 28/28 (eski kod bu testlerde kalır); kuruldu — 2026-10-02
- DONE: (K) MT-AR-012 yeniden (0.4.1, ekran 12): önizlemede eski cümle üstü çizili üstte, paragraf mavi — geçti — 2026-10-02
- DONE: (K) MT-AR-004 (ekran 13): editörde eski cümle üstü çizili + yeni cümle, 7. satır soluk; önizlemede iki eski satır üstte — geçti — 2026-10-02
- DONE: (K) MT-AR-005 (ekran 14): silme işareti + yeşil yeni satır, önizlemede de — geçti — 2026-10-02
- DONE: (K) MT-AR-006, 007 (ekran 15): C3 parlak, öncekiler soluk, ruler işaretleri — geçti — 2026-10-02
- NOTE: (2026-10-02) C3'ün üstündeki boş satır (12) soluk: tazelik farkı boş satırı eskisiyle eşleştiriyor; küçük, kullanıcı istemezse dokunulmaz
- DONE: (K) MT-AR-008, 009, 010: kullanıcı "bunların hepsi oldu" — geçti — 2026-10-02
- NOTE: (2026-10-02) Kullanıcı yeni istek: önceki değişiklikleri düğmeyle görmek, "commit commit gibi" → [#7](../7/TODO.md)
- DONE: (K) MT-AR-011 dirtywork / interview — kullanımda doğrulandı (2026-10-05)
- DONE: (K) MT-AR-001 eklenti kurulu (0.4.0), MT-AR-002 temiz başlangıç — kullanımda doğrulandı (2026-10-05)
- TODO: (K+C) MT-AR-004 cümle, MT-AR-005 ekleme/silme, MT-AR-006 son düzenleme parlak, MT-AR-007 kaydırma çubuğu
- DONE: (K) MT-AR-008 stage renklere dokunmaz, MT-AR-009 Accept, MT-AR-010 Accept all + tarihçe — kullanımda doğrulandı (2026-10-05)
- TODO: (C) Sonuçları agent-review.md durum satırlarına yaz; kalan hata → yeni issue
- TODO: (C) Deneme dosyasını taban metne döndür ve commit'le (bkz. #5 notu)

## Sorular (kullanıcıya)

## Kararlar

- DECISION: (2026-10-02) Kullanıcı: "manuel test adımları için de bir issue aç". Testlerin koşulması #5'den ayrıldı; #5 kod tarafı, #6 doğrulama. Pano: In Review (kullanıcıya bekliyor)

## Notlar / engeller
