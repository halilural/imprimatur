# #54 · Yerleşim: todos/ → docs/todos/, kök dokümanlar docs/'a

[#54](https://github.com/halilural/imprimatur/issues/54) · Epic [#53](../53/TODO.md)

## Durum

Sürüyor: Imprimatur iki yerleşimi okuyor, bu repo taşındı (0.33.0). Kalan: dev-workflow skill'i ve diğer repolar — 2026-10-09

## Yapılacaklar

- DONE: (C) `ARCHITECTURE.md`: «Görev klasörlerinin yeri» hedef hâl
- DONE: (C) `vscode/tasks.js`: `TODO_DIRS`, `todoFiles`, `todoOfKey` (iki yerleşim, yenisi önce), `taskOfFile` (graph.js'ten taşındı)
- DONE: (C) `graph.js` (şerit, başlık), `todo-done.js` (bitişle kapanış), `history.js` (`TODO: (K)` istekleri), `jiraBase` ortak yardımcıyı kullanıyor
- DONE: (C) `test/layout.test.mjs`: iki yerleşimde görev, TODO.md listesi, istekler, Jira adresi, bitişle kapanış; 146/146 yeşil
- DONE: (C) Bu repo: `git mv todos docs/todos`, TODO.md'lerdeki göreli bağlantılar (`../../docs/…` → `../../…`, `../../vscode|hooks` → `../../../…`), README, `.vscode/settings.json`
- DONE: (C) Sürüm 0.33.0, main'e birleştirildi, `npm run setup -- --lang Turkish` ile bu makinede kuruldu
- 👉 TODO: (K) Diğer repoların taşınma sırası (öneri: groundwork, investment, interview, dirtywork; sonra prepzio, twinread, radarly, electron-mcp-server)
- TODO: (C) dev-workflow skill'i: TODO.md yolu, Todo Tree `includeGlobs`, `ALLOWED_ON_MAIN` (`^docs/`), where-we-left-off grep'i, commit kapsamı `todos/N`, `todos/README.md` → `docs/todos/README.md`, eski repolar için taşıma adımı
- TODO: (C) Diğer repoları taşı (sıraya göre); interview story dosyaları ve `.claude/rules/stories.md` yolu, twinread `TEMPLATE.md`, prepzio `NOTES.local.md`, electron-mcp-server kök .md'leri
- TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish`

## Sorular (kullanıcıya)

## Notlar / engeller

- NOTE: (2026-10-09) Bu repoda kökte README dışında doküman yoktu; tasarım zaten `docs/design/`'da.
- NOTE: (2026-10-09) `imprimatur.editorAlsoFor` örneği `**/todos/**` `docs/todos/` için de eşleşir, değişmedi.

## Kararlar

- DECISION: (2026-10-09) Yol tek yerde (`TODO_DIRS`), yeni yerleşim önce; görev iki yerde birden varsa (taşıma ortasında) `docs/todos/` kazanır.
- DECISION: (2026-10-09) Kökte kalanlar: README.md, CLAUDE.md, AGENTS.md, LICENSE (ajanlar bunları kökte arar).
