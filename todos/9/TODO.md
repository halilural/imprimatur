# #9 · feat: agent-review Mermaid diyagram farkı: eklenen/değişen/silinen düğümler renkli

[#9](https://github.com/halilural/imprimatur/issues/9) · Part of [#2](../2/TODO.md) · Sprint 2

## Durum

Sürüyor — 2026-10-02

## Yapılacaklar

- DONE: (C) Araştırma (kaynaklar ana oturumda açıldı, 2026-10-02): [Flow Lens](https://jsr.io/@goog/flow-lens) `classDef added/modified/deleted` (yeşil/turuncu/kırmızı, 5 px kenar) + kutuda +, Δ, −; [GoJS Visual Diff](https://gojs.net/extras/visualDiff.html) eklenen sarı, silinen kırmızı, değişen camgöbeği; [pi-visualize-code-changes](https://pi.dev/packages/pi-visualize-code-changes) birleşik renkli Mermaid farkı (eklenen/silinen/değişen/aynı). DZone "Diffing software architecture" açılamadı (403). Ortak desen: tek birleşik diyagram, silinen de görünür, renk + işaret
- ANSWERED: (kullanıcı, 2026-10-02, ekran 32) interview'da HLD diyagramındaki iki oka etiket eklettirdi: "Değiştirdik, bir şey olmadı" → beklenen: kod blokları (Mermaid de) işaretlenmiyor; bu iş #9. Deneme onay sayıldı
- DONE: (K) Plan onayı (deneme ile) — 2026-10-02
- DONE: (C) `ARCHITECTURE.md` hedef hâl — 2026-10-02
- DONE: (C) `mermaid-diff.js`: `parseFlowchart` (düğüm etiketleri, ok sırası, zincir), `mermaidDiff` (classDef/class/linkStyle, silinenler hayalet düğüm/ok), `mermaidBlocks`, `matchOld`; 4 test — 2026-10-02
- DONE: (C) Önizleme: `diagramDiff` fence token kopyasına renk satırları, üstte açıklama + ✓ Accept (çit aralığı), sağ kenarda turuncu çentik; eklenti `getBase` (kopya metni); test 50/50 — 2026-10-02
- DONE: (C) 0.11.0 kuruldu (eski klasör silinmedi), MT-AR-021; interview diyagramında ölçüm: MQ etiketi değişti + 8 ve 9. oklar etiket aldı → 3 turuncu — 2026-10-02
- NOTE: (2026-10-03, ekran 42) Önizlemede diyagram üstü "Agent changes in this diagram: added 3, changed 4, removed 0" çıkıyor; ama diyagram arada boş, yenileyince geliyor → inceleniyor (iki Mermaid eklentisi yarışı mı, eklentinin kaydırma geri yüklemesi mi)
- NOTE: (kullanıcı, 2026-10-03) "Syntax mermaid falan diyor, tekrar refresh ettikten sonra hemen kayboluyor, şekil geliyor" → aralıklı "Syntax error" Mermaid'in zaten çizilmiş (SVG'ye dönmüş) bloğu ikinci kez çizmesinin tipik belirtisi (iki Mermaid eklentisi). Eklenen renk satırlarının geçerliliği gerçek Mermaid ayrıştırıcısıyla ölçülüyor
- NOTE: (2026-10-03) Ölçüm: interview HLD diyagramı + eklentinin renk satırları gerçek Mermaid ayrıştırıcısında (mermaid npm + jsdom, `mermaid.parse`) GEÇERLİ. Aralıklı "Syntax error" bizden değil: iki Mermaid önizleme eklentisi aynı bloğu çiziyor, ikincisi SVG'ye dönmüş bloğu yeniden ayrıştırınca hata
- QUESTION: (2026-10-03) Mermaid Chart eklentisi kapatılsın mı (kullanıcı yapar: Extensions → Mermaid Chart → Disable → Reload)? Markdown Mermaid Zoom yeter (yakınlaştırma da onda)
- NOTE: (kullanıcı, 2026-10-03) "Mermaid grafikler yine görünmedi". Mermaid Chart'ın kapatılıp kapatılmadığı bilinmiyor (eklenti açık/kapalı durumu VS Code'un iç deposunda, dosyadan okunamıyor). Bizim satırlar geçerli (ölçüldü); kalan ayırma: (1) Mermaid Chart kapalı mı, (2) değilse Agent Review kapatılıp diyagram gelir mi
- NOTE: (kullanıcı, 2026-10-03) "E hâlâ aynı" → Mermaid Chart kapatıldı, diyagram yine arada boş varsayıldı; Mermaid Zoom'un çizim yolu inceleniyor
- NOTE: (2026-10-03) Kaynak: Markdown Mermaid Zoom readme "Troubleshooting": Mermaid Chart (`mermaidchart.vscode-mermaid-chart`) ve Markdown Preview Mermaid Support bilinen çakışanlar; iki Mermaid örneği aynı webview'da diyagram tanıma kaydını bozuyor; çözüm "Disable or uninstall". Mermaid Chart WSL'de kurulu (~/.vscode-server/extensions/mermaidchart.vscode-mermaid-chart-2.7.4); önizleme WSL'de koşuyor → Windows tarafında kapatmak yetmeyebilir
- ANSWERED: (2026-10-03) Mermaid Chart'ı WSL'den kaldırayım mı (`code-server --uninstall-extension mermaidchart.vscode-mermaid-chart`; geri kurulabilir)? → kullanıcı: "Kaldırmıyorum; agent review tarafını kaldıralım, Mermaid chart'larını etkileyen"
- DECISION: (2026-10-03) Mermaid diyagram farkı varsayılan KAPALI: ayar `agentReview.mermaidDiff` (false); kapalıyken önizleme Mermaid bloklarına hiçbir satır, açıklama ya da düğme eklemez. Kod kalır (tek Mermaid eklentisiyle açılabilir)
- DONE: (C) Ayar ve kurulum (0.17.0): `getBase` yalnız `agentReview.mermaidDiff` açıkken; varsayılan kapalı; kuruldu; README, ARCHITECTURE, MT-AR-020/021 — 2026-10-03
- 👉 TODO: (K) Gözle (varsayılan kapalı): Reload Window, interview HLD diyagramında turuncu MQ ve iki ok

## Sorular (kullanıcıya)

- ANSWERED: (2026-10-02) Plan uygun mu? Varsayılan renkler Flow Lens gibi: eklenen yeşil, değişen turuncu, silinen kırmızı kesikli (+ legend)

## Kararlar

## Notlar / engeller

- NOTE: (2026-10-02) Ekran 30: interview ARCHITECTURE.md diyagramı artık çiziliyor (Mermaid ayırma denemesinin sonucu kullanıcıdan bekleniyor: hangi eklenti kapatıldı?)
