# #53 · Epic: Geliştirme süreci Imprimatur'da

[#53](https://github.com/halilural/imprimatur/issues/53)

## Durum

Sürüyor (Sprint 2): yön değişti, kayıtların asıl kaynağı Imprimatur veritabanı; sıradaki #57 — 2026-10-09

## Yapılacaklar

- DONE: (C) [#54 Yerleşim: docs/todos/](https://github.com/halilural/imprimatur/issues/54) — imprimatur, groundwork, interview, twinread taşındı; kalanlar doğrudan veritabanına (#59)
- 👉 TODO: (C) [#57 Veritabanı: node:sqlite, cihaz bazlı, asıl kaynak](https://github.com/halilural/imprimatur/issues/57) — önce ARCHITECTURE.md hedef hâl
- TODO: (C) [#58 Imprimatur MCP sunucusu](https://github.com/halilural/imprimatur/issues/58)
- TODO: (C) [#59 Markdown kayıtlarını aktar, sonra kaldır](https://github.com/halilural/imprimatur/issues/59)
- TODO: (C) [#60 Kayıt görünümleri](https://github.com/halilural/imprimatur/issues/60) — Sprint 3
- TODO: (C) [#55 Grafikte ajanın her işi](https://github.com/halilural/imprimatur/issues/55) — Sprint 3, kayıt değişiklikleri Accept'siz
- TODO: (C) [#56 Süreç hook'ları Imprimatur'a](https://github.com/halilural/imprimatur/issues/56) — Sprint 3, veritabanından okur
- TODO: (C) [#61 Bulut desteği](https://github.com/halilural/imprimatur/issues/61) — Backlog
- TODO: (K) prepzio ve electron-mcp-server için karar (#54)

## Sorular (kullanıcıya)

## Notlar / engeller

- NOTE: (2026-10-09) Diğer repolar tarandı (dirtywork, groundwork, interview, investment, prepzio, twinread, radarly, rtmkit, groundwork-trials, electron-mcp-server). Süreç hook'ları 4 repoda kopya; interview'da main guard yok, tek-👉 kontrolü yalnız orada. CLAUDE.md'de yazan ama hook'u olmayan süreç kuralları #56'ya eklendi. todos/ altındaki TODO olmayan dosyalar (interview story'leri, twinread TEMPLATE.md) #54'e not edildi.

## Kararlar

- DECISION: (2026-10-09) Kullanıcı onayı: tek epic, altında yerleşim (#54), süreç hook'ları (#56) ve ajanın her işi (#55). #55 #2'yi genişletmek yerine burada; #2'nin eski maddeleri (#4–#10) #55'te gözden geçirilecek.
- DECISION: (2026-10-09) Hedef yol `docs/todos/`; README.md, CLAUDE.md, AGENTS.md, LICENSE kökte kalır.
- DECISION: (2026-10-09) Repoya özel kurallar (em dash, i-have-adhd, interview code-guard, investment onay kapıları, migration, deploy) #56 kapsamı dışında, repoda kalır.
- DECISION: (2026-10-09) Kullanıcı: "architecture design recordlar, product design recordlar, ve todolar, questionlar, decisionlar artık ne varsa bunların hepsi Imprimatur db'de". Asıl kaynak veritabanı (node:sqlite, araştırma: VS Code 1.141 / Node 24.21'de bayraksız, WAL + busy_timeout ile 12 eşzamanlı yazıcı hatasız).
- DECISION: (2026-10-09) Ajan yazma yolu: Imprimatur MCP sunucusu (#58).
- DECISION: (2026-10-09) Veritabanı cihaz bazlı; bulut desteği ayrı iş (#61).
- DECISION: (2026-10-09) Agent Change Graph'te kayıt değişiklikleri Accept edilmez (#55).
- DECISION: (2026-10-09) Markdown tamamen kalkar, üretilen görünüm yok. README.md, CLAUDE.md, AGENTS.md, .claude/rules ve skill'ler araç yapılandırması olarak dosyada kalır (varsayım, kullanıcıya bildirildi).
