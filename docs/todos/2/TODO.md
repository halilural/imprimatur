# #2 · Epic: Ajan değişikliklerini editörde incelemek

[#2](https://github.com/halilural/imprimatur/issues/2) · Sprint 2 · Epic haritası (groundwork)

## Durum

Sürüyor: #3 başladı — 2026-10-02

## Yapılacaklar

- DONE: [#3 MD değişikliklerini editörde renkli göster (hook + VS Code eklentisi)](../3/TODO.md) — 0.2.0, kapandı 2026-10-02
- TODO: [#4 agent-review bu makinede bütün repolarda](../4/TODO.md)
- TODO: [#9 Mermaid diyagram farkı](../9/TODO.md)
- 👉 TODO: [#10 Eklentinin adı Imprimatur](../10/TODO.md)
- NOTE: (kullanıcı, 2026-10-03) "Projesi, issue'ları da ayrı olsun; #1'ü o repoya götürelim, buradan silelim" → #1 [halilural/imprimatur](https://github.com/halilural/imprimatur)'a taşınıyor (private → public aktarım GitHub'da yok: orada yeni issue + kendi panosu, burada silinir); groundwork'teki `modules/imprimatur/` kaldırılır, hook'lar `~/projects/imprimatur`'a
- TODO: [#8 Agent Change Graph paneli](../8/TODO.md)
- DONE: [#11 Waiting on you sekmesi](../11/TODO.md) — kapandı 2026-10-05
- TODO: [#7 tarihçe düğmesi, commit listesi gibi](../7/TODO.md)
- TODO: [#6 elle testler MT-AR-001…012](../6/TODO.md)
- TODO: [#5 git'ten bağımsız: tarihçe, Accept'e kadar kalıcı renkler](../5/TODO.md)
- TODO: (C) Ürün özellik havuzuna Ö31 (ajan değişikliği editörde, stage = kabul) — #3 bitince, ne öğrendiğimizle

## Sorular (kullanıcıya)

## Kararlar

- DECISION: (2026-10-02) Kullanıcı: "epic oluştur ve başla". #3 groundwork#2'den bu epic'e taşındı; Sprint 2'ye eklendi (Sprint 1 işleri bitti, kapasite boş)

## Notlar / engeller
- ANSWERED: (K) (kullanıcı, 2026-10-03) Eklentiye isim → araştırıldı, aşağıda: VS Code eklentisi olarak "cool" bir ad (öneriler: Redline, Signoff, Margin, Footprint, Nod). Seçilince Marketplace çakışması kontrol edilir
- DONE: (C) İsim araştırması (kullanıcı, 2026-10-03: "internetten araştır, iyice bak"): benzer araçların adları, isim kalıpları, aday listesi + Marketplace / npm / GitHub çakışma kontrolü
- NOTE: İsim taraması (2026-10-03, VS Code Marketplace API + Open VSX + npm + GitHub). Dolu: Redline (5 eklenti, 4'ü AI/Markdown inceleme: Claude Code Redline, Redline-Review, Redline Mark, Redline — Markdown Comments), Agent Review, Footprint, Marginalia, Galley, Wake, Caret, Nod, Ghost. Boş (Marketplace): Tidemark (npm boş), Diffmark (npm boş), Blue Pencil (npm boş), Proofmark (npm'de küçük paket), Imprimatur, Signoff
- ANSWERED: (K) İsim seçimi → Imprimatur (kullanıcı, 2026-10-03) → [#10](../10/TODO.md)
- NOTE: (kullanıcı, 2026-10-03) "Imprimatur ile ilgili issue'lar ve todos history de oraya gitsin" → #3–#10 (epic #2 dahil) halilural/imprimatur'da yeniden açılır (private → public aktarım yok), todos/25–33 + test dokümanları oraya taşınır; groundwork'te ne kalacağı (silme / kapatıp bağlantı) kullanıcıya sorulur
