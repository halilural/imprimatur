# #4 · chore: agent-review bu makinede bütün repolarda (global hook + gitignore)

[#4](https://github.com/halilural/imprimatur/issues/4) · Part of [#2](../2/TODO.md) · Sprint 2

## Durum

Sürüyor — 2026-10-02

## Yapılacaklar

- DONE: (C) VS Code eklentisi zaten makine genelinde: `~/.vscode-server/extensions/halilural.agent-review-0.2.0` her pencerede yüklenir — 2026-10-02
- DONE: (C) 1. `~/.claude/settings.json`: PreToolUse `Edit|Write` → `node ~/…/hooks/baseline.mjs md mdx` (yedek alındı; mevcut SessionStart hook'u korundu) — 2026-10-02
- DONE: (C) 2. Global gitignore `~/.config/git/ignore`: `.claude/review-baseline/` — 2026-10-02
- DONE: (C) 3. Ölç: dirtywork ve interview'da bir MD için hook kopya alıyor mu, `git status` temiz kalıyor mu; groundwork'te çift hook (proje + global) zararsız mı → hook elle çalıştırıldı: dirtywork (`.claude/skills/deploy/SKILL.md`) ve interview (`.claude/rules/coding-modules.md`) için exit 0, kopya birebir, `git status`'ta görünmüyor (global ignore); deneme kopyaları silindi. groundwork'te proje + global hook ikisi de koşar: ilki kopyayı alır, ikincisi aynı içeriği yazar ya da korur, zararsız — 2026-10-02
- ANSWERED: (kullanıcı sordu, 2026-10-02) "Interview reposuna da kurdun mu?" → evet, makine geneli: interview'un kendi dosyalarına bir şey yazılmadı, hook ve ignore orada da geçerli; ölçüm DONE 3'te (interview `.claude/rules/coding-modules.md`); interview penceresi 12:10'dan beri açık, eklenti için Reload Window gerekli
- ANSWERED: (kullanıcı sordu, 2026-10-02) "Extension'ı nereden göreceğim, adı ne?" → "Agent Review" (halilural.agent-review 0.2.0); Extensions panelinde (Ctrl+Shift+X) "Agent Review" araması ya da `@installed agent`; komutlar Ctrl+Shift+P → "Agent Review"; durum çubuğunda "N agent changes"
- NOTE: (2026-10-02) Kullanıcının ekran görüntüsü 8 (interview): eklenti interview'da çalışıyor (kelime farkı, yeşil, soluk katman) → kurulum interview'da doğrulandı; yeni istek [#5](../5/TODO.md) (git'ten bağımsız)
- 👉 TODO: (K) 4. dirtywork / interview penceresinde Reload Window, Claude bir MD değiştirince renkler

## Sorular (kullanıcıya)

## Kararlar

- DECISION: (2026-10-02) Kullanıcı: "bu laptopta global olsun; dirtywork, interview felan". Repo başına ayar yerine makine geneli: tek hook satırı + global gitignore; yeni repolar da kendiliğinden alır. Bedel: hook groundwork'teki modülün yoluna bağlı; modül taşınırsa yol güncellenir

## Notlar / engeller

- NOTE: (2026-10-02) dirtywork ve interview Claude'a takip dosyalarını her mesajda commit'letiyor; commit'lenen MD'nin renkleri hemen kalkar (tasarım gereği). Renkler commit'lenmeden duran MD değişikliklerinde görünür
