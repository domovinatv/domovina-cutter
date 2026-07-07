# domovina-cutter

On-demand **video chapter cutter** for domovina.ai. Lazy **cut-once, cache-forever**:
the first request for a chapter cuts it out of the full episode with ffmpeg, stores it on
R2, and every request after that is served straight from `cdn.domovina.ai`.

Read-only consumer of the `fetch.domovina.tv` CDN artifacts
(`data/{videoId}/video_h264.mp4` + `article.json`) — it never touches that pipeline.

## Architecture

```
Flutter app
  │  GET https://cutter.domovina.ai/clip/{videoId}/{chapter}.mp4[?dl=1][&precise=1]
  ▼
Cloudflare Worker (free plan, cache-gate)          ── src/
  1. fetch article.json → iterations[chapter-1] → start/end/theme
  2. deterministic key: clips/{videoId}/ch{N}__{startSec}-{endSec}[_precise].mp4
  3. R2.head(key)  ── HIT ──►  302 → cdn.domovina.ai/{key}   (warm = pure CDN)
                   └─ MISS ─►  POST {CUTTER_URL}/cut  (Bearer CUTTER_API_KEY)
                                     │
                                     ▼
Coolify Docker microservice (ffmpeg)               ── service/
  ffmpeg -ss -t -c copy (HTTP-range seek, no full download) → S3 PutObject → R2
  single-flight coalescing by key + HeadObject idempotency
                                     │
                                     ▼
  Worker re-checks R2.head → 302 → cdn.domovina.ai/{key}
```

Why a Coolify microservice and not a Cloudflare Container: CF Containers require the
Workers **Paid** plan, and the cut is **I/O-bound, not CPU-bound**. A small always-on
Docker service (same pattern as `mcp.domovina.ai`) is cheaper and reuses existing infra.
The Worker stays on the free plan as a pure cache-gate.

> ⚠️ Existence checks go through the **R2 binding**, never a public CDN GET —
> `cdn.domovina.ai` caches 404s for 4h.

## API

```
GET /clip/{videoId}/{chapter}.mp4
      {chapter} = iteration_number (1-based) from article.json
      ?dl=1       → Content-Disposition: attachment; filename="{slug(theme)}.mp4"
      ?precise=1  → frame-accurate re-encode (libx264/aac, slower); default is
                    stream-copy (-c copy), start snaps to nearest keyframe

302 → cdn.domovina.ai/clips/...   (warm/inline)     Cache-Control: immutable, 1y
200   video/mp4                    (?dl=1 streamed through Worker with filename)
404   unknown videoId / chapter out of range / no article.json
502   cutter service unreachable / ffmpeg / upstream error

GET /chapters/{videoId}   → [{ chapter, start_time, end_time, theme, clip_url }]
GET /healthz              → 200 "ok"
```

## Flutter integration

The app already has the chapter list from the CDN `article.json` (or call
`/chapters/{videoId}`). To download a chapter, just hit the clip URL — the first hit
cuts + caches, later hits redirect to the CDN:

```dart
// videoId = 11-char YouTube id; chapter = 1-based iteration_number from article.json
String clipUrl(String videoId, int chapter, {bool download = false}) {
  final q = download ? '?dl=1' : '';
  return 'https://cutter.domovina.ai/clip/$videoId/$chapter.mp4$q';
}

// Download the chapter clip (attachment filename derives from the chapter theme):
final url = clipUrl('fKlRKppc9Cs', 1, download: true);
final res = await http.get(Uri.parse(url)); // follows the 302 to cdn.domovina.ai
// res.bodyBytes → save / share. First call may take a few seconds (cold cut),
// subsequent calls are instant CDN hits.
```

For inline playback (e.g. `video_player` / `chewie`), use the URL without `?dl=1`.

## Deploy

Two pieces: the **Coolify service** (does the cutting) and the **Cloudflare Worker**
(the cache-gate). Deploy the service first so the Worker's cold path has a target.

### 1. Cutter service on Coolify (`service/`)

1. New Coolify app from this repo, build context `service/` (Dockerfile). Port `8080`.
2. Assign a domain — e.g. `cutter-svc.domovina.ai` (must differ from the Worker's
   `cutter.domovina.ai`).
3. Set env (see `service/.env.example`):
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — scoped R2 Object
     Read & Write token for bucket `cdn-domovina-ai` (same family as the main repo `.env`).
   - `R2_BUCKET=cdn-domovina-ai`
   - `CUTTER_API_KEY` — shared bearer token (`openssl rand -hex 32`).
4. Deploy. Verify: `curl https://cutter-svc.domovina.ai/health` → `ok`.

### 2. Cloudflare Worker (`wrangler`)

```bash
npm install

# Point the Worker at the service domain chosen above (if not cutter-svc.domovina.ai):
#   edit vars.CUTTER_URL in wrangler.jsonc

npx wrangler deploy
npx wrangler secret put CUTTER_API_KEY   # paste the same token as the service

# Custom domain (once the domovina.ai zone is confirmed):
#   Cloudflare dash → Workers → domovina-cutter → Settings → Domains & Routes
#   → Add Custom Domain → cutter.domovina.ai
# or add a "routes" entry to wrangler.jsonc and redeploy.
```

R2 credentials never live in the Worker or git — the Worker uses the R2 **binding**
(no keys); only the service needs S3 keys, supplied via Coolify env.

## Smoke test

```bash
curl -sI "https://cutter.domovina.ai/clip/fKlRKppc9Cs/1.mp4"   # 1st call cuts (302 after upload)
curl -sI "https://cutter.domovina.ai/clip/fKlRKppc9Cs/1.mp4"   # 2nd call → 302 cdn.domovina.ai/clips/...
```

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Hono Worker: routes, article resolver, key derivation, R2 head/302, cold-path call |
| `src/article.ts` | article.json fetch/parse, `HH:MM:SS`→sec, key derivation, theme slug |
| `service/server.js` | ffmpeg cut + R2 S3 upload HTTP service (Coolify) |
| `service/Dockerfile` | alpine + ffmpeg + node runtime |
| `wrangler.jsonc` | Worker config: R2 binding `CLIPS`, `CUTTER_URL` var |
| `PLAN.md` | architecture SSOT |
```
