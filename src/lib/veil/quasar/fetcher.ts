/**
 * Quasar Fetcher
 * --------------
 * Builds outbound requests from proxied requests (header mapping, referer
 * restoration, cookie jar injection) and builds client responses (header
 * filtering, body rewriting, streaming pass-through, charset handling).
 */

import { parseProxiedPath, type RequestCtx } from "./codec-server";
import {
  cookieHeader,
  storeSetCookies,
  normContainer,
  DEFAULT_CONTAINER,
} from "./cookies";
import { rewriteHtml, rewriteCss, rewriteM3u8, rewriteJsonMedia } from "./rewriter";
import { HOOK_BUNDLE, quasarHeadParts } from "./hooks";
import { siteFixFor, type SiteFix } from "./site-fixes";
import { rewriteJs } from "./js-ast";
import { createHtmlStream } from "./html-stream";
import { assertSafeTarget } from "./security";
import { dispatcherFor } from "./http-agent";
import { injectPoTokenIfNeeded } from "./potoken";
import { QUASAR_VERSION } from "./version";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Raw, UNPATCHED undici fetch. The proxy engine must never go through
// Next.js's globalThis.fetch wrapper: its dev instrumentation (data-cache
// wrapping / response cloning) corrupts large streamed upstream bodies and
// can return synthetic "Unknown Error" responses (observed with multi-MB
// HTML pages). serverExternalPackages keeps undici unbundled.
import { fetch as undiciFetch } from "undici";

const MAX_REDIRECTS = 8;
/** How long to wait for response HEADERS (the body streams unrestricted after). */
const REQUEST_TIMEOUT_MS = 30_000;
/** One silent retry for idempotent requests that fail at the network level. */
const RETRY_DELAY_MS = 250;
/** Bodies larger than this are streamed untouched (JSON/m3u8 rewrites skipped). */
const MAX_REWRITE_BYTES = 12 * 1024 * 1024;

/** Headers we never copy from the browser request to the target request. */
const REQ_HEADER_BLOCKLIST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cookie",
  "origin",
  "referer",
  "x-quasar-target",
  "x-quasar-referer",
  "upgrade-insecure-requests",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-fetch-storage-access",
  "te",
  "trailer",
  "transfer-encoding",
  "expect",
  "keep-alive",
]);

/** Response headers we forward back to the browser. */
const FORWARD_RES_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "pragma",
  "vary",
  "accept-ranges",
  "content-range",
  "content-disposition",
  "content-length",
  "age",
  "retry-after",
  // v2.4.1 — Roblox APIs answer first POSTs with 403 + x-csrf-token; the
  // client JS must read it to sign the retry. Expose it on every response
  // (tiny header, no security impact — it is meant for the client anyway).
  "x-csrf-token",
];

/** Recover the real referer from our proxied referer URL. */
export function mapReferer(referer: string | null): string | undefined {
  if (!referer) return undefined;
  try {
    const u = new URL(referer);
    const parsed = parseProxiedPath(u.pathname, u.search);
    if (!parsed) return undefined;
    return parsed.origin + parsed.rest + u.search;
  } catch {
    return undefined;
  }
}

/** Iterate every header of the client request (some values may repeat). */
function forEachClientHeader(headers: Headers, fn: (name: string, value: string) => void): void {
  headers.forEach((value, name) => fn(name.toLowerCase(), value));
}

export interface ProxiedRequestResult {
  response: Response;
  finalUrl: string;
}

/** Hostname of the incoming request's Host header (port stripped, brackets kept). */
function clientHostnameOf(headers: Headers): string | undefined {
  const host = headers.get("host");
  if (!host) return undefined;
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : h;
  }
  return h.split(":")[0];
}

/**
 * Fetch a target and hand redirects back to the browser (the route rewrites
 * the Location into a proxied path): every hop becomes its own proxied
 * request with native browser semantics — method downgrades, body handling,
 * per-hop cookie absorption and a canonical visible /p/ URL afterwards.
 *
 * v2.1.0 — `ctx` carries the per-tab context decoded from the request blob:
 * container (cookie-jar partition), egress mode (upstream proxy vs direct)
 * and an optional User-Agent override (client-hint headers are dropped when
 * set so the request stays internally consistent).
 */
export async function proxyFetch(
  method: string,
  startTarget: string,
  clientHeaders: Headers,
  body: ArrayBuffer | undefined,
  ctx: RequestCtx = {}
): Promise<ProxiedRequestResult> {
  const targetUrl = new URL(startTarget);
  const container = ctx.container ? normContainer(ctx.container) : DEFAULT_CONTAINER;

  // SSRF guard (also re-applied per hop by the browser-driven redirect chain).
  // The client host unlocks the same-host WS-bridge probe exemption.
  await assertSafeTarget(targetUrl, clientHostnameOf(clientHeaders));

  const jarCookie = cookieHeader(targetUrl.origin, container);

  const headers = new Headers();
  forEachClientHeader(clientHeaders, (name, value) => {
    if (!REQ_HEADER_BLOCKLIST.has(name)) headers.set(name, value);
  });
  if (jarCookie) headers.set("cookie", jarCookie);

  // v2.1.0 — UA override: replace the forwarded UA and drop client hints,
  // which would contradict the override and defeat its purpose.
  if (ctx.ua) {
    headers.set("user-agent", ctx.ua);
    headers.delete("sec-ch-ua");
    headers.delete("sec-ch-ua-mobile");
    headers.delete("sec-ch-ua-platform");
    headers.delete("sec-ch-ua-full-version-list");
    headers.delete("sec-ch-ua-arch");
    headers.delete("sec-ch-ua-bitness");
    headers.delete("sec-ch-ua-model");
    headers.delete("sec-ch-ua-platform-version");
    headers.delete("sec-ch-ua-reduced");
    headers.delete("sec-ch-ua-wow64");
  }

  // Per-site request fixes (headers stripped/merged for this host).
  const fix = siteFixFor(startTarget);
  for (const name of fix?.stripRequestHeaders ?? []) headers.delete(name);
  for (const [name, value] of Object.entries(fix?.requestHeaders ?? {})) {
    headers.set(name, value);
  }

  // Restore the referer the target would have seen. The service worker
  // strips `referer` from proxied requests but preserves it under
  // x-quasar-referer, so hotlink/CSRF-referer checks keep working.
  const referer = mapReferer(
    clientHeaders.get("referer") ?? clientHeaders.get("x-quasar-referer")
  );
  if (referer) {
    try {
      if (new URL(referer).origin === targetUrl.origin) headers.set("referer", referer);
      else headers.set("referer", targetUrl.origin + "/");
    } catch {
      /* ignore */
    }
  }
  // Map Origin to the target so CORS-stateful endpoints behave.
  const clientOrigin = clientHeaders.get("origin");
  if (clientOrigin && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers.set("origin", targetUrl.origin);
  }

  let res: Response;
  try {
    // v2.0.4 — YouTube innertube calls get a server-generated poToken
    // (BotGuard attestation) injected into the JSON body when available.
    // Never throws; requests proceed unchanged without a token.
    if (body && method === "POST") {
      try {
        const tu = new URL(startTarget);
        if (
          /(^|\.)youtube\.com$/i.test(tu.hostname) &&
          tu.pathname.startsWith("/youtubei/") &&
          body.byteLength <= 2 * 1024 * 1024
        ) {
          body = await injectPoTokenIfNeeded(body);
        }
      } catch {
        /* token injection is best-effort */
      }
    }
    res = await fetchWithRetry(startTarget, method, headers, body, ctx.egress);
  } catch (err) {
    throw enhanceFetchError(err, startTarget);
  }

  // Absorb Set-Cookie from this response (3xx or final — login flows set
  // session cookies on the 302/303 responses themselves).
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (setCookies.length) storeSetCookies(targetUrl.origin, setCookies, container);

  return { response: res, finalUrl: startTarget };
}

/**
 * One outbound fetch attempt. The abort timer covers only the wait for
 * response HEADERS — once headers arrive it is cleared so long-lived bodies
 * (video ranges, HLS segments, EventSource/SSE, big downloads) are never
 * killed mid-stream.
 */
function fetchOnce(
  target: string,
  method: string,
  headers: Headers,
  body: ArrayBuffer | undefined,
  egress?: string
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Timed out waiting for response headers", "TimeoutError")),
    REQUEST_TIMEOUT_MS
  );
  return undiciFetch(
    target,
    {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: ctrl.signal,
      // v2.0.4 — pooled dispatcher with HTTP/2 enabled (QUASAR_NO_H2=1 reverts).
      // v2.1.0 — egress mode selects the pool (QUASAR_UPSTREAM_PROXY / direct).
      dispatcher: dispatcherFor(egress),
    } as Parameters<typeof undiciFetch>[1]
  )
    .then((res) => res as unknown as Response)
    .finally(() => clearTimeout(timer));
}

/**
 * Fetch with a single silent retry for idempotent requests hit by transient
 * network errors (DNS blips, reset connections). Redirects stay manual so the
 * retry never re-submits anything destructive.
 */
async function fetchWithRetry(
  target: string,
  method: string,
  headers: Headers,
  body: ArrayBuffer | undefined,
  egress?: string
): Promise<Response> {
  const idempotent = method === "GET" || method === "HEAD";
  let lastErr: unknown;
  for (let attempt = 0; attempt <= (idempotent ? 1 : 0); attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    try {
      return await fetchOnce(target, method, headers, body, egress);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function enhanceFetchError(err: unknown, target: string): Error {
  const cause = err instanceof Error ? err.message : String(err);
  let hint = "The target server could not be reached.";
  if (/getaddrinfo|ENOTFOUND|dns|EAI_AGAIN/i.test(cause)) {
    hint = "DNS lookup failed — the domain may not exist or is unreachable from this network.";
  } else if (/aborted|timeout|ECONNRESET|UND_ERR/i.test(cause)) {
    hint = "The connection timed out or was reset by the target.";
  } else if (/certificate|SSL|TLS/i.test(cause)) {
    hint = "TLS/SSL negotiation with the target failed.";
  } else if (/ECONNREFUSED/i.test(cause)) {
    hint = "The target refused the connection.";
  }
  const e = new Error(cause + "||" + hint + "||" + target);
  e.name = "QuasarFetchError";
  return e;
}

/** Copy safe response headers, dropping proxy-breaking and identity-breaking ones. */
export function buildClientHeaders(res: Response, finalUrl: string): Headers {
  const out = new Headers();
  for (const name of FORWARD_RES_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  // undici transparently decompresses; stale identity headers would break clients.
  if (res.headers.has("content-encoding")) {
    out.delete("content-encoding");
    out.delete("content-length");
  }
  out.set("x-quasar-target", finalUrl);
  out.set("x-quasar-version", QUASAR_VERSION);
  return out;
}

function charsetOf(contentType: string): string {
  const m = contentType.match(/charset=([^;]+)/i);
  return m ? m[1].trim().replace(/["']/g, "") : "utf-8";
}

/* ------------------------------------------------------------------ */
/* v2.0.4 — AST-rewrite cache (URL + ETag keyed, LRU)                  */
/* ------------------------------------------------------------------ */

interface JsCacheEntry {
  code: string;
  status: number;
  headers: [string, string][];
}

const jsCache = new Map<string, JsCacheEntry>();
const JS_CACHE_MAX_ENTRIES = 48;
const JS_CACHE_MAX_BYTES =
  Math.max(16, Number(process.env.QUASAR_JS_CACHE_MB) || 160) * 1024 * 1024;
let jsCacheBytes = 0;

function jsCacheGet(key: string): JsCacheEntry | undefined {
  const hit = jsCache.get(key);
  if (!hit) return undefined;
  jsCache.delete(key);
  jsCache.set(key, hit); // LRU refresh
  return hit;
}

function jsCacheSet(key: string, entry: JsCacheEntry): void {
  if (jsCache.has(key)) jsCache.delete(key);
  jsCache.set(key, entry);
  jsCacheBytes += key.length + entry.code.length * 2; // rough UTF-16 footprint
  while (jsCache.size > JS_CACHE_MAX_ENTRIES || jsCacheBytes > JS_CACHE_MAX_BYTES) {
    const oldest = jsCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = jsCache.get(oldest);
    jsCacheBytes -= oldest.length + (evicted ? evicted.code.length * 2 : 0);
    jsCache.delete(oldest);
  }
  astCacheDirty = true;
  scheduleAstPersist();
}

/* v2.1.0 — AST cache disk persistence. In-memory alone meant every server
   restart re-ran acorn on every chunk of every site. Write-behind (90s when
   dirty) with an atomic tmp+rename; load bounded by the same byte budget. */
const AST_CACHE_DIR = process.env.QUASAR_CACHE_DIR || join(process.cwd(), ".quasar-cache");
const AST_CACHE_FILE = join(AST_CACHE_DIR, "ast-cache.json");
let astCacheDirty = false;
let astCacheTimer: ReturnType<typeof setInterval> | null = null;

function scheduleAstPersist(): void {
  if (astCacheTimer) return;
  astCacheTimer = setInterval(() => {
    if (!astCacheDirty) return;
    astCacheDirty = false;
    try {
      // Map order is LRU order (oldest first) — serialize newest-first.
      const entries: [string, JsCacheEntry][] = [];
      let budget = JS_CACHE_MAX_BYTES;
      for (const [k, e] of Array.from(jsCache.entries()).reverse()) {
        const cost = k.length + e.code.length * 2;
        if (cost > budget) continue;
        budget -= cost;
        entries.push([k, e]);
        if (entries.length >= JS_CACHE_MAX_ENTRIES) break;
      }
      mkdirSync(AST_CACHE_DIR, { recursive: true });
      const tmp = AST_CACHE_FILE + ".tmp";
      writeFileSync(tmp, JSON.stringify({ v: 1, entries }), "utf8");
      renameSync(tmp, AST_CACHE_FILE);
    } catch {
      /* cache persistence is best-effort */
    }
  }, 90_000);
  // Never hold the process open for a cache write.
  try {
    (astCacheTimer as unknown as { unref?: () => void }).unref?.();
  } catch {}
}

(function loadAstCache() {
  try {
    const raw = JSON.parse(readFileSync(AST_CACHE_FILE, "utf8")) as {
      v?: number;
      entries?: [string, JsCacheEntry][];
    };
    if (!raw || raw.v !== 1 || !Array.isArray(raw.entries)) return;
    let budget = JS_CACHE_MAX_BYTES;
    for (const [key, entry] of raw.entries) {
      if (
        typeof key !== "string" ||
        !entry ||
        typeof entry.code !== "string" ||
        !Array.isArray(entry.headers)
      )
        continue;
      const cost = key.length + entry.code.length * 2;
      if (cost > budget) continue;
      budget -= cost;
      jsCache.set(key, { code: entry.code, status: entry.status, headers: entry.headers });
      jsCacheBytes += cost;
      if (jsCache.size >= JS_CACHE_MAX_ENTRIES) break;
    }
    if (jsCache.size) {
      console.log("[quasar] AST cache restored from disk: " + jsCache.size + " entries");
    }
  } catch {
    /* first boot or unreadable — start empty */
  }
})();

function decodeBuffer(buf: ArrayBuffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export interface BodyOutcome {
  body: BodyInit | null;
  headers: Headers;
  status: number;
}

/** True when the response declares a body size we are willing to buffer. */
function sizeWithin(res: Response, max: number): boolean {
  const len = Number(res.headers.get("content-length") || 0);
  return !(len > max);
}

/** Build the head-injection block (page data + site config + hooks). */
function buildInjection(
  targetUrl: string,
  site: SiteFix | null,
  ctx?: RequestCtx
): string {
  const { pageDataTag, siteConfigTag } = quasarHeadParts(targetUrl, site, ctx);
  return pageDataTag + siteConfigTag + `<script data-quasar="engine">${HOOK_BUNDLE}</script>`;
}

/** Produce the client-facing body for a proxied response (rewrite or stream). */
export async function buildResponseBody(
  res: Response,
  finalUrl: string,
  method: string,
  ctx: RequestCtx = {}
): Promise<BodyOutcome> {
  const headers = buildClientHeaders(res, finalUrl);
  const status = res.status;
  if (method === "HEAD" || status === 204 || status === 304) {
    return { body: null, headers, status };
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const lower = contentType.toLowerCase();
  const fix = siteFixFor(finalUrl);
  const flags = fix?.flags ?? {};

  if (lower.includes("text/html") || lower.includes("application/xhtml")) {
    const injection = buildInjection(finalUrl, fix, ctx);

    // Preferred path: stream the document through the incremental rewriter —
    // first paint happens while the rest of the body is still in flight.
    if (res.body && !flags.noStream) {
      try {
        headers.set("content-type", "text/html; charset=utf-8");
        headers.delete("content-length");
        headers.set("cache-control", "no-cache");
        const stream = createHtmlStream(finalUrl, {
          charset: charsetOf(lower),
          injection,
        });
        return { body: res.body.pipeThrough(stream), headers, status };
      } catch (err) {
        console.error("[quasar] html stream init failed, using buffered pipeline", err);
      }
    }

    // Buffered fallback (also used when the upstream gave us no stream).
    const buf = await res.arrayBuffer();
    const charset = charsetOf(lower);
    let html = decodeBuffer(buf, charset);
    try {
      html = rewriteHtml(html, finalUrl, { site: fix, injection });
    } catch (err) {
      console.error("[quasar] html rewrite failed", err);
    }
    headers.set("content-type", "text/html; charset=utf-8");
    headers.delete("content-length");
    // Rewritten HTML must never be served from the browser's HTTP cache —
    // stale bundles were the #1 source of "the page broke after an update".
    // no-cache still allows ETag revalidation, so nothing is wasted.
    headers.set("cache-control", "no-cache");
    return { body: html, headers, status };
  }

  // JavaScript — AST-based rewriting (acorn). Regex fallback is built into
  // rewriteJs for unparseable code; huge bundles stream untouched.
  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    /* keep empty */
  }
  const isJs =
    /\b(?:javascript|ecmascript)\b/i.test(lower) || /\.(?:m?js|esm)$/i.test(pathname);
  const noAst = flags.noAst || process.env.QUASAR_NO_AST === "1";
  if (isJs && !noAst && sizeWithin(res, MAX_REWRITE_BYTES)) {
    try {
      // v2.0.4 — serve previously rewritten chunks without re-running acorn.
      // Keyed by URL + validator headers, so upstream changes always miss.
      const etag = res.headers.get("etag") ?? "";
      const lastMod = res.headers.get("last-modified") ?? "";
      const cacheKey = `${finalUrl}|${QUASAR_VERSION}|${etag}|${lastMod}`;
      if (method === "GET" && (etag || lastMod)) {
        const hit = jsCacheGet(cacheKey);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set("x-quasar-cache", "hit");
          return { body: hit.code, headers: h, status: hit.status };
        }
      }
      const text = decodeBuffer(await res.arrayBuffer(), charsetOf(lower));
      const result = rewriteJs(text, finalUrl, /\.mjs$/i.test(pathname), {
        virtLoc: !!flags.virtLoc,
      });
      if (result.changed) headers.delete("content-length");
      if (method === "GET" && (etag || lastMod)) {
        jsCacheSet(cacheKey, {
          code: result.code,
          status,
          headers: Array.from(headers.entries()),
        });
      }
      return { body: result.code, headers, status };
    } catch (err) {
      console.error("[quasar] js rewrite failed", err);
    }
  }

  // HLS playlists — rewrite segment/variant URIs so players stay in the tunnel.
  const isM3u8 =
    lower.includes("mpegurl") ||
    /\.m3u8($|\?)/i.test(finalUrl) ||
    /\.m3u8$/i.test(new URL(finalUrl).pathname);
  if (isM3u8 && sizeWithin(res, MAX_REWRITE_BYTES)) {
    try {
      const text = decodeBuffer(await res.arrayBuffer(), charsetOf(lower));
      headers.set("content-type", "application/vnd.apple.mpegurl");
      headers.delete("content-length");
      return { body: rewriteM3u8(text, finalUrl), headers, status };
    } catch (err) {
      console.error("[quasar] m3u8 rewrite failed", err);
    }
  }

  // JSON payloads — conservatively proxy media URLs (thumbnails, posters,
  // video sources) discovered as string values. Non-media values are never
  // touched, so signatures / issuer fields / redirect URIs stay intact.
  if (
    (lower.includes("application/json") || lower.includes("+json")) &&
    !lower.includes("jwt") &&
    !flags.noJsonMedia &&
    sizeWithin(res, MAX_REWRITE_BYTES)
  ) {
    try {
      const text = decodeBuffer(await res.arrayBuffer(), charsetOf(lower));
      const rewritten = rewriteJsonMedia(text, finalUrl);
      headers.delete("content-length");
      return { body: rewritten === text ? text : rewritten, headers, status };
    } catch (err) {
      console.error("[quasar] json rewrite failed", err);
    }
  }

  if (lower.includes("text/css")) {
    const buf = await res.arrayBuffer();
    const charset = charsetOf(lower);
    let css = decodeBuffer(buf, charset);
    try {
      css = rewriteCss(css, finalUrl);
    } catch (err) {
      console.error("[quasar] css rewrite failed", err);
    }
    headers.set("content-type", "text/css; charset=utf-8");
    headers.delete("content-length");
    return { body: css, headers, status };
  }

  // Everything else streams straight through (video ranges, images, JSON, JS…).
  return { body: res.body, headers, status };
}
