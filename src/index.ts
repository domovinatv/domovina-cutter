import { Hono } from "hono";
import type { Context } from "hono";
import {
  CDN_BASE,
  fetchArticle,
  isValidVideoId,
  rangeKey,
  resolveChapter,
  slugify,
  videoUrl,
} from "./article";
import { isDocumentNavigation, renderDownloadPage } from "./page";

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
    "domovina-cutter\n" +
      "  GET /clip/{videoId}/{chapter}.mp4[?dl=1][&precise=1]     (article iteration)\n" +
      "  GET /clip/{videoId}/r/{startSec}-{endSec}.mp4[?dl=1][&precise=1][&name=slug]  (range)\n",
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

/**
 * Shared cache-gate: given a resolved clip window, HIT → 302 to CDN, MISS →
 * cold-cut via the Coolify service then 302 (or stream with a filename on ?dl=1).
 *
 * Existence check goes through the R2 binding, NEVER a public CDN GET —
 * cdn.domovina.ai caches 404s for 4h, which would poison the warm redirect.
 */
async function serveClip(
  c: Context<{ Bindings: Env }>,
  opts: {
    key: string;
    startSec: number;
    endSec: number;
    precise: boolean;
    dl: boolean;
    filename: string;
    title: string;
  },
): Promise<Response> {
  const env = c.env;
  const { key, startSec, endSec, precise, dl, filename, title } = opts;

  // A download link opened in a browser tab gets a progress page (instead of a
  // blank tab during the cold cut) that fetches the MP4 itself via ?raw=1.
  if (dl && c.req.query("raw") !== "1" && isDocumentNavigation(c.req.raw)) {
    const url = new URL(c.req.url);
    const raw = new URL(url);
    raw.searchParams.set("raw", "1");
    const share = new URL(url.origin + url.pathname);
    if (precise) share.searchParams.set("precise", "1");
    return renderDownloadPage({
      title,
      filename,
      startSec,
      endSec,
      rawUrl: raw.pathname + raw.search,
      shareUrl: share.toString(),
    });
  }

  let head = await env.CLIPS.head(key);

  if (!head) {
    // Cold path — ask the Coolify cutter service to produce + upload the clip.
    // The service coalesces concurrent identical cuts and is idempotent.
    const videoId = key.split("/")[1];
    const cutReq: CutRequest = {
      videoUrl: videoUrl(videoId),
      startSec,
      durationSec: endSec - startSec,
      key,
      precise,
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(env.CUTTER_API_KEY
        ? { authorization: `Bearer ${env.CUTTER_API_KEY}` }
        : {}),
    };
    const body = JSON.stringify(cutReq);
    // The service is idempotent + coalescing, so a retry is safe. This rides
    // out transient unavailability (container cold start / redeploy window).
    let cutRes: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      try {
        cutRes = await fetch(`${env.CUTTER_URL}/cut`, {
          method: "POST",
          headers,
          body,
        });
      } catch (err) {
        lastErr = `cutter unreachable: ${err instanceof Error ? err.message : String(err)}`;
        cutRes = null;
        continue;
      }
      if (cutRes.ok) break;
      lastErr = `cut failed: ${await cutRes.text().catch(() => "")}`;
    }
    if (!cutRes || !cutRes.ok) {
      return c.text(lastErr || "cut failed", 502);
    }
    head = await env.CLIPS.head(key);
    if (!head) return c.text("clip missing after cut", 502);
  }

  if (dl) {
    // Stream the object through the Worker so we can set an attachment filename.
    // R2 body is a ReadableStream — not buffered into Worker memory.
    const obj = await env.CLIPS.get(key);
    if (!obj) return c.text("clip vanished", 502);
    const outHeaders = new Headers();
    outHeaders.set("content-type", "video/mp4");
    outHeaders.set("cache-control", CLIP_CACHE);
    outHeaders.set("content-length", String(obj.size));
    outHeaders.set(
      "content-disposition",
      `attachment; filename="${filename}.mp4"`,
    );
    return new Response(obj.body, { headers: outHeaders });
  }

  // Warm/inline path — clean CDN redirect.
  return new Response(null, {
    status: 302,
    headers: {
      location: `${CDN_BASE}/${key}`,
      "cache-control": CLIP_CACHE,
    },
  });
}

// Range clip: arbitrary [startSec, endSec] window (per-chapter share/download).
// MUST be registered before the generic /:file route so "r" isn't swallowed.
app.get("/clip/:videoId/r/:file", async (c) => {
  const videoId = c.req.param("videoId");
  if (!isValidVideoId(videoId)) return c.text("bad videoId", 404);

  const file = c.req.param("file");
  const m = /^(\d+)-(\d+)\.mp4$/.exec(file);
  if (!m) return c.text("expected {startSec}-{endSec}.mp4", 404);
  const startSec = parseInt(m[1], 10);
  const endSec = parseInt(m[2], 10);
  if (endSec <= startSec) return c.text("empty range", 404);

  const precise = c.req.query("precise") === "1";
  const dl = c.req.query("dl") === "1";
  const name = c.req.query("name") ?? "";

  return serveClip(c, {
    key: rangeKey(videoId, startSec, endSec, precise),
    startSec,
    endSec,
    precise,
    dl,
    filename: slugify(name) === "clip" ? `isjecak-${startSec}` : slugify(name),
    title: name.trim() || "Isječak",
  });
});

// Chapter clip: 1-based article iteration_number.
app.get("/clip/:videoId/:file", async (c) => {
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

  return serveClip(c, {
    key: resolved.key,
    startSec: resolved.startSec,
    endSec: resolved.endSec,
    precise,
    dl,
    filename: slugify(resolved.theme),
    title: resolved.theme || `Poglavlje ${chapter}`,
  });
});

export default app;
