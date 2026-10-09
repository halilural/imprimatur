# #3 · feat: Claude'un MD değişikliklerini editörde renkli göster (hook + VS Code eklentisi)

[#3](https://github.com/halilural/imprimatur/issues/3) · Part of [#2](../2/TODO.md) · Sprint 2 · priority:medium

## Durum

Bitti — 2026-10-02

## Yapılacaklar

- ANSWERED: (2026-10-02) Ne zaman: şimdi mi (Sprint 2'ye acil olmayan ek iş, plan sayfasına not), yoksa Sprint 3'te mi (10 Eki)? Accept tanımı ve ürün havuzu sorusu açık; cevap gelmezse varsayılanlar → kullanıcı: "epic oluştur ve başla": epic [#2](../2/TODO.md), Sprint 2'de şimdi; Accept ve havuz varsayılanla
- ANSWERED: (kullanıcı, 2026-10-02) "İnsanlar bunu nasıl yapıyor, fikir amatör olabilir, best practice'i var mı?" → 1. madde (hazır çözüm araştırması) öne alındı
- DONE: (C) 1a. Hazır çözüm araştırması (kaynaklar ana oturumda açıldı, 2026-10-02). Aynı desen var: (1) [claude-diff-review](https://github.com/Gorluxor/Claude-Code-Diff-Review) v0.8.x: PreToolUse'da orijinali shadow'a kopyalar, Stop'ta dosya başına VS Code native diff açar, hunk başına kabul/ret, ret Claude'u yeniden çalıştırır; baseline `round`/`session`; 1 yıldız, son push 2026-04-12. (2) [Claude Code VS Code eklentisi](https://code.claude.com/docs/en/vs-code): Manual modda düzenlemeden ÖNCE yan yana diff, "Accept/Reject this change" (v2.1.275+), checkpoint/rewind. (3) [VS Code ajan incelemesi](https://code.visualstudio.com/docs/agents/run/review-code-edits) (2026-09-30): satır içi Keep/Undo yalnız Copilot/yerleşik chat için. (4) [GitHuman](https://github.com/mcollina/githuman) ([yazı](https://adventures.nodeland.dev/archive/building-githuman-an-ai-coded-tool-for-reviewing/), 2026-01-27): incelemeyi stage alanına taşır, commit'ten önce web arayüzünde diff + yorum, yorum ajana döner
- NOTE: (2026-10-02) Sonuç: fikir amatör değil, best practice "inceleme commit'ten önce, stage = incelendi" (GitHuman) ve "orijinali hook'la kopyala, sonra diff" (claude-diff-review). Farkımız: ayrı diff penceresi değil editörün kendisinde satır içi renk, stage'lenene kadar kalıcı, MD/düzyazı odaklı. Ponytail: VS Code'un yerleşik "Open Changes" diff'i satır içi modda (`diffEditor.renderSideBySide: false`) index'e karşı kırmızı/yeşil gösteriyor, "Stage Selected Ranges" = Accept; kod sıfır. Eksikleri: kullanıcının kendi stage'lenmemiş düzenlemesi de görünür, untracked yeni dosya görünmez (`git add -N` çözer), renk ayrı sekmede
- ANSWERED: (kullanıcı, 2026-10-02) "Hayır, dış dünyada bu nasıl yapılıyor diyorum, dosya change management" → soru yalnız AI araçları değil, genel doküman değişiklik yönetimi (track changes, öneri modu, prose diff, docs-as-code incelemesi)
- DONE: (C) 1c. Genel doküman değişiklik yönetimi (kaynaklar ana oturumda açıldı, 2026-10-02). Üç aile: (1) **belgenin içinde izleme**: Word Track Changes / Google Docs Suggesting; ekleme renkli, silme kırmızı üstü çizili, değişiklik başına kabul/ret, "hepsini kabul" ([PCWorld](https://www.pcworld.com/article/606677/how-to-track-changes-in-google-docs.html)). (2) **düz metin karşılığı CriticMarkup** (`{++ ++}`, `{-- --}`, `{~~eski~>yeni~~}`): değişiklik dosyanın içine yazılır; [ChangeDown](https://github.com/hackerbara/changedown) (5★, 2026-05) bunu AI ajanlar için yapıyor: Claude Code plugin + MCP, politika hook'ları, VS Code'da kabul/ret, yazar başına renk, DOCX'e aktarım; [Critique Markup](https://github.com/xinbenlv/critique-markup-vscode-ext) (1★), [Editmarks](https://kitchingroup.cheme.cmu.edu/scimax_vscode/20-editmarks.html). (3) **docs-as-code**: git/PR diff; düzyazıda satır diff'i gürültülü, kelime diff'i (`git diff --word-diff`, dwdiff) önerilir; [Ink & Switch](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/04/) araştırması: en iyi çalışan "tam belgede yeşil ekleme + silineni hover'da göster" ve kenarda "minibar" (değişiklik yerleri)
- NOTE: (2026-10-02) Bizim tasarım = (1)'in kullanıcı deneyimi (Word gibi satır içi renk, kabul/ret) + (3)'ün depolaması (değişiklik dosyaya yazılmaz, baseline kopya + git stage = kabul). Ink & Switch'in bulduğuyla aynı: hover'da silinen, overview ruler = minibar. ChangeDown'dan farkı: dosyaya işaret yazmıyor, commit'e markup sızmıyor. Eksik olabilecek: satır değil kelime düzeyinde fark (düzyazıda daha okunur)
- NOTE: (2026-10-02) ChangeDown groundwork ürünü için rakip adayı (ajan değişikliğine gerekçe/tartışma kaydı dosyanın içinde)
- ANSWERED: (kullanıcı, 2026-10-02) "Kendi tasarımımız ile gidelim"; "kelime düzeyinde mi" sorusu anlaşılmadı → örnekle açıklandı
- ANSWERED: (2026-10-02) Değişen satırda fark satır düzeyinde mi (eski satırın tamamı sonda kırmızı), kelime düzeyinde mi (yalnız değişen kelimeler renkli)? Öneri: kelime düzeyi, LCS'yi bir de değişen satırın kelimelerine uygulamak ~20 satır → kullanıcı: "kelime düzeyinde olsun, ne değiştiyse"
- CANCELED: (C) 1b. Sıfır kodlu yolu dene: bir MD dosyasında Claude düzenlemesi → Open Changes satır içi → Stage Selected Ranges; eksik kalan gerçekten rahatsız ediyor mu (kullanıcıyla karar)
- DONE: (C) 2. [ARCHITECTURE.md · Modül: agent-review](../../design/ARCHITECTURE.md) hedef hâl; belgeler açıldı: Claude Code hooks (`MultiEdit` yok, `file_path` mutlak, PreToolUse zaman aşımında araç devam eder), `vscode.d.ts` `createFileSystemWatcher` (`.git` içi özyinelemesiz desenle izlenir) — 2026-10-02
- DONE: (C) 3. Hook [baseline.mjs](../../../hooks/baseline.mjs) (node, bağımlılıksız, her zaman exit 0) + `.gitignore` + `.claude/settings.json`; [MT-REPO-034](../../testing/imprimatur.md) 13/13, hook seti 34/34 — 2026-10-02
- DONE: (C) 4. Eklenti [modules/imprimatur/vscode/](../../../vscode/extension.js): satır LCS + değişen satırda kelime LCS (eski kelime önce), tema renkleri, hover, overview ruler, durum çubuğu, Accept / Accept all, `.git/index` izleme + temizlik; README (EN), MIT LICENSE, `npm test`, `npm run package` (vsce 4.0.0) — 2026-10-02
- DONE: (C) 5a. `.vsix` (6.5 KB) WSL'de kuruldu: `~/.vscode-server/extensions/halilural.agent-review-0.1.0` (VS Code 1.140, Node 24) — 2026-10-02
- DONE: (C) 5b-1. Canlı hook kopya aldı (todos/25/TODO.md, modules/imprimatur/README.md), kopya git-ignored — 2026-10-02
- TODO: (C) 5b-2. Reload Window sonrası exthost logunda hata yok mu; [MT-REPO-035](../../testing/imprimatur.md)
- NOTE: (2026-10-02) Demo düzenlemesi yanlışlıkla fix commit'ine girdi; commit düzeltildi (f7e7660), düzenleme yine stage'lenmemiş, kopya yeniden kuruldu. Eski 0.1.0 açık kaldıkça index değişince kopyayı silebilir (bulgu 1) → önce Reload Window
- NOTE: (2026-10-02) Kullanıcı Reload Window yaptı; 0.1.1 16:18'de etkinleşti. Kopya yine silinmişti: büyük olasılıkla eski 0.1.0 reload'dan önce (VS Code'un git yenilemesi index'i yazınca). Kopya yeniden kuruldu; 0.1.1 altında index değişince kalıyor mu ölçülüyor
- ANSWERED: (kullanıcı, 2026-10-02) "Geri changes'e aldığımda geri gelmiyor" → stage'lenince kopya siliniyordu, unstage edince karşılaştıracak kopya yok. Düzeltme: üç durum (`git status` XY): Y dolu → renkler; yalnız X dolu (stage'li, commit'siz) → kopya kalır, renkler gizlenir; temiz (commit'lendi) → kopya silinir. Kayıtta da yeniden hesap (unstage index'i değiştirir, kaydetme değiştirmez)
- DONE: (C) 6c. Unstage'de renkler geri geliyor: `reviewState` (stage'lenmemiş / stage'li / temiz), stage'li kopya gizlenir silinmez, kayıtta da yeniden hesap; test 18/18; 0.1.2 kuruldu; demo kopyası yeniden kuruldu. Modül README metni demo geri alınınca güncellenecek — 2026-10-02
- NOTE: (2026-10-02) İkinci reload: 0.1.2 16:23'te etkinleşti, logda hata yok, demo kopyası yerinde, README ` M`
- NOTE: (2026-10-02) Kullanıcının ekran görüntüsü (0.1.2): değişen kelime (eski "changed" kırmızı üstü çizili + "edited"), yeşil DEMO satırı, "⌫ 2 lines deleted" + hover'da silinen metin görünüyor → MT-REPO-035 adım 2 geçti
- ANSWERED: (kullanıcı, 2026-10-02) "Staged'a aldım, sonra bir change oldu (C1, C2, C3): C1'i görebilmem lazım" → hata: stage'lenince kopya gizleniyor; ajanın sonraki düzenlemesinde hook kopyayı stage'li hâle yeniliyor ama eklenti gizliliği yalnız index değişince/kaydedince yeniden hesaplıyor, ajanın diske yazması bunu tetiklemiyor → C1 görünmüyor. Düzeltme: kopya değişince ve dosya diskten yeniden yüklenince de durum yeniden hesaplanır; yeni değişiklik stage'li hâle göre gösterilir (git'in "stage'lenmemiş" tanımı)
- DONE: (C) 6d. Stage sonrası ajan düzenlemesi görünüyor: gizli (stage'li) kopya her çizimde yeniden denetlenir; senaryo testi (stage → hook → C1 → yalnız C1 eklenmiş) 19/19; 0.1.3 kuruldu — 2026-10-02
- NOTE: (2026-10-02) Üçüncü reload: 0.1.3 16:27'de etkin. Senaryo kurulumu Claude'da: README'yi kullanıcı yerine stage'ler (yalnız demo), sonra C1–C3 satırlarını Edit ile ekler
- ANSWERED: (kullanıcı, 2026-10-02) "Ben nasıl deneyeceğim?" → adım adım deneme yolu verildi (README'ye bak, stage/unstage, Accept komutu)
- NOTE: (2026-10-02) Kullanıcının ekran görüntüsü (0.1.3): stage'den sonra eklenen C1–C3 yeşil, önceki (stage'li) değişiklikler renksiz, durum çubuğu "1 agent change" (3 satır tek blok) → "stage sonrası yalnız yeni değişiklik" geçti
- DONE: (C) Demo düzenlemesi geri alındı, kopyası silindi; modül README'si stage/unstage davranışına göre güncellendi — 2026-10-02
- DONE: (C) Dal feat/25-agent-review → main ff-merge, push ([cf9c92d](https://github.com/halilural/groundwork/commit/cf9c92d)); pano In Review — 2026-10-02
- ANSWERED: (kullanıcı, 2026-10-02) "Nerede deneyeceğim?" → demo geri alındığı için denenecek değişiklik yoktu; Claude README'de yeni bir demo değişikliği yaptı, deneme yeri ve adımları verildi
- ANSWERED: (kullanıcı, 2026-10-02) "Ne yapacağım?" → adımlar tek tek, ekrandaki yerleriyle yeniden yazıldı
- NOTE: (2026-10-02) Kullanıcının ekran görüntüsü 4: yeni demo dosyasında 1–4. satırlar yeşil (yeni dosya = boş kopya) → adım 1 geçti; sıra stage/unstage'de
- ANSWERED: (kullanıcı, 2026-10-02) "Ne simgesi?" → Source Control simgesi tarif edildi (üç daire, çizgiyle bağlı; Ctrl+Shift+G); terminal yolu da verildi
- NOTE: (2026-10-02) Kullanıcının ekran görüntüsü 5: `git add docs/agent-review-demo.md` sonrası dosya Staged Changes'te (A), editörde yeşiller kalktı → stage adımı geçti; sıra unstage'de
- DONE: (K) 6. Kullanıcının ekran görüntüsü 6: `git restore --staged` sonrası yeşiller geri geldi → [MT-REPO-035](../../testing/imprimatur.md) DONE; demo dosyası ve kopyası silindi — 2026-10-02
- ANSWERED: (kullanıcı, 2026-10-02) "Ajan C1 yaptı stage oldu, C2 yaptı stage oldu, C3 yaptı stage oldu: böyle bir şey oluyor mu?" → bugünkü davranış: her stage sonrası kopya stage'li metne yenilenir, yalnız son tur görünür; C3 de stage'lenince hiçbir şey görünmez; sonra unstage edilirse yalnız C3 geri gelir (C1, C2 değil, onların kopyası yok). Stage'i ajan yapıyorsa kullanıcı hiçbirini görmez
- ANSWERED: (2026-10-02) Hangisi: (A) bugünkü gibi stage = incelendi, her tur ayrı; (B) kopya commit'e kadar sabit (ajandan önceki hâl), stage'lenen değişiklikler soluk renkte, yeni değişiklik parlak renkte, C1–C3 commit'e kadar görünür. Öneri: B (stage'i ajan yapsa bile kaybolmaz) → kullanıcı: B
- ANSWERED: (kullanıcı, 2026-10-02) "Nasıl yapacağım, adım adım söyle" → C1–C3 senaryosunu kendi gözüyle denemesi için adımlar; C1'i Claude hemen yaptı (docs/agent-review-demo.md, deneme sonrası silinir)
- NOTE: (2026-10-02) Senaryo: kullanıcı C1'i stage'ledi (A), "hallet" → Claude C2'yi ekliyor
- NOTE: (2026-10-02) Senaryo: C2 eklendi (AM, yalnız C2 eklenmiş satır); kullanıcı "C3 yap" → Claude C3'ü ekliyor
- NOTE: (2026-10-02) Senaryo bitti: C3 stage'lendi, sonra `git restore --staged` → dosya `??`, ölçüm: yalnız C3 eklenmiş satır (C1, C2 yok) = A'nın sınırı gösterildi. Demo dosyası ve kopyası silindi. A/B kararı kullanıcıda
- DONE: (C) 8. B, 0.2.0: hook kopyayı commit'e kadar tutar; `review()` (kopya→dosya farkı + index→dosya farkına giren satır = parlak, diğerleri soluk), iki dekorasyon katmanı, 4 yeni soluk renk, durum çubuğu "N agent changes (M new)", index önbelleği; testler 21/21 (C1, C2 stage'li + C3 → yalnız C3 parlak; unstage → üçü parlak), hook seti 34/34; 0.2.0 kuruldu; ARCHITECTURE/README/MT-REPO-035 güncel — 2026-10-02
- NOTE: (2026-10-02) Kullanıcı reload etti (0.2.0, 17:11), C1'i stage'ledi, "devam et" → Claude C2'yi ekler, demo için C2'yi stage'ler, C3'ü ekler
- DONE: (K) 9. 0.2.0 gözle (ekran 7): 1–4. satır soluk, C3 parlak, "1 agent change (1 new)" → [MT-REPO-035](../../testing/imprimatur.md) DONE; demo silindi — 2026-10-02
- NOTE: (2026-10-02) Soluk renk ekranda çok hafif; kullanıcı yorum yapmadı, kapanışta açık bırakıldı (#2)
- DONE: (K) Kapanış onayı: kullanıcı "kapat bunu"; kalanlar epic #2'da (Ö31, açık kaynak yayını); soluk renk sorusu cevapsız, açık kaynak öncesi bakılır — 2026-10-02
- DONE: (K) Kapanış onayı (bitenler / kalanlar listesi cevapta) — kullanımda doğrulandı (2026-10-05)
- CANCELED: (K) 6 (eski metin): bir MD değişikliğinde Source Control'de + (renkler kalkar) ve − (renkler geri gelir); renkler ve ilk iki adım geçti (ekran görüntüleri 2 ve 3) ([MT-REPO-035](../../testing/imprimatur.md)); demo düzenlemesi sonra geri alınır
- DONE: (C) 6b. Kod incelemesi (reviewer ajanı) 10 bulgu, hepsi düzeltildi: (1, yüksek) `git()` `.trim()` porcelain'in baştaki boşluğunu siliyordu → ` M` dosyaların kopyası temizlikte siliniyordu (demo kopyası gerçekten silindi, yeniden kuruldu); (2, yüksek) yolda boşluk/ASCII dışı harf varsa hook hiç çalışmıyordu (`pathToFileURL`); (3) hook kopyayı proje kökünde, eklenti git kökünde arıyordu → ikisi de git kökü; (4) Windows yol/büyük harf; (5) Accept 150 ms eski diff'le yanlış satırı yazabiliyordu → komutta taze diff; (6) git-ignored dosyanın kopyası her düzenlemede eziliyordu; (7) CRLF/LF; (8) büyük dosyada LCS sınırı; (9) hook ile temizlik yarışı → 5 sn'den genç kopya silinmez; (10) aynı repoda çok kök. Ortak git mantığı tek dosyada (`vscode/review-state.js`); testler 17/17; 0.1.1 kuruldu — 2026-10-02
- DONE: (C) 7. `ARCHITECTURE.md` son hâl: başlıktan "hedef hâl" kalktı, hook satırına git kökü eklendi, stage/unstage satırları yapılanla aynı; CLAUDE.md'ye akış satırı eklendi — 2026-10-02

## Sorular (kullanıcıya)

- QUESTION: (2026-10-02) Lisans MIT olsun mu? (varsayılan MIT)

- QUESTION: (2026-10-02) Bu yalnız bu reponun aracı mı, yoksa groundwork ürününe de özellik (Ö31, havuz) olarak mı girsin? Varsayılan: ikisi (repoda dogfood + havuza satır)
- QUESTION: (2026-10-02) Önce sıfır kodlu yol (yerleşik satır içi diff + stage) mı, yoksa doğrudan eklenti mi? Öneri: önce sıfır kod, eksik rahatsız ederse eklenti
- QUESTION: (2026-10-02) "Accept" ne yapsın? Varsayılan: imleçteki değişikliği kopyaya yazar (renk kalkar, git'e dokunmaz); "Accept all" kopyayı siler. Stage'lemek kullanıcının işi kalır

## Kararlar

- DECISION: (2026-10-02) B: kopya ajandan önceki hâlde commit'e kadar sabit; stage'li değişiklikler soluk, stage'lenmemiş (yeni) değişiklikler parlak; stage gizlemez. Gerekçe: C1–C3 turlarında önceki turlar kayboluyordu (kullanıcının denemesi), ajan stage'lese de kayıp olmasın

- DECISION: (2026-10-02) Kullanıcı: "bunu hep groundwork'te ayrı bir modül gibi düşünelim, her an çıkartılıp farklı bir repoya taşınacak gibi" → her şey tek klasörde `modules/imprimatur/` (hook, VS Code eklentisi, diff, testler, README, kurulum); repo yalnız dışarıdan bağlar (`.claude/settings.json` hook satırı, `.gitignore`, `scripts/test-hooks.sh` modülün testini çağırır). Modül repo yardımcılarını (`_json.sh` vb.) kullanmaz, kendi başına çalışır; klasörü kopyalamak taşımaya yeter
- DECISION: (2026-10-02) Kullanıcı: "farklı bir repoya taşınıp bağımsız olacak gibi, bunu open source'a açabilirim" → modül kendi başına bir proje: kendi `package.json`'ı, İngilizce README (açık kaynak okuru), LICENSE (varsayılan MIT), kendi testleri (`npm test`), groundwork'e özgü hiçbir yol/ad yok; groundwork onu yalnız kullanan ilk repo. İsim açık kaynak öncesi marketplace/npm'de kontrol edilir

- DECISION: (2026-10-02) Kelime düzeyi fark: eklenen/silinen satır satır düzeyinde; değişen satırda yalnız değişen kelimeler renkli, eski kelime yanında kırmızı üstü çizili (kullanıcı). Spec'teki "eski hal satır sonunda" bunun yerine geçer

- DECISION: (2026-10-02) Kendi tasarımımız (baseline kopya + editörde satır içi renk + stage = kabul); ChangeDown denenmez. Gerekçe: dosyaya markup yazmıyor, git akışıyla uyumlu

- DECISION: (2026-10-02) Epic #2, Sprint 2 (kullanıcı "başla"); ilk karar (epic groundwork#2, Sprint 3) geçersiz

## Notlar / engeller

- NOTE: (2026-10-02) Canlı deneme: bu satır Edit aracıyla eklendi; hook `.claude/review-baseline/todos/25/TODO.md`'yi almalı

- NOTE: (2026-10-02) İlk kod bu olursa [groundwork#2](https://github.com/halilural/groundwork/issues/2)'nin "ürün kodu gelince kalite kapısı" maddesi tetiklenir (eklentiye typecheck/lint)
