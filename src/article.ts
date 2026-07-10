// Helpers for resolving chapters from article.json and deriving clip keys.
// Read-only consumer of cdn.domovina.ai — never mutates upstream artifacts.

export const CDN_BASE = "https://cdn.domovina.ai";

export interface Iteration {
  iteration_number: number;
  start_time: string; // "HH:MM:SS"
  end_time: string; // "HH:MM:SS"
  theme: string;
  sections?: unknown[];
}

export interface Article {
  metadata?: Record<string, unknown>;
  iterations: Iteration[];
}

/** Source video that ffmpeg cuts from. */
export function videoUrl(videoId: string): string {
  return `${CDN_BASE}/data/${videoId}/video_h264.mp4`;
}

/** 11-char YouTube id. Keeps the key namespace and upstream fetch safe. */
export function isValidVideoId(videoId: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId);
}

/** Parse "HH:MM:SS" (or "MM:SS") into whole seconds. Returns null if invalid. */
export function hmsToSeconds(hms: string): number | null {
  const parts = hms.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    total = total * 60 + parseInt(p, 10);
  }
  return total;
}

/**
 * Fetch article.json with a short edge cache (chapters can be regenerated).
 * Returns null on 404 / parse failure.
 */
export async function fetchArticle(videoId: string): Promise<Article | null> {
  const res = await fetch(`${CDN_BASE}/data/${videoId}/article.json`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  try {
    const json = (await res.json()) as Article;
    if (!json || !Array.isArray(json.iterations)) return null;
    return json;
  } catch {
    return null;
  }
}

export interface ResolvedChapter {
  chapter: number;
  startSec: number;
  endSec: number;
  start: string;
  end: string;
  theme: string;
  key: string;
}

/**
 * Resolve a 1-based chapter to its clip key + cut window.
 * Returns null if the chapter is out of range or timestamps are malformed.
 *
 * Key is deterministic and versioned by the embedded seconds, so a regenerated
 * article with different boundaries yields a fresh key (no stale immutable clip).
 * The precise (re-encode) variant gets a distinct key so it never collides with
 * the stream-copy clip for the same window.
 */
export function resolveChapter(
  article: Article,
  videoId: string,
  chapter: number,
  precise: boolean,
): ResolvedChapter | null {
  if (!Number.isInteger(chapter) || chapter < 1) return null;
  const it = article.iterations[chapter - 1];
  if (!it) return null;
  const startSec = hmsToSeconds(it.start_time);
  const endSec = hmsToSeconds(it.end_time);
  if (startSec === null || endSec === null || endSec <= startSec) return null;
  const suffix = precise ? "_precise" : "";
  const key = `clips/${videoId}/ch${chapter}__${startSec}-${endSec}${suffix}.mp4`;
  return {
    chapter,
    startSec,
    endSec,
    start: it.start_time,
    end: it.end_time,
    theme: it.theme ?? "",
    key,
  };
}

/**
 * Deterministic key for an arbitrary [startSec, endSec] range clip (used by the
 * per-chapter route, where boundaries come from outline chapters rather than
 * article iterations). Distinct `r` prefix so it never collides with the
 * per-iteration `ch{N}__…` keys.
 */
export function rangeKey(
  videoId: string,
  startSec: number,
  endSec: number,
  precise: boolean,
): string {
  const suffix = precise ? "_precise" : "";
  return `clips/${videoId}/r${startSec}-${endSec}${suffix}.mp4`;
}

/** ASCII, filesystem-safe slug of a chapter theme for download filenames. */
export function slugify(input: string): string {
  const map: Record<string, string> = {
    č: "c", ć: "c", đ: "d", š: "s", ž: "z",
    Č: "c", Ć: "c", Đ: "d", Š: "s", Ž: "z",
  };
  const slug = input
    .replace(/[čćđšžČĆĐŠŽ]/g, (ch) => map[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "clip";
}
