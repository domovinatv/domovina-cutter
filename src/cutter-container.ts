import { Container } from "@cloudflare/containers";
import type { Env } from "./index";

/**
 * Cloudflare Container running ffmpeg. It cuts a chapter from the source video
 * (HTTP-range seek, no full download) and uploads the resulting mp4 straight to
 * R2 via the S3 API — the clip bytes never pass through the Worker (avoids the
 * 128 MB Worker memory ceiling for 50–150 MB clips).
 *
 * R2 S3 credentials come from Worker secrets on `env` and are injected into the
 * container process as env vars.
 */
export class CutterContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "10m";
  // ffmpeg pulls from cdn.domovina.ai and pushes to r2.cloudflarestorage.com.
  enableInternet = true;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    // Pass R2 S3 credentials + target bucket down to the container process.
    this.envVars = {
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID ?? "",
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
      R2_BUCKET: "cdn-domovina-ai",
    };
  }
}
