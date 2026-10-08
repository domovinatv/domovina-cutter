/**
 * Progress page for browser navigations to a `?dl=1` clip URL.
 *
 * Opening the download link in a tab used to show a blank page for the whole
 * cold cut (the Worker holds the request until ffmpeg finishes). Instead, a
 * document navigation gets this page, which fetches the same URL with `raw=1`
 * (the actual MP4 stream), shows cut → download progress, and then:
 *   - mobile: offers the Web Share sheet with the file itself (WhatsApp,
 *     Telegram, "Save Video" to Photos, …) plus a plain file download;
 *   - desktop: triggers the download automatically.
 *
 * Programmatic clients (Flutter http, curl, <video>) never send
 * `Sec-Fetch-Dest: document`, so they keep getting the MP4 directly.
 */

/** True for a top-level browser navigation (not fetch / XHR / <video>). */
export function isDocumentNavigation(req: Request): boolean {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  // Browsers without Fetch Metadata: fall back to the Accept header.
  return (req.headers.get("accept") ?? "").includes("text/html");
}

// The source video runs ~27 KB/s (see domovina.ai ClipService), so duration
// gives a good size estimate before the first byte arrives.
const BYTES_PER_SECOND = 27000;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
}

function clock(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function renderDownloadPage(opts: {
  title: string;
  filename: string;
  startSec: number;
  endSec: number;
  rawUrl: string;
  shareUrl: string;
}): Response {
  const { title, filename, startSec, endSec, rawUrl, shareUrl } = opts;
  const durationSec = endSec - startSec;
  const minutes = Math.max(1, Math.round(durationSec / 60));
  const estMb = Math.max(1, Math.round((durationSec * BYTES_PER_SECOND) / 1e6));
  const config = JSON.stringify({
    rawUrl,
    shareUrl,
    filename: `${filename}.mp4`,
    title,
    estBytes: durationSec * BYTES_PER_SECOND,
  }).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#002F6C">
<title>${escapeHtml(title)} · DOMOVINA.ai</title>
<style>
  :root {
    --bg: #f4f6fa; --card: #ffffff; --text: #0e1726; --muted: #5b6577;
    --brand: #002F6C; --brand-ink: #ffffff; --accent: #FF0000;
    --track: #e3e8f0; --border: #e3e8f0; --error: #b42318;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b1220; --card: #131c2e; --text: #eef2f8; --muted: #9aa6ba;
      --brand: #3d7be0; --brand-ink: #ffffff; --track: #24304a;
      --border: #24304a; --error: #ff8a80;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background: var(--bg); color: var(--text);
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; min-height: 100dvh;
    padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
  }
  .card {
    width: 100%; max-width: 440px; background: var(--card);
    border: 1px solid var(--border); border-radius: 20px; padding: 28px 24px;
    box-shadow: 0 10px 30px rgba(0, 20, 60, .08);
  }
  .brand { font-weight: 800; letter-spacing: .04em; font-size: 14px; margin-bottom: 20px; }
  .brand span { color: var(--accent); }
  .kicker { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  h1 { font-size: 20px; line-height: 1.3; margin: 4px 0 6px; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
  .status { display: flex; align-items: center; gap: 12px; font-weight: 600; min-height: 28px; }
  .spinner {
    width: 22px; height: 22px; flex: none; border-radius: 50%;
    border: 3px solid var(--track); border-top-color: var(--brand);
    animation: spin .9s linear infinite;
  }
  .done-dot, .err-dot {
    width: 22px; height: 22px; flex: none; border-radius: 50%; display: none;
    color: #fff; font-size: 14px; line-height: 22px; text-align: center;
  }
  .done-dot { background: #12b76a; }
  .err-dot { background: var(--error); }
  [data-state="ready"] .spinner, [data-state="error"] .spinner { display: none; }
  [data-state="ready"] .done-dot { display: block; }
  [data-state="error"] .err-dot { display: block; }
  .hint { color: var(--muted); font-size: 14px; margin: 6px 0 0 34px; min-height: 20px; }
  .bar { height: 6px; background: var(--track); border-radius: 99px; overflow: hidden; margin: 18px 0 4px; }
  .bar > div { height: 100%; width: 0; background: var(--brand); border-radius: 99px; transition: width .2s; }
  [data-state="cutting"] .bar > div {
    width: 35%; animation: indet 1.4s ease-in-out infinite;
  }
  .actions { display: none; flex-direction: column; gap: 10px; margin-top: 22px; }
  [data-state="ready"] .actions, [data-state="error"] .actions { display: flex; }
  button, .btn {
    appearance: none; border: 0; border-radius: 14px; padding: 15px 18px;
    font: inherit; font-weight: 600; text-align: center; text-decoration: none;
    cursor: pointer; display: block; width: 100%;
  }
  .primary { background: var(--brand); color: var(--brand-ink); }
  .secondary { background: transparent; color: var(--text); border: 1px solid var(--border); }
  [hidden] { display: none !important; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes indet { 0% { transform: translateX(-100%); } 100% { transform: translateX(290%); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner, [data-state="cutting"] .bar > div { animation-duration: 3s; }
  }
</style>
</head>
<body>
<main class="card" id="app" data-state="cutting">
  <div class="brand">DOMOVINA<span>.ai</span></div>
  <div class="kicker">Isječak · ${clock(startSec)}–${clock(endSec)}</div>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">MP4 · ~${estMb} MB · ${minutes} min</div>

  <div class="status" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <div class="done-dot" aria-hidden="true">✓</div>
    <div class="err-dot" aria-hidden="true">!</div>
    <span id="label">Izrezujem isječak…</span>
  </div>
  <div class="hint" id="hint">Prvi put može potrajati do minute. Ne zatvaraj ovu karticu.</div>
  <div class="bar"><div id="fill"></div></div>

  <div class="actions">
    <button class="primary" id="share" hidden>Pošalji ili spremi video</button>
    <a class="btn primary" id="save" hidden>Preuzmi datoteku</a>
    <button class="secondary" id="shareLink" hidden>Podijeli poveznicu</button>
    <button class="primary" id="retry" hidden>Pokušaj ponovno</button>
  </div>
  <noscript><p><a href="${escapeHtml(rawUrl)}">Preuzmi isječak</a></p></noscript>
</main>
<script>
(() => {
  const cfg = ${config};
  const $ = (id) => document.getElementById(id);
  const app = $("app"), label = $("label"), hint = $("hint"), fill = $("fill");
  const shareBtn = $("share"), saveLink = $("save"), linkBtn = $("shareLink"), retryBtn = $("retry");
  const mobile = matchMedia("(pointer: coarse)").matches;
  let file = null, blobUrl = null, timer = null;

  const mb = (n) => (n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(".", ",") + " MB";
  const set = (state, text, sub) => {
    app.dataset.state = state;
    label.textContent = text;
    hint.textContent = sub || "";
  };

  async function run() {
    [shareBtn, saveLink, linkBtn, retryBtn].forEach((el) => (el.hidden = true));
    fill.style.width = "";
    set("cutting", "Izrezujem isječak…", "Prvi put može potrajati do minute. Ne zatvaraj ovu karticu.");
    const t0 = Date.now();
    timer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      if (s >= 3) hint.textContent = "Izrezujem iz cijele epizode… " + s + " s";
    }, 1000);

    try {
      // The Worker answers only once the clip exists on R2, so the response
      // headers arriving = cut finished; the body is the download itself.
      const res = await fetch(cfg.rawUrl);
      clearInterval(timer);
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || "HTTP " + res.status);

      const total = Number(res.headers.get("content-length")) || cfg.estBytes;
      set("downloading", "Preuzimam…", "0 %");
      const chunks = [];
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        const pct = Math.min(100, Math.round((got / total) * 100));
        fill.style.width = pct + "%";
        hint.textContent = pct + " % · " + mb(got) + " / " + mb(total);
      }
      fill.style.width = "100%";
      file = new File(chunks, cfg.filename, { type: "video/mp4" });
      blobUrl = URL.createObjectURL(file);
      ready();
    } catch (err) {
      clearInterval(timer);
      console.error("clip failed:", err);
      fill.style.width = "0";
      set("error", "Izrezivanje nije uspjelo", "Pokušaj ponovno za trenutak.");
      retryBtn.hidden = false;
    }
  }

  function ready() {
    saveLink.href = blobUrl;
    saveLink.download = cfg.filename;
    saveLink.hidden = false;
    const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] }));

    if (canShareFile) {
      shareBtn.hidden = false;
      // On phones the share sheet is the main path (WhatsApp, Spremi video…).
      if (mobile) {
        saveLink.className = "btn secondary";
        set("ready", "Isječak je spreman", mb(file.size) + " · pošalji ga u WhatsApp ili spremi u Fotografije.");
        return;
      }
      shareBtn.className = "secondary";
    } else if (navigator.share) {
      linkBtn.hidden = false;
    }

    if (mobile) {
      set("ready", "Isječak je spreman", mb(file.size));
    } else {
      // Desktop: keep the old behaviour — the file just lands in Downloads.
      saveLink.click();
      saveLink.textContent = "Preuzmi ponovno";
      set("ready", "Preuzimanje je pokrenuto", mb(file.size) + " · " + cfg.filename);
    }
  }

  shareBtn.addEventListener("click", async () => {
    try {
      await navigator.share({ files: [file], title: cfg.title });
    } catch (err) {
      if (err && err.name === "AbortError") return; // user closed the sheet
      // Some targets reject files — fall back to sharing the link.
      try { await navigator.share({ url: cfg.shareUrl, title: cfg.title }); } catch (_) {}
    }
  });
  linkBtn.addEventListener("click", () =>
    navigator.share({ url: cfg.shareUrl, title: cfg.title }).catch(() => {}),
  );
  retryBtn.addEventListener("click", run);

  run();
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      vary: "Accept, Sec-Fetch-Dest",
    },
  });
}
