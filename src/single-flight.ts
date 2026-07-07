import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export interface CutRequest {
  videoUrl: string;
  startSec: number;
  durationSec: number;
  key: string;
  precise: boolean;
}

interface CutResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Per-clip-key single-flight lock. Addressed via getByName(key), so all
 * concurrent requests for the same not-yet-cut clip land on one instance and
 * share a single ffmpeg run instead of triggering N duplicate cuts.
 */
export class SingleFlight extends DurableObject<Env> {
  private inflight: Promise<CutResult> | null = null;

  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as CutRequest;

    // Double-check R2 — the clip may have been produced since the Worker's head().
    const existing = await this.env.CLIPS.head(body.key);
    if (existing) return Response.json({ ok: true, status: 200 });

    if (!this.inflight) {
      this.inflight = this.runCut(body).finally(() => {
        this.inflight = null;
      });
    }
    const result = await this.inflight;
    return Response.json(result, { status: result.ok ? 200 : result.status });
  }

  private async runCut(body: CutRequest): Promise<CutResult> {
    try {
      const container = this.env.CUTTER.getByName(body.key);
      await container.startAndWaitForPorts();
      const res = await container.containerFetch("http://cutter/cut", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, status: 502, error: detail.slice(0, 500) };
      }
      return { ok: true, status: 200 };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
