# Tárgyaló – privát videókonferencia

Kilian (CEO) és Krisztián (programozó) saját meetingterme.

## Indítás

```bash
npm install     # csak első alkalommal
npm start
```

Ezután nyisd meg a böngészőben: http://localhost:3000

## Hogyan éri el Krisztián?

A kamera és a mikrofon a böngészőben csak **HTTPS-en** (vagy localhoston) működik, ezért kívülről egy HTTPS-alagúton keresztül érdemes megosztani:

```bash
brew install cloudflared                        # egyszer
cloudflared tunnel --url http://localhost:3000
```

A parancs kiír egy `https://valami.trycloudflare.com` címet. Ezt küldd el Krisztiánnak. A cím minden indításkor új lesz, az adatok viszont megmaradnak.

Ha ugyanazon a wifin vagytok, ez is megy, de ugyanúgy HTTPS kell hozzá. Ezért egyszerűbb mindig az alagutat használni.

## Funkciók

- **Regisztráció:** név, szerep (CEO / Programozó / SEO / egyéb), 4 jegyű kód, majd a kód megismétlése. Minden fiókhoz saját kód tartozik, és csak a hash-ük kerül mentésre. 5 rossz próbálkozás után a fiók 5 percre zárolódik.
- **Belépés:** kattints a nevedre, és írd be a kódod. A böngésző megjegyzi a munkamenetet.
- **Meetingek:** azonnali indítás vagy meghirdetés címmel, napirenddel, időponttal és hosszal. A meghívó link automatikusan a vágólapra kerül.
- **Élő jelzés:** a főoldalon látod, ki van online, és ki melyik hívásban ül. Ha a másik belép egy meetingbe, értesítést kapsz.
- **Hívás:** HD videó és hang, mikrofon némítása (`M`), kamera ki/be (`V`), képernyőmegosztás (`S`). Megosztás közben a képernyő kiemelt nézetbe kerül. A beszélő csempéje zölden világít.
- **Chat és fájlok:** üzenetek és fájlfeltöltés hívás közben, legfeljebb 1 GB-ig. Fájlt csatolhatsz a gemkapoccsal, ráhúzhatod az ablakra, vagy beillesztheted. A képekből előnézet készül, és minden fájl letölthető a „Fájlok” fülön.
- **Reakciók:** 👍 ❤️ 😂 🎉 👏 🔥 🤔
- **Eszközválasztás:** az előcsarnokban kiválaszthatod a mikrofont és a kamerát, és beállíthatod, hogy némítva vagy kamera nélkül lépj be.

## Adatok

Minden a `data/` mappában van:

| Fájl | Tartalom |
|---|---|
| `users.json` | fiókok (a kódok hash-elve) |
| `meetings.json` | meetingek |
| `messages.json` | chat előzmények |
| `files.json` + `uploads/` | feltöltött fájlok |
| `sessions.json` | bejelentkezések |

Ha mindent törölni akarsz, állítsd le a szervert, és töröld a `data/` mappát.

## Beállítások (környezeti változók)

| Változó | Alapérték | Leírás |
|---|---|---|
| `PORT` | `3000` | port |
| `ALLOW_REGISTRATION` | `true` | Állítsd `false`-ra, miután mindketten regisztráltatok, így idegen nem tud fiókot nyitni. |
| `MAX_UPLOAD_MB` | `1024` | legnagyobb feltölthető fájlméret |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | – | TURN szerver, ha valamelyik hálózat blokkolja a közvetlen kapcsolatot |

Példa: `ALLOW_REGISTRATION=false npm start`

A videó közvetlenül a két gép között megy (WebRTC), a szerver csak összeköti őket. Ritkán előfordul, hogy egy szigorú céges vagy mobilhálózat ezt nem engedi, és a csempén a „Kapcsolat sikertelen” felirat jelenik meg. Ilyenkor kell egy TURN szerver, például a metered.ca ingyenes csomagja. Az adatait a fenti változókba írd be.
