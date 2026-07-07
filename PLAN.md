# domovina-cutter — Plan

**On-demand video chapter cutter za domovina.ai.** Standalone Cloudflare Worker + Container
(ffmpeg) koji na zahtjev izreže poglavlje (chapter) iz cjelovitog videa, cache-ira rezultat
na R2 i svaki idući put ga servira s CDN-a. **Lazy "cut-once, cache-forever".**

Ovaj repo je **potpuno odvojen** od `fetch.domovina.tv` (glavni pipeline). Cutter je
**read-only consumer** postojećih CDN artefakata — ne dira, ne pokreće i ne mijenja nijedan
korak fetch/transkripcija/article pipelinea. Deploy je isključivo Cloudflare (wrangler).

---

## 1. Zašto lazy on-demand (a ne preprocessing)

- Chapteri **particioniraju cijeli video** → zbroj svih chaptera jednog videa ≈ cijeli taj
  video. Preprocesirati sve = udvostručiti cijelu video biblioteku na R2 (~stotine GB) za
  nešto što 99% korisnika nikad ne skine.
- Pristup je **long-tail** — realno se skine šačica chaptera popularnih epizoda.
- Rezanje je **jeftino**: `ffmpeg -ss … -to … -c copy` je stream-copy, **bez re-enkodiranja**
  → sekunde po clipu, HTTP-range seek (nema download cijelog videa).

Zaključak: materijaliziraj **samo ono što netko stvarno zatraži**.

---

## 2. Provjerene činjenice o izvornim podacima (SSOT za implementaciju)

Sve provjereno uživo 2026-07-07 iz `fetch.domovina.tv`:

| Stvar | Vrijednost |
|---|---|
| Video asset (izvor rezanja) | `https://cdn.domovina.ai/data/{videoId}/video_h264.mp4` |
| Video codec | **H.264 (libx264, crf30) + AAC 128k @ 48kHz**, `+faststart` → clip s `-c copy` ima I sliku I zvuk |
| Range support | `accept-ranges: bytes` ✅ (ffmpeg `-ss` prije `-i` seeka preko HTTP range, ne vuče cijeli fajl) |
| Tipična veličina | ~100 MB (360p, ~1h). Chapter clip je manji dio toga. |
| Chapter izvor | `https://cdn.domovina.ai/data/{videoId}/article.json` |
| Chapter struktura | `{ metadata, iterations: [{ iteration_number, start_time, end_time, theme, sections[] }] }` |
| Timestamp format | `"HH:MM:SS"` (npr. `"00:42:30"`) |
| Broj chaptera po videu | ~2–4 (iteration = 35–45 min tematska cjelina) |
| R2 bucket | `cdn-domovina-ai` |
| CDN domena | `cdn.domovina.ai` (custom domain na R2, `max-age=31536000, immutable`) |
| ⚠️ Gotcha | **cdn.domovina.ai cache-ira 404 na 4h.** Nikad se ne oslanjaj na "GET statični URL → 404 → generiraj → retry" preko CDN-a. Provjera postojanja MORA ići kroz R2 binding u Workeru, ne kroz javni CDN GET. |

`videoId` = 11-znakovni YouTube ID (npr. `fKlRKppc9Cs`).

---

## 3. Arhitektura

```
Flutter app
  │  GET https://cutter.domovina.ai/clip/{videoId}/{chapter}.mp4[?dl=1][&precise=1]
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ Worker (router / cache-gate)                                     │
│  1. resolve chapter → fetch article.json (Cache API, kratki TTL) │
│     iterations[chapter-1] → start_time, end_time, theme          │
│  2. deterministički ključ:                                       │
│       clips/{videoId}/ch{chapter}__{startSec}-{endSec}.mp4       │
│  3. R2.head(ključ)  ── HIT ──►  302 → cdn.domovina.ai/{ključ}    │
│                    │                    (topli put = čisti CDN)   │
│                    └── MISS ─►  SingleFlight DO (lock po ključu)  │
│                                   │                              │
│                                   ▼                              │
│                          Container (ffmpeg)  ──►  R2.put(ključ)  │
│                                   │                              │
│                                   ▼                              │
│                          302 → cdn.domovina.ai/{ključ}          │
└─────────────────────────────────────────────────────────────────┘
```

### Odluke

1. **Clipovi u isti bucket `cdn-domovina-ai`, pod prefiksom `clips/`.**
   Nakon prvog reza topli put je **čisti CDN** (`cutter` 302 → `cdn.domovina.ai/clips/...`),
   Worker je samo na hladnom putu. Clipovi su regenerabilni derivati → miješanje s
   `data/` immutable artefaktima je bezopasno.

2. **Deterministički, verzionirani ključ s ugrađenim sekundama**
   (`ch{N}__{startSec}-{endSec}.mp4`). Ako se article regenerira s drugim granicama, ključ se
   promijeni sam → nema stale immutable clipa. Poštuje pravilo "immutable assets = verzionirano ime".

3. **`-c copy` (stream-copy) je default.** Keyframe caveat: start snapa na najbliži prethodni
   keyframe (par sekundi ranije) — prihvatljivo za chapter download. `?precise=1` → re-encode
   put (frame-accurate, `-ss` poslije `-i`, `libx264 crf30 + aac`). Sporije, opcionalno.

4. **Single-flight preko Durable Objecta** (lock po ključu) — dva istovremena zahtjeva za isti
   još-nerezani clip ne pokreću dva reza; drugi čeka isti rez.

5. **Compute = Cloudflare Container s ffmpegom** (fully wrangler-deployable, standalone na CF).
   Container radi rez i **uploada direktno na R2 (S3 API)** — robusno za 50–150 MB clipove,
   izbjegava buffering kroz 128 MB Worker memoriju. Worker orkestrira + servira 302.
   *(Fallback ako Containers nisu opcija: Worker zove Modal funkciju — glavni projekt već
   koristi Modal. Ostaviti dokumentirano, ne implementirati prvo.)*

### ffmpeg naredba (stream-copy, default)

```bash
ffmpeg -nostdin -hide_banner -loglevel error \
  -ss {START_HHMMSS} -to {END_HHMMSS} \
  -i "https://cdn.domovina.ai/data/{videoId}/video_h264.mp4" \
  -c copy -movflags +faststart -f mp4 /tmp/out.mp4
```

`-ss` **prije** `-i` = brzi keyframe seek preko HTTP range. `-to` je apsolutno vrijeme
(radi jer je `-ss` prije `-i`; ako se koristi input-seek, provjeri treba li `-t` trajanje umjesto).

### ffmpeg naredba (`?precise=1`, frame-accurate)

```bash
ffmpeg -nostdin -hide_banner -loglevel error \
  -ss {START} -to {END} -i "https://cdn.domovina.ai/data/{videoId}/video_h264.mp4" \
  -c:v libx264 -preset veryfast -crf 30 -c:a aac -b:a 128k -movflags +faststart -f mp4 /tmp/out.mp4
```

---

## 3.5. Cost & compute — zašto je jeftino

**ffmpeg NE trči u Workeru.** Worker je V8 isolate: nema native binarija, 128 MB RAM, CPU cap.
On samo orkestrira (fetch `article.json`, R2 `head`, 302) → par ms CPU → praktički $0.
ffmpeg trči u **Containeru**, i to kao **remux, ne re-encode**.

`-c copy` = demux odabranog byte-rangea + rewrite MP4 containera. **Nema decode/encode**, CPU
minimalan; čita samo dio fajla (chapter 2/3 = srednja trećina, preko HTTP range). Trošak je
**I/O (bajtovi u prometu) + par sekundi container-vremena**, ne CPU.

| Stavka | Trošak (red veličine) |
|---|---|
| Worker (orkestracija) | ~$0 (par ms CPU, unutar 10M besplatnih zahtjeva) |
| Container CPU+RAM po rezu | ~$0.0005 (1 vCPU / 1 GiB, ~10–20s remux) |
| Container egress fetch+upload (~100 MB, većim dijelom intra-CF) | ~$0.001–0.0025 ako se broji |
| **Ukupno po rezu (HLADNI put)** | **sub-cent, ~$0.001–0.005** |
| **TOPLI put (2. i svaki idući poziv)** | **~$0 — čisti CDN 302, container se ne budi** |
| R2 storage clipa (~50 MB) | ~$0.0008/mj, **egress $0** (R2 nema egress fee) |
| Fiksno | Workers Paid **$5/mj** baza (Containers traže Paid plan) |

Isti red veličine kao ~$0.003/epizoda transkripcija. **Zaključak: jeftino, dominira I/O ne CPU.**

Caveat 1 — **cold start**: prvi rez nekog clipa plaća container spin-up (par sek latencije) +
vrijeme reza. Zato single-flight DO — dva istovremena prva poziva ne bude dva containera.
Caveat 2 — **pricing brojke su procjena** (CF Containers cjenik se mijenja) → implementacijska
sesija neka potvrdi aktualne stope preko `cloudflare` skilla; zaključak "jeftino" stoji čvrsto.
Caveat 3 — **Cloudflare Media Transformations** može klipati MP4 bez containera, ALI ima cap na
trajanje clipa (kratke minute) → 40-min chapter gotovo sigurno prekoračuje. Sesija neka to u 30s
provjeri prije gradnje Containera; ako je limit i dalje nizak, Container+ffmpeg ostaje.

---

## 4. HTTP API (javni ugovor za Flutter)

```
GET /clip/{videoId}/{chapter}.mp4
      {chapter} = iteration_number (1-based) iz article.json
      ?dl=1       → Content-Disposition: attachment; filename="{slug(theme)}.mp4"
      ?precise=1  → frame-accurate re-encode (sporije)

200/302  video/mp4  (302 na cdn.domovina.ai/clips/... kad je topao)
404      nepoznat videoId / chapter izvan raspona / nema article.json
502      ffmpeg/upstream greška

GET /chapters/{videoId}            (helper za frontend, opcionalno)
200 JSON: [{ chapter, start_time, end_time, theme, clip_url }]

GET /healthz → 200 "ok"
```

Cache headeri na clip odgovoru: `Cache-Control: public, max-age=31536000, immutable`.

---

## 5. Cloudflare resursi (wrangler)

- **Worker** — entry `src/index.ts` (predlaže se Hono router; isti stack kao postojeći
  pipeline.domovina.ai queue Worker).
- **Durable Object** — `SingleFlight` (lock po clip-ključu).
- **Container** — `Dockerfile` (alpine + ffmpeg + mali HTTP server koji izvrši rez i uploada na R2).
- **R2 binding** — `CLIPS` → bucket `cdn-domovina-ai`.
- **Custom domain / route** — `cutter.domovina.ai`.
- **Secrets** (`wrangler secret put`): R2 S3 kredencijali za container upload
  (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) — scoped Object Read&Write token,
  isti tip kao u glavnom repou. Worker sam koristi R2 **binding** (bez keyeva); keyevi trebaju
  samo containeru za direktni S3 upload.

---

## 6. Milestones (redoslijed rada za handoff sesiju)

1. Scaffold: `npm init`, wrangler, Hono, TypeScript, `wrangler.jsonc`.
2. Worker router + article.json resolver + ključ-derivacija + R2 head/302 (bez reza još).
3. Container image (ffmpeg) + `/cut` endpoint (rez + R2 S3 upload).
4. SingleFlight DO + spajanje hladnog puta.
5. `?dl=1`, `?precise=1`, `/chapters/{id}`, `/healthz`.
6. Deploy: `wrangler deploy`, custom domain `cutter.domovina.ai`, secrets, smoke test na
   živom videu (`fKlRKppc9Cs`, chapter 1).
7. README s Flutter integracijskim snippetom.

## 7. Smoke test (nakon deploya)

```bash
# topli/hladni put — prvi poziv reže, drugi 302 na CDN
curl -sI "https://cutter.domovina.ai/clip/fKlRKppc9Cs/1.mp4"
curl -sI "https://cutter.domovina.ai/clip/fKlRKppc9Cs/1.mp4"   # očekuj 302 → cdn.domovina.ai/clips/...
```

## 8. Ne-ciljevi / oprez

- **Ne mijenja fetch pipeline.** Cutter je isključivo read-only nad CDN-om.
- **Ne preprocesira** cijeli katalog. Samo na zahtjev.
- Ne stavljati R2 kredencijale u Worker kod niti u git — samo `wrangler secret`.
- `git` remote nije postavljen — user odlučuje hoće li push.

---

## 9. Scope: ovaj repo = shareable file, NE in-app clamp

Postoje **dvije različite značajke** oko "chaptera" — ne miješati ih:

1. **In-app "chapter mode"** — player u Flutteru clampan na `[start, end]` (ne možeš seekati
   van chaptera). Rješava se **čisto na frontendu**, nula backenda, nula rezanja, radi
   retroaktivno za sve epizode. **Ovaj repo to NE radi** — to je posao domovina.ai Flutter repoa.

2. **Downloadable / shareable chapter file** — prava MP4 datoteka koja se sama zavrti inline u
   WhatsApp/Telegram/iMessage. **TO je ovaj repo (domovina-cutter).**

Bitna korekcija na eventualnu "AV1 blokira inline share" zabrinutost: **CDN već servira
H.264 + AAC** (`data/{videoId}/video_h264.mp4`, migracija gotova 2696/2696, legacy `video.mp4`
obrisan). Dakle inline autoplay u WhatsAppu **NIJE blokiran**, i rez ide **stream-copy `-c copy`
bez re-encodea** (izvor je već H.264) → nema dual-encode ovisnosti. Ranije analize koje spominju
"CDN je AV1 / treba dual-encode prvo" rade na zastarjelom stanju.
