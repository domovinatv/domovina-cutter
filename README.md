# domovina-cutter

On-demand **video chapter cutter** za domovina.ai. Standalone Cloudflare Worker + Container
(ffmpeg) koji na zahtjev izreže poglavlje iz cjelovitog videa, cache-ira na R2 i idući put
servira s CDN-a. Lazy **cut-once, cache-forever**.

- **Plan / arhitektura:** [`PLAN.md`](./PLAN.md)
- **Handoff za implementaciju + deploy:** [`HANDOFF.md`](./HANDOFF.md)

Repo je odvojen od `fetch.domovina.tv` (glavni pipeline) — cutter je read-only consumer CDN
artefakata (`data/{videoId}/video_h264.mp4` + `article.json`) i ne dira pipeline.

## API (planirano)

```
GET https://cutter.domovina.ai/clip/{videoId}/{chapter}.mp4[?dl=1][&precise=1]
```

`{chapter}` = `iteration_number` (1-based) iz `article.json`. Vraća mp4 clip (H.264+AAC)
tematskog poglavlja.

## Status

Skeleton + plan spreman. Implementacija i deploy idu iz zasebne sesije preko `HANDOFF.md`.
