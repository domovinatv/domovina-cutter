import { Hono } from "hono";
import {
  CDN_BASE,
  fetchArticle,
  isValidVideoId,
  resolveChapter,
  slugify,
  videoUrl,
} from "./article";

export interface Env {
  // R2 bucket that also backs cdn.domovina.ai. Used ONLY for existence checks
  // (head) and the ?dl=1 stream — the cache-gate. Works on the Workers free plan.
  CLIPS: R2Bucket;
  // Base URL of the Coolify-hosted ffmpeg cutter service (e.g.
  // https://cutter-svc.domovina.ai). Configured as a var in wrangler.jsonc.
  CUTTER_URL: string;
  // Bearer token the Worker sends to the cutter service. `wrangler secret put`.
  CUTTER_API_KEY?: string;
}

interface CutRequest {
  videoUrl: string;
  startSec: number;
  durationSec: number;
  key: string;
  precise: boolean;
}

const CLIP_CACHE = "public, max-age=31536000, immutable";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.text("ok"));

app.get("/", (c) =>
  c.text(
    "domovina-cutter — GET /clip/{videoId}/{chapter}.mp4[?dl=1][&precise=1]\n",
  ),
);

// Helper for frontends: chapter list with ready-to-use clip URLs.
app.get("/chapters/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  if (!isValidVideoId(videoId)) return c.text("bad videoId", 404);
  const article = await fetchArticle(videoId);
  if (!article) return c.text("no article.json", 404);
  const origin = new URL(c.req.url).origin;
  const chapters = article.iterations.map((it) => ({
    chapter: it.iteration_number,
    start_time: it.start_time,
    end_time: it.end_time,
    theme: it.theme,
    clip_url: `${origin}/clip/${videoId}/${it.iteration_number}.mp4`,
  }));
  return c.json(chapters);
});

app.get("/clip/:videoId/:file", async (c) => {
  const env = c.env;
  const videoId = c.req.param("videoId");
  if (!isValidVideoId(videoId)) return c.text("bad videoId", 404);

  const file = c.req.param("file");
  const m = /^(\d+)\.mp4$/.exec(file);
  if (!m) return c.text("expected {chapter}.mp4", 404);
  const chapter = parseInt(m[1], 10);

  const precise = c.req.query("precise") === "1";
  const dl = c.req.query("dl") === "1";

  const article = await fetchArticle(videoId);
  if (!article) return c.text("no article.json", 404);

  const resolved = resolveChapter(article, videoId, chapter, precise);
  if (!resolved) return c.text("chapter out of range", 404);

  // Cache-gate: existence check MUST go through the R2 binding, never a public
  // CDN GET (cdn.domovina.ai caches 404s for 4h).
  let head = await env.CLIPS.head(resolved.key);

  if (!head) {
    // Cold path — ask the Coolify cutter service to produce + upload the clip.
    // The service coalesces concurrent identical cuts and is idempotent.
    const cutReq: CutRequest = {
      videoUrl: videoUrl(videoId),
      startSec: resolved.startSec,
      durationSec: resolved.endSec - resolved.startSec,
      key: resolved.key,
      precise,
    };
    let cutRes: Response;
    try {
      cutRes = await fetch(`${env.CUTTER_URL}/cut`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.CUTTER_API_KEY
            ? { authorization: `Bearer ${env.CUTTER_API_KEY}` }
            : {}),
        },
        body: JSON.stringify(cutReq),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.text(`cutter unreachable: ${msg}`, 502);
    }
    if (!cutRes.ok) {
      const detail = await cutRes.text().catch(() => "");
      return c.text(`cut failed: ${detail}`, 502);
    }
    head = await env.CLIPS.head(resolved.key);
    if (!head) return c.text("clip missing after cut", 502);
  }

  if (dl) {
    // Stream the object through the Worker so we can set an attachment filename.
    // R2 body is a ReadableStream — not buffered into Worker memory.
    const obj = await env.CLIPS.get(resolved.key);
    if (!obj) return c.text("clip vanished", 502);
    const headers = new Headers();
    headers.set("content-type", "video/mp4");
    headers.set("cache-control", CLIP_CACHE);
    headers.set("content-length", String(obj.size));
    headers.set(
      "content-disposition",
      `attachment; filename="${slugify(resolved.theme)}.mp4"`,
    );
    return new Response(obj.body, { headers });
  }

  // Warm/inline path — clean CDN redirect.
  return new Response(null, {
    status: 302,
    headers: {
      location: `${CDN_BASE}/${resolved.key}`,
      "cache-control": CLIP_CACHE,
    },
  });
});

export default app;
