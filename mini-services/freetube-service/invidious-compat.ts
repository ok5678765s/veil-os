/**
 * freetube-service — invidious-compat.ts
 *
 * The FreeTube program's Invidious backend pointed at a LOCAL "instance":
 * this module implements the Invidious API surface FreeTube uses, backed by
 * Piped API instances (reachable from datacenter IPs, unlike public
 * Invidious instances). Stream/thumbnail URLs returned to the renderer are
 * Piped's public proxy URLs — playable from any visitor's browser.
 *
 * Mounted under /ft-invidious (the renderer's instance setting is
 * https://freetube-instance.veil.local, rewritten to this path by the
 * browser bridge, or routed by the Next rewrite).
 */

const PIPED_INSTANCES = [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
];

/* Each piped instance fronts googlevideo through its own proxy host; the
 * video signature is minted for the path+query, not the proxy host, so a
 * URL from a gated proxy can be re-hosted on the sibling. */
const PIPED_PROXY_HOSTS: Record<string, string> = {
  "piped-proxy.ducks.party": "proxy.piped.private.coffee",
  "proxy.piped.private.coffee": "piped-proxy.ducks.party",
};

const CACHE_TTL = { list: 25_000, video: 60_000, comments: 60_000, channel: 60_000 };

/* Coherent browser fingerprint for every outbound request this service
 * makes (pooled instances, thumbnails, media passthrough). A bare undici
 * fetch — no user-agent, undici's own TLS handshake — is trivially
 * flagged and blocked by CDNs, so every fetch() below carries a real
 * browser header set. Never add a headerless fetch here. */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type CacheEntry = { at: number; body: unknown };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/* Stale-if-error pool: Google's rotating bot-gate occasionally rejects
 * /streams extraction on EVERY instance at once (minutes-long windows).
 * The last successful body per path is kept for hours — stream URLs on
 * the surviving shapes (LBRY HLS, piped-proxy progressive) don't expire
 * nearly that fast, so a once-played video keeps playing straight
 * through a gate window instead of erroring out. */
const STALE_TTL_MS = 6 * 60 * 60 * 1000;
const lastGood = new Map<string, CacheEntry>();

function rememberGood(path: string, body: unknown): void {
  lastGood.set(path, { at: Date.now(), body });
  if (lastGood.size > 400) {
    const oldest = [...lastGood.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [k] of oldest) lastGood.delete(k);
  }
}

/* Background self-heal: when a /streams path is fully gated, keep probing
 * it every ~20s (up to 45 minutes) OUTSIDE the user's request. When the
 * gate reopens, the fresh body lands in lastGood + the normal cache — so
 * the user's next "press play again" gets a real answer instead of the
 * same error. (Window extended from 10min: the per-video gate rotates on
 * minute-to-hour scales, and the longer arc catches far more of them.) */
const RETRY_MS = 20_000;
const RETRY_WINDOW_MS = 45 * 60_000;
const retryQueue = new Map<string, number>(); // path → first-failure time

function scheduleBackgroundRetry(path: string): void {
  if (!/\/streams\//.test(path)) return; // only video playback data
  if (!retryQueue.has(path)) {
    retryQueue.set(path, Date.now());
    console.log(`[invidious] queued background retry for ${path}`);
  }
  if (retryTimer) return;
  retryTimer = setTimeout(runBackgroundRetries, RETRY_MS);
  retryTimer.unref?.();
}

/** Landing-page warm-up: queue background probes for the trending list's
 * videos that are not playable yet. The first visitor's page load starts
 * the heal; by the time they click, many ids have landed in the pool —
 * "videos never load" becomes "most videos load a minute in". */
function warmTrending(ids: string[]): void {
  let queued = 0;
  for (const id of ids) {
    if (queued >= 14) break;
    if (!id || cache.has(`v:${id}`) || lastGood.has(`/streams/${id}`)) continue;
    scheduleBackgroundRetry(`/streams/${id}`);
    queued++;
  }
}
const videoIdOfStreamsPath = (path: string): string | null => {
  const m = /\/streams\/([\w-]{6,})$/.exec(path);
  return m ? m[1] : null;
};
let retryTimer: ReturnType<typeof setTimeout> | null = null;

async function runBackgroundRetries(): Promise<void> {
  retryTimer = null;
  const now = Date.now();
  const paths = [...retryQueue.keys()];
  for (const path of paths) {
    const since = now - (retryQueue.get(path) ?? now);
    if (since > RETRY_WINDOW_MS) {
      retryQueue.delete(path);
      continue;
    }
    if (lastGood.has(path)) {
      // healed by a normal request already
      retryQueue.delete(path);
      continue;
    }
    try {
      let body: any;
      try {
        body = await rawPipedFetch(path);
        /* A piped "heal" whose bytes don't serve (their proxy is gated,
        * the signatures died) is NOT healed — keep the queue entry so the
        * loop keeps chasing an innertube landing for this video. */
        if (body && videoIdOfStreamsPath(path) && !(await byteProbe(body))) {
          body = null;
        }
      } catch {
        /* Piped still gated — the innertube fallback is an INDEPENDENT
         * extraction path (this box's egress vs. Piped's servers), so the
         * background retry probes it too before dropping this tick. */
        const fbId = videoIdOfStreamsPath(path);
        body = fbId ? await innertubeStreamsFallback(fbId).catch(() => null) : null;
      }
      if (!body) throw new Error("still gated");
      console.log(`[invidious] background retry healed ${path}`);
      retryQueue.delete(path);
      rememberGood(path, body);
      // also refresh the API-shape cache so the next request is instant
      const vm = videoIdOfStreamsPath(path);
      if (vm) cache.set(`v:${vm}`, { at: Date.now(), body: mapVideo(vm, body) });
    } catch {
      /* still gated — try again next tick */
    }
  }
  if (retryQueue.size > 0) {
    retryTimer = setTimeout(runBackgroundRetries, RETRY_MS);
    retryTimer.unref?.();
  }
}

/* ------------------------------------------------------------------ */
/* FORCE refresh — on-demand fresh extraction for a video whose cached */
/* stream URLs have gone stale (the player hit a 403 mid-session).     */
/* Clears every cached copy, then rides the gate flap: innertube      */
/* multi-round FIRST (direct googlevideo URLs — our best shape,       */
/* minted for this box's own egress), then a fresh piped pass.        */
/* Throws when everything stays gated through the whole arc.          */
/* ------------------------------------------------------------------ */
async function refreshStreams(id: string): Promise<any> {
  cache.delete(`v:${id}`);
  lastGood.delete(`/streams/${id}`);
  console.log(`[invidious] force refresh for ${id} — riding the gate flap…`);
  /* Phase 1 — innertube, 2 rounds (~17s worst). Direct googlevideo URLs
   * are the shape that ACTUALLY plays from this box: they are minted for
   * our own egress, so the /stream proxy fetches them same-IP. */
  let it = await innertubeStreamsFallback(id, 2).catch(() => null);
  if (it && (await byteProbe(it))) {
    rememberGood(`/streams/${id}`, it);
    cache.set(`v:${id}`, { at: Date.now(), body: mapVideo(id, it) });
    return it;
  }
  /* Phase 2 — a fresh piped pass, byte-probed (its URLs ride piped's
   * public byte proxies, which are gated much harder than their API). */
  let pipedBody: any = null;
  try {
    pipedBody = await piped(`/streams/${id}`);
    if (pipedBody?.error) pipedBody = null;
  } catch {
    /* fully gated — keep riding */
  }
  if (pipedBody && (await byteProbe(pipedBody))) {
    rememberGood(`/streams/${id}`, pipedBody);
    cache.set(`v:${id}`, { at: Date.now(), body: mapVideo(id, pipedBody) });
    return pipedBody;
  }
  /* Phase 3 — the flap keeps turning and the per-video gate rotates on
   * minute scales: 4 more innertube rounds (~35s). */
  it = await innertubeStreamsFallback(id, 4).catch(() => null);
  if (it && (await byteProbe(it))) {
    rememberGood(`/streams/${id}`, it);
    cache.set(`v:${id}`, { at: Date.now(), body: mapVideo(id, it) });
    return it;
  }
  /* Only byte-playable bodies count as refreshed — a fresh-but-unplayable
   * piped body would hand the player dead URLs again. Gate it: the watch
   * view's auto-retry + relay machinery takes over, and the background
   * retry queue keeps chasing an innertube landing. */
  scheduleBackgroundRetry(`/streams/${id}`);
  throw gateError("the refresh arc finished without playable bytes");
}

/** Cheap byte-playability probe: one range request through our own /stream
 * handler (sibling-swap logic included). 200/206 = the body plays. */
async function byteProbe(body: any): Promise<boolean> {
  const streams: any[] = Array.isArray(body?.videoStreams) ? body.videoStreams : [];
  const f =
    streams.find((v) => v?.videoOnly === false && /mp4/i.test(String(v?.mimeType || ""))) ||
    streams[0];
  const u = f?.url;
  if (typeof u !== "string" || !/^https?:\/\//.test(u)) return false;
  try {
    const res = await fetch(
      `http://localhost:3031/ft-invidious/stream?u=${encodeURIComponent(u)}`,
      { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(7_000) },
    );
    await res.arrayBuffer().catch(() => {});
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

/** One raw pass over the instances (no retries, no queueing). */
async function rawPipedFetch(path: string): Promise<any> {
  for (const base of PIPED_INSTANCES) {
    try {
      const res = await fetch(base + path, {
        signal: AbortSignal.timeout(8_000),
        headers: { "user-agent": BROWSER_UA, accept: "application/json", "accept-language": "en-US,en;q=0.9" },
      });
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error(`non-JSON from ${base}`); }
      if (json && typeof json === "object" && json.error) continue;
      return json;
    } catch {
      /* next instance */
    }
  }
  throw new Error("raw pass failed");
}

function cached<T>(key: string, ttl: number, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.body as T);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = make()
    .then((body) => { cache.set(key, { at: Date.now(), body }); inflight.delete(key); return body; })
    .catch((err) => { inflight.delete(key); throw err; });
  inflight.set(key, p);
  return p as Promise<T>;
}

/** Error text the renderer's toast shows when upstream is fully gated. */
function gateError(lastErr: string): Error {
  return new Error(
    `YouTube is rate-limiting Veil's video access right now (its bot-gate hits less popular videos from server IPs; trending/popular and recently played videos still work). This video is auto-retried in the background — press play again in a minute or try another video. (${lastErr.slice(0, 120)})`
  );
}

/* ------------------------------------------------------------------ */
/* innertube fallback — keyless direct /player from this box           */
/* ------------------------------------------------------------------ */

/* Why: Google's visitor gate rotates PER EGRESS IP and PER VIDEO
 * POPULARITY. The Piped instances (ducks.party / private.coffee) fail
 * from THEIR servers while this box's own innertube calls can succeed
 * (and vice-versa) — verified live: dQw4w9WgXcQ 200 + 29 plain-URL
 * adaptive formats from here while both Piped instances handed back
 * LBRY-only degraded bodies. The fallback keeps every consumer
 * (mapVideo below + grayjay-relay's DASH/HLS builders) working by
 * synthesizing a Piped /streams-shaped body.
 *
 * Client notes (probed 2026-09-07 from this box):
 *   - ANDROID 20.10.38 (plain URLs, no signatureCipher, no deciphering)
 *   - IOS 20.14.1 (same properties, second opinion for gate windows)
 *   - older ANDROID/IOS versions (< 20.x) are FAILED_PRECONDITION-dead;
 *     TVHTML5/WEB_EMBEDDED/ANDROID_VR answer but stay LOGIN_REQUIRED,
 *     and locally-minted PO tokens (bgutil provider) do NOT clear the
 *     "Robot / Bot or Crawler" flag this box's IP carries — so no
 *     token plumbing here, just the raw keyless clients.
 *
 * Delivery: googlevideo URLs carry ip=<this box's egress>, but every
 * URL mapVideo emits is re-wrapped into the same-origin /stream proxy
 * (fetched from THIS box — the same egress that minted them), so they
 * play from any visitor's browser; the proxy's piped-proxy-host swap
 * covers the odd gated CDN host. */
type InnertubeClient = {
  label: string;
  version: string;
  ua: string;
  headerName: string;
  body: Record<string, unknown>;
};
const INNERTUBE_CLIENTS: InnertubeClient[] = [
  {
    label: "ANDROID 20.10.38",
    version: "20.10.38",
    ua: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    headerName: "3",
    body: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" },
  },
  {
    label: "IOS 20.14.1",
    version: "20.14.1",
    ua: "com.google.ios.youtube/20.14.1 (iPhone16,2; CPU OS 17_4 like Mac OS X)",
    headerName: "5",
    body: { clientName: "IOS", clientVersion: "20.14.1", deviceModel: "iPhone16,2", hl: "en" },
  },
];

/** One innertube /player attempt. Returns null when gated/unusable. */
async function innertubePlayer(id: string, client: InnertubeClient): Promise<any | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "content-type": "application/json",
        "user-agent": client.ua,
        "x-youtube-client-name": client.headerName,
        "x-youtube-client-version": client.version,
      },
      body: JSON.stringify({ context: { client: client.body }, videoId: id }),
    });
    const json: any = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return null;
    const playability = String(json?.playabilityStatus?.status || "");
    if (playability !== "OK") return null; // LOGIN_REQUIRED (bot gate) / ERROR (dead video) / UNPLAYABLE
    const sd = json.streamingData || {};
    const plainUrlFormats = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].filter(
      (f: any) => typeof f?.url === "string" && /^https?:\/\//.test(f.url)
    );
    // Live streams can answer with ONLY an HLS manifest — that is still
    // perfectly playable through the legacy player's hlsUrl path.
    if (plainUrlFormats.length === 0 && !sd.hlsManifestUrl) return null;
    return json;
  } catch {
    return null; // network/timeout — next client
  }
}

/* innertube mimeType "video/mp4; codecs=\"avc1...\"" → piped's split fields */
function splitMime(mime: unknown): { mimeType: string; codec: string | null } {
  const s = String(mime || "");
  const semi = s.indexOf(";");
  const mimeType = (semi > 0 ? s.slice(0, semi) : s).trim() || "video/mp4";
  const codecs = /codecs="?([^"\];]+)"?/.exec(s);
  return { mimeType, codec: codecs ? codecs[1].trim() : null };
}

/* ------------------------------------------------------------------ */
/* /next enrichment — related videos + likes for the fallback bodies    */
/*                                                                     */
/* The /player response (the innertube fallback's source) carries NO   */
/* related videos and NO like counts — a gated Piped window meant the   */
/* watch page showed zero recommendations and zero likes. The /next     */
/* endpoint answers from the same keyless clients and fills both:        */
/* ANDROID hands an endScreenVideoRenderer list (up-next videos), WEB    */
/* carries the segmented like/dislike counts. Both are best-effort      */
/* parallel fetches; failure keeps the /player-only body.               */
/* ------------------------------------------------------------------ */

/** Compact count text ("604", "1.2K", "27,358 watching now") → number. */
function parseCompactCount(s: unknown): number {
  const m = /([\d.]+)\s*([KMB])?/i.exec(String(s || "").replace(/[\s,]/g, ""));
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[String(m[2] || "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

/** Deep-collect every value under `key` (bounded depth, arrays included). */
function collectRenderers(o: any, key: string, depth: number, out: any[] = []): any[] {
  if (!o || typeof o !== "object" || depth > 20) return out;
  if (Array.isArray(o)) {
    for (const x of o) collectRenderers(x, key, depth + 1, out);
    return out;
  }
  if (o[key]) out.push(o[key]);
  for (const v of Object.values(o)) collectRenderers(v, key, depth + 1, out);
  return out;
}

/** The GRID's continuation token. Videos/shorts grids page from
 * richGridRenderer.contents[last].continuationItemRenderer — but the
 * SAME page also carries sectionListRenderer continuations (panel
 * targets that answer aboutChannelRenderer garbage). Deep-collecting
 * "continuationItemRenderer" returns them in DFS order and grabs the
 * wrong one half the time (verified live: the sectionList token deflected
 * to aboutChannelRenderer, the richGrid token paged 31 videos). Walk the
 * grid explicitly; only fall back to the deep collect when the page has
 * no grid at all. */
function gridContinuationToken(page: any): string | null {
  for (const g of collectRenderers(page, "richGridRenderer", 0)) {
    const contents = Array.isArray(g?.contents) ? g.contents : [];
    for (let i = contents.length - 1; i >= 0; i--) {
      const tok = contents[i]?.continuationItemRenderer?.continuationEndpoint
        ?.continuationCommand?.token;
      if (tok) return String(tok);
    }
  }
  for (const c of collectRenderers(page, "continuationItemRenderer", 0)) {
    const tok = c?.continuationEndpoint?.continuationCommand?.token;
    if (tok) return String(tok);
  }
  return null;
}

/** innertube /next endScreenVideoRenderer → a piped relatedStreams item.
 * Field shapes differ per client (WEB titles are simpleText, ANDROID uses
 * runs; bylines likewise) — every read handles both. */
function endScreenToPipedRelated(e: any): any {
  const by = e?.shortBylineText?.runs?.[0] || e?.longBylineText?.runs?.[0] || {};
  const thumb =
    (e?.thumbnail?.thumbnails || []).slice().sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url || "";
  /* duration arrives as lengthText "3:24" (web) or runs[0].text (android) */
  const lenRaw =
    e?.lengthText?.simpleText ??
    e?.lengthText?.runs?.[0]?.text ??
    e?.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText;
  const lenText = String(lenRaw ?? "");
  const durParts = lenText.split(":").map((x: string) => parseInt(x, 10));
  const duration =
    durParts.length > 0 && durParts.every((n: number) => Number.isFinite(n))
      ? durParts.reduce((acc: number, n: number) => acc * 60 + n, 0)
      : Number(e?.lengthInSeconds || 0);
  const viewsRaw = e?.shortViewCountText?.simpleText ?? e?.viewCountText?.simpleText;
  const viewsText = String(viewsRaw ?? "");
  return {
    url: "/watch?v=" + String(e?.videoId || ""),
    title: String(e?.title?.simpleText ?? e?.title?.runs?.[0]?.text ?? ""),
    thumbnail: thumb,
    uploaderName: String(by?.text || ""),
    uploaderUrl: by?.navigationEndpoint?.browseEndpoint?.browseId
      ? "/channel/" + String(by.navigationEndpoint.browseEndpoint.browseId)
      : "",
    duration,
    views: parseCompactCount(viewsText),
    uploadedDate: String(e?.publishedTimeText?.simpleText || ""),
    isShort: false,
    isLive: /watching now/i.test(viewsText),
  };
}

/** WEB /next → related videos + like/dislike counts + description in one
 * call (the /player fallback body carries none of them). Returns null
 * pieces on failure — every field is best-effort, the /player-only body
 * stays playable without them. */
async function innertubeNextEnrich(
  id: string,
): Promise<{ related: any[] | null; likes: number; dislikes: number; description: string } | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "x-youtube-client-name": "1",
        "x-youtube-client-version": "2.20240926.00.00",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20240926.00.00", hl: "en" } },
        videoId: id,
      }),
    });
    const json: any = await res.json().catch(() => null);
    if (!json || typeof json !== "object") return null;
    /* related — the WEB endScreen list carries views/duration/date (the
     * ANDROID one is leaner); "206M views"-style counts parse to numbers */
    const ess = collectRenderers(json, "endScreenVideoRenderer", 0);
    const related = ess
      .map(endScreenToPipedRelated)
      .filter((r: any) => r.title && r.url.length > 12);
    /* like/dislike counts live as buttonViewModel.title inside the
     * segmented toggle tree ("604", "1.2K") */
    const segmented = collectRenderers(json, "segmentedLikeDislikeButtonViewModel", 0)[0];
    let likes = 0;
    let dislikes = 0;
    if (segmented) {
      const find = (o: any, icon: string, depth: number): string | null => {
        if (!o || typeof o !== "object" || depth > 16) return null;
        if (Array.isArray(o)) {
          for (const x of o) {
            const r = find(x, icon, depth + 1);
            if (r) return r;
          }
          return null;
        }
        if (o.iconName === icon && typeof o.title === "string" && /\d/.test(o.title)) return o.title;
        for (const v of Object.values(o)) {
          const r = find(v, icon, depth + 1);
          if (r) return r;
        }
        return null;
      };
      likes = parseCompactCount(find(segmented, "LIKE", 0));
      dislikes = parseCompactCount(find(segmented, "DISLIKE", 0));
    }
    /* description — attributedDescription.content inside the secondary
     * info renderer (modern /next shape); plain text, runs already joined */
    let description = "";
    try {
      const sec = collectRenderers(json, "videoSecondaryInfoRenderer", 0)[0];
      const d = sec?.attributedDescription?.content;
      if (typeof d === "string") description = d;
    } catch {
      /* best-effort */
    }
    return { related: related.length > 0 ? related : null, likes, dislikes, description };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Comments via keyless WEB /next — Piped's answer stopped carrying    */
/* comment authorThumbnails ("thumbnail": "" on every instance probed),*/
/* so PFPs died site-wide on channels' comment threads. The innertube  */
/* comment payloads carry the author avatar natively; this maps them   */
/* into the SAME invidious shape mapComments produces (yt.ts and the   */
/* offline shell consume it unchanged). Replies ride innertube         */
/* continuation tokens that come straight back through this handler.   */
/* ------------------------------------------------------------------ */

async function innertubeNextCall(body: Record<string, unknown>): Promise<any | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/next?prettyPrint=false", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": WEB_INNERTUBE.ua,
        "x-youtube-client-name": "1",
        "x-youtube-client-version": WEB_INNERTUBE.version,
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: WEB_INNERTUBE.version, hl: "en" } },
        ...body,
      }),
    });
    const json: any = await res.json().catch(() => null);
    /* an EMPTY alerts array is a healthy answer — only a non-empty one
     * (a consent/age wall) invalidates the page */
    if (!json || typeof json !== "object" || (Array.isArray(json.alerts) && json.alerts.length > 0))
      return null;
    return json;
  } catch {
    return null;
  }
}

/** The comments thread's first continuation token hides inside the video
 * /next answer — under the comments engagement panel, or the
 * comment-item-section's trailing continuationItemRenderer. */
function commentsEntryPointToken(json: any): string {
  for (const p of collectRenderers(json, "engagementPanelSectionListRenderer", 0)) {
    if (String(p?.panelIdentifier || "").indexOf("engagement-panel-comments-section") === -1) continue;
    const tok = p?.content?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (typeof tok === "string" && tok.length > 20) return tok;
  }
  for (const s of collectRenderers(json, "itemSectionRenderer", 0)) {
    if (String(s?.sectionIdentifier || "") !== "comment-item-section") continue;
    for (const c of s?.contents || []) {
      const tok = c?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (typeof tok === "string" && tok.length > 20) return tok;
    }
  }
  return "";
}

/** commentThreadRenderers + the page's next token off a comments page
 * (first page reloads the results slot; deeper pages append). 2026-10-28:
 * REPLY pages carry bare commentViewModel items — no commentThreadRenderer
 * wrapper (the newer YouTube shape) — so they're collected as-is; the
 * mapper's vm lookup handles both shapes. */
function commentThreadItems(json: any): { threads: any[]; next: string } {
  const threads: any[] = [];
  let next = "";
  const grab = (items: any[]) => {
    for (const it of items || []) {
      if (it?.commentThreadRenderer) threads.push(it.commentThreadRenderer);
      else if (it?.commentViewModel) threads.push(it);
      else if (it?.continuationItemRenderer) {
        const tok = it.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (typeof tok === "string" && tok.length > 20) next = tok;
      }
    }
  };
  for (const ep of json?.onResponseReceivedEndpoints || []) {
    /* the body slot has carried both RELOAD_CONTINUATION_SLOT_BODY and
     * …_GROUP_RESULTS across client versions — don't filter: the header
     * slot's items are never commentThreadRenderers, so grabbing all
     * reload/append items is safe */
    if (ep?.reloadContinuationItemsCommand?.continuationItems)
      grab(ep.reloadContinuationItemsCommand.continuationItems);
    else if (ep?.appendContinuationItemsAction?.continuationItems)
      grab(ep.appendContinuationItemsAction.continuationItems);
  }
  return { threads, next };
}

/** The first comments page carries the sort menu ("Top comments" /
 * "Newest first") — each chip is its own first-page continuation token.
 * Returns { top, new } tokens (whichever shapes are present). */
function commentsSortTokens(json: any): { top: string; new: string } {
  const out: any = { top: "", new: "" };
  for (const hdr of collectRenderers(json, "commentsHeaderRenderer", 0)) {
    const items = hdr?.sortFilterSubmenuRenderer?.subMenuItems || [];
    for (const it of items) {
      const title = String(it?.title || "").toLowerCase();
      const tok =
        it?.serviceEndpoint?.continuationCommand?.token ||
        it?.serviceEndpoint?.getCommentsFromContinuationCommand?.token ||
        it?.continuation?.token ||
        "";
      if (!tok) continue;
      if (title.includes("newest")) out.new = String(tok);
      else if (title) out.top = String(tok);
    }
  }
  return out;
}

/* Newest-sort tokens, remembered per video for 15 minutes: YouTube's
 * comments experiment buckets rotate — the sort menu (and its "Newest
 * first" chip token) appears on some first pages and hides on others.
 * Whenever ANY first page shows the menu, the new-token is stashed here
 * so a sort=new request can still use it while the menu is hidden. */
const newestSortTokens = new Map<string, { token: string; at: number }>();
const SORT_TOKEN_TTL = 15 * 60_000;

/** A video's comment page off innertube — same invidious blob mapComments
 * returns, or null (the caller falls back to Piped). `continuation` is
 * either a next-page token (more top-level) or a replies token. `sort`
 * ("top" default | "new") swaps the first page onto the sort menu's
 * continuation — paging then stays inside that sort order. When the
 * newest token can't be found (menu hidden this bucket), the top page
 * comes back with sortApplied:false so the UI can say so honestly. */
export async function innertubeComments(
  id: string,
  continuation = "",
  sort = "",
): Promise<any | null> {
  let token = continuation;
  /* 2026-10-28 — THE REPLY BUG: YouTube's current comment shapes hand
   * out URL-ENCODED continuation tokens (base64 "==" surfaces as
   * "%3D%3D", "/" as "%2F"). Sending the encoded form back to /next
   * gets it ignored — the answer carries the video's comments page,
   * so "Show replies" rendered the TOP-LEVEL list again. Decode once
   * when the token looks percent-encoded (Piped JSON-blob nextpage
   * tokens start with "{" and pass through untouched). */
  if (token && !token.trim().startsWith("{") && /%[0-9A-Fa-f]{2}/.test(token)) {
    try {
      token = decodeURIComponent(token);
    } catch {
      /* malformed sequence — keep the raw form */
    }
  }
  let commentCount = 0;
  if (!token) {
    const next = await innertubeNextCall({ videoId: id });
    if (!next) return null;
    token = commentsEntryPointToken(next);
    if (!token) return null;
    /* the entry header carries "19K comments" / "1.1M Comments" */
    const hdr = collectRenderers(next, "commentsEntryPointHeaderRenderer", 0)[0];
    const cntText =
      hdr?.commentCount?.contentText?.runs?.[0]?.text || hdr?.commentCount?.simpleText || "";
    commentCount = parseCompactCount(cntText);
  }
  let page = await innertubeNextCall({ continuation: token });
  if (!page) return null;
  let sortApplied = true;
  /* sort switch: only on a fresh first page (no continuation) — the
   * header's "Newest first" chip token IS that sort's first page. */
  if (!continuation && sort === "new") {
    let newTok = commentsSortTokens(page).new;
    if (!newTok) {
      /* menu hidden this bucket — a token remembered from an earlier
       * menu-bearing page still unlocks the newest order */
      const cached = newestSortTokens.get(id);
      if (cached && Date.now() - cached.at < SORT_TOKEN_TTL) newTok = cached.token;
    }
    if (newTok) {
      const swapped = await innertubeNextCall({ continuation: newTok });
      /* keep the swap only when it actually carries a comments page */
      const si = swapped ? commentThreadItems(swapped) : { threads: [], next: "" };
      if (swapped && (si.threads.length > 0 || si.next)) page = swapped;
      else sortApplied = false;
    } else {
      sortApplied = false;
    }
  } else if (!continuation) {
    /* free discovery: a top-sorted first page that shows the sort menu
     * seeds the newest token for later sort=new requests */
    const newTok = commentsSortTokens(page).new;
    if (newTok) newestSortTokens.set(id, { token: newTok, at: Date.now() });
  }
  const { threads, next } = commentThreadItems(page);
  if (!threads.length && !next) return null;
  /* comment bodies ride frameworkUpdates mutations keyed by entityKey
   * ("comment:…" on some shapes, the raw commentKey on others — the
   * payload also self-carries `key`, which matches the thread's
   * commentKey) — index by every alias, then merge per thread */
  const payloads: Record<string, any> = {};
  for (const m of page?.frameworkUpdates?.entityBatchUpdate?.mutations || []) {
    const p = m?.payload?.commentEntityPayload;
    if (!p) continue;
    if (m.entityKey) payloads[String(m.entityKey)] = p;
    if (p.key) payloads[String(p.key)] = p;
  }
  const comments = threads
    .map((t: any) => {
      /* the thread links to its payload by commentKey — nested
       * commentViewModel on the thread itself (current shape), the BARE
       * commentViewModel of a reply item (reply pages, 2026-10-28), or
       * under content (older shape) */
      const vm =
        t?.commentViewModel?.commentViewModel || t?.commentViewModel || t?.content?.commentViewModel || {};
      const key = String(vm.commentKey || "");
      const p = payloads[key];
      if (!p) return null;
      /* avatar: current payloads carry author.avatarThumbnailUrl (a plain
       * yt3 URL, no file extension — e.g. "…=s88-c-k-c0x00ffffff");
       * older shapes keep avatarImage.sources[] */
      const srcs = (p?.author?.avatarImage?.sources || []).filter((s: any) => s?.url);
      const avatar =
        String(p?.author?.avatarThumbnailUrl || "") ||
        srcs.slice().sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url || "";
      const repliesTree = t?.replies?.commentRepliesRenderer || null;
      const replyTok =
        collectRenderers(repliesTree, "continuationItemRenderer", 0)[0]?.continuationEndpoint
          ?.continuationCommand?.token || null;
      /* reply count rides toolbar.replyCount ("322"); the token alone
       * still proves a thread — the button works even without a count */
      let replyCount = parseCompactCount(p?.toolbar?.replyCount);
      if (replyCount === 0 && replyTok) {
        const m = /([\d][\d,.]*\s*[KMB]?)\s*repl/i.exec(JSON.stringify(repliesTree));
        replyCount = m ? parseCompactCount(m[1]) : 1;
      }
      return {
        author: String(p?.author?.displayName || ""),
        authorThumbnails: avatar ? [{ url: avatar, width: 176, height: 176 }] : [],
        authorId: String(p?.author?.channelId || ""),
        /* text: properties.content.content (current) / content.text (older) */
        content: String(p?.properties?.content?.content || p?.content?.text || ""),
        published: 0,
        publishedText:
          String(p?.properties?.publishedTime?.text || p?.properties?.publishedTime || ""),
        likeCount: parseCompactCount(p?.toolbar?.likeCountNotliked || p?.toolbar?.likeCountLiked || ""),
        replyCount,
        replies: { replyCount, continuation: replyTok },
        pinned: collectRenderers(t, "pinnedCommentBadgeRenderer", 0).length > 0,
        verified: Boolean(p?.author?.isVerified || p?.author?.isCreator),
        authorVerified: Boolean(p?.author?.isVerified || p?.author?.isCreator),
        isOwner: false,
        isSponsor: false,
      };
    })
    .filter((c: any) => c && c.author && c.content);
  if (!comments.length && !next) return null;
  const out: any = { comments, continuation: next || null };
  if (commentCount > 0) out.commentCount = commentCount;
  else if (comments.length) out.commentCount = comments.length;
  out.videoId = id;
  /* honest degrade signal: true = the requested order is what came back;
   * false = YouTube hid the sort menu this bucket, top order returned */
  out.sortApplied = sortApplied;
  return out;
}

/* ------------------------------------------------------------------ */
/* /browse fallback — channel pages when every Piped instance is      */
/* gated with nothing cached (the "no videos on any channel" window).  */
/* Keyless WEB /browse from this box's own egress is an INDEPENDENT    */
/* gate window from Piped's servers — same reason the /player          */
/* fallback works. Verified live: home tab carries the header + the    */
/* Videos/Shorts tab params tokens; the videos tab hands 30            */
/* lockupViewModel cards (contentId, title, duration badge, view +     */
/* published rows). Synthesizes the Piped /channel shape so            */
/* mapChannel consumes it unchanged.                                   */
/* ------------------------------------------------------------------ */

const WEB_INNERTUBE = {
  ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  version: "2.20240926.00.00",
};

async function innertubeBrowse(body: Record<string, unknown>): Promise<any | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false", {
      method: "POST",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "content-type": "application/json",
        "user-agent": WEB_INNERTUBE.ua,
        "x-youtube-client-name": "1",
        "x-youtube-client-version": WEB_INNERTUBE.version,
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: WEB_INNERTUBE.version, hl: "en" } },
        ...body,
      }),
    });
    const json: any = await res.json().catch(() => null);
    if (!json || typeof json !== "object" || Array.isArray(json.alerts)) return null;
    return json;
  } catch {
    return null;
  }
}

/** "23:28" → 1408 (seconds). */
function parseLenText(s: unknown): number {
  const parts = String(s || "").split(":").map((x) => parseInt(x, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Relative age text ("10 days ago", "Streamed 2 months ago",
 * "Premiered 1 year ago") → approximate upload epoch in SECONDS.
 * Powers the channel grids' Newest/Oldest sorts + publishedAt — without
 * it every lockup card inherits "now" and the sort is meaningless. */
function parseAgeText(s: unknown): number {
  const m =
    /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(
      String(s || ""),
    );
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const secs: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000, // 30 days
    year: 31536000, // 365 days
  };
  /* MILLISECONDS — mapStreamItem divides `uploaded` by 1000 (Piped's
   * wire convention), so match it or every date lands 1000x off. */
  return Math.floor(Date.now() - n * (secs[unit] ?? 0) * 1000);
}

/** One lockupViewModel / videoRenderer / shortsLockupViewModel → a piped
 * stream item. */
function lockupToPipedItem(lu: any, chName: string, chId: string, forceShort: boolean): any {
  /* shorts lockups carry the id inside onTap.reelWatchEndpoint (and their
   * title/views ride the accessibilityText: "<title>, 29 thousand views -
   * play Short") — everything else (duration badge, metadata rows) is the
   * regular lockup path */
  const reelId = String(lu?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || "");
  const videoId = String(lu?.contentId || lu?.videoId || reelId || "");
  if (!videoId) return null;
  let title =
    String(lu?.metadata?.lockupMetadataViewModel?.title?.content || "") ||
    String(lu?.title?.runs?.[0]?.text || lu?.title?.simpleText || "");
  const sources = lu?.contentImage?.thumbnailViewModel?.image?.sources ||
    lu?.thumbnail?.thumbnails ||
    lu?.onTap?.innertubeCommand?.reelWatchEndpoint?.thumbnail?.thumbnails || [];
  const thumb = (Array.isArray(sources) ? sources : [])
    .slice()
    .sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url || "";
  /* duration rides the thumbnail badge ("23:28") on lockups, lengthText on
   * classic renderers; shorts carry no badge (they are ≤ 60s) */
  let lenText = "";
  let liveBadge = false;
  for (const ov of lu?.contentImage?.thumbnailViewModel?.overlays || []) {
    for (const b of ov?.thumbnailBottomOverlayViewModel?.badges || []) {
      const t = b?.thumbnailBadgeViewModel?.text;
      if (t && /\d/.test(String(t))) lenText = String(t);
      /* the LIVE thumbnail badge (badgeStyle …STYLE_LIVE, text "LIVE") —
       * the streams-tab items carry it instead of a duration */
      if (String(t ?? "").toUpperCase() === "LIVE") liveBadge = true;
    }
  }
  const duration = lenText
    ? parseLenText(lenText)
    : parseLenText(lu?.lengthText?.simpleText ?? lu?.lengthText?.runs?.[0]?.text);
  /* view + published rows under the lockup metadata ("88M views" / "7 days
   * ago"), or the classic viewCountText/publishedTimeText. YouTube
   * renamed the field to `metadataRows` (2025+ lockup shape) — read BOTH
   * so channel grids + their continuation pages keep their stat lines
   * (the "every card shows no views/date" bug). */
  let views = 0;
  let uploadedDate = "";
  const cmv = lu?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel;
  const rows = [
    ...((cmv?.metadataRows || []) as any[]),
    ...((cmv?.rows || []) as any[]),
  ];
  for (const r of rows) {
    for (const p of r?.metadataParts || []) {
      const t = String(p?.text?.content || "");
      if (!t) continue;
      if (/views|watching/i.test(t)) views = parseCompactCount(t);
      else if (/ago|streamed|premiered/i.test(t)) uploadedDate = t;
    }
  }
  if (!views) views = parseCompactCount(lu?.shortViewCountText?.simpleText ?? lu?.viewCountText?.simpleText);
  if (!uploadedDate) uploadedDate = String(lu?.publishedTimeText?.simpleText || "");
  /* shorts title/views from the accessibilityText when the structured
   * fields are absent */
  const acc = String(lu?.accessibilityText || "");
  if (!title && acc) {
    const m = /^(.*?),\s*([\d.,]+\s*(?:thousand|million|billion)?\s*views?)\s*-\s*play\s*Short$/i.exec(acc);
    if (m) {
      title = m[1];
      views = parseCompactCount(m[2]);
    } else if (acc.includes(" - play Short")) {
      title = acc.split(" - play Short")[0].replace(/,\s*[\d.,\s]*(thousand|million|billion)?\s*views?$/i, "");
    }
  } else if (title && acc && !views) {
    const m = /,\s*([\d.,]+\s*(?:thousand|million|billion)?\s*views?)\s*-\s*play\s*Short$/i.exec(acc);
    if (m) views = parseCompactCount(m[1]);
  }
  return {
    url: "/watch?v=" + videoId,
    title,
    thumbnail: thumb,
    uploaderName: chName,
    uploaderUrl: "/channel/" + chId,
    duration,
    views,
    uploadedDate,
    /* real (approximate) upload epoch for mapStreamItem's `published` —
     * 0 = unknown, the mapper falls back to "now" */
    uploaded: parseAgeText(uploadedDate),
    isShort: forceShort || /SHORTS/i.test(String(lu?.contentType || "")) || !!reelId,
    isLive: liveBadge || /watching now/i.test(String(lu?.shortViewCountText?.simpleText || "")),
  };
}

/** The channel's tab discovery + header from one keyless innertube home
 * browse — { name, avatarUrl, subscriberCount, description, tabs: {videos,
 * shorts, live, posts} params } (params are the browse tokens each tab
 * needs; "posts" covers the renamed Community tab). Cached 60s per channel
 * because every sub-route + the fallback share it. */
const tabDiscoveryCache = new Map<string, { at: number; body: any | null }>();
export async function innertubeChannelTabs(id: string): Promise<any | null> {
  const hit = tabDiscoveryCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.body;
  const home = await innertubeBrowse({ browseId: id });
  if (!home) {
    tabDiscoveryCache.set(id, { at: Date.now(), body: null });
    return null;
  }
  const cm = home?.metadata?.channelMetadataRenderer || {};
  const name = String(cm.title || home?.header?.pageHeaderRenderer?.pageTitle || "");
  if (!name) {
    tabDiscoveryCache.set(id, { at: Date.now(), body: null });
    return null;
  }
  const avatarUrl =
    (cm.avatar?.thumbnails || []).slice().sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url || "";
  const description = String(cm.description || "");
  /* "517M subscribers" rides the pageHeader metadata rows */
  let subscriberCount = 0;
  const metaRows =
    home?.header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel
      ?.metadataRows || [];
  for (const r of metaRows) {
    for (const p of r?.metadataParts || []) {
      const t = String(p?.text?.content || "");
      if (/subscribers?/i.test(t)) subscriberCount = parseCompactCount(t);
    }
  }
  /* tab params tokens — Videos / Shorts / Live / Posts (the renamed
   * Community tab), URL-encoded in the response */
  const tabs: Record<string, string> = {};
  for (const tr of collectRenderers(home, "tabRenderer", 0)) {
    const t = String(tr?.title || "").toLowerCase();
    const p = tr?.endpoint?.browseEndpoint?.params;
    if (!p) continue;
    if (t === "videos") tabs.videos = decodeURIComponent(String(p));
    else if (t === "shorts") tabs.shorts = decodeURIComponent(String(p));
    else if (t === "live" || t === "streams") tabs.live = decodeURIComponent(String(p));
    else if (t === "posts" || t === "community") tabs.posts = decodeURIComponent(String(p));
  }
  const body = { id, name, avatarUrl, subscriberCount, description, tabs };
  tabDiscoveryCache.set(id, { at: Date.now(), body });
  return body;
}

/** One video-ish tab page (videos / shorts / live) from innertube — the
 * tab params token comes from innertubeChannelTabs; a continuation token
 * (continuationItemRenderer) pages deeper. Returns piped-shaped stream
 * items + the next token. */
export async function innertubeLockupTab(
  id: string,
  params: string,
  continuation = "",
): Promise<{ videos: any[]; continuation: string | null } | null> {
  const page = continuation
    ? await innertubeBrowse({ continuation })
    : await innertubeBrowse({ browseId: id, params });
  if (!page) return null;
  const disc = await innertubeChannelTabs(id).catch(() => null);
  const name = String(disc?.name || "");
  const items = [
    ...collectRenderers(page, "lockupViewModel", 0),
    ...collectRenderers(page, "shortsLockupViewModel", 0),
    ...collectRenderers(page, "videoRenderer", 0),
  ]
    .map((lu: any) => lockupToPipedItem(lu, name, id, false))
    .filter((v: any) => v && v.title);
  const next = gridContinuationToken(page);
  return { videos: items, continuation: next };
}

/** One backstage post (backstagePostRenderer) → the wire shape the app
 * consumes: text, likes, comments count, published, image attachments
 * (largest thumb each) and an optional poll. */
function mapBackstagePost(pr: any, chName: string, chAvatar: string): any {
  const text = runTextOf(pr?.contentText);
  /* images: backstageImageRenderer (single) or postMultiImageRenderer (many) */
  const images: string[] = [];
  const att = pr?.backstageAttachment || null;
  if (att) {
    const all = [
      ...collectRenderers(att, "backstageImageRenderer", 0),
    ];
    if (all.length === 0 && att?.postMultiImageRenderer?.images) {
      for (const im of att.postMultiImageRenderer.images) {
        if (im?.backstageImageRenderer) all.push(im.backstageImageRenderer);
      }
    }
    for (const im of all) {
      const url = (im?.image?.thumbnails || [])
        .slice()
        .sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url;
      if (url) images.push(/^https?:/.test(url) ? url : "https:" + url);
    }
  }
  /* poll — pollRenderer inside the attachment */
  const pollR = att?.pollRenderer || null;
  let poll: any = null;
  if (pollR) {
    const choices = Array.isArray(pollR?.choices) ? pollR.choices : [];
    poll = {
      question: runTextOf(pollR?.question),
      options: choices.map((ch: any) => ({
        text: runTextOf(ch?.text),
        pct: Math.round(Number(ch?.voteRatioIfNotVoted ?? ch?.voteRatio ?? 0) * 100),
      })),
    };
  }
  /* comments count rides the reply button's text ("64") */
  let comments = 0;
  for (const b of collectRenderers(pr?.actionButtons, "buttonRenderer", 0)) {
    const t = b?.text?.simpleText;
    if (t && /^\d[\d.,]*$/.test(String(t).trim())) {
      comments = parseCompactCount(t);
      break;
    }
  }
  return {
    postId: String(pr?.postId || ""),
    author: String(runsFirst(pr?.authorText?.runs) || chName),
    avatar: chAvatar,
    published: runTextOf(pr?.publishedTimeText),
    likes: parseCompactCount(pr?.voteCount?.simpleText),
    comments,
    text,
    images,
    poll,
  };
}
function runsFirst(runs: any): string {
  return Array.isArray(runs) && runs.length ? String(runs[0]?.text || "") : "";
}
function runTextOf(ct: any): string {
  if (!ct) return "";
  if (Array.isArray(ct.runs)) return ct.runs.map((r: any) => String(r?.text || "")).join("");
  return String(ct.simpleText || "");
}

/** The Posts (community) tab page from innertube — backstage threads →
 * posts + the continuation token for "load more". */
export async function innertubePostsTab(
  id: string,
  params: string,
  continuation = "",
): Promise<{ posts: any[]; continuation: string | null } | null> {
  const page = continuation
    ? await innertubeBrowse({ continuation })
    : await innertubeBrowse({ browseId: id, params });
  if (!page) return null;
  const disc = await innertubeChannelTabs(id).catch(() => null);
  const name = String(disc?.name || "");
  const avatarAbs = String(disc?.avatarUrl || "");
  const posts = collectRenderers(page, "backstagePostThreadRenderer", 0)
    .map((t: any) => t?.post?.backstagePostRenderer)
    .filter(Boolean)
    .map((pr: any) => mapBackstagePost(pr, name, avatarAbs))
    .filter((p: any) => p.postId && (p.text || p.images.length > 0 || p.poll));
  let next: string | null = null;
  for (const c of collectRenderers(page, "continuationItemRenderer", 0)) {
    const tok = c?.continuationEndpoint?.continuationCommand?.token;
    if (tok) next = String(tok);
  }
  return { posts, continuation: next };
}

/** Channel page from innertube when Piped is fully gated (or handed back
 * an empty videos shelf). Returns a Piped /channel-shaped body {id, name,
 * avatarUrl, subscriberCount, description, relatedStreams, shorts} —
 * `shorts` is extra (the /shorts route consumes it when Piped's tab blob
 * is unavailable). */
export async function innertubeChannelFallback(id: string): Promise<any | null> {
  const disc = await innertubeChannelTabs(id);
  if (!disc) return null;
  const { name, avatarUrl, subscriberCount, description, tabs } = disc;
  const [videosTab, shortsTab] = await Promise.all([
    tabs.videos ? innertubeLockupTab(id, tabs.videos).catch(() => null) : null,
    tabs.shorts ? innertubeLockupTab(id, tabs.shorts).catch(() => null) : null,
  ]);
  const relatedStreams = (videosTab?.videos ?? []).map((v: any) => ({ ...v, isShort: false }));
  const shorts = (shortsTab?.videos ?? []).map((v: any) => ({ ...v, isShort: true }));
  return {
    id,
    name,
    avatarUrl,
    subscriberCount,
    description,
    verified: false,
    /* WEB-client token — marked so the paging route keeps it on the
     * innertube rail instead of feeding it to Piped's /nextpage */
    nextpage: itMark(videosTab?.continuation),
    relatedStreams,
    shorts,
  };
}

/** innertube /player json → a Piped /streams-shaped body. */
function innertubeToPiped(id: string, d: any): any {
  const vd = d?.videoDetails || {};
  const sd = d?.streamingData || {};
  const mf = d?.microformat?.playerMicroformatRenderer || {};

  const videoStreams: any[] = [];
  // Combined (video+audio) progressive formats → videoOnly: false entries
  for (const f of sd.formats || []) {
    if (typeof f?.url !== "string" || !/^https?:\/\//.test(f.url)) continue; // signatureCipher — never decipher
    const { mimeType, codec } = splitMime(f.mimeType);
    videoStreams.push({
      url: f.url,
      format: /webm/i.test(mimeType) ? "WEBM" : "MPEG_4",
      quality: String(f.qualityLabel || f.quality || "360p"),
      mimeType: /webm/i.test(mimeType) ? "video/webm" : "video/mp4",
      codec,
      videoOnly: false,
      bitrate: Math.round(Number(f.averageBitrate || f.bitrate || 0) / 1000), // piped uses kbps
      width: Number(f.width || 0),
      height: Number(f.height || 0),
      fps: Number(f.fps || 30),
      itag: Number(f.itag || 0),
      initStart: null,
      initEnd: null,
      indexStart: null,
      indexEnd: null,
    });
  }
  // Video-only adaptive formats → videoOnly: true entries
  for (const f of sd.adaptiveFormats || []) {
    if (typeof f?.url !== "string" || !/^https?:\/\//.test(f.url)) continue;
    const { mimeType, codec } = splitMime(f.mimeType);
    if (!/^video\//i.test(mimeType)) continue;
    videoStreams.push({
      url: f.url,
      format: /webm/i.test(mimeType) ? "WEBM" : "MPEG_4",
      quality: String(f.qualityLabel || f.quality || ""),
      mimeType: /webm/i.test(mimeType) ? "video/webm" : "video/mp4",
      codec,
      videoOnly: true,
      bitrate: Math.round(Number(f.averageBitrate || f.bitrate || 0) / 1000),
      width: Number(f.width || 0),
      height: Number(f.height || 0),
      fps: Number(f.fps || 30),
      itag: Number(f.itag || 0),
      initStart: f.initRange ? Number(f.initRange.start) : null,
      initEnd: f.initRange ? Number(f.initRange.end) : null,
      indexStart: f.indexRange ? Number(f.indexRange.start) : null,
      indexEnd: f.indexRange ? Number(f.indexRange.end) : null,
    });
  }
  const audioStreams: any[] = [];
  for (const f of sd.adaptiveFormats || []) {
    if (typeof f?.url !== "string" || !/^https?:\/\//.test(f.url)) continue;
    const { mimeType, codec } = splitMime(f.mimeType);
    if (!/^audio\//i.test(mimeType)) continue;
    audioStreams.push({
      url: f.url,
      format: /webm/i.test(mimeType) ? "WEBMA" : "M4A",
      quality: /HIGH$/i.test(String(f.audioQuality || "")) ? "HIGH" : /LOW$/i.test(String(f.audioQuality || "")) ? "LOW" : "MEDIUM",
      mimeType: /webm/i.test(mimeType) ? "audio/webm" : "audio/mp4",
      codec,
      videoOnly: false,
      bitrate: Math.round(Number(f.averageBitrate || f.bitrate || 0) / 1000),
      itag: Number(f.itag || 0),
      initStart: f.initRange ? Number(f.initRange.start) : null,
      initEnd: f.initRange ? Number(f.initRange.end) : null,
      indexStart: f.indexRange ? Number(f.indexRange.start) : null,
      indexEnd: f.indexRange ? Number(f.indexRange.end) : null,
    });
  }
  // Live streams answer with ONLY an HLS manifest — expose it as a piped-style
  // HLS entry in videoStreams (mapVideo's isHlsEntry puts it first and feeds
  // it to the legacy player's shaka path, and emits hlsUrl) instead of an
  // empty body that mapVideo would reject as "no playable formats".
  if (videoStreams.length === 0 && audioStreams.length === 0 && sd.hlsManifestUrl) {
    videoStreams.push({
      url: String(sd.hlsManifestUrl),
      format: "HLS",
      quality: "HLS",
      mimeType: "application/x-mpegurl",
      codec: null,
      videoOnly: false,
      bitrate: 0,
      width: 0,
      height: 0,
      fps: 0,
      itag: -1,
      initStart: null,
      initEnd: null,
      indexStart: null,
      indexEnd: null,
    });
  }

  const publishedMs = Date.parse(String(mf.publishDate || mf.uploadDate || ""));
  const thumb = (vd.thumbnail?.thumbnails || []).slice().sort((a: any, b: any) => (b.width || 0) - (a.width || 0))[0]?.url || "";
  const captions = (d?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((c: any) => {
    // innertube hands out fmt=srv3 (XML) tracks; mapCaption + the renderer
    // want VTT — the timedtext endpoint honors the swap (verified 200 text/vtt)
    const baseUrl = String(c?.baseUrl || "");
    const vttUrl = /[?&]fmt=/.test(baseUrl)
      ? baseUrl.replace(/([?&]fmt=)\w+/, "$1vtt")
      : baseUrl + (baseUrl.includes("?") ? "&" : "?") + "fmt=vtt";
    return {
      url: vttUrl,
      name: String(c?.name?.simpleText || c?.name?.runs?.[0]?.text || c?.languageCode || "captions"),
      code: String(c?.languageCode || "en"),
      format: "VTT",
    };
  });

  return {
    title: String(vd.title || ""),
    description: String(vd.shortDescription || ""),
    thumbnailUrl: thumb,
    uploader: String(vd.author || ""),
    uploaderUrl: "/channel/" + String(vd.channelId || ""),
    uploaderAvatar: "", // the /player response carries no channel avatar — mapVideo tolerates the empty authorThumbnails
    duration: Number(vd.lengthSeconds || 0),
    views: Number(vd.viewCount || 0),
    likes: 0, // not present in a /player response — mapVideo defaults it to 0
    dislikes: 0,
    uploadDate: publishedMs > 0 ? new Date(publishedMs).toISOString() : "", // ANDROID bodies omit microformat — cosmetic gap
    uploaded: publishedMs > 0 ? publishedMs : null,
    livestream: !!(vd.isLive || mf.liveBroadcastDetails),
    hls: sd.hlsManifestUrl ? String(sd.hlsManifestUrl) : null, // mapVideo routes this through the HLS-aware /stream proxy
    category: String(mf.category || ""),
    dash: null, // the DASH manifest is built client-side from adaptiveFormats
    relatedStreams: [], // FreeTube tolerates an empty recommendations section
    subtitles: captions,
    previewFrames: [], // storyboard spec parsing is not worth the fragility; seek-previews just stay off
    videoStreams,
    audioStreams,
    proxied: false,
    source: "veil-innertube-fallback",
  };
}

/** /streams/{id} via the direct innertube clients; null when all gated. */
async function innertubeStreamsFallback(id: string, rounds = 1): Promise<any | null> {
  /* The bot-gate FLAPS on short scales, and this box rides multiple
   * egress IPs (different connections → different source IPs → different
   * gate treatment). A multi-round loop catches both: each round re-dials
   * every client, and the backoff spreads rounds across the flap. */
  for (let round = 0; round < Math.max(1, rounds); round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 2_500));
    for (const client of INNERTUBE_CLIENTS) {
      const json = await innertubePlayer(id, client);
      if (!json) continue;
      const body = innertubeToPiped(id, json);
      if ((body.videoStreams?.length || 0) + (body.audioStreams?.length || 0) === 0 && !body.hls) continue; // empty body — try next client
      /* /next enrichment — the /player body alone carries no related videos
       * and no likes (both were silently zero through every gate window);
       * fill them from the WEB /next endpoint, best-effort. */
      const enrich = await innertubeNextEnrich(id).catch(() => null);
      if (enrich) {
        if (enrich.related) body.relatedStreams = enrich.related;
        if (enrich.likes > 0) body.likes = enrich.likes;
        if (enrich.dislikes > 0) body.dislikes = enrich.dislikes;
      }
      console.log(
        `[invidious] innertube fallback (${client.label}, round ${round + 1}/${rounds}) answered for ${id}` +
          (enrich?.related ? ` +${enrich.related.length} related` : "") +
          (enrich && enrich.likes > 0 ? ` +${enrich.likes} likes` : ""),
      );
      return body;
    }
  }
  return null;
}

/* A Piped 200 that carries ONLY combined LBRY/360p entries (no audio, no
 * video-only formats) means their extraction was gutted by the gate — the
 * innertube fallback usually still has the full adaptive ladder, so we
 * upgrade the body instead of serving the crippled one. */
function isDegradedPipedStreams(d: any): boolean {
  if (d?.error) return true;
  const hasAudio = Array.isArray(d?.audioStreams) && d.audioStreams.length > 0;
  const hasVideoOnly = Array.isArray(d?.videoStreams) && d.videoStreams.some((v: any) => v?.videoOnly === true);
  return !hasAudio && !hasVideoOnly;
}

export async function piped(path: string, pass = 0): Promise<any> {
  let lastErr = "no instances";
  // Only /streams/{id} paths have an innertube fallback (the synthesized
  // body is a /streams shape); computed once, reused at the exit points.
  const fallbackId = videoIdOfStreamsPath(path);
  // Instance order rotates per pass so both get tried first-half the time
  // (a gated instance #1 should not shadow a healthy #2 for 2 passes).
  const bases = pass % 2 === 1 ? [...PIPED_INSTANCES].reverse() : PIPED_INSTANCES;
  for (const base of bases) {
    try {
      const res = await fetch(base + path, {
        // 8s per instance: 3 passes (2 instances + backoff) stay ≈ 55s —
        // inside the server's 120s idleTimeout, and slow-gated upstreams
        // fail over quickly instead of hanging the renderer's request.
        signal: AbortSignal.timeout(8_000),
        headers: { "user-agent": BROWSER_UA, accept: "application/json", "accept-language": "en-US,en;q=0.9" },
      });
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error(`non-JSON from ${base}`); }
      if (json && typeof json === "object" && json.error) {
        lastErr = String(json.message || json.error).slice(0, 200);
        continue; // try the next instance
      }
      /* Success — but a /streams body that carries ONLY combined LBRY/
       * 360p entries (no audio, no video-only formats) means Piped's
       * extraction was gutted by the same gate. The innertube clients
       * usually still answer with the full adaptive ladder for such
       * videos, so upgrade instead of serving the crippled body. On any
       * fallback failure we keep Piped's answer — it still plays. */
      if (fallbackId && isDegradedPipedStreams(json)) {
        const upgraded = await innertubeStreamsFallback(fallbackId).catch(() => null);
        if (upgraded) {
          rememberGood(path, upgraded);
          return upgraded;
        }
      }
      rememberGood(path, json);
      return json;
    } catch (err) {
      lastErr = String((err as Error)?.message || err).slice(0, 200);
    }
  }
  // The instances' YouTube access fluctuates (Google's rotating bot-gate) —
  // two backoff retries (600ms, 1600ms) usually land on a healthier answer.
  if (pass === 0) {
    await new Promise((r) => setTimeout(r, 600));
    return piped(path, 1);
  }
  if (pass === 1) {
    await new Promise((r) => setTimeout(r, 1600));
    return piped(path, 2);
  }
  /* Innertube fallback: every Piped instance just failed for a video —
   * BEFORE serving stale data, try extracting directly from YouTube's
   * keyless innertube API with this box's own egress (an INDEPENDENT
   * gate window from Piped's servers). A fresh body beats hours-old
   * cached URLs; failure falls through to the stale pool + retry queue
   * exactly as before. */
  if (fallbackId) {
    const body = await innertubeStreamsFallback(fallbackId).catch(() => null);
    if (body) {
      rememberGood(path, body);
      return body;
    }
  }
  // Stale-if-error: every instance failed — serve the last good body when
  // it is fresh enough instead of erroring the watch page.
  const stale = lastGood.get(path);
  if (stale && Date.now() - stale.at < STALE_TTL_MS) {
    const ageMin = Math.round((Date.now() - stale.at) / 60000);
    console.log(`[invidious] all upstreams failed for ${path} (${lastErr}) — serving ${ageMin}min-old cached copy`);
    return stale.body;
  }
  // Fully gated with nothing cached: probe in the background so the user's
  // next attempt lands on fresh data when the gate reopens.
  scheduleBackgroundRetry(path);
  throw gateError(lastErr);
}

/* ------------------------------------------------------------------ */
/* field mappers (piped → invidious shapes)                            */
/* ------------------------------------------------------------------ */

const videoIdFromUrl = (u: unknown): string => {
  const m = /[?&]v=([\w-]{6,})/.exec(String(u || ""));
  return m ? m[1] : "";
};
const channelIdFromUrl = (u: unknown): string => {
  const s = String(u || "");
  const m = /\/channel\/(UC[\w-]{10,})/.exec(s) || /^UC[\w-]{10,}$/.test(s) ? [/^UC[\w-]{10,}$/.test(s) ? s : "", s] : /\/channel\/(UC[\w-]{10,})/.exec(s);
  return m ? m[1] : s.replace(/^\//, "");
};

function thumbs(pipedUrl: string | undefined): Array<{ quality: string; url: string; width: number; height: number }> {
  const url = pipedUrl || "";
  return url
    ? [
        { quality: "maxresdefault", url, width: 1280, height: 720 },
        { quality: "hqdefault", url, width: 480, height: 360 },
        { quality: "medium", url, width: 320, height: 180 },
      ]
    : [];
}

/** A piped stream item (search/trending/related/channel tab) → invidious video. */
function mapStreamItem(it: any): any {
  const videoId = videoIdFromUrl(it?.url);
  return {
    type: "video",
    isShort: !!it?.isShort,
    title: String(it?.title || ""),
    videoId,
    author: String(it?.uploaderName || it?.uploader || ""),
    authorId: channelIdFromUrl(it?.uploaderUrl),
    authorVerified: !!it?.uploaderVerified,
    videoThumbnails: thumbs(it?.thumbnail),
    description: String(it?.shortDescription || it?.description || ""),
    viewCount: Number(it?.views ?? 0),
    // Piped LIVE items carry duration -119 and uploaded 0 — render as
    // live-now (0s, now) instead of "-1:59" / "57 years ago"
    published: it?.uploaded != null && Number(it.uploaded) > 0 ? Math.floor(Number(it.uploaded) / 1000) : Math.floor(Date.now() / 1000),
    publishedText: String(it?.uploadedDate || it?.publishedText || ""),
    lengthSeconds: Math.max(0, Number(it?.duration ?? 0)),
    liveNow: !!(it?.isLive || it?.liveNow),
    isUpcoming: false,
    is3D: false,
  };
}

function mapCaption(s: any): any {
  // Invidious spec: { label, language_code, url } — url relative so the
  // app's instance-prefix + fetch shim resolve it same-origin.
  const pipedUrl = String(s?.url || "").replace(/fmt=ttml/, "fmt=vtt");
  return {
    label: String(s?.name || s?.code || "captions"),
    language_code: String(s?.code || "en"),
    url: pipedUrl ? `/ft-invidious/timedtext?u=${encodeURIComponent(pipedUrl)}` : "",
  };
}

/**
 * Wrap a CDN media URL in the same-origin stream proxy. The media
 * element's requests then carry our origin (no crossOrigin/CDN CORS
 * quirks — some Piped CDNs stall the browser media pipeline while plain
 * fetches work), and playback works from any birth origin, incl. the
 * offline file's direct app frame.
 *
 * The URL must be ABSOLUTE: the program's player does new URL(src) for
 * stream-expiry parsing, which throws on relative strings. The absolute
 * base differs per birth origin, so a placeholder stem is baked here and
 * substituted with the caller's x-veil-origin at serialization time
 * (cached bodies stay origin-agnostic).
 */
const VEIL_STEM = "__VEIL_STEM__";
const streamUrl = (u: unknown): string | null => {
  const s = String(u || "");
  return /^https?:\/\//i.test(s) ? `${VEIL_STEM}/stream?u=${encodeURIComponent(s)}` : s || null;
};

/** piped /streams/{id} → invidious /api/v1/videos/{id}. */
function mapVideo(id: string, d: any): any {
  /* Combined (video+audio) formats. The upstream gate often leaves ONLY
   * LBRY mirrors: a broken concatenated MP4 blob and a HEALTHY HLS
   * master. Put HLS entries first (the program's legacy player feeds
   * the URL + mimeType to shaka, which plays HLS natively) and drop the
   * blob variant when HLS exists — the player then picks a working
   * stream instead of the 11 GB merged file that stalls at readyState 0. */
  const isHlsEntry = (v: any) =>
    String(v?.format || "").toUpperCase() === "HLS" ||
    /mpegurl/i.test(String(v?.mimeType || "")) ||
    /\.m3u8([?#]|$)/i.test(String(v?.url || ""));
  const rawCombined = (d?.videoStreams || []).filter((v: any) => v?.videoOnly === false);
  const hasHls = rawCombined.some(isHlsEntry);
  const orderedCombined = hasHls
    ? [...rawCombined.filter(isHlsEntry), ...rawCombined.filter((v: any) => !isHlsEntry && !(String(v?.quality || "").toUpperCase() === "LBRY" && String(v?.format || "").toUpperCase() === "MP4"))]
    : rawCombined;
  const adaptive: any[] = [];
  for (const v of d?.videoStreams || []) {
    if (v?.videoOnly === false) continue;
    adaptive.push({
      itag: v?.itag ?? null,
      url: streamUrl(v?.url),
      type: v?.mimeType ? `${v.mimeType}${v.codec ? `; codecs="${v.codec}"` : ""}` : "video/mp4",
      quality: mapInvidiousQuality(v?.quality),
      qualityLabel: v?.quality ? String(v.quality) : "",
      bitrate: Number(v?.bitrate ?? 0) * 1000,
      container: v?.format?.toLowerCase() || "mp4",
      encoding: null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: v?.fps ?? null,
      audioQuality: null,
      audioSampleRate: null,
      audioChannels: null,
      // the DASH manifest builder does e.init.split("-") / e.index.split("-")
      init: v?.initStart != null && v?.initEnd != null ? `${v.initStart}-${v.initEnd}` : "0-0",
      index: v?.indexStart != null && v?.indexEnd != null ? `${v.indexStart}-${v.indexEnd}` : "0-0",
    });
  }
  for (const a of d?.audioStreams || []) {
    adaptive.push({
      itag: a?.itag ?? null,
      url: streamUrl(a?.url),
      type: a?.mimeType ? `${a.mimeType}${a.codec ? `; codecs="${a.codec}"` : ""}` : "audio/mp4",
      quality: a?.quality ? String(a.quality) : "AUDIO_QUALITY_MEDIUM",
      qualityLabel: a?.quality ? String(a.quality) : "",
      bitrate: Number(a?.bitrate ?? 0) * 1000,
      container: a?.format?.toLowerCase() || "m4a",
      encoding: null,
      audioQuality: a?.quality ? `AUDIO_QUALITY_${/high/i.test(String(a.quality)) ? "HIGH" : /low/i.test(String(a.quality)) ? "LOW" : "MEDIUM"}` : "AUDIO_QUALITY_MEDIUM",
      audioSampleRate: null,
      audioChannels: null,
      init: a?.initStart != null && a?.initEnd != null ? `${a.initStart}-${a.initEnd}` : "0-0",
      index: a?.indexStart != null && a?.indexEnd != null ? `${a.indexStart}-${a.indexEnd}` : "0-0",
    });
  }
  const formatStreams = orderedCombined.map((v: any) => {
    const hls = isHlsEntry(v);
    const w = hls ? 1280 : Number(v?.width ?? 0) || (String(v?.quality || "").match(/(\d{3,4})/)?.[1] ? Number(String(v.quality).match(/(\d{3,4})/)[1]) : 640);
    const h = hls ? 720 : Math.round((w * 9) / 16);
    return {
      itag: v?.itag ?? null,
      url: streamUrl(v?.url),
      type: hls ? "application/x-mpegurl" : (v?.mimeType || "video/mp4"),
      quality: hls ? "hd720" : mapInvidiousQuality(v?.quality),
      qualityLabel: hls ? "HLS" : (v?.quality ? String(v.quality) : ""),
      container: v?.format?.toLowerCase() || "mp4",
      // the player's legacy mapper does e.size.split("x") — never null
      size: `${w}x${h}`,
      resolution: v?.quality ? String(v.quality) : null,
    };
  });
  if (adaptive.length === 0 && formatStreams.length > 0) {
    // Gated upstreams hand back only a combined (video+audio) format —
    // expose it as an adaptive entry too: the player reads
    // adaptiveFormats[0].url for stream-expiry parsing unconditionally.
    const f = formatStreams[0];
    adaptive.push({
      itag: f.itag,
      url: f.url, // already stream-proxied above
      type: f.type,
      quality: f.quality,
      qualityLabel: f.qualityLabel,
      bitrate: 0,
      container: f.container,
      encoding: null,
      width: null,
      height: null,
      fps: null,
      audioQuality: null,
      audioSampleRate: null,
      audioChannels: null,
      init: "0-0",
      index: "0-0",
    });
  }
  if (adaptive.length === 0 && formatStreams.length === 0) {
    throw new Error("upstream returned no playable formats (gated)");
  }
  return {
    type: "video",
    title: String(d?.title || ""),
    videoId: id,
    titleHtml: String(d?.title || ""),
    videoThumbnails: thumbs(d?.thumbnailUrl),
    description: String(d?.description || ""),
    descriptionHtml: String(d?.description || ""),
    published: d?.uploaded != null ? Math.floor(Number(d.uploaded) / 1000) : Math.floor(Date.now() / 1000),
    publishedText: String(d?.uploadDate || ""),
    viewCount: Number(d?.views ?? 0),
    likeCount: Number(d?.likes ?? 0),
    dislikeCount: Number(d?.dislikes ?? 0),
    author: String(d?.uploader || ""),
    authorId: channelIdFromUrl(d?.uploaderUrl),
    authorVerified: !!d?.uploaderVerified,
    // the watch page reads authorThumbnails[1] — always emit ≥2 entries
    authorThumbnails: d?.uploaderAvatar
      ? [
          { url: d.uploaderAvatar, width: 88, height: 88 },
          { url: d.uploaderAvatar, width: 176, height: 176 },
        ]
      : [],
    subCountText: d?.uploaderSubscriberCount != null ? `${d.uploaderSubscriberCount.toLocaleString("en-US")} subscribers` : "",
    subCount: Number(d?.uploaderSubscriberCount ?? 0),
    lengthSeconds: Number(d?.duration ?? 0),
    rating: 4.5,
    liveNow: !!d?.livestream,
    isLiveContent: !!d?.livestream,
    isPostLiveDvr: false,
    isListed: true,
    isFamilyFriendly: true,
    genre: String(d?.category || ""),
    dash: d?.dash || null,
    hlsUrl: streamUrl(d?.hls) || null,
    adaptiveFormats: adaptive,
    formatStreams,
    captions: (d?.subtitles || []).map(mapCaption),
    recommendedVideos: (d?.relatedStreams || []).map(mapStreamItem),
    storyboards: (d?.previewFrames || []).map((pf: any) => ({
      url: pf?.urls?.[0] || "",
      width: pf?.width ?? null,
      height: pf?.height ?? null,
      count: pf?.count ?? -1,
      interval: pf?.fps ? Math.round(1000 / pf.fps) : 5000,
      storyboardWidth: null,
      storyboardHeight: null,
      sprites: pf?.urls || [],
    })),
  };
}

function mapInvidiousQuality(label: unknown): string {
  const s = String(label || "").toLowerCase();
  if (s.includes("1080")) return "hd1080";
  if (s.includes("1440")) return "hd1440";
  if (s.includes("2160") || s.includes("4k")) return "hd2160";
  if (s.includes("720")) return "hd720";
  if (s.includes("480")) return "large";
  if (s.includes("360")) return "medium";
  if (s.includes("240") || s.includes("144")) return "small";
  return "medium";
}

const decodeEntities = (s: string): string =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

/** piped comments → invidious comments. */
function mapComments(d: any): any {
  return {
    commentCount: Number(d?.commentCount ?? d?.comments?.length ?? 0),
    videoId: videoIdFromUrl(d?.comments?.[0]?.commentorUrl) || "",
    comments: (d?.comments || []).map((c: any) => ({
      author: String(c?.author || ""),
      authorThumbnails: [{ url: c?.thumbnail || "", width: 48, height: 48 }],
      authorId: channelIdFromUrl(c?.commentorUrl),
      content: decodeEntities(String(c?.commentText || "")),
      published: Math.floor(Date.now() / 1000),
      publishedText: String(c?.commentedTime || ""),
      likeCount: Number(c?.likeCount ?? 0),
      replyCount: Number(c?.replyCount ?? 0),
      replies: {
        replyCount: Number(c?.replyCount ?? 0),
        continuation: c?.repliesPage || null,
      },
      pinned: !!c?.pinned,
      verified: !!c?.verified,
      authorVerified: !!c?.verified,
      isOwner: false,
      isSponsor: false,
    })),
    continuation: d?.nextpage || null,
  };
}

/* ------------------------------------------------------------------ */
/* Continuation-token dialect marking. Channel continuations come from  */
/* TWO upstreams: Piped's own paging tokens (feed /nextpage/channel or  */
/* /channels/tabs) and innertube WEB-client tokens (minted by the      */
/* keyless /browse fallbacks in this file). Both are protobuf blobs    */
/* starting "4qmF" — indistinguishable by shape — but each only pages  */
/* against its own upstream (feeding a WEB token to Piped's /nextpage  */
/* 500s with a Jackson parse error; feeding a Piped token to a WEB     */
/* /browse returns the wrong tab). Every innertube-minted token is     */
/* therefore prefixed "it:" at the MINT site, and the paging routes    */
/* dispatch on it. Unprefixed = Piped.                                 */
/* ------------------------------------------------------------------ */

const IT_TOK = "it:";
const itMark = (t: string | null | undefined): string | null => (t ? IT_TOK + t : null);

/** Piped's newer channel paging dialect: /channel/:id hands nextpage as
 * a stringified PREPARED REQUEST {"url": "…", "body": "<base64 json>"}.
 * Executing it (POST the decoded body to the url) returns the next
 * innertube page — and the body's context (current clientVersion,
 * platform DESKTOP, …) is exactly what YouTube accepts. Returns the page
 * plus the decoded body so the caller can swap the continuation token
 * and re-encode the next prepared request. */
async function execPipedPrepared(
  preqStr: string,
): Promise<{ json: any; body: Record<string, any> } | null> {
  try {
    const preq = JSON.parse(preqStr);
    if (!preq || typeof preq.url !== "string" || typeof preq.body !== "string") return null;
    const body = JSON.parse(Buffer.from(preq.body, "base64").toString("utf8"));
    if (!body || typeof body !== "object") return null;
    const res = await fetch(preq.url, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA, accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => null);
    if (!json || typeof json !== "object" || Array.isArray(json.alerts)) return null;
    return { json, body };
  } catch {
    return null;
  }
}

function mapChannel(d: any): any {
  const latest = d?.latestVideos || d?.relatedStreams || [];
  return {
    author: String(d?.name || ""),
    authorId: String(d?.id || ""),
    authorThumbnails: d?.avatarUrl ? [{ url: d.avatarUrl, width: 176, height: 176 }] : [],
    authorVerified: !!d?.verified,
    subCount: Number(d?.subscriberCount ?? 0),
    subCountText: d?.subscriberCount != null ? `${d.subscriberCount.toLocaleString("en-US")} subscribers` : "",
    description: String(d?.description || ""),
    descriptionHtml: String(d?.description || ""),
    latestVideos: latest.map(mapStreamItem),
    relatedChannels: (d?.relatedChannels || []).map((rc: any) => ({
      author: String(rc?.name || ""),
      authorId: String(rc?.id || ""),
      authorThumbnails: rc?.avatarUrl ? [{ url: rc.avatarUrl, width: 176, height: 176 }] : [],
    })),
    continuation: d?.nextpage || null,
  };
}

/* ------------------------------------------------------------------ */
/* route handler                                                      */
/* ------------------------------------------------------------------ */

/** True when the host is a private/loopback/reserved target (SSRF guard). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const ip = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (h.includes(":")) {
    if (h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
    if (/^::ffff:\d+\./.test(h)) return isPrivateHost(h.replace(/^::ffff:/, ""));
    return false;
  }
  return false; // public DNS name
}

export async function handleInvidious(rawPath: string, url: URL, req?: Request): Promise<Response> {
  // FreeTube appends trailing slashes: /api/v1/search/?q=…
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  // Absolute base for the stream proxy URLs we emit — the origin the
  // BROWSER speaks to. Resolution order: x-veil-origin (set by the Next
  // ft-proxy, derived from the visitor's real page origin) → the request's
  // Referer origin → this request's own origin (direct dev access). The
  // old default (this request's origin = http://localhost:3031) left every
  // baked media URL pointing at a host only this box can reach — the
  // visitor's player spun forever while feeds/thumbnails worked.
  let stemBase = "";
  try {
    stemBase = req?.headers.get("x-veil-origin") || "";
    if (!stemBase) {
      const ref = req?.headers.get("referer");
      if (ref) {
        try {
          const ru = new URL(ref);
          if (ru.protocol === "http:" || ru.protocol === "https:") stemBase = `${ru.protocol}//${ru.host}`;
        } catch { /* unparseable referer */ }
      }
    }
    if (!stemBase && req) stemBase = new URL(req.url).origin;
  } catch {
    stemBase = "";
  }
  const stem = String(stemBase).replace(/\/$/, "") + "/ft-invidious";
  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "cache-control": "no-store",
  };
  const json = (body: unknown, statusOrHeaders: number | Record<string, string> = 200) => {
    const status = typeof statusOrHeaders === "number" ? statusOrHeaders : 200;
    const extra = typeof statusOrHeaders === "object" ? statusOrHeaders : {};
    return new Response(JSON.stringify(body).replaceAll(VEIL_STEM, stem), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
    });
  };
  const err = (msg: string, status = 500) => json({ error: msg, errorType: "api_request_failed" }, status);

  try {
    // Image proxy: /image?u=<encoded thumbnail/avatar url> — the Next
    // origin's own fetch (undici) is walled from these CDNs (the same
    // JA3/TLS gate that made curl-fetch necessary for the wallpaper
    // catalog), while THIS bun process reaches them fine. The Stream
    // section's thumbnails and channel avatars ride this path.
    if (path === "/image") {
      const u = url.searchParams.get("u");
      if (!u) return new Response("missing url", { status: 400, headers: CORS });
      let target: URL;
      try { target = new URL(u); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
      if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
        return new Response("forbidden host", { status: 403, headers: CORS });
      }
      const looksImage =
        /\.(jpe?g|png|webp|gif|ico|avif)([?#]|$)/i.test(target.pathname) ||
        /\/vi\d?\//i.test(target.pathname) ||
        /(ytimg|ggpht)\./i.test(target.hostname) ||
        /* extension-less Google user-content shapes: avatars
         * "…=s160-c-k-…", post images "…=w608-h1080-…", banners
         * "…=w1060-fcrop64=1,…" — PFPs ride these through piped-proxy */
        /=[swh]\d{1,5}(?:[-=][^/?]*)?$/i.test(target.pathname);
      if (!looksImage) return new Response("not an image path", { status: 403, headers: CORS });
      try {
        const imgHeaders = {
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          accept: "image/*,*/*",
        };
        let res = await fetch(target.href, {
          headers: imgHeaders,
          signal: AbortSignal.timeout(12_000),
          redirect: "follow",
        });
        /* Sibling proxy fallback — same trick as the /stream handler: the
         * thumbnails' query signatures are host-agnostic, and one piped
         * proxy front is sometimes gated while the other serves. */
        const swap = PIPED_PROXY_HOSTS[target.hostname.toLowerCase()];
        if (swap && (!res.ok || !res.body) && [403, 429, 500, 502, 503, 504].includes(res.status)) {
          try { await res.body?.cancel(); } catch { /* already gone */ }
          const alt = new URL(target.href);
          alt.hostname = swap;
          try {
            const res2 = await fetch(alt.href, { headers: imgHeaders, signal: AbortSignal.timeout(12_000), redirect: "follow" });
            if (res2.ok && res2.body) res = res2;
            else await res2.arrayBuffer().catch(() => {});
          } catch { /* sibling unreachable — fall through with first */ }
        }
        if (!res.ok || !res.body) {
          await res.arrayBuffer().catch(() => {});
          return new Response("upstream refused the image", { status: 502, headers: CORS });
        }
        return new Response(res.body, {
          status: 200,
          headers: {
            "content-type": res.headers.get("content-type") || "image/jpeg",
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          },
        });
      } catch {
        return new Response("image fetch failed", { status: 502, headers: CORS });
      }
    }

    // /api/v1/trending and /api/v1/popular
    if (path === "/api/v1/trending" || path === "/api/v1/popular") {
      const region = url.searchParams.get("region") || "US";
      const type = path === "/api/v1/popular" ? "popular" : (url.searchParams.get("type") || "featured");
      const body = await cached(`t:${region}:${type}`, CACHE_TTL.list, async () => {
        const d = await piped(`/trending?region=${encodeURIComponent(region)}`);
        return (Array.isArray(d) ? d : []).map(mapStreamItem);
      });
      warmTrending((Array.isArray(body) ? body : []).map((v: any) => String(v?.videoId || "")));
      return json(body);
    }

    // /api/v1/search
    if (path === "/api/v1/search" || path === "/api/v1/search/suggestions") {
      const q = url.searchParams.get("q") || "";
      if (path === "/api/v1/search/suggestions") {
        if (!q) return json({ suggestions: [] });
        try {
          const body = await cached(`sg:${q}`, CACHE_TTL.list, async () => {
            const d = await piped(`/suggestions?q=${encodeURIComponent(q)}`);
            return Array.isArray(d) ? d : [];
          });
          return json(body);
        } catch {
          return json({ suggestions: [] });
        }
      }
      const type = url.searchParams.get("type") || "video";
      const sortBy = url.searchParams.get("sort_by") || "relevance";
      const page = url.searchParams.get("page") || "1";
      if (!q) return json([]);
      const filterMap: Record<string, string> = {
        video: "videos",
        videos: "videos",
        playlist: "playlists",
        playlists: "playlists",
        channel: "channels",
        channels: "channels",
        all: "all",
        movie: "videos",
        show: "videos",
      };
      const filter = filterMap[type] || "videos";
      const key = `s:${q}:${filter}:${sortBy}:${page}`;
      const body = await cached(key, CACHE_TTL.list, async () => {
        const d = await piped(`/search?q=${encodeURIComponent(q)}&filter=${filter}`);
        const items = (d?.items || []).filter((x: any) => (filter !== "videos" && filter !== "all") || x?.type !== "channel");
        return items.map(mapStreamItem);
      });
      return json(body);
    }

    // /api/v1/videos/{id}/meta — likes + related ONLY (the /next data),
    // independent of the stream-extraction gate: the watch RELAY lane gets
    // real like counts and real up-next recommendations even while the
    // player is gated. Zeros + empty list when /next has nothing.
    const vmm = /^\/api\/v1\/videos\/([\w-]{6,})\/meta$/.exec(path);
    if (vmm) {
      const id = vmm[1];
      const body = await cached(`vmeta:${id}`, 10 * 60_000, async () => {
        const enrich = await innertubeNextEnrich(id);
        return {
          likeCount: enrich?.likes ?? 0,
          dislikeCount: enrich?.dislikes ?? 0,
          description: String(enrich?.description ?? ""),
          /* /next items carry the piped-related shape (url="/watch?v=…") —
           * mapStreamItem extracts the videoId + normalizes the fields */
          recommendedVideos: (enrich?.related ?? []).map(mapStreamItem).filter((v: any) => v.videoId),
        };
      }).catch(() => ({ likeCount: 0, dislikeCount: 0, description: "", recommendedVideos: [] }));
      return json(body);
    }

    // /api/v1/videos/{id}
    const vm = /^\/api\/v1\/videos\/([\w-]{6,})$/.exec(path);
    if (vm) {
      const id = vm[1];
      /* FORCE refresh — the on-demand self-heal lane. The watch view's
       * player calls this when its stream URLs went stale mid-session
       * (403s from expired signatures). Rides the gate flap with an
       * aggressive innertube arc; answers 503 when it stays closed. */
      if (url.searchParams.get("force") === "1") {
        try {
          const fresh = await refreshStreams(id);
          const mapped = mapVideo(id, fresh);
          cache.set(`v:${id}`, { at: Date.now(), body: mapped });
          return json(mapped, { "x-veil-playable": "1" });
        } catch (e) {
          return new Response(
            JSON.stringify({ error: "still gated", message: String((e as Error)?.message || e) }),
            { status: 503, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
          );
        }
      }
      const load = () => cached(`v:${id}`, CACHE_TTL.video, async () => {
        let d = await piped(`/streams/${id}`);
        if (!d || d.error) throw new Error(String(d?.message || d?.error || "no data"));
        /* BYTE-PROBE — the pool's invariant is "served formats actually
         * play". Piped-proxy URLs die behind Google's byte gate while
         * their API keeps answering, and stale-pool signatures expire;
         * a body that 403s is metadata, not a playable stream. One quick
         * innertube upgrade round, then gate the video (the watch view's
         * auto-retry + relay lane + our background queue take over). */
        if (!(await byteProbe(d))) {
          const up = await innertubeStreamsFallback(id, 1).catch(() => null);
          if (up && (await byteProbe(up))) {
            rememberGood(`/streams/${id}`, up);
            d = up;
          } else {
            scheduleBackgroundRetry(`/streams/${id}`);
            throw gateError("this video's stream bytes are gated upstream");
          }
        }
        return mapVideo(id, d);
      });
      /* Click-retry: a gated video gets ONE late pass ~9s in — the per-video
       * gate rotates on short scales for many ids (and the background
       * warm-up may land the body right then), so a click that would have
       * errored instantly often resolves instead. Total worst case stays
       * well inside the server's 120s idleTimeout. */
      try {
        const body = await load();
        return json(body);
      } catch (firstErr) {
        if (!/rate-limiting/i.test(String((firstErr as Error)?.message || ""))) throw firstErr;
        await new Promise((r) => setTimeout(r, 9_000));
        try {
          const body = await load();
          console.log(`[invidious] click-retry healed ${id}`);
          return json(body);
        } catch {
          throw firstErr;
        }
      }
    }

    // /api/v1/comments/{id} — ?sort_by=top (default) | new
    const cm = /^\/api\/v1\/comments\/([\w-]{6,})$/.exec(path);
    if (cm) {
      const id = cm[1];
      const continuation = url.searchParams.get("continuation");
      const sortBy = url.searchParams.get("sort_by") === "new" ? "new" : "top";
      const body = await cached(`c:${id}:${continuation || ""}:${sortBy}`, CACHE_TTL.comments, async () => {
        /* innertube first — Piped no longer carries comment authorThumbnails
         * ("thumbnail": "" on every instance), so PFPs only survive here.
         * Innertube continuation tokens (top-level pages AND reply threads)
         * come back through this same branch; Piped tokens take the piped
         * branch — each token type is self-consistent. Sort only applies
         * to the first page (paging tokens are already sort-scoped). */
        const it = await innertubeComments(id, continuation || "", sortBy).catch(() => null);
        if (it && (it.comments || []).length) return it;
        const nextpage = continuation ? `?nextpage=${encodeURIComponent(continuation)}` : "";
        const d = await piped(`/comments/${id}${nextpage}`);
        const out = mapComments(d);
        /* Piped has no comments sort — a newest ask degrades to top there */
        if (sortBy === "new") (out as any).sortApplied = false;
        return out;
      });
      return json(body);
    }

    // /api/v1/storyboards/{id} — best effort (not required for playback)
    const sm = /^\/api\/v1\/storyboards\/([\w-]{6,})$/.exec(path);
    if (sm) {
      const id = sm[1];
      try {
        const body = await cached(`sb:${id}`, 120_000, async () => {
          const d = await piped(`/streams/${id}`);
          const sbs = (d?.previewFrames || []).map((pf: any) => ({
            url: pf?.urls?.[0] || "",
            width: pf?.width ?? null,
            height: pf?.height ?? null,
            count: pf?.count ?? -1,
            interval: pf?.fps ? Math.round(1000 / pf.fps) : 5000,
            storyboardWidth: null,
            storyboardHeight: null,
            sprites: pf?.urls || [],
          }));
          return sbs;
        });
        return json(body);
      } catch {
        return json([]);
      }
    }

    // /api/v1/channels/{id}[/videos|/playlists...]
    const chm = /^\/api\/v1\/channels\/(UC[\w-]{6,}|HC[\w-]{6,})(\/videos|\/playlists|\/shorts|\/streams|\/community|\/about)?$/.exec(path);
    if (chm) {
      const id = chm[1];
      const sub = chm[2] || "";
      if (sub === "/playlists" || sub === "/about") {
        return json({ playlists: [], author: "", authorId: id });
      }
      const continuation = url.searchParams.get("continuation");
      const sortBy = url.searchParams.get("sort_by") || "newest";
      /* Shorts tab: piped's /channel/:id response carries tabs[] with the
       * shorts continuation data blob; /channels/tabs?data=<enc> returns the
       * shorts shelf (content items carry isShort: true). A `continuation`
       * (the shelf's nextpage token) pages deeper — the same data blob plus
       * &nextpage=<enc> hands the next 48 shorts. */
      if (sub === "/shorts") {
        const key = `ch:${id}:shorts:${continuation || ""}`;
        const body = await cached(key, CACHE_TTL.channel, async () => {
          let d: any;
          try {
            d = await piped(`/channel/${id}`);
          } catch (err) {
            /* every Piped instance gated — the keyless innertube /browse
             * fallback synthesizes the channel (incl. a `shorts` shelf)
             * from this box's own egress, an independent gate window */
            const fb = await innertubeChannelFallback(id).catch(() => null);
            if (fb) {
              const vids = (fb.shorts || []).map(mapStreamItem).filter((v: any) => v.videoId);
              return { author: fb.name, authorId: id, videos: vids, continuation: null };
            }
            throw err;
          }
          const tabs: any[] = Array.isArray(d?.tabs) ? d.tabs : [];
          const shortsTab = tabs.find((t: any) => String(t?.name || "").toLowerCase() === "shorts");
          if (!shortsTab?.data) {
            /* no shorts blob on the piped answer — the innertube shorts
             * tab fills the shelf instead (also covers the new upstream
             * shape where /channel/:id carries NO tabs at all) */
            const disc = await innertubeChannelTabs(id).catch(() => null);
            if (disc?.tabs?.shorts) {
              const page = await innertubeLockupTab(id, disc.tabs.shorts).catch(() => null);
              if (page) {
                const vids = page.videos.map((v: any) => ({ ...v, isShort: true })).map(mapStreamItem).filter((v: any) => v.videoId);
                return { author: disc.name, authorId: id, videos: vids, continuation: null };
              }
            }
            return { author: String(d?.name || ""), authorId: id, videos: [], continuation: null };
          }
          const dataQ = `data=${encodeURIComponent(String(shortsTab.data))}`;
          const sd = continuation
            ? await piped(`/channels/tabs?${dataQ}&nextpage=${encodeURIComponent(continuation)}`)
            : await piped(`/channels/tabs?${dataQ}`);
          const items: any[] = Array.isArray(sd?.content) ? sd.content : Array.isArray(sd?.relatedStreams) ? sd.relatedStreams : [];
          const vids = items.map(mapStreamItem).filter((v: any) => v.videoId);
          return { author: String(d?.name || ""), authorId: id, videos: vids, continuation: sd?.nextpage || null };
        });
        return json(body);
      }
      /* Live/streams tab — piped's tabs[] "live" blob when present, else
       * the keyless innertube Live tab (lockups carry the LIVE badge →
       * liveNow). A `continuation` token pages deeper on both paths. */
      if (sub === "/streams") {
        const key = `ch:${id}:streams:${continuation || ""}`;
        const body = await cached(key, CACHE_TTL.channel, async () => {
          /* piped path: home → live tab blob → /channels/tabs */
          if (!continuation) {
            try {
              const d = await piped(`/channel/${id}`);
              const tabs: any[] = Array.isArray(d?.tabs) ? d.tabs : [];
              const liveTab = tabs.find(
                (t: any) => ["live", "streams"].includes(String(t?.name || "").toLowerCase()),
              );
              if (liveTab?.data) {
                const sd = await piped(`/channels/tabs?data=${encodeURIComponent(String(liveTab.data))}`);
                const items: any[] = Array.isArray(sd?.content) ? sd.content : Array.isArray(sd?.relatedStreams) ? sd.relatedStreams : [];
                const vids = items.map(mapStreamItem).filter((v: any) => v.videoId);
                return { author: String(d?.name || ""), authorId: id, videos: vids, continuation: sd?.nextpage || null };
              }
            } catch {
              /* fall through to innertube */
            }
          }
          /* innertube path — the tab params from the discovery browse.
           * WEB-minted continuations carry the "it:" mark; bare tokens
           * are Piped tab tokens and page through /channels/tabs. */
          if (continuation && !continuation.startsWith(IT_TOK)) {
            /* Piped tab token — re-derive the live tab's data blob and
             * page Piped with it (the same wire the first page used) */
            try {
              const d0 = await piped(`/channel/${id}`);
              const tabs0: any[] = Array.isArray(d0?.tabs) ? d0.tabs : [];
              const live0 = tabs0.find(
                (t: any) => ["live", "streams"].includes(String(t?.name || "").toLowerCase()),
              );
              if (live0?.data) {
                const sd = await piped(
                  `/channels/tabs?data=${encodeURIComponent(String(live0.data))}&nextpage=${encodeURIComponent(continuation)}`,
                );
                const items: any[] = Array.isArray(sd?.content) ? sd.content : Array.isArray(sd?.relatedStreams) ? sd.relatedStreams : [];
                const vids = items.map(mapStreamItem).filter((v: any) => v.videoId);
                return { author: String(d0?.name || ""), authorId: id, videos: vids, continuation: sd?.nextpage || null };
              }
            } catch {
              /* fall through to the innertube rail below */
            }
          }
          const disc = await innertubeChannelTabs(id).catch(() => null);
          if (!disc?.tabs?.live) {
            return { author: String(disc?.name || ""), authorId: id, videos: [], continuation: null };
          }
          const page = await innertubeLockupTab(
            id,
            disc.tabs.live,
            continuation ? continuation.slice(IT_TOK.length) : "",
          ).catch(() => null);
          if (!page) return { author: disc.name, authorId: id, videos: [], continuation: null };
          const vids = page.videos.map(mapStreamItem).filter((v: any) => v.videoId);
          return { author: disc.name, authorId: id, videos: vids, continuation: itMark(page.continuation) };
        });
        return json(body);
      }
      /* Posts (community) tab — innertube only: the backstage threads →
       * posts with text/likes/comments/images/polls + continuation. */
      if (sub === "/community") {
        const key = `ch:${id}:posts:${continuation || ""}`;
        const body = await cached(key, CACHE_TTL.channel, async () => {
          const disc = await innertubeChannelTabs(id).catch(() => null);
          if (!disc?.tabs?.posts) {
            return { author: String(disc?.name || ""), authorId: id, posts: [], continuation: null };
          }
          const page = await innertubePostsTab(id, disc.tabs.posts, continuation || "").catch(() => null);
          if (!page) return { author: String(disc?.name || ""), authorId: id, posts: [], continuation: null };
          return { author: disc.name, authorId: id, posts: page.posts, continuation: page.continuation };
        });
        return json(body);
      }
      const key = `ch:${id}:${continuation || ""}:${sortBy}`;
      const body = await cached(key, CACHE_TTL.channel, async () => {
        if (continuation) {
          /* Two continuation dialects (see IT_TOK above): "it:"-prefixed
           * tokens were minted by this service's own WEB-client /browse
           * fallbacks (the EMPTY-SHELF RESCUE below, the full-channel
           * fallback, the streams tab) — they page through innertubeBrowse
           * or they die on Piped's Jackson parser. Bare tokens are Piped's
           * own — /nextpage/channel as always. */
          if (continuation.startsWith(IT_TOK)) {
            const page = await innertubeLockupTab(id, "", continuation.slice(IT_TOK.length)).catch(() => null);
            if (page) {
              const vids = page.videos.map(mapStreamItem).filter((v: any) => v.videoId);
              return { author: "", authorId: id, latestVideos: vids, continuation: itMark(page.continuation) };
            }
            return { author: "", authorId: id, latestVideos: [], continuation: null };
          }
          /* Piped's prepared-request dialect — {"url":…,"body":base64}.
           * Execute it, harvest the lockups, and hand back the NEXT
           * prepared request (same context, swapped continuation token)
           * so every later page stays in this dialect. */
          if (continuation.startsWith('{"url"')) {
            const done = await execPipedPrepared(continuation);
            if (done) {
              const vids = [
                ...collectRenderers(done.json, "lockupViewModel", 0),
                ...collectRenderers(done.json, "videoRenderer", 0),
              ]
                .map((lu: any) => lockupToPipedItem(lu, "", id, false))
                .filter((v: any) => v && v.videoId)
                .map(mapStreamItem);
              const tok = gridContinuationToken(done.json);
              let nextPreq: string | null = null;
              if (tok) {
                try {
                  nextPreq = JSON.stringify({
                    ...JSON.parse(continuation),
                    body: Buffer.from(JSON.stringify({ ...done.body, continuation: tok })).toString("base64"),
                  });
                } catch {
                  nextPreq = null;
                }
              }
              return { author: "", authorId: id, latestVideos: vids, continuation: nextPreq };
            }
            return { author: "", authorId: id, latestVideos: [], continuation: null };
          }
          const d = await piped(`/nextpage/channel/${id}?nextpage=${encodeURIComponent(continuation)}`);
          const vids = (Array.isArray(d) ? d : d?.relatedStreams || d?.latestVideos || []).map(mapStreamItem);
          return { author: "", authorId: id, latestVideos: vids, continuation: d?.nextpage || null };
        }
        let d: any;
        try {
          d = await piped(`/channel/${id}`);
        } catch (err) {
          /* every Piped instance gated with nothing stale to serve — the
           * keyless innertube /browse fallback builds the channel (header
           * + latest videos) from this box's own egress so channel pages
           * keep working through gate windows */
          const fb = await innertubeChannelFallback(id).catch(() => null);
          if (fb) d = fb;
          else throw err;
        }
        /* EMPTY-SHELF RESCUE: Piped increasingly answers /channel/:id with
         * a healthy header but ZERO latestVideos (and no tabs[]) — the
         * channel page then rendered "no videos came back". The innertube
         * videos tab fills the shelf from this box's own egress instead. */
        if (!Array.isArray(d?.latestVideos) || d.latestVideos.length === 0) {
          const disc = await innertubeChannelTabs(id).catch(() => null);
          if (disc?.tabs?.videos) {
            const page = await innertubeLockupTab(id, disc.tabs.videos).catch(() => null);
            if (page && page.videos.length > 0) {
              d = {
                ...d,
                name: d?.name || disc.name,
                relatedStreams: page.videos,
                /* WEB-minted — marked so /videos?continuation pages the
                 * innertube rail (Piped's /nextpage can't read it) */
                nextpage: itMark(page.continuation) ?? d?.nextpage ?? null,
              };
            }
          }
        }
        const mapped = mapChannel(d);
        if (sub === "/videos") {
          return { author: mapped.author, authorId: id, videos: mapped.latestVideos, continuation: mapped.continuation };
        }
        return mapped;
      });
      return json(body);
    }

    // thumbnail passthrough: /vi/... — FreeTube constructs these from the
    // instance base; Piped thumbnails are already absolute proxied URLs, so
    // items carry their own; this path is a fallback.
    const tm = /^\/vi\/([\w-]{6,})\/([\w]+)\.(jpg|webp)$/.exec(path);
    if (tm) {
      const [, id, name] = tm;
      // Browser-shaped image fetch (UA + image accept + youtube referer):
      // ytimg sees exactly what a real page load sees, not a bare bot.
      const res = await fetch(`https://i.ytimg.com/vi/${id}/${name}.jpg`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
        headers: {
          "user-agent": BROWSER_UA,
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.youtube.com/",
        },
      });
      return new Response(res.body, {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400", ...CORS },
      });
    }

    // Media stream proxy: /stream?u=<encoded CDN url> — range-aware byte
    // passthrough so the player's media element requests stay same-origin
    // (some Piped CDNs stall cross-origin media loads while range fetches
    // work fine). Only the URLs mapVideo emits point here; crafted ones
    // are constrained to public hosts + media path shapes.
    if (path === "/stream") {
      const u = url.searchParams.get("u");
      if (!u) return new Response("missing url", { status: 400, headers: CORS });
      let target: URL;
      try { target = new URL(u); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
      if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
        return new Response("forbidden host", { status: 403, headers: CORS });
      }
      const mediaPath = target.pathname + target.search;
      if (!/\/(streams|videoplayback|api\/timedtext|manifest)\b|\.(mp4|m4a|m3u8|ts|webm|vtt)\b/i.test(mediaPath)) {
        return new Response("not a media path", { status: 403, headers: CORS });
      }
      try {
        const range = req?.headers.get("range");
        const headers: Record<string, string> = {
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          accept: "*/*",
        };
        if (range) headers.range = range;
        // NOTE: no AbortSignal here — it would abort the BODY mid-stream
        // (video playback runs minutes); client cancels (seek/pause) do
        // propagate, and dead sockets are reaped by the server's idle
        // timeout.
        let res = await fetch(target.href, { headers, redirect: "follow" });
        /* Proxy-host fallback: googlevideo signatures minted by one piped
         * instance are host-agnostic, and the instance's own proxy front
         * is sometimes gated (piped-proxy.ducks.party 403s while the
         * private.coffee sibling serves the SAME path+query 206 — verified
         * live). On a failure status from a piped proxy host, re-host and
         * retry once before giving up. */
        const swap = PIPED_PROXY_HOSTS[target.hostname.toLowerCase()];
        if (swap && [403, 429, 500, 502, 503, 504].includes(res.status)) {
          try { await res.body?.cancel(); } catch { /* already gone */ }
          const alt = new URL(target.href);
          alt.hostname = swap;
          try {
            const res2 = await fetch(alt.href, { headers, redirect: "follow" });
            if (res2.status < 400) {
              res = res2;
            } else {
              try { await res2.body?.cancel(); } catch { /* keep first */ }
            }
          } catch { /* sibling unreachable — fall through with first */ }
        }
        // HLS playlists: rewrite every referenced URI (variants, segments,
        // EXT-X-MAP/EXT-X-MEDIA URI="" attrs) to resolve against the
        // ORIGINAL manifest URL and re-enter through this proxy — the
        // manifest is served from our origin, so its relative refs must
        // never leak (they would 404 against /ft-invidious/stream).
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const looksManifest = ct.includes("mpegurl") || /\.m3u8([?#]|$)/i.test(target.pathname);
        if (looksManifest && res.status === 200) {
          const text = await res.text();
          const proxied = (ref: string) => {
            try {
              const abs = new URL(ref, target).href;
              return /^https?:/i.test(abs) ? `/ft-invidious/stream?u=${encodeURIComponent(abs)}` : ref;
            } catch { return ref; }
          };
          const out = text
            .split(/\r?\n/)
            .map((line) => {
              if (!line) return line;
              if (line.startsWith("#")) {
                return line.replace(/URI="([^"]+)"/g, (_m, u1) => `URI="${proxied(u1)}"`);
              }
              return proxied(line);
            })
            .join("\n");
          return new Response(out, {
            status: 200,
            headers: { "content-type": "application/vnd.apple.mpegurl", ...CORS, "cache-control": "no-store" },
          });
        }
        const out: Record<string, string> = {
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "content-range, content-length, accept-ranges",
          "accept-ranges": res.headers.get("accept-ranges") || "bytes",
          "cache-control": "no-store",
        };
        for (const h of ["content-type", "content-length", "content-range", "etag", "last-modified"]) {
          const v = res.headers.get(h);
          if (v) out[h] = v;
        }
        if ([204, 205, 304].includes(res.status)) return new Response(null, { status: res.status, headers: out });
        return new Response(res.body, { status: res.status, headers: out });
      } catch {
        return new Response("stream fetch failed", { status: 502, headers: CORS });
      }
    }

    // timedtext proxy: /timedtext?u=<encoded piped timedtext url>
    // (the app prefixes the instance URL; the browser bridge rewrites it
    // same-origin, landing here — we stream the caption file)
    if (path === "/timedtext") {
      const u = url.searchParams.get("u");
      if (!u || !/^https:\/\/[-\w.]+\/(api\/timedtext|videoplayback)/i.test(u)) {
        return new Response("bad caption url", { status: 400, headers: CORS });
      }
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
        const ct = res.headers.get("content-type") || "text/vtt";
        return new Response(res.body, { status: res.status, headers: { "content-type": ct, "access-control-allow-origin": "*" } });
      } catch {
        return new Response("caption fetch failed", { status: 502, headers: CORS });
      }
    }

    return err(`unknown invidious endpoint: ${path}`, 404);
  } catch (e) {
    return err(String((e as Error)?.message || e), 502);
  }
}

export function isCacheHealthy(): boolean {
  return cache.size < 500;
}
