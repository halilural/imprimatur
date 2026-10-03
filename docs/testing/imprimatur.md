# imprimatur · elle testler

[halilural/imprimatur](https://github.com/halilural/imprimatur) (#3, #4, #5):
ajanın MD dosyalarındaki değişiklikleri, kabul edilene kadar editörde renkli
gösteren VS Code eklentisi + Claude Code hook'u. Otomatik testler (hook, fark
hesabı) [repo.md · MT-REPO-034](repo.md#mt-repo-034--modülün-test-seti-geçer-hook--diff);
burada yalnız gözle bakılması gerekenler.

<!-- toc -->

İçindekiler:

- [Başlamadan](#başlamadan)
- [Kurulum](#kurulum)
  - [MT-AR-001 · Eklenti kurulu ve açık](#mt-ar-001--eklenti-kurulu-ve-açık)
  - [MT-AR-002 · Temiz başlangıç](#mt-ar-002--temiz-başlangıç)
- [Değişikliklerin görünümü](#değişikliklerin-görünümü)
  - [MT-AR-003 · Tek kelime değişince yalnız o kelime işaretlenir](#mt-ar-003--tek-kelime-değişince-yalnız-o-kelime-işaretlenir)
  - [MT-AR-004 · Birden çok kelime değişince cümle bütün olarak](#mt-ar-004--birden-çok-kelime-değişince-cümle-bütün-olarak)
  - [MT-AR-005 · Eklenen satır yeşil, silinen satır işaretli](#mt-ar-005--eklenen-satır-yeşil-silinen-satır-işaretli)
  - [MT-AR-006 · Önceki ve son düzenleme aynı görünür (0.12.0)](#mt-ar-006--önceki-ve-son-düzenleme-aynı-görünür-0120)
  - [MT-AR-007 · Kaydırma çubuğunda işaretler](#mt-ar-007--kaydırma-çubuğunda-işaretler)
  - [MT-AR-012 · Önizlemede de görünür](#mt-ar-012--önizlemede-de-görünür)
- [Kalıcılık ve kabul](#kalıcılık-ve-kabul)
  - [MT-AR-008 · Stage ve commit renklere dokunmaz](#mt-ar-008--stage-ve-commit-renklere-dokunmaz)
  - [MT-AR-009 · Accept imleçteki değişikliği kabul eder](#mt-ar-009--accept-imleçteki-değişikliği-kabul-eder)
  - [MT-AR-010 · Accept all hepsini kaldırır, tarihçe kalır](#mt-ar-010--accept-all-hepsini-kaldırır-tarihçe-kalır)
  - [MT-AR-013 · Tarihçe düğmesi: ajan düzenlemeleri commit listesi gibi](#mt-ar-013--tarihçe-düğmesi-ajan-düzenlemeleri-commit-listesi-gibi)
  - [MT-AR-014 · Agent Change Graph paneli](#mt-ar-014--agent-change-graph-paneli)
  - [MT-AR-015 · Blok blok Accept ve okunur eski metin](#mt-ar-015--blok-blok-accept-ve-okunur-eski-metin)
  - [MT-AR-016 · Fark sekmesinde (Working Tree) imprimatur kapalı](#mt-ar-016--fark-sekmesinde-working-tree-imprimatur-kapalı)
  - [MT-AR-017 · Ajan değişikliğinden sonra kendiliğinden yenilenir](#mt-ar-017--ajan-değişikliğinden-sonra-kendiliğinden-yenilenir)
  - [MT-AR-018 · Varsayılan: işaretler yalnız önizlemede](#mt-ar-018--varsayılan-işaretler-yalnız-önizlemede)
  - [MT-AR-019 · Önizlemede sağ kenar işaret şeridi](#mt-ar-019--önizlemede-sağ-kenar-işaret-şeridi)
  - [MT-AR-020 · Mermaid diyagramları ajan değişikliğinden sonra da çizilir (varsayılan: imprimatur Mermaid bloğuna dokunmaz)](#mt-ar-020--mermaid-diyagramları-ajan-değişikliğinden-sonra-da-çizilir-varsayılan-imprimatur-mermaid-bloğuna-dokunmaz)
  - [MT-AR-021 · Mermaid diyagram farkı (ayar imprimatur.mermaidDiff açıkken)](#mt-ar-021--mermaid-diyagram-farkı-ayar-imprimaturmermaiddiff-açıkken)
  - [MT-AR-022 · todos/ altındaki dosyalarda önizleme ve kaynak birlikte](#mt-ar-022--todos-altındaki-dosyalarda-önizleme-ve-kaynak-birlikte)
  - [MT-AR-023 · Yeni blok tek Accept, değişen hücre tek satır](#mt-ar-023--yeni-blok-tek-accept-değişen-hücre-tek-satır)
- [Başka repolar](#başka-repolar)
  - [MT-AR-011 · dirtywork ve interview'da da çalışır](#mt-ar-011--dirtywork-ve-interviewda-da-çalışır)
- [Bitiş](#bitiş)

<!-- tocstop -->

## Başlamadan

- Deneme dosyası: [imprimatur-sandbox.md](imprimatur-sandbox.md). Testlerde
  Claude bu dosyayı değiştirir; sen yalnız bakarsın.
- Claude'a yazılacak cümleler `>` ile verildi; sağdaki Claude Code paneline
  aynen yapıştır.
- Komut paleti: `Ctrl+Shift+P`. Durum çubuğu: pencerenin en altındaki şerit,
  sol tarafı.
- Testler sırayla koşulur; her biri bir öncekinin bıraktığı yerden başlar.

## Kurulum

### MT-AR-001 · Eklenti kurulu ve açık

- Önkoşul: yok.
- Adımlar:
  1. `Ctrl+Shift+P` → **Developer: Reload Window**.
  2. `Ctrl+Shift+X` (Extensions paneli).
  3. Arama kutusuna `@installed agent review` yaz.
- Beklenen: listede **Imprimatur**, sürüm **0.18.0** ya da üstü, devre dışı değil.
- TODO: MT-AR-001

### MT-AR-002 · Temiz başlangıç

- Önkoşul: MT-AR-001.
- Adımlar:
  1. `imprimatur-sandbox.md`'yi aç.
  2. `Ctrl+Shift+P` → **Imprimatur: Accept All Agent Changes in File**.
- Beklenen: dosyada hiç renk yok; durum çubuğunda "agent change" yazısı yok.
- TODO: MT-AR-002

## Değişikliklerin görünümü

### MT-AR-003 · Tek kelime değişince yalnız o kelime işaretlenir

- Önkoşul: MT-AR-002.
- Adımlar:
  1. Claude'a yaz:
     > imprimatur-sandbox.md'de "cumartesi" kelimesini "pazartesi" yap, başka bir şeye dokunma.
  2. Dosyaya bak.
- Beklenen: "Sprint … başlar" satırında yalnız **pazartesi** vurgulu; hemen
  önünde **cumartesi** kırmızı ve üstü çizili. Satırın geri kalanı düz.
- DONE: MT-AR-003 · 0.3.0 · 2026-10-02 · kullanıcı (ekran 10) — geçti

### MT-AR-004 · Birden çok kelime değişince cümle bütün olarak

- Önkoşul: MT-AR-003.
- Adımlar:
  1. Claude'a yaz:
     > imprimatur-sandbox.md'de "Ajan bu satırı baştan yazacak" ile başlayan satırı tamamen farklı kelimelerle yeniden yaz.
  2. Dosyaya bak.
- Beklenen: editörde (`both` ya da `todos/` gibi `editorAlsoFor` yolu) eski cümle satırın üstünde "− …" olarak (CodeLens), yeni cümle altında vurgulu; önizlemede eski cümle kırmızı kutuda üstte. Kelime kelime karışık işaret yok.
- DONE: MT-AR-004 · 0.4.1 · 2026-10-02 · kullanıcı (ekran 13) — geçti: editörde eski cümle üstü çizili önce, yeni cümle ardından; önizlemede iki eski satır üstte

### MT-AR-005 · Eklenen satır yeşil, silinen satır işaretli

- Önkoşul: MT-AR-004.
- Adımlar:
  1. Claude'a yaz:
     > imprimatur-sandbox.md'de "Bu satır silinecek." satırını sil ve dosyanın sonuna "Yeni satır." ekle.
  2. Dosyaya bak.
  3. Fareyi kırmızı **⌫ 1 line deleted** yazısının üzerine getir.
- Beklenen: (2) "Yeni satır." yeşil arka planlı; silinen satırın yerinde, bir
  önceki satırın sonunda kırmızı **⌫ 1 line deleted**. (3) Açılan kutuda
  "Bu satır silinecek." yazar.
- DONE: MT-AR-005 · 0.4.1 · 2026-10-02 · kullanıcı (ekran 14) — geçti: "⌫ 1 line deleted" 8. satır sonunda, yeni satır yeşil; önizlemede silinen satır üstü çizili + yeni paragraf yeşil (hover ekran 2'de görülmüştü)

### MT-AR-006 · Önceki ve son düzenleme aynı görünür (0.12.0)

- Önkoşul: MT-AR-005.
- Adımlar:
  1. Claude'a yaz:
     > imprimatur-sandbox.md'nin sonuna "C3: en son değişiklik." satırını ekle.
  2. Dosyaya ve durum çubuğuna bak.
- Beklenen: "C3" satırı ve MT-AR-003…005'teki işaretler aynı renk ve belirginlikte; durum çubuğunda "N agent changes".
- DONE: MT-AR-006 · 0.4.1 · 2026-10-02 · kullanıcı (ekran 15) — geçti: C3 parlak, önceki işaretler soluk, önizlemede de (durum çubuğu görüntüde yok; "(N latest)" sayısı ölçümle: 2 değişiklik, 1 son)

### MT-AR-007 · Kaydırma çubuğunda işaretler

- Önkoşul: MT-AR-006.
- Adımlar:
  1. Editörün sağ kenarındaki kaydırma çubuğuna bak.
- Beklenen: değişen satırların hizasında sol kenarda renkli küçük işaretler.
- DONE: MT-AR-007 · 0.4.1 · 2026-10-02 · kullanıcı (ekran 15) — geçti: kaydırma çubuğunda değişen satırların hizasında işaretler

### MT-AR-012 · Önizlemede de görünür

- Önkoşul: MT-AR-006.
- Adımlar:
  1. Deneme dosyası açıkken sağ üstteki **Open Preview to the Side** düğmesine bas (ya da `Ctrl+K V`).
- Beklenen: değişen paragrafın hemen üstünde eski hâli kırmızı ve üstü çizili;
  değişen paragraf mavi kenarlı, eklenen paragraf yeşil kenarlı; silinen satır
  bulunduğu yerde üstü çizili. Son düzenleme belirgin, öncekiler soluk.
  Claude dosyayı yeniden değiştirince önizleme kendiliğinden yenilenir.
- DONE: MT-AR-012 · 0.4.1 · 2026-10-02 · kullanıcı (ekran 12) — geçti: eski cümle üstte kırmızı üstü çizili, paragraf mavi kenar + arka plan (0.4.0'da kalmıştı: parse belgesiz, #6)

## Kalıcılık ve kabul

### MT-AR-008 · Stage ve commit renklere dokunmaz

- Önkoşul: MT-AR-006.
- Adımlar:
  1. Terminalde (`` Ctrl+` ``): `git add docs/testing/imprimatur-sandbox.md`
  2. Dosyaya bak.
  3. `git restore --staged docs/testing/imprimatur-sandbox.md`
- Beklenen: (2) renkler aynen duruyor. Commit de renklere dokunmaz (otomatik
  testte ölçüldü; deneme dosyasını commit'lemek gerekmez).
- DONE: MT-AR-008 · 0.4.1 · 2026-10-02 · kullanıcı ("bunların hepsi oldu") — geçti: stage ve unstage sonrası renkler aynen durdu

### MT-AR-009 · Accept imleçteki değişikliği kabul eder

- Önkoşul: MT-AR-006.
- Adımlar:
  1. İmleci "C3" satırına koy.
  2. `Ctrl+Shift+P` → **Imprimatur: Accept Agent Change at Cursor**.
- Beklenen: yalnız "C3" satırının rengi kalkar; diğer işaretler durur, durum
  çubuğundaki sayı bir azalır.
- DONE: MT-AR-009 · 0.4.1 · 2026-10-02 · kullanıcı ("bunların hepsi oldu") — geçti: Accept at cursor C3 bloğunu kabul etti, diğerleri durdu

### MT-AR-010 · Accept all hepsini kaldırır, tarihçe kalır

- Önkoşul: MT-AR-009.
- Adımlar:
  1. `Ctrl+Shift+P` → **Imprimatur: Accept All Agent Changes in File**.
  2. Terminalde: `wc -l .claude/imprimatur/history/docs/testing/imprimatur-sandbox.md.jsonl`
- Beklenen: (1) dosyada hiç renk yok. (2) sayı 0'dan büyük: ajanın her
  düzenlemesi tarihçede (MT-AR-003…006 için en az 4 satır).
- DONE: MT-AR-010 · 0.4.1 · 2026-10-02 · kullanıcı ("bunların hepsi oldu") — geçti: Accept all renkleri kaldırdı, tarihçe dosyası duruyor

### MT-AR-013 · Tarihçe düğmesi: ajan düzenlemeleri commit listesi gibi

- Önkoşul: MT-AR-006 (deneme dosyasında birkaç ajan düzenlemesi).
- Adımlar:
  1. Deneme dosyası açıkken alttaki durum çubuğunda **$(history) N agent edits** düğmesine tıkla.
  2. Listeden en üstteki düzenlemeyi seç.
  3. Düğmeye yeniden tıkla, **All changes under review**'ı seç.
- Beklenen: (1) düzenlemeler yeniden eskiye: "#N saat", "Edit · +x −y". (2) fark penceresi: solda o düzenlemeden önce, sağda sonra. (3) ajanın ilk düzenlemesinden önceki kopya ↔ şimdiki dosya. Accept all sonrasında da düğme durur.
- TODO: MT-AR-013

### MT-AR-014 · Agent Change Graph paneli

- Önkoşul: MT-AR-013.
- Adımlar:
  1. Durum çubuğunda **N agent edits** → listenin en üstünde **Open Agent Change Graph** (ya da `Ctrl+Shift+P` → **Imprimatur: Open Agent Change Graph**).
  2. Claude'a yaz:
     > imprimatur-sandbox.md'de "Son paragraf." satırını "Son paragraf, graph testi." yap.
  3. Paneldeki en üst satıra tıkla.
  4. Süzgeç kutusuna `sandbox` yaz.
- Beklenen: (1) Git Graph gibi tablo: solda oturum başına renkli şerit ve nokta, Description, File, Date, Session, Changes. (2) panel kendiliğinden yenilenir, en üstte yeni satır, Description'da isteğin ilk satırı. (3) o düzenlemenin fark penceresi açılır. (4) yalnız deneme dosyasının satırları kalır.
- TODO: MT-AR-014

### MT-AR-015 · Blok blok Accept ve okunur eski metin

- Önkoşul: deneme dosyasında en az iki değişiklik bloğu (MT-AR-003…006).
- Adımlar:
  1. Editörde bir değişiklik bloğunun üstündeki **✓ Accept** yazısına tıkla.
  2. Önizlemeyi aç (`Ctrl+K V`), başka bir bloğun üstündeki **✓ Accept** düğmesine tıkla (ilk seferde VS Code "uzantıya izin ver" diye sorabilir).
  3. Üstü çizili eski metni oku.
- Beklenen: (1) yalnız o bloğun rengi kalkar, diğerleri durur. (2) ilk tıklamada "Allow 'Imprimatur' extension to open this URI?" çıkar (Do not ask again + Open); blok anında temizlenir (önizleme yeniden yüklenmez, zıplama yok) ve sıradaki işaretli bloğa yumuşakça kayar; editörde (`both`) ✓ Accept sonrası imleç sıradaki değişikliğe gider. (3) eski metin üstü çizgisiz, normal yazıyla kırmızı kutunun içinde; önizlemede liste işareti (`-`, `*`) ham görünmez.
- TODO: MT-AR-015

### MT-AR-016 · Fark sekmesinde (Working Tree) imprimatur kapalı

- Önkoşul: ajanın değiştirdiği, renkleri görünen bir MD dosyası.
- Adımlar:
  1. Source Control'de dosyaya tıkla (Working Tree farkı açılır).
  2. Normal sekmeye geri dön.
- Beklenen: (1) fark sekmesinde yalnız git'in kırmızı/yeşili; imprimatur renkleri, ✓ Accept ve durum çubuğu sayısı yok. (2) normal sekmede renkler geri.
- FIXME: MT-AR-016 · 0.7.1/0.7.2 · 2026-10-02 · kullanıcı (ekran 21, 22) — kaldı: fark sekmesinde ✓ Accept ve üstü çizili eski cümleler; 0.7.3'te düzeltildi, yeniden koşulacak

### MT-AR-017 · Ajan değişikliğinden sonra kendiliğinden yenilenir

- Önkoşul: deneme dosyası editörde açık ve yanında önizlemesi (`Ctrl+K V`).
- Adımlar:
  1. Claude'a yaz:
     > imprimatur-sandbox.md'nin sonuna "Yenileme testi." satırını ekle.
  2. Hiçbir şeye dokunmadan 2 saniye bekle.
- Beklenen: editörde yeni satır parlak yeşil, üstünde ✓ Accept; önizlemede yeni paragraf yeşil; durum çubuğu ve graph güncel. Dosyaya tıklamak, kaydetmek ya da sekme değiştirmek gerekmez.
- TODO: MT-AR-017

### MT-AR-018 · Varsayılan: işaretler yalnız önizlemede

- Önkoşul: ajanın değiştirdiği bir MD dosyası, ayar `imprimatur.showIn` değiştirilmemiş.
- Adımlar:
  1. Dosyayı editörde aç.
  2. Önizlemeyi aç (`Ctrl+K V`).
  3. `Ctrl+,` → `agent review` ara → **Show In**'i `both` yap.
- Beklenen: (1) editörde renk ve ✓ Accept yok; durum çubuğunda "N agent changes" var. (2) önizlemede işaretler ve ✓ Accept var. (3) editörde de işaretler belirir; `preview`'e dönünce kalkar.
- TODO: MT-AR-018

### MT-AR-019 · Önizlemede sağ kenar işaret şeridi

- Önkoşul: birkaç ajan değişikliği olan bir MD dosyasının önizlemesi.
- Adımlar:
  1. Önizlemenin sağ kenarına, kaydırma çubuğunun üstüne bak (editördeki kaydırma çubuğu işaretleri gibi).
  2. Aşağıdaki bir çentiğe tıkla.
- Beklenen: (1) her değişiklik için renkli çentik: eklenen yeşil, değişen mavi, eski/silinen kırmızı; önceki düzenlemeler soluk; konumları belgedeki yerleriyle orantılı. (2) önizleme o bloğa kayar.
- TODO: MT-AR-019

### MT-AR-020 · Mermaid diyagramları ajan değişikliğinden sonra da çizilir (varsayılan: imprimatur Mermaid bloğuna dokunmaz)

- Önkoşul: içinde Mermaid diyagramı olan bir MD dosyasının önizlemesi (ör. another repo's design doc).
- Adımlar:
  1. Claude'a diyagramın dışında bir satırı değiştirt.
  2. Önizlemede bir ✓ Accept'e tıkla.
- Beklenen: iki durumda da diyagramlar çizili kalır; elle yenileme gerekmez. Kalırsa: iki Mermaid eklentisinden biri kapatılıp yeniden denenir (Markdown Mermaid Zoom ile Mermaid Chart aynı diyagramı çiziyor).
- TODO: MT-AR-020

### MT-AR-021 · Mermaid diyagram farkı (ayar `imprimatur.mermaidDiff` açıkken)

- Önkoşul: `imprimatur.mermaidDiff: true`; Mermaid flowchart'ı olan bir MD dosyası (ör. another repo's design doc), önizlemesi açık.
- Adımlar:
  1. Claude'a diyagramda bir düğüm ekletip bir okun etiketini değiştirt ve bir oku sildir.
  2. Önizlemede diyagrama bak.
  3. Diyagramın üstündeki ✓ Accept'e tıkla.
- Beklenen: (2) diyagramın üstünde "Agent changes in this diagram: ■ added ■ changed ■ removed" satırı; yeni düğüm/ok yeşil kalın, etiketi değişen turuncu, silinen ok/düğüm kırmızı kesikli olarak duruyor; sağ kenarda turuncu çentik. (3) renkler kalkar. Dosyanın kendisi değişmez.
- TODO: MT-AR-021

### MT-AR-022 · todos/ altındaki dosyalarda önizleme ve kaynak birlikte

- Önkoşul: uzak makine ayarında `imprimatur.editorAlsoFor: ["**/todos/**"]`; ajanın değiştirdiği bir `todos/<n>/TODO.md`.
- Adımlar:
  1. TODO.md'yi editörde aç.
  2. Yanında önizlemeyi aç (`Ctrl+K V`).
  3. Aynı repoda `todos/` dışındaki bir MD dosyasını editörde aç.
- Beklenen: (1) editörde işaretler ve ✓ Accept. (2) önizlemede de işaretler. (3) `todos/` dışında editörde işaret yok (yalnız önizlemede).
- TODO: MT-AR-022

### MT-AR-023 · Yeni blok tek Accept, değişen hücre tek satır

- Önkoşul: `showIn: both`.
- Adımlar:
  1. Claude'a bir MD dosyasına yeni bir tablo, bir alıntı ve üç liste maddesi ekletip var olan bir tablonun bir hücresini değiştirt.
  2. Editörde ✓ Accept'lere bak.
- Beklenen: yeni tablonun (ya da var olan tabloya eklenen satırların) üstünde tek "✓ Accept N lines", alıntıda tek, her liste maddesinde ayrı; değişen hücrenin satırında kendi ✓ Accept'i. Önizlemede tablonun üstünde "✓ Accept table".
- TODO: MT-AR-023

## Başka repolar

### MT-AR-011 · dirtywork ve interview'da da çalışır

- Önkoşul: MT-AR-001; o reponun VS Code penceresinde **Developer: Reload Window**.
- Adımlar:
  1. O pencerede Claude'a yaz:
     > Bu repoda herhangi bir .md dosyasında tek bir kelimeyi değiştir.
  2. Değişen dosyayı aç.
- Beklenen: MT-AR-003'teki gibi kelime işareti; `git status`'ta
  `.claude/imprimatur/` görünmez.
- TODO: MT-AR-011

## Bitiş

Claude'a yaz:

> imprimatur-sandbox.md'yi git'teki hâline geri al.

Sonra MT-AR-002'yi bir kez daha yap (kopyayı temizler).

## Otomatik test seti ve ilk elle test (groundwork'ten)

Modül 2026-10-03'ten beri ayrı public repoda: [halilural/imprimatur](https://github.com/halilural/imprimatur) (#3, #2). Test seti orada (`npm test`); buradaki testler tarihçe.

### MT-REPO-034 · Modülün test seti geçer (hook + diff)

- Adımlar: `cd modules/imprimatur && node --test` (`scripts/test-hooks.sh` ve modül dosyası stage'lenince pre-commit koşar)
- Beklenen: 59/59 (`npm install` sonrası). Silinen numaralı madde: yalnız silme işaretlenir, yeniden numaralananlar değil. Önizlemede Accept: blok anında temizlenir, sıradaki değişikliğe kaydırılır, yeniden yükleme beklenmez. Silme + Accept bağlantısı render'ı (boş önizleme gerilemesi); işaretleme hatasında önizleme işaretsiz çizilir. Var olan tabloya eklenen satırlar tek Accept, listeye eklenen maddeler ayrı. Accept birimleri: satır sezgisi ve markdown-it blokları (her blok türü yeniyse tek birim, değişen hücre satırı tek, liste maddeleri ayrı); önizlemede tablo başına tek Accept. Bitişik liste maddeleri (tek parça): bir satır kabul edilince komşuları kalır. Mermaid: flowchart düğüm/ok ayrıştırma (linkStyle sırası, zincir oklar), eklenen/değişen/silinen renk satırları ve hayalet düğüm/ok, eski bloğu eşleme; önizlemede açıklama satırı, önbellekteki token değişmez. Satır düzeyinde accept: tek parça olan iki paragraftan biri kabul edilince öteki kalır; değişen satırlardan biri; yalnız o silme. Accept sonrası yenilemede sıradaki değişikliğe gidilir. Önizleme kaydırması: yenilemeden hemen sonra kaldığı yere döner, ilk açılışta dokunmaz. İşaret şeridi (sahte DOM): işaretli blok başına çentik, türüne göre renk, önceki soluk, tıklayınca kaydırma. Bash: python heredoc ile yapılan düzenleme Edit gibi kaydedilir, `cat` iz bırakmaz, bekleyen dosya silinir; komuttaki .md/.mdx yolları bulunur. Önizleme Accept: değişen blok başına bir düğme, bağlantı bloğun satır aralığını taşır; eski metin Markdown olarak, liste işaretsiz (biçimleyici yoksa kaçırılır). Kod blokları: çitli blok içindeki eklenen, değişen ve silinen satırlar işaretlenmez, yalnız düz metin. Graph: bütün dosyaların düzenlemeleri yeniden eskiye, oturum başına şerit; tarihçe satırı oturum dökümündeki son isteği taşır. Tarihçe: git log gibi yeniden eskiye, her düzenlemenin önce/sonrası ve +/− satır; paralel iki hook'un yazdığı aynı satır tek düzenleme sayılır. Önizleme (VS Code gibi: parse belgesiz, render `currentDocument`'lı; önbellekteki token'lar değişmez): değişen paragraf sınıf alır ve eski metni üstünde üstü çizili; eklenen başlık, silinen paragraf; önceki düzenleme soluk, son parlak; tablo satırı sınıf alır, tabloya div girmez; eski metin HTML'den kaçırılır; kopya yoksa çıktı aynı. Hook: ilk dokunuş kopyalar ve tarihçeye yazar (öncesi, oturum, araç); yeni dosyaya boş kopya; kopya stage ve commit'ten sonra da kalır, her düzenleme tarihçeye bir satır; başka uzantı ve proje dışı dosya atlanır, uzantı listesi argümandan; bozuk girdi aracı engellemez; hook iki kez kuruluysa (proje + kullanıcı) tarihçeye tek satır; git yoksa proje kökü; yolunda boşluk olan hook çalışır; C1–C3 arada commit'lense de üçü görünür, yalnız C3 (son düzenleme) parlak. Diff: aynı metin boş; eklenen satır; silinen blok önceki satıra; tek kelime değişince kelime işareti, birden çok kelimede eski cümle üstü çizili önce, yeni cümle sonra; kelime ekleme/silme; fazla yeni satır = değişen + eklenen; bütün parçalar kabul edilince yeni metin; CRLF ile LF eşit; boyut sınırı; son düzenleme parlak, öncekiler soluk.
- DONE: MT-REPO-034 · feat/25-agent-review · 2026-10-02 · Claude — geçti (61/61, 0.18.1 Imprimatur; hook testleri MT-REPO toplamı 34/34)
- CANCELED: MT-REPO-034 (2026-10-03) → modül [halilural/imprimatur](https://github.com/halilural/imprimatur)'a taşındı; `scripts/test-hooks.sh` ve pre-commit artık koşmaz

### MT-REPO-035 · Eklenti ajan değişikliklerini kabul edilene kadar gösterir: son düzenleme parlak, öncekiler soluk

- Önkoşul: `.vsix` kurulu ([halilural/imprimatur](https://github.com/halilural/imprimatur) `dist/`), VS Code yeniden yüklendi, hook (proje ya da `~/.claude/settings.json`).
- Adımlar: (1) Claude bir MD dosyasında tek kelime değiştirir, bir cümleyi baştan yazar, bir satır ekler, bir satır siler. (2) Dosyayı editörde aç. (3) Claude C1, C2, C3 ekler; arada stage'le ve commit'le. (4) Accept all.
- Beklenen: (2) tek kelime: yeni kelime vurgulu, eski kelime yanında kırmızı üstü çizili; baştan yazılmış cümle: eski cümle üstü çizili önce, yeni cümle vurgulu sonra; eklenen satır yeşil; silinen blok "⌫ N lines deleted" (hover'da metin); durum çubuğu "N agent changes (M latest)". (3) sonrası C1, C2 soluk, C3 parlak, commit renklere dokunmaz. (4) sonrası renkler kalkar; `.claude/imprimatur/history/` durur.
- DONE: MT-REPO-035 (0.1.3 ve 0.2.0 davranışı) · 2026-10-02 · kullanıcı (ekran 2, 3, 5, 6, 7) — geçti
- CANCELED: MT-REPO-035 (0.3.0) → elle testler adım adım [imprimatur.md](imprimatur.md) (MT-AR-001…011)
