import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const PORT = parseInt(process.env.PORT || "8080", 10);
const CLIP_CACHE = "public, max-age=31536000, immutable";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET = "cdn-domovina-ai",
  CUTTER_API_KEY, // Bearer token required on /cut (except /health)
} = process.env;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function log(...args) {
  console.log("[cutter]", new Date().toISOString(), ...args);
}

/** Build the ffmpeg argv. `-ss` before `-i` = fast keyframe seek over HTTP range. */
function ffmpegArgs({ videoUrl, startSec, durationSec, precise }) {
  const base = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(startSec),
    "-t",
    String(durationSec),
    "-i",
    videoUrl,
  ];
  const encode = precise
    ? [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "30",
        "-c:a", "aac",
        "-b:a", "128k",
      ]
    : ["-c", "copy"];
  return [...base, ...encode, "-movflags", "+faststart", "-f", "mp4"];
}

function runFfmpeg(args, outPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [...args, outPath]);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function doCut(body) {
  const { videoUrl, startSec, durationSec, key, precise } = body;
  if (!videoUrl || !key || durationSec == null || startSec == null) {
    throw new Error("missing fields");
  }
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 credentials not configured");
  }

  // Idempotency: another request may have produced this clip already.
  if (await objectExists(key)) {
    log("exists", key);
    return { ok: true, cached: true };
  }

  const outPath = `/tmp/${randomUUID()}.mp4`;
  const args = ffmpegArgs({ videoUrl, startSec, durationSec, precise });
  log("cut", key, precise ? "(precise)" : "(copy)", `${startSec}+${durationSec}s`);

  try {
    await runFfmpeg(args, outPath);
    const size = statSync(outPath).size;
    if (size === 0) throw new Error("ffmpeg produced empty file");

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: createReadStream(outPath),
        ContentLength: size,
        ContentType: "video/mp4",
        CacheControl: CLIP_CACHE,
      }),
    );
    log("uploaded", key, `${size} bytes`);
    return { ok: true, size };
  } finally {
    await unlink(outPath).catch(() => {});
  }
}

// Single-flight: coalesce concurrent identical cut requests in-process.
const inflight = new Map();
function handleCut(body) {
  const key = body.key;
  if (inflight.has(key)) return inflight.get(key);
  const p = doCut(body).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!CUTTER_API_KEY) return true; // auth disabled if no key set
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${CUTTER_API_KEY}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url.pathname === "/cut") {
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const result = await handleCut(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", msg);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => log(`listening on :${PORT}`));
