# #54 · Yerleşim: todos/ → docs/todos/, kök dokümanlar docs/'a

[#54](https://github.com/halilural/imprimatur/issues/54) · Epic [#53](../53/TODO.md)

## Durum

Sürüyor: Imprimatur iki yerleşimi okuyor; imprimatur, groundwork, interview, twinread taşındı; dev-workflow v2.5. Kalan: investment, dirtywork (açık oturumlar), prepzio, electron-mcp-server (karar) — 2026-10-09

## Yapılacaklar

- DONE: (C) `ARCHITECTURE.md`: «Görev klasörlerinin yeri» hedef hâl
- DONE: (C) `vscode/tasks.js`: `TODO_DIRS`, `todoFiles`, `todoOfKey` (iki yerleşim, yenisi önce), `taskOfFile` (graph.js'ten taşındı)
- DONE: (C) `graph.js` (şerit, başlık), `todo-done.js` (bitişle kapanış), `history.js` (`TODO: (K)` istekleri), `jiraBase` ortak yardımcıyı kullanıyor
- DONE: (C) `test/layout.test.mjs`: iki yerleşimde görev, TODO.md listesi, istekler, Jira adresi, bitişle kapanış; 146/146 yeşil
- DONE: (C) Bu repo: `git mv todos docs/todos`, TODO.md'lerdeki göreli bağlantılar (`../../docs/…` → `../../…`, `../../vscode|hooks` → `../../../…`), README, `.vscode/settings.json`
- DONE: (C) Sürüm 0.33.0, main'e birleştirildi, `npm run setup -- --lang Turkish` ile bu makinede kuruldu
- 👉 TODO: (K) Diğer repoların taşınma sırası (öneri: groundwork, investment, interview, dirtywork; sonra prepzio, twinread, radarly, electron-mcp-server)
- DONE: (C) dev-workflow skill'i v2.5 (`~/.claude/skills/dev-workflow/SKILL.md`, git'te değil): 22 yol `docs/todos/`'a, `ALLOWED_ON_MAIN` ve pre-commit `^docs/`, TODO.md'den test linki `../../testing/…`; bölüm 0'da "önce yerleşim", yeni bölüm 14: kökte kalanlar + eski repoyu taşıma adımları (bağlantılar, CLAUDE.md, rules `paths:`, hook'lar, Todo Tree, grep kontrolü) — 2026-10-09
- DONE: (C) groundwork taşındı: [groundwork#35](https://github.com/halilural/groundwork/issues/35), 7bde35f; hook'lar, pre-commit, docs-toc (`docs/todos/` atlanır), Todo Tree; hook testleri 33/33 — 2026-10-09
- DONE: (C) interview taşındı: [interview#224](https://github.com/halilural/interview/issues/224), 6c13a4b; story dosyaları, `.claude/rules/stories.md` `paths:`, hook'lar, docs-toc; hook testleri yeşil — 2026-10-09
- DONE: (C) twinread taşındı: 474e677 (Linear, issue yok); `TEMPLATE.md`, 14 BLUEPRINT linki, CLAUDE.md, Todo Tree — 2026-10-09
- TODO: (C) investment ve dirtywork: açık Claude oturumları var (investment'ta biri çalışıyor, dirtywork feature dalında + 8 commit'lenmemiş dosya); oturumlar kapanınca taşı
- TODO: (K) prepzio organizasyon reposu (`prepzio/prepzio`): taşıma ekibe sorulsun mu; `NOTES.local.md` git-ignored, kalır
- TODO: (K) electron-mcp-server: `todos/` yok; 5 kök .md (`ISSUE_TEMPLATE.md`, `MCP_USAGE_GUIDE.md`, `REACT_COMPATIBILITY_ISSUES.md`, `SECURITY.md`, `SECURITY_CONFIG.md`) `docs/`'a taşınsın mı
- NOTE: (2026-10-09) radarly: `todos/` ve ek kök .md yok, taşınacak bir şey yok
- TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Sorular (kullanıcıya)

## Notlar / engeller

- NOTE: (2026-10-09) Bu repoda kökte README dışında doküman yoktu; tasarım zaten `docs/design/`'da.
- NOTE: (2026-10-09) `imprimatur.editorAlsoFor` örneği `**/todos/**` `docs/todos/` için de eşleşir, değişmedi.

## Kararlar

- DECISION: (2026-10-09) Yol tek yerde (`TODO_DIRS`), yeni yerleşim önce; görev iki yerde birden varsa (taşıma ortasında) `docs/todos/` kazanır.
- DECISION: (2026-10-09) Kökte kalanlar: README.md, CLAUDE.md, AGENTS.md, LICENSE (ajanlar bunları kökte arar).
