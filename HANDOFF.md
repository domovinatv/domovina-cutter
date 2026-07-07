# HANDOFF — implementiraj i deployaj domovina-cutter

Ovaj fajl je i handoff prompt: pokreni **novu Claude Code sesiju u
`/Users/ms/git/domovinatv/domovina-cutter`** i zalijepi sadržaj ispod (od linije `---`).

---

Ti si u standalone repou `domovina-cutter`. Zadatak: implementiraj i deployaj **on-demand
video chapter cutter** kao Cloudflare Worker + Container, i deployaj ga wranglerom. Pročitaj
`PLAN.md` u ovom repou — on je SSOT za arhitekturu i sve provjerene činjenice; ne odstupaj od
njega bez razloga. Ovaj repo je potpuno odvojen od `fetch.domovina.tv` pipelinea i NE smije ga
dirati (read-only consumer CDN-a).

## Što gradiš (sažetak; detalji u PLAN.md)

Endpoint `GET https://cutter.domovina.ai/clip/{videoId}/{chapter}.mp4`:
1. Fetchaj `https://cdn.domovina.ai/data/{videoId}/article.json`, uzmi `iterations[chapter-1]`
   → `start_time`, `end_time` (`"HH:MM:SS"`), `theme`.
2. Deterministički ključ `clips/{videoId}/ch{chapter}__{startSec}-{endSec}.mp4`.
3. R2 binding `head(ključ)`: HIT → `302` na `https://cdn.domovina.ai/{ključ}`.
4. MISS → single-flight (Durable Object lock po ključu) → Container izreže s ffmpegom i
   uploada na R2 → `302` na CDN.

## Ključne provjerene činjenice (ne moraš re-verificirati — potvrđeno 2026-07-07)

- Izvor: `https://cdn.domovina.ai/data/{videoId}/video_h264.mp4` — H.264 **+ AAC audio**,
  `accept-ranges: bytes` (ffmpeg HTTP-range seek radi), immutable, ~100 MB.
- Rezanje default = stream-copy (bez re-encode):
  ```
  ffmpeg -nostdin -hide_banner -loglevel error -ss {START} -to {END} \
    -i "https://cdn.domovina.ai/data/{videoId}/video_h264.mp4" \
    -c copy -movflags +faststart -f mp4 /tmp/out.mp4
  ```
  `-ss` PRIJE `-i` = brzi keyframe seek. Start snapa na keyframe (par sek ranije) — OK.
  `?precise=1` → re-encode put (`libx264 -crf 30 -c:a aac`), frame-accurate, sporije.
- R2 bucket: `cdn-domovina-ai`. Clipovi idu pod prefiks `clips/`.
- ⚠️ **cdn.domovina.ai cache-ira 404 na 4h** — provjera postojanja MORA ići kroz R2 binding u
  Workeru, NIKAD kroz javni CDN GET.

## Stack i pravila

- Cloudflare Worker (TypeScript, **Hono** router), Durable Object za single-flight,
  R2 binding `CLIPS` → `cdn-domovina-ai`, Cloudflare **Container** (Dockerfile: alpine + ffmpeg
  + mali HTTP server koji izvrši rez i uploada direktno na R2 preko S3 API-ja).
- **Prije pisanja Cloudflare koda učitaj skillove `cloudflare`, `wrangler` i po potrebi
  `durable-objects`** da dohvatiš AKTUALNI Cloudflare Containers + Workers + wrangler API
  (ne oslanjaj se na moguće zastarjelo znanje — Containers API se mijenjao).
- R2 kredencijali (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, Object R&W token)
  idu ISKLJUČIVO preko `wrangler secret put` — nikad u kod ni u git. Worker koristi R2 binding
  (bez keyeva); keyevi trebaju samo containeru za S3 upload. Traži od usera te vrijednosti kad
  dođeš do deploya (postoje u `.env` glavnog repoa `fetch.domovina.tv`).
- Cache headeri na clip odgovoru: `Cache-Control: public, max-age=31536000, immutable`.

## Redoslijed (milestones iz PLAN.md §6)

1. Scaffold (`package.json`, `wrangler.jsonc`, TS, Hono, `.gitignore` s `.env`/`node_modules`/`.dev.vars`).
2. Worker router + article.json resolver + ključ-derivacija + R2 head/302 (bez reza).
3. Container image + `/cut` (rez + R2 S3 upload).
4. SingleFlight DO + hladni put.
5. `?dl=1` (Content-Disposition slug(theme)), `?precise=1`, `/chapters/{id}`, `/healthz`.
6. Deploy: `wrangler deploy` → custom domain `cutter.domovina.ai` → `wrangler secret put …`
   → smoke test.
7. README s Flutter integracijskim snippetom (URL `https://cutter.domovina.ai/clip/{id}/{chapter}.mp4?dl=1`;
   listu chaptera app već ima iz postojećeg `article.json` na CDN-u).

## Smoke test (živi video)

```bash
curl -sI "https://cutter.domovina.ai/clip/fKlRKppc9Cs/1.mp4"   # 1. poziv reže
curl -sI "https://cutter.domovina.ai/clip/fKlRKppc9Cs/1.mp4"   # 2. poziv → 302 na cdn.domovina.ai/clips/...
```

## Definicija gotovog

- `wrangler deploy` prolazi, `cutter.domovina.ai` odgovara.
- Prvi poziv na `fKlRKppc9Cs/1.mp4` vrati validan mp4 (VLC ga otvori, ima sliku i zvuk).
- Drugi poziv 302-a na topli CDN clip.
- `README.md` ima Flutter snippet.
- Nema secreta u gitu; `git status` čist osim namjernih fajlova.

Radi kroz milestone-ove, commitaj po fazi, i stani da pitaš usera samo za: (a) R2 secret
vrijednosti pri deployu, (b) potvrdu custom domene `cutter.domovina.ai` u Cloudflare zoni.
Sve ostalo provedi autonomno.
