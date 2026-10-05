# #11 · feat: Waiting on you — ajanın kullanıcıdan beklediklerini hook ile tut, Graph'ta ayrı sekme

[#11](https://github.com/halilural/imprimatur/issues/11) · Part of [#2](../2/TODO.md)

## Durum

Sürüyor: elle test (MT-AR-024) — 2026-10-05

## Yapılacaklar

- DONE: (C) 1. `hooks/waiting.mjs`: AskUserQuestion, PermissionRequest, Stop, Notification → `.claude/imprimatur/waiting/<oturum>.jsonl`; UserPromptSubmit ve PostToolUse AskUserQuestion cevap olarak; test
- DONE: (C) 2. `waitingItems()` saf fonksiyon: olaylar → maddeler (açık/cevaplandı, cevap metni); test
- DONE: (C) 3. Graph paneli: Edits | Waiting on you (N) sekmeleri, ortak filtre, "cevaplananları göster", tıklayınca tam metin
- DONE: (C) 4. `~/.claude/settings.json`'a hook (yedekli), paket + kurulum, README, ARCHITECTURE, MT testi
- DONE: (C) 6. Kullanıcı geri bildirimi (2026-10-05): durum rozetleri + Accept düğmesi, kalıcı ve kaydırılır hover, durum çubuğunda Agent Graph, sağ tık (Accept / Open diff / Mark as done / Copy), "What you need to do" listesi; açıklama `message.id` ile; çift soru kaydı ve geçmiş zaman gürültüsü düzeltildi — 0.20.0, 73/73
- 👉 TODO: (K) 5. Gözle → MT-AR-024: bir soru, bir komut izni, bir "kontrol et" isteği sekmede görünüyor, cevaplayınca "answered"

## Sorular (kullanıcıya)

## Kararlar

- DECISION: (2026-10-05) Kullanıcı: "kullanıcıdan input beklediği her şey diyelim şimdilik; gürültü olursa ben followup öneririm". Görünüm: ayrı sekme. Hook ile, Graph içinde, filtreyle tek yerden.
- DECISION: (2026-10-05) Bir oturumdaki her yeni olay, o oturumda daha önce açık kalan maddeleri kapatır (izin verildiyse ya da reddedildiyse ajan devam etmiştir); UserPromptSubmit ve AskUserQuestion cevabı metni maddeye yazılır. Notification `permission_prompt` ve `idle_prompt` alınmaz: PermissionRequest ve Stop ile aynı şeyi söylerler.

## Notlar / engeller

- NOTE: (2026-10-05) Hook girdileri belgeden (code.claude.com/docs/en/hooks): Stop `last_assistant_message`, PermissionRequest `tool_name`/`tool_input`, Notification `notification_type`/`message`. UserPromptSubmit alanı `prompt` ya da `prompt_text` olabilir; ikisi de okunur.
- NOTE: (2026-10-05) Uygulandı 0.19.0: `hooks/waiting.mjs` (asksIn, recordOf, recordWaiting), `vscode/waiting.js` (itemsOf, waitingItems), Graph'ta iki sekme; testler 69/69; paket + kurulum; `~/.claude/settings.json`'a 6 hook girdisi (yedek `settings.json.bak-2026-10-05-waiting`); `waiting/` değişince yalnız Graph yenilenir. Hook çalışma ağacındaki dosyayı çalıştırır: bu dal birleşmeden `main`'e geçilirse `waiting.mjs` yok olur ve hook hata yazar (aracı engellemez).
