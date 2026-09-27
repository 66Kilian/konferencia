# Tárgyaló – privát videókonferencia

Kilian (CEO) és Krisztián (programozó) saját meetingterme. Teljesen ingyen fut Vercelen.

## Hogyan működik

| Rész | Hol fut | Ingyenes keret |
|---|---|---|
| Oldal + API (`public/`, `api/`) | Vercel (Hobby) | bőven elég |
| Fiókok, meetingek, chat | Upstash Redis (Vercel Storage) | 500 ezer parancs/hó |
| Feltöltött fájlok | Vercel Blob | 1 GB |
| A két gép összekötése | PeerJS ingyenes jelzőszerver (0.peerjs.com) + TURN | – |

A kép, a hang, a chat-értesítések és a reakciók közvetlenül a két gép között mennek (WebRTC). A szerver csak a belépést, a meetingeket, a chat előzményeket és a jelenlétet kezeli.

## Vercel beállítás (egyszer)

1. A projekt a GitHub repóból települ. Ha a projekt beállításainál (Settings → Build & Deployment) korábban kézzel átírtál valamit, állítsd vissza: Framework Preset: **Other**, a Build és az Output mező üres / alapértelmezett.
2. **Storage** → **Create Database** → **Upstash for Redis** → Free csomag → **Connect** a projekthez.
3. **Storage** → **Blob** → **Create** → hozzáférés: **Public** → **Connect** a projekthez.
4. **Deployments** → a legutóbbi → **Redeploy**.

Ha a 2. lépés kimarad, az oldal kiírja, hogy mit kell még bekötni.

Ajánlott: ha mindketten regisztráltatok, a **Settings → Environment Variables** alatt vedd fel az `ALLOW_REGISTRATION` = `false` változót (utána Redeploy). Így idegen nem tud fiókot nyitni.

### Saját domain (pl. konferencia.pureshine.hu)

1. Vercel → projekt → **Settings → Domains** → add hozzá a `konferencia.pureshine.hu` domaint. A Vercel kiír egy **CNAME** értéket.
2. A domain DNS-szolgáltatójánál (pureshine.hu → domdom.net) vegyél fel egy rekordot:
   - Típus: **CNAME**
   - Név: **konferencia**
   - Érték: amit a Vercel kiírt (pl. `valami.vercel-dns-017.com`)
3. Pár perc – néhány óra, és mindenhol elérhető lesz, telefonon is.

## Helyi futtatás

```bash
npm install
npm start
```

Ezután nyisd meg: http://localhost:3000. Helyben nem kell se Redis, se Blob: az adatok a `data/` mappába kerülnek.

## Funkciók

- **Regisztráció:** név, szerep, 4 jegyű kód, majd a kód megismétlése. A regisztráció éles oldalon le van zárva (lásd Biztonság).
- **Meetingek:** azonnali indítás vagy meghirdetés címmel, napirenddel, időponttal és hosszal. A meghívó link a vágólapra kerül.
- **Élő jelzés:** látod, ki van online, és ki melyik hívásban ül. Ha a másik belép, értesítést kapsz.
- **Hívás:** mikrofon (`M`), kamera (`V`), képernyőmegosztás (`S`), kiemelt nézet, beszélő kiemelése, reakciók.
- **Chat és fájlok:** üzenetek és fájlok hívás közben (max 500 MB). Húzd az ablakra, illeszd be, vagy csatold a gemkapoccsal.
- **Zene (Spotify):** a lebegő lejátszóba bármilyen Spotify link beilleszthető (dal, album, lista, podcast), és van 3 beépített lista. Hívás közben a **Közös hallgatás** a másiknál is betölti, elindítja, megállítja és tekeri ugyanazt a számot. Mindenki a saját Spotify-jából hallgat. A Spotifyba belépve teljes számok szólnak, anélkül 30 mp-es részletek. A lejátszó oldalváltáskor sem áll le.

## Biztonság

- **Belépés:** a munkamenet HttpOnly, `SameSite=Strict`, `__Host-` sütiben van, így a böngészőben futó kód nem fér hozzá. A szerver csak a hash-ét tárolja.
- **4 jegyű kód:** scrypt és egy titkos „bors” (`PIN_PEPPER`) védi, így az adatbázis kiszivárgása esetén sem törhető. Idegen eszközről 3 hiba után 15 perc zárolás, utána minden hibánál duplázódik, legfeljebb 24 óráig. A saját, már használt eszközöd külön számlálót kap, így a támadó nem tud kizárni. A sikertelen próbálkozásokról figyelmeztetést kapsz.
- **Fióklista:** csak már használt eszközön látszik, idegen gépen a nevet is be kell írni.
- **Spam ellen:** kérés-korlátok minden végponton, gombtiltás a kérés végéig, legfeljebb 64 KB-os kérések, csak JSON, és más oldalról indított kérés (CSRF) tiltva.
- **Fájlok:** privát Blob tárolóban vannak. Csak belépve, egy 5 percig érvényes aláírt linkkel tölthetők le.
- **Hívás:** csak az a résztvevő csatlakozhat, akit a szerver belépett felhasználóként igazol. A kép és a hang végponttól végpontig titkosítva megy (DTLS-SRTP).
- **Fejlécek:** szigorú CSP, `X-Frame-Options: DENY`, HSTS, Referrer- és Permissions-Policy.
- **Pajzs gomb** a főoldalon: minden eszköz kiléptetése és a megbízható eszközök törlése, például elveszett telefon esetén.

A `PIN_PEPPER` értékét **soha ne változtasd meg**, különben egyik kód sem fog működni.

## Beállítások (környezeti változók)

| Változó | Alapérték | Leírás |
|---|---|---|
| `ALLOW_REGISTRATION` | `true` | `false` = új fiók nem hozható létre |
| `MAX_UPLOAD_MB` | `500` | legnagyobb feltölthető fájl |
| `PIN_PEPPER` | – | titkos érték a kódok hash-éhez (Vercelen be van állítva, ne módosítsd) |

A Redis és a Blob változóit (`KV_REST_API_*`, `BLOB_READ_WRITE_TOKEN`) a Vercel automatikusan beállítja, amikor bekötöd őket.

## Fejlesztőknek

- `lib/handler.js` – az összes API végpont (Vercelen `api/index.js`, helyben `dev-server.js` hívja)
- `lib/db.js` – Upstash Redis, helyben JSON fájl
- `public/app.js` – a teljes kliens
- `npm run vendor` – újraépíti a `public/vendor/` böngészős könyvtárakat (PeerJS, Vercel Blob feltöltő)
