// node --test (Node ≥ 23 strip-only TypeScript), bez mreže.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockResponse,
  checkClipAllowed,
  clipBlock,
  closeOff,
  EpisodeChannelCache,
  parseSettings,
  SETTINGS_RETRY_MS,
  SETTINGS_TTL_MS,
  SettingsCache,
  type InfoSource,
} from "../src/settings.ts";

const UC = "UCrolbzqlzSeLTH624wKbtLQ";
const quiet = () => {};

function fakeFetch(bodies: (unknown | Error | number)[]) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const b = bodies.length > 1 ? bodies.shift() : bodies[0];
    if (b instanceof Error) throw b;
    if (typeof b === "number") return new Response("x", { status: b });
    return Response.json(b);
  };
  return { impl, calls };
}

function fakeInfo(files: Record<string, unknown>): InfoSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async get(key: string) {
      reads.push(key);
      if (!(key in files)) return null;
      return { json: async <T>() => files[key] as T };
    },
  };
}

const settingsBody = (s: Record<string, unknown>) => ({ version: "1", catalog: "1", settings: s, meta: { rows_read: 0 } });

test("closeOff kao u fetchu", () => {
  assert.equal(closeOff([], "withdrawn").size, 20);
  assert.ok(closeOff(["article_summary"], "active").has("share_clips"));
  assert.ok(closeOff(["transcript_subtitles"], "active").has("article_summary"));
  assert.equal(closeOff(["nepoznat"], "active").size, 0);
});

test("odluka po kanalu", () => {
  const st = (status: string, off: string[]) => parseSettings(settingsBody({ [UC]: { status, off } })).get(UC);
  assert.equal(clipBlock(undefined), null);
  assert.equal(clipBlock(st("active", ["magisterium", "home_featured"])), null);
  assert.equal(clipBlock(st("active", ["share_clips"]))?.status, 403);
  assert.equal(clipBlock(st("active", ["cdn_playback"]))?.error, "setting_off:cdn_playback");
  // article_summary zatvaranjem gasi share_clips; prvi pogodak u CLIP_KEYS.
  assert.equal(clipBlock(st("active", ["article_summary"]))?.status, 403);
  assert.equal(clipBlock(st("active", ["transcript_subtitles"]))?.status, 403);
  assert.equal(clipBlock(st("withdrawn", ["channel_enabled"]))?.error, "channel_withdrawn");
  assert.equal(clipBlock(st("active", ["channel_enabled"]))?.status, 403);
  const del = clipBlock(st("deleted", []));
  assert.equal(del?.status, 410);
  assert.equal(del?.error, "channel_deleted");
});

test("odgovor odbijanja: JSON na hrvatskom, no-store", async () => {
  const res = blockResponse({ status: 403, error: "setting_off:share_clips", reason: "Vlasnik kanala je isključio isječke ove epizode." });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.error, "setting_off:share_clips");
  assert.match(body.reason, /isječke/);
});

test("checkClipAllowed: isključen share_clips → 403, UC iz info.json kroz R2", async () => {
  const { impl } = fakeFetch([settingsBody({ [UC]: { status: "active", off: ["share_clips"] } })]);
  const info = fakeInfo({ "data/abcdefghijk/info.json": { channel_id: UC }, "data/zzzzzzzzzzz/info.json": { channel_id: "UCdrugi" } });
  const settings = new SettingsCache("http://katalog.test/v1/settings", impl, quiet);
  const channels = new EpisodeChannelCache(quiet);
  assert.equal((await checkClipAllowed("abcdefghijk", settings, channels, info))?.status, 403);
  assert.equal(await checkClipAllowed("zzzzzzzzzzz", settings, channels, info), null);
  // UC se pamti: drugi zahtjev ne čita info.json ponovno.
  await checkClipAllowed("abcdefghijk", settings, channels, info);
  assert.equal(info.reads.filter((k) => k === "data/abcdefghijk/info.json").length, 1);
});

test("checkClipAllowed: obrisan → 410; bez info.json ili bez UC-a → smije", async () => {
  const { impl } = fakeFetch([settingsBody({ [UC]: { status: "deleted", off: [], deleted_at: "2026-11-10T09:30:00Z" } })]);
  const info = fakeInfo({ "data/abcdefghijk/info.json": { channel_id: UC }, "data/bezucbezuc/info.json": {} });
  const settings = new SettingsCache("u", impl, quiet);
  const channels = new EpisodeChannelCache(quiet);
  assert.equal((await checkClipAllowed("abcdefghijk", settings, channels, info))?.status, 410);
  assert.equal(await checkClipAllowed("nemanigdjeee", settings, channels, info), null);
  assert.equal(await checkClipAllowed("bezucbezuc", settings, channels, info), null);
});

test("prazne postavke: ne čita info.json, smije (kao danas)", async () => {
  const { impl } = fakeFetch([settingsBody({})]);
  const info = fakeInfo({});
  const r = await checkClipAllowed("abcdefghijk", new SettingsCache("u", impl, quiet), new EpisodeChannelCache(quiet), info);
  assert.equal(r, null);
  assert.deepEqual(info.reads, []);
});

test("cache ~60 s: jedan dohvat unutar TTL-a, novi nakon", async () => {
  const { impl, calls } = fakeFetch([settingsBody({})]);
  const c = new SettingsCache("http://katalog.test/v1/settings", impl, quiet);
  await c.get(1_000);
  await c.get(1_000 + SETTINGS_TTL_MS - 1);
  assert.equal(calls.length, 1);
  await c.get(1_000 + SETTINGS_TTL_MS);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], "http://katalog.test/v1/settings");
});

test("fail-open: greška bez prethodne snimke → null (smije), logira, ne ponavlja odmah", async () => {
  const logs: string[] = [];
  const { impl, calls } = fakeFetch([new TypeError("network down")]);
  const c = new SettingsCache("u", impl, (m) => logs.push(m));
  assert.equal(await c.get(0), null);
  assert.equal(await c.get(SETTINGS_RETRY_MS - 1), null);
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /fail-open/);
  const r = await checkClipAllowed("abcdefghijk", c, new EpisodeChannelCache(quiet), fakeInfo({}));
  assert.equal(r, null);
});

test("greška nakon dobre snimke: zadnja dobra snimka i dalje blokira", async () => {
  const logs: string[] = [];
  const good = settingsBody({ [UC]: { status: "active", off: ["share_clips"] } });
  const { impl } = fakeFetch([good, 503, { nije: "oblik" }]);
  const c = new SettingsCache("u", impl, (m) => logs.push(m));
  assert.equal((await c.get(0))?.get(UC)?.off.has("share_clips"), true);
  assert.equal((await c.get(SETTINGS_TTL_MS))?.get(UC)?.off.has("share_clips"), true);
  assert.match(logs[0], /HTTP 503.*zadnju dobru/);
  assert.equal((await c.get(SETTINGS_TTL_MS + SETTINGS_RETRY_MS))?.has(UC), true);
  assert.match(logs[1], /neispravan odgovor/);
});
