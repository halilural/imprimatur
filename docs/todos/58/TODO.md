# #58 · Imprimatur MCP sunucusu: ajanlar kayıtları buradan okur ve yazar

[#58](https://github.com/halilural/imprimatur/issues/58) · Epic [#53](../53/TODO.md)

## Durum

Bitti — 2026-10-09 (main'e birleşti; panelde görme #60'ta, ajan kuralları #59'da)

## Yapılacaklar

- DONE: (C) `mcp/server.mjs`: bağımlılıksız stdio, iki protokol dönemi (2026-07-28 `server/discover` + eski `initialize`), 8 araç
- DONE: (C) `vscode/db.js`: `taskByKey`, `whereWeLeftOff`, `search` (LIKE kaçışlı, isimli parametre)
- DONE: (C) `hooks/mcp-session.mjs`: PreToolUse `mcp__imprimatur__.*` → `_session` + `allow`
- DONE: (C) `scripts/setup.mjs`: hook + Claude Code (`claude mcp add -s user`), Cursor, Codex kaydı; bu makinede kuruldu, `claude mcp get imprimatur` → Connected
- DONE: (C) `test/mcp.test.mjs`: gerçek stdio oturumu, iki el sıkışma, her araç, hatalar, repo seçimi, hook, Cursor/Codex birleştirme; 163/163
- DONE: (C) Uçtan uca: `claude -p --model haiku`, geçici veritabanı: tek turda görev + madde + DONE, sürüm satırlarında `claude-code:<oturum>`
- DONE: (C) README, ARCHITECTURE «MCP sunucusu»; issue'lar: panel ölçütü #60'a, dev-workflow v3 #59'a
- DONE: (C) İnceleme (8 bulgu): boşluklu/Türkçe yolda sunucu hiç başlamıyordu (`fileURLToPath`), açılamayan veritabanında sunucu ölmüyor, araç nedenini söylüyor; argüman denetimi (id, boş anahtar, `limit` 1..100, `arguments: null`); JSON-RPC çerçeveleme (-32600, istemci yanıtına cevap yok, batch); Codex: tırnaklı başlık, çok satırlı dizi/string, CRLF, dağınık alt tablo; setup'ta bir istemcinin hatası ötekileri durdurmuyor, Claude'da eski kayıt geri konur; 168/168
- 👉 TODO: (K) İş makinesinde pull + `npm run setup -- --lang Turkish` (MCP sunucusunu da kaydeder; Node ≥ 22.13 gerekir)

## Sorular (kullanıcıya)

## Notlar / engeller

- NOTE: (2026-10-09) Bu makinede Cursor ve Codex kurulu değil (`~/.cursor`, `~/.codex` yok): kayıtları birim testli, gerçek istemcide denenmedi.
- NOTE: (2026-10-09) Claude Code MCP sunucusuna oturum kimliği vermiyor (belgelenmemiş); hook'un `updatedInput`'u MCP araçlarında çalışıyor (uçtan uca denendi).

## Kararlar

- DECISION: (2026-10-09) Az, genel araç (~8), tür başına araç değil (kullanıcı; bağlam bütçesi #29)
- DECISION: (2026-10-09) "Waiting on you ve panel anında görüyor" #60'a taşındı (kullanıcı)
- DECISION: (2026-10-09) dev-workflow v3 #59'dan sonra: aktarma bitmeden kurala geçilirse kayıtlar iki yere bölünür (kullanıcı)
- DECISION: (2026-10-09) SDK yok, elle stdio JSON-RPC: hook'lar gibi repodan koşar, iş makinesinde `npm install` adımı yok
- DECISION: (2026-10-09) Hook Imprimatur araçlarını izin sormadan çalıştırır (`allow`): yalnız Imprimatur'un veritabanına dokunurlar
