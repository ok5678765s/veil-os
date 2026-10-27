/**
 * Quasar YouTube Fix (v1.3.8)
 * ---------------------------
 * Why: YouTube's proxied embed player fails its own auth checks inside a
 * rewriting proxy (BotGuard/poToken) and reports "Video unavailable" — a
 * wall for every proxy that re-serves YouTube's player JS.
 *
 * Fix: Quasar stops proxying YouTube *player pages* entirely and serves its
 * own branded pages instead. The video itself is played by YouTube's
 * `youtube-nocookie.com` embed, loaded DIRECTLY by the user's browser —
 * outside the tunnel — so playback works with no auth errors and without
 * the ad-heavy watch page. Search results are scraped server-side from
 * YouTube's static `ytInitialData` payload and rendered as a fast grid.
 *
 *   /watch?v=ID · /shorts/ID · /embed/ID · youtu.be/ID  → custom player
 *   /playlist?list=…                                    → playlist player
 *   /results?search_query=…                             → custom search
 *   / (root)                                            → portal page
 *   everything else (channels, feeds…)                  → normal proxy flow
 */

import { CODEC_SOURCE, proxyPath } from "./codec-server";
import { QUASAR_VERSION } from "./version";

const YT_ORIGIN = "https://www.youtube.com";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* Special-page detection                                              */
/* ------------------------------------------------------------------ */

export type YoutubeSpecial =
  | { kind: "watch"; videoId: string; list?: string; start?: number; target: string }
  | { kind: "search"; query: string; target: string }
  | { kind: "portal"; target: string };

function isYtHost(host: string): boolean {
  return host === "youtu.be" || host === "youtube-nocookie.com" || host === "youtube.com" || host.endsWith(".youtube.com");
}

function parseStart(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const plain = parseInt(v, 10);
  if (/^\d+$/.test(v) && Number.isFinite(plain)) return plain || undefined;
  const m = v.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (!m) return undefined;
  const s = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  return s > 0 ? s : undefined;
}

const VIDEO_ID_RE = /^[\w-]{6,20}$/;

/** Classify a target URL; null means "no special handling, use the proxy". */
export function youtubeSpecialFor(target: string): YoutubeSpecial | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (!isYtHost(u.hostname.toLowerCase())) return null;
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const q = u.searchParams;

  if (p === "/watch") {
    const v = q.get("v") ?? "";
    if (VIDEO_ID_RE.test(v)) {
      return { kind: "watch", videoId: v, list: q.get("list") ?? undefined, start: parseStart(q.get("t") ?? q.get("start")), target };
    }
    const list = q.get("list");
    if (list) return { kind: "watch", videoId: "", list, target };
    return { kind: "portal", target };
  }
  const m = p.match(/^\/(?:shorts|embed|v)\/([\w-]{6,20})/);
  if (m) {
    return { kind: "watch", videoId: m[1], list: q.get("list") ?? undefined, start: parseStart(q.get("t")), target };
  }
  if (p === "/playlist" && q.get("list")) {
    return { kind: "watch", videoId: "", list: q.get("list") as string, target };
  }
  if (p === "/results") {
    const query = q.get("search_query") ?? q.get("q") ?? "";
    return { kind: "search", query, target };
  }
  if (p === "/" && !/^(music|gaming|vr)\./.test(u.hostname)) {
    return { kind: "portal", target };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Metadata fetchers                                                   */
/* ------------------------------------------------------------------ */

interface VideoMeta {
  title: string;
  author: string;
}

async function fetchVideoMeta(videoId: string): Promise<VideoMeta> {
  try {
    const res = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`),
      { headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(3500) }
    );
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { title?: string; author_name?: string };
    return { title: data.title || "YouTube video", author: data.author_name || "" };
  } catch {
    return { title: "YouTube video", author: "" };
  }
}

export interface SearchResult {
  id: string;
  title: string;
  author: string;
  length: string;
  views: string;
}

/** Pull ytInitialData out of the static results HTML (several shapes). */
function extractInitialData(html: string): unknown | null {
  const patterns = [
    /var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/,
    /ytInitialData\s*=\s*(\{[\s\S]*?\});/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

function textOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  if (typeof o.simpleText === "string") return o.simpleText;
  const runs = o.runs;
  if (Array.isArray(runs) && runs.length) {
    const first = runs[0] as Record<string, unknown>;
    return typeof first?.text === "string" ? first.text : "";
  }
  return "";
}

function collectVideoRenderers(node: unknown, out: SearchResult[], depth: number): void {
  if (!node || out.length >= 24 || depth > 40) return;
  if (Array.isArray(node)) {
    for (const child of node) collectVideoRenderers(child, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const vr = obj.videoRenderer;
  if (vr && typeof vr === "object") {
    const v = vr as Record<string, unknown>;
    if (typeof v.videoId === "string" && VIDEO_ID_RE.test(v.videoId)) {
      out.push({
        id: v.videoId,
        title: textOf(v.title) || "Untitled",
        author: textOf(v.ownerText) || textOf(v.longBylineText) || "",
        length: textOf(v.lengthText) || "",
        views: textOf(v.shortViewCountText) || textOf(v.viewCountText) || "",
      });
    }
  }
  for (const value of Object.values(obj)) collectVideoRenderers(value, out, depth + 1);
}

export async function scrapeYoutubeSearch(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  try {
    const res = await fetch(
      `${YT_ORIGIN}/results?hl=en&gl=US&search_query=${encodeURIComponent(query)}`,
      { headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(9000) }
    );
    if (!res.ok) return [];
    const html = await res.text();
    const data = extractInitialData(html);
    if (!data) return [];
    const out: SearchResult[] = [];
    collectVideoRenderers(data, out, 0);
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Shared page shell                                                   */
/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SHELL_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { min-height:100%; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:#09090b; color:#e4e4e7; padding:20px 16px 40px; }
  .wrap { max-width:880px; margin:0 auto; }
  .bar { display:flex; align-items:center; gap:10px; margin-bottom:18px; }
  .orb { width:30px; height:30px; border-radius:50%; flex:none;
    background:conic-gradient(from 120deg,#7c3aed,#d946ef,#f59e0b,#7c3aed); }
  .brand { font-weight:800; letter-spacing:.04em; font-size:15px; }
  .brand span { color:#a78bfa; }
  form.search { display:flex; gap:8px; margin:0 0 20px; }
  form.search input { flex:1; padding:11px 14px; border-radius:10px; border:1px solid #3f3f46;
    background:#131316; color:#e4e4e7; font:inherit; font-size:14px; min-width:0; }
  form.search input:focus { outline:none; border-color:#7c3aed; }
  form.search button { cursor:pointer; font:inherit; font-size:14px; font-weight:600; padding:10px 18px;
    border-radius:10px; border:none; background:linear-gradient(135deg,#7c3aed,#a855f7); color:#fff; }
  form.search button:hover { filter:brightness(1.12); }
  .card { background:rgba(24,24,27,.85); border:1px solid #27272a; border-radius:16px;
    padding:18px; box-shadow:0 24px 80px rgba(0,0,0,.5); }
  .player { position:relative; width:100%; padding-top:56.25%; border-radius:12px; overflow:hidden;
    background:#000; }
  .player iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  h1.vt { font-size:18px; font-weight:700; margin-top:16px; line-height:1.4; }
  .va { margin-top:6px; font-size:13px; color:#a1a1aa; }
  .row { margin-top:16px; display:flex; gap:10px; flex-wrap:wrap; }
  a.btn, button.btn { cursor:pointer; font:inherit; font-size:13px; font-weight:600; text-decoration:none;
    padding:9px 16px; border-radius:10px; border:1px solid #3f3f46; background:#18181b; color:#e4e4e7;
    display:inline-flex; align-items:center; gap:6px; transition:all .15s ease; }
  a.btn:hover, button.btn:hover { border-color:#7c3aed; color:#fff; }
  a.btn.primary { background:linear-gradient(135deg,#7c3aed,#a855f7); border:none; color:#fff; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px; }
  a.tile { display:block; text-decoration:none; color:inherit; border:1px solid #27272a;
    border-radius:12px; overflow:hidden; background:#131316; transition:border-color .15s ease; }
  a.tile:hover { border-color:#7c3aed; }
  .thumb { position:relative; width:100%; padding-top:56.25%; background:#000; }
  .thumb img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
  .len { position:absolute; right:6px; bottom:6px; background:rgba(0,0,0,.8); color:#fff;
    font-size:11px; font-weight:600; padding:2px 6px; border-radius:5px; }
  .tt { font-size:13px; font-weight:600; line-height:1.35; padding:9px 10px 2px;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .ta { font-size:11px; color:#71717a; padding:2px 10px 10px; }
  .note { margin-top:16px; font-size:11px; color:#52525b; letter-spacing:.1em; text-transform:uppercase; text-align:center; }
  .chip { display:inline-block; margin:0 8px 10px 0; font-size:12px; padding:7px 13px; border-radius:999px;
    border:1px solid #3f3f46; background:#18181b; color:#c4c4cc; text-decoration:none; }
  .chip:hover { border-color:#7c3aed; color:#fff; }
  .err { margin-top:14px; font-size:13px; color:#a1a1aa; line-height:1.6; }
  @media (max-width:520px){ .grid { grid-template-columns:repeat(2,1fr); gap:10px; } .bar { margin-bottom:12px; } }
`;

/** Shared branded shell with codec + address-bar sync preinstalled. */
function pageShell(title: string, realUrl: string, bodyHtml: string, searchValue = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Quasar</title>
<style>${SHELL_CSS}</style>
<script data-quasar="codec">${CODEC_SOURCE}</script>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <div class="orb" aria-hidden="true"></div>
    <div class="brand">QUA<span>SAR</span> <span style="color:#52525b;font-weight:600">v${QUASAR_VERSION}</span></div>
  </div>
  <form class="search" onsubmit="return (function(f){
    var i=f.querySelector('input');
    var q=(i.value||'').trim();
    if(!q) return false;
    location.href='/p/'+window.__QUASAR_CODEC__.encodeOrigin('${YT_ORIGIN}')+'/results?search_query='+encodeURIComponent(q);
    return false; })(this)">
    <input id="np-q" type="text" placeholder="Search YouTube…" value="${esc(searchValue)}" autocomplete="off" autofocus>
    <button type="submit">Search</button>
  </form>
  ${bodyHtml}
  <div class="note">Quasar v${QUASAR_VERSION} · adblock on · ad-free player mode</div>
</div>
<script>
try { parent.postMessage({ __quasar: 'location', url: ${JSON.stringify(realUrl)}, title: ${JSON.stringify(title)} }, location.origin); } catch (e) {}
</script>
</body>
</html>`;
}

function ytResponse(html: string, target: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-quasar-target": target,
      "x-quasar-version": QUASAR_VERSION,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Page builders                                                       */
/* ------------------------------------------------------------------ */

function embedSrc(videoId: string, list?: string, start?: number): string {
  const base = videoId
    ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`
    : "https://www.youtube-nocookie.com/embed/videoseries";
  const params = new URLSearchParams({
    autoplay: "1",
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
    iv_load_policy: "3",
  });
  if (list) params.set("list", list);
  if (start && start > 0) params.set("start", String(start));
  return `${base}?${params.toString()}`;
}

function watchPageHtml(videoId: string, list: string | undefined, start: number | undefined, meta: VideoMeta, target: string): string {
  const realUrl = videoId
    ? `${YT_ORIGIN}/watch?v=${videoId}${start ? `&t=${start}s` : ""}`
    : `${YT_ORIGIN}/playlist?list=${encodeURIComponent(list ?? "")}`;
  const title = videoId ? meta.title : "Playlist";
  const body = `
  <div class="card">
    <div class="player">
      <iframe
        src="${esc(embedSrc(videoId, list, start))}"
        title="${esc(title)}"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
        allowfullscreen></iframe>
    </div>
    <h1 class="vt">${esc(title)}</h1>
    ${meta.author ? `<div class="va">${esc(meta.author)}</div>` : ""}
    <div class="row">
      <a class="btn primary" href="${esc(proxyPath(realUrl))}">Reload player</a>
      <a class="btn" href="${esc(realUrl)}" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a>
      <button class="btn" type="button" onclick="document.getElementById('np-q').focus()">Search videos</button>
    </div>
  </div>`;
  return pageShell(title, realUrl, body, "");
}

function resultsPageHtml(query: string, results: SearchResult[], target: string): string {
  let body: string;
  if (!results.length) {
    body = `
  <div class="card">
    <div class="err">No results could be fetched for <strong>${esc(query)}</strong> right now.
    YouTube may be rate-limiting this server. Try again in a moment, or open the
    <a style="color:#a78bfa" href="${esc(`${YT_ORIGIN}/results?search_query=${encodeURIComponent(query)}`)}" target="_blank" rel="noopener noreferrer">results on YouTube ↗</a>.</div>
  </div>`;
  } else {
    const tiles = results
      .map(
        (r) => `
    <a class="tile" href="${esc(proxyPath(`${YT_ORIGIN}/watch?v=${r.id}`))}" title="${esc(r.title)}">
      <div class="thumb"><img src="https://i.ytimg.com/vi/${encodeURIComponent(r.id)}/mqdefault.jpg" alt="" loading="lazy">${r.length ? `<span class="len">${esc(r.length)}</span>` : ""}</div>
      <div class="tt">${esc(r.title)}</div>
      <div class="ta">${esc(r.author)}${r.views ? ` · ${esc(r.views)}` : ""}</div>
    </a>`
      )
      .join("");
    body = `
  <div class="grid">${tiles}</div>`;
  }
  return pageShell(`“${query}” — YouTube search`, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, body, query);
}

function portalPageHtml(target: string): string {
  const chips = ["Lo-fi beats", "Live music", "News", "Podcasts", "Classical", "Gaming"]
    .map(
      (c) =>
        `<a class="chip" href="${esc(proxyPath(`${YT_ORIGIN}/results?search_query=${encodeURIComponent(c)}`))}">${esc(c)}</a>`
    )
    .join("");
  const body = `
  <div class="card">
    <h1 class="vt" style="margin-top:0">YouTube — ad-free player</h1>
    <div class="err">Search above or paste a link (<code style="color:#a78bfa">youtu.be/…</code>,
    <code style="color:#a78bfa">youtube.com/watch?v=…</code>). Videos play through YouTube's
    native ad-light player — no proxy auth, no &quot;Video unavailable&quot;.</div>
    <div class="row">${chips}</div>
  </div>`;
  return pageShell("YouTube — Quasar", `${YT_ORIGIN}/`, body, "");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the client Response for a YouTube special page. Never throws —
 * every failure path degrades to a usable page (so a dead oEmbed/scrape
 * can't take the navigation down with it).
 */
export async function youtubeResponse(special: YoutubeSpecial): Promise<Response> {
  if (special.kind === "portal") {
    return ytResponse(portalPageHtml(special.target), special.target);
  }
  if (special.kind === "search") {
    const results = await scrapeYoutubeSearch(special.query);
    return ytResponse(resultsPageHtml(special.query, results, special.target), special.target);
  }
  const meta = special.videoId ? await fetchVideoMeta(special.videoId) : { title: "Playlist", author: "" };
  return ytResponse(watchPageHtml(special.videoId, special.list, special.start, meta, special.target), special.target);
}
