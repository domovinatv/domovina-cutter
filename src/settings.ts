// Vlasnikove postavke kanala (lanac `postavke-kanala` u domovina.ai, S8).
//
// Cutter ne reže (ni ne preusmjerava na već izrezan isječak) kad kanal
// epizode ima isključen `share_clips`, `cdn_playback` ili `article_summary`,
// ili je povučen/obrisan. Izvor: katalog `GET /api/katalog/v1/settings`
// (samo UC-ovi s barem jednim isključenim ključem ili tombstoneom; UC kojeg
// nema = sve uključeno, nepoznat ključ = uključen).
//
// Cutter je ČITAČ: kad postavke nisu dostupne, ne blokira (fail-open) i
// logira. Već izrezan isječak na CDN-u ostaje (sakriti ≠ obrisati).
//
// Modul je bez ovisnosti (ni Hono ni ./article) da ga `node --test` vrti
// izravno, bez mreže.

export const KEYS = [
  "channel_enabled", "processing", "home_featured", "in_app_search", "search_engines",
  "push_notifications", "cdn_playback", "share_clips", "ebook", "article_summary",
  "transcript_subtitles", "english_translation", "magisterium", "highlights_reels",
  "persons_mentions", "news_portal", "ai_assistants", "donations", "paid_sponsor_moments",
  "sponsors_in_video",
] as const;

const AI_KEYS = [
  "article_summary", "transcript_subtitles", "english_translation", "magisterium",
  "highlights_reels", "persons_mentions", "news_portal", "ai_assistants",
];
const ARTICLE_DEPENDENTS = ["ebook", "magisterium", "english_translation", "share_clips", "news_portal"];

/** Ključevi bez kojih cutter ne smije izrezati ni preusmjeriti na isječak. */
export const CLIP_KEYS = ["share_clips", "cdn_playback", "article_summary"] as const;

export const DEFAULT_SETTINGS_URL = "https://domovina.ai/api/katalog/v1/settings";
export const SETTINGS_TTL_MS = 60_000;
/** Nakon neuspjelog dohvata ne pokušavaj ponovno na svaki zahtjev. */
export const SETTINGS_RETRY_MS = 15_000;
const FETCH_TIMEOUT_MS = 3_000;

/**
 * Preslika `closeOff` iz fetch.domovina.tv/lib/channel_settings.js (master →
 * sve; transkript → AI; članak → ovisni). Mijenja se ondje i ovdje zajedno.
 */
export function closeOff(off: readonly string[], status: string): Set<string> {
  const known: readonly string[] = KEYS;
  const s = new Set(off.filter((k) => known.includes(k)));
  if (status === "withdrawn" || status === "deleted" || s.has("channel_enabled")) return new Set(KEYS);
  if (s.has("transcript_subtitles")) AI_KEYS.forEach((k) => s.add(k));
  if (s.has("article_summary")) ARTICLE_DEPENDENTS.forEach((k) => s.add(k));
  return s;
}

export interface ChannelState {
  status: string;
  off: Set<string>;
}

/** UC → stanje (zatvoren `off`). Baca na krivom obliku odgovora. */
export function parseSettings(body: unknown): Map<string, ChannelState> {
  const settings = (body as { settings?: unknown } | null)?.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("neispravan odgovor kataloga (nema objekta settings)");
  }
  const out = new Map<string, ChannelState>();
  for (const [uc, raw] of Object.entries(settings as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as { status?: unknown; off?: unknown };
    const status = typeof v.status === "string" ? v.status : "active";
    const off = Array.isArray(v.off) ? v.off.filter((k): k is string => typeof k === "string") : [];
    out.set(uc, { status, off: closeOff(off, status) });
  }
  return out;
}

export interface Block {
  status: 403 | 410;
  error: string;
  reason: string;
}

/** Odluka za jedan kanal; `null` = smije. */
export function clipBlock(state: ChannelState | undefined): Block | null {
  if (!state) return null;
  if (state.status === "deleted") {
    return { status: 410, error: "channel_deleted", reason: "Kanal je uklonjen s DOMOVINA.ai na zahtjev vlasnika." };
  }
  if (state.status === "withdrawn" || state.off.has("channel_enabled")) {
    return { status: 403, error: "channel_withdrawn", reason: "Vlasnik je povukao kanal s DOMOVINA.ai." };
  }
  const key = CLIP_KEYS.find((k) => state.off.has(k));
  if (key === undefined) return null;
  return { status: 403, error: `setting_off:${key}`, reason: "Vlasnik kanala je isključio isječke ove epizode." };
}

// ------------------------------------------------------------------ dohvat

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface Snapshot {
  at: number;
  map: Map<string, ChannelState> | null;
}

/**
 * Postavke s memorijskim cacheom po izolatu (~60 s). Na grešku vraća zadnju
 * dobru snimku ako postoji, inače `null` (fail-open); grešku logira i ne
 * pokušava ponovno kraće od `SETTINGS_RETRY_MS`.
 */
export class SettingsCache {
  private snap: Snapshot | null = null;
  private lastGood: Map<string, ChannelState> | null = null;
  private inflight: Promise<Map<string, ChannelState> | null> | null = null;

  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly log: (msg: string) => void;

  // Bez parameter propertyja: `node --test` vrti ovaj modul strip-only.
  constructor(url: string, fetchImpl: FetchLike, log: (msg: string) => void = (m) => console.error(m)) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  async get(now = Date.now()): Promise<Map<string, ChannelState> | null> {
    const s = this.snap;
    if (s) {
      const ttl = s.map ? SETTINGS_TTL_MS : SETTINGS_RETRY_MS;
      if (now - s.at < ttl) return s.map ?? this.lastGood;
    }
    this.inflight ??= this.load(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(now: number): Promise<Map<string, ChannelState> | null> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const map = parseSettings(await res.json());
      this.snap = { at: now, map };
      this.lastGood = map;
      return map;
    } catch (e) {
      this.snap = { at: now, map: null };
      this.log(
        `postavke kanala nedostupne (${this.url}): ${e instanceof Error ? e.message : String(e)}; ` +
          (this.lastGood ? "koristim zadnju dobru snimku" : "ne blokiram (fail-open)"),
      );
      return this.lastGood;
    }
  }
}

/** Minimalno sučelje R2 bindinga koje treba čitanje `info.json`. */
export interface InfoSource {
  get(key: string): Promise<{ json<T>(): Promise<T> } | null>;
}

/**
 * UC epizode iz `data/<id>/info.json` (`channel_id`), kroz R2 binding — ne
 * preko javnog CDN-a, koji cachira 404. Datoteka je immutable, pa se UC pamti
 * u izolatu. Nečitljivo/bez UC-a = `null` (ne blokira).
 */
export class EpisodeChannelCache {
  private readonly ucs = new Map<string, string | null>();
  private readonly log: (msg: string) => void;
  constructor(log: (msg: string) => void = (m) => console.error(m)) {
    this.log = log;
  }

  async uc(source: InfoSource, videoId: string): Promise<string | null> {
    if (this.ucs.has(videoId)) return this.ucs.get(videoId) ?? null;
    let uc: string | null = null;
    try {
      const obj = await source.get(`data/${videoId}/info.json`);
      if (!obj) return null; // može stići kasnije; ne pamti promašaj
      const info = await obj.json<{ channel_id?: unknown }>();
      uc = typeof info.channel_id === "string" && info.channel_id ? info.channel_id : null;
    } catch (e) {
      this.log(`info.json ${videoId} nečitljiv: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (this.ucs.size > 5000) this.ucs.clear();
    this.ucs.set(videoId, uc);
    return uc;
  }
}

/** Cijela provjera za jedan zahtjev: `null` = smije rezati/preusmjeriti. */
export async function checkClipAllowed(
  videoId: string,
  settings: SettingsCache,
  channels: EpisodeChannelCache,
  info: InfoSource,
): Promise<Block | null> {
  const map = await settings.get();
  // Prazne postavke (danas na produkciji) ne traže ni info.json.
  if (!map || map.size === 0) return null;
  const uc = await channels.uc(info, videoId);
  if (!uc) return null;
  return clipBlock(map.get(uc));
}

export function blockResponse(b: Block): Response {
  return new Response(JSON.stringify({ error: b.error, reason: b.reason }), {
    status: b.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Kratko: kad vlasnik opet uključi, isječak mora proraditi bez čekanja.
      "cache-control": "no-store",
    },
  });
}
