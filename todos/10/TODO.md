# #10 · feat: agent-review eklentisinin adı Imprimatur

[#10](https://github.com/halilural/imprimatur/issues/10) · Part of [#2](../2/TODO.md) · Sprint 2

## Durum

Sürüyor — 2026-10-03

## Yapılacaklar

- DONE: (C) 1. `ARCHITECTURE.md` hedef hâl: eklenti adı Imprimatur (kimlik `halilural.imprimatur`, komut/ayar/renk öneki `imprimatur.`, eski `agentReview.*` ayarları okunmaya devam eder)
- DONE: (C) 2. `package.json`: name, displayName, description, komutlar, ayarlar, renkler; `extension.js`: komut/ayar/renk kimlikleri, URI, çıktı kanalı adı
- DONE: (C) 3. README başlığı ve kurulum metni; testler 61/61; ARCHITECTURE ve MT-AR test adımlarında komut/ayar adları — 2026-10-03
- DONE: (C) 4. 0.18.0 paketlendi ve kuruldu (`halilural.imprimatur`), `halilural.agent-review` kaldırıldı, makine ayarı `imprimatur.showIn: both`, `imprimatur.editorAlsoFor` (yedek scratchpad'de) — 2026-10-03. Paketle, kur; eski `halilural.agent-review` eklentisini kaldır (iki kopya çakışır); makine ayarlarını `imprimatur.*`'a taşı
- DONE: (C) 5a. Repodaki ad da Imprimatur (kullanıcı, 2026-10-03: "repodaki adı agent review değil imprimatur olsun"): `modules/imprimatur/` → `modules/imprimatur/`, paket adı, veri klasörü `.claude/agent-review/` → `.claude/imprimatur/` (groundwork, dirtywork, interview'daki veri taşınır), hook yolları (proje + global ayar), git ignore, CSS sınıfları `imprimatur-*`, `docs/testing/imprimatur*.md` → `imprimatur*.md`, ARCHITECTURE bölümü, CLAUDE.md
- NOTE: (2026-10-03) 5a yapıldı: klasör `modules/imprimatur/`, `docs/testing/imprimatur.md` + `imprimatur-sandbox.md` (sandbox taban metne döndü), veri `.claude/imprimatur/` (groundwork ve interview'da taşındı; dirtywork'te veri yoktu), global hook yolu ve `~/.config/git/ignore` (yedek scratchpad'de), interview `.gitignore` satırı (interview'da commit'lenmedi), CSS sınıfları `imprimatur-*`. 61/61, hook testleri geçti, 0.18.1 kuruldu. Test kimlikleri MT-AR kaldı
- 👉 TODO: (K) 5. Reload Window (groundwork, dirtywork, interview) → Extensions'ta "Imprimatur"; Claude bir MD değiştirince işaretler ve ✓ Accept çalışıyor
- TODO: (C) 6. `ARCHITECTURE.md` son hâl eşleşmesi

## Sorular (kullanıcıya)

- ANSWERED: (K) (2026-10-03) Hepsi Imprimatur olsun (5a). Soru: Modül klasörü (`modules/imprimatur/`) ve veri klasörü (`.claude/agent-review/`) da Imprimatur olsun mu? Varsayılan: şimdilik kalır (hook yolları 3 repoda ve global ayarda; veri klasörü değişirse bekleyen incelemeler kaybolur)

## Kararlar

- DECISION: (2026-10-03) Ad Imprimatur (kullanıcı seçti; isim taraması [todos/26](../2/TODO.md)). İç CSS sınıfları da (5a) `imprimatur-*` olur: açık kaynakta tek ad

## Notlar / engeller
