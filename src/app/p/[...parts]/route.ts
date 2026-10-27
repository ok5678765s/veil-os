/**
 * Quasar Proxy Endpoint — /p/<blob>/<path>?<query>
 * ------------------------------------------------
 * The main reverse-proxy route. Supports every common HTTP method, manual
 * redirect following with per-hop cookie handling, streaming HTML rewriting,
 * AST-based JS rewriting, CSS/HLS/JSON rewriting, binary streaming, branded
 * error pages — plus the security layer (SSRF guard, rate limit, optional
 * password gate).
 *
 * v2.1.0 — blobs carry per-tab context (container / egress / UA override)
 * which is decoded here and threaded through the fetcher; a server-side
 * static cache serves immutable-looking subresources without touching the
 * upstream (ETag/Last-Modified revalidation on stale entries); every request
 * is recorded into the debug ring.
 *
 * Special blob: `!rel` resolves the rest-path against the real target of the
 * request's referer. The service worker uses this for escaped root-relative
 * requests because it cannot decrypt AES blobs itself.
 */

import { NextRequest } from "next/server";
import { parseProxiedRequest, proxyPath, encodeCtxSuffix } from "@/lib/veil/quasar/codec-server";
import { proxyFetch, buildResponseBody } from "@/lib/veil/quasar/fetcher";
import { errorPageResponse } from "@/lib/veil/quasar/error-page";
import { assertSafeTarget, allowRequest, clientKeyOf, gate } from "@/lib/veil/quasar/security";
import { isAdUrl } from "@/lib/veil/quasar/adblock";
import { siteFixFor } from "@/lib/veil/quasar/site-fixes";
import { QUASAR_VERSION } from "@/lib/veil/quasar/version";
import { youtubeSpecialFor, youtubeResponse } from "@/lib/veil/quasar/youtube";
import { curlFetchText } from "@/lib/veil/curl-fetch";
import {
  cacheLookup,
  cacheServeStale,
  cacheStore,
  cacheValidators,
  isCacheableContentType,
} from "@/lib/veil/quasar/http-cache";
import { recordRequest } from "@/lib/veil/quasar/debuglog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIMPLE_HINTS: [RegExp, string][] = [
  [/getaddrinfo|ENOTFOUND|dns-failure|dns/i, "DNS lookup failed — the domain may not exist or is unreachable."],
  [/blocked-private|blocked-host|blocked-credentials/, "The request was blocked by the proxy's security policy (private/loopback targets are not allowed)."],
  [/blocked-scheme/, "Only http and https URLs can be proxied."],
  [/aborted|timeout|UND_ERR|ECONNRESET/i, "The connection timed out or was reset."],
  [/certificate|SSL|TLS/i, "TLS negotiation with the target failed."],
  [/ECONNREFUSED/i, "The target refused the connection."],
];

function withCacheHeader(headers: Headers, value: string): Headers {
  const out = new Headers(headers);
  out.set("x-quasar-cache", value);
  out.set("age", "0");
  return out;
}

async function handle(req: NextRequest): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const method = req.method;

  // Optional password gate (no-op unless QUASAR_PASSWORD is set).
  const denied = gate(req, method === "GET");
  if (denied) return denied;

  // Per-client rate limiting.
  if (!allowRequest(clientKeyOf(req))) {
    return errorPageResponse(429, "Too many requests through this proxy — slow down a little.", url.pathname, "The per-client rate limit was hit. Retry in a few seconds.");
  }

  // `!rel` blobs are resolved against the referer's proxied URL (which also
  // supplies the per-tab context — containers survive root-relative loads).
  const refererHref = req.headers.get("x-quasar-referer") ?? req.headers.get("referer");
  const parsed = parseProxiedRequest(url.pathname, url.search, refererHref);
  if (!parsed) {
    return errorPageResponse(400, "The proxied URL could not be decoded.", url.pathname, "Malformed Quasar URL blob.");
  }
  const ctx = { container: parsed.container, egress: parsed.egress, ua: parsed.ua };

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await req.arrayBuffer();
    } catch {
      body = undefined;
    }
  }

  const finishDebug = (
    status: number,
    contentType: string,
    cache: string,
    fixId: string
  ) => {
    recordRequest({
      t: started,
      method,
      target: parsed.target.slice(0, 300),
      status,
      contentType: contentType.split(";")[0].slice(0, 60),
      ms: Date.now() - started,
      cache,
      container: parsed.container,
      egress: parsed.egress ?? "auto",
      fix: fixId,
    });
  };

  // ---- Adblocker, network layer (v1.3.8) ----------------------------
  // Known ad/tracker endpoints get an empty 204 before any upstream
  // connection: kills ad scripts, beacons, ad iframes and analytics for
  // every proxied page, no matter how the URL was constructed. The service
  // worker counts the x-quasar-blocked header and reports it to the UI.
  if (isAdUrl(parsed.target)) {
    console.log(`[quasar] BLOCKED (ad) ${method} ${parsed.target.slice(0, 120)}`);
    finishDebug(204, "-", "blocked", "-");
    return new Response(null, {
      status: 204,
      headers: {
        "x-quasar-blocked": "ad",
        "x-quasar-version": QUASAR_VERSION,
        "access-control-allow-origin": "*",
      },
    });
  }

  // ---- v2.5.7 YouTube special pages --------------------------------
  // Watch/search/portal pages on youtube.com get Quasar's own branded,
  // tunnel-free player (youtube-nocookie embed loaded DIRECTLY by the
  // browser) + scraped search grid — YouTube's proxied player fails its
  // own BotGuard checks inside any rewriting proxy.
  const ytSpecial = method === "GET" ? youtubeSpecialFor(parsed.target) : null;
  if (ytSpecial) {
    const r = await youtubeResponse(ytSpecial);
    finishDebug(
      r.status,
      r.headers.get("content-type") ?? "text/html",
      "yt-special",
      "youtube"
    );
    return r;
  }

  // ---- v2.1.0 static cache: fresh hits skip the upstream entirely ----
  const cacheEligible = method === "GET";
  if (cacheEligible) {
    const fresh = cacheLookup(parsed.target);
    if (fresh) {
      console.log(`[quasar] ${method} ${parsed.target} -> ${fresh.status} (cache memhit)`);
      finishDebug(fresh.status, fresh.headers.find(([k]) => k === "content-type")?.[1] ?? "-", "memhit", "-");
      return new Response(fresh.body as unknown as BodyInit, {
        status: fresh.status,
        headers: withCacheHeader(new Headers(fresh.headers), "memhit"),
      });
    }
  }

  try {
    // Stale entry with validators -> conditional GET (upstream 304 serves
    // the stored body; the clientHeaders copy carries the validators).
    let upstreamHeaders: Headers = req.headers;
    const stale = cacheEligible ? cacheValidators(parsed.target) : null;
    if (stale && (stale.etag || stale.lastModified)) {
      upstreamHeaders = new Headers(req.headers);
      if (stale.etag) upstreamHeaders.set("if-none-match", stale.etag);
      if (stale.lastModified) upstreamHeaders.set("if-modified-since", stale.lastModified);
    }

    const { response: res, finalUrl } = await proxyFetch(method, parsed.target, upstreamHeaders, body, ctx);

    /* Veil — curl second chance for walled documents: before giving up on
     * a 401/403/429, retry once through curl's TLS fingerprint. Node's
     * fetch (undici) carries a JA3 fingerprint some CDNs wall (Wikimedia's
     * edge 403s undici while curl passes — same URL, same UA, verified
     * from this box). Covers HTML plus the small text assets sites need
     * to actually render (CSS, JS, SVG) — big media keeps streaming. */
    const WALL_STATUSES = [401, 403, 429];
    if (method === "GET" && WALL_STATUSES.includes(res.status)) {
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      const curlable =
        ct.includes("text/html") ||
        ct.includes("application/xhtml") ||
        ct.includes("text/css") ||
        ct.includes("javascript") ||
        ct.includes("ecmascript") ||
        ct.includes("image/svg+xml") ||
        ct.includes("application/xml") ||
        ct.includes("text/plain") ||
        ct === "";
      if (curlable) {
        try {
          const curled = await curlFetchText(parsed.target, {
            accept: ct.includes("text/css")
              ? "text/css,*/*;q=0.1"
              : ct.includes("javascript")
                ? "*/*"
                : "text/html,application/xhtml+xml,*/*;q=0.8",
          });
          if (curled.status >= 200 && curled.status < 400 && curled.body.length < 4_000_000) {
            try {
              await res.body?.cancel();
            } catch {
              /* already gone */
            }
            const synth = new Response(curled.body, {
              status: curled.status,
              headers: { "content-type": ct || "text/html; charset=utf-8" },
            });
            const outcome = await buildResponseBody(synth, parsed.target, method, ctx);
            console.log(
              `[quasar] ${method} ${parsed.target} -> ${curled.status} via curl second chance (${Date.now() - started}ms)`
            );
            finishDebug(curled.status, ct || "-", "miss", "-");
            return new Response(outcome.body, { status: outcome.status, headers: outcome.headers });
          }
        } catch {
          /* curl failed — fall through with the original response */
        }
      }
    }

    // Upstream answered 304 to our conditional GET: serve the stored entry.
    if (res.status === 304 && cacheEligible) {
      const staleEntry = cacheServeStale(parsed.target);
      if (staleEntry) {
        res.body?.cancel();
        console.log(`[quasar] ${method} ${finalUrl} -> 200 (cache 304hit)`);
        finishDebug(200, staleEntry.headers.find(([k]) => k === "content-type")?.[1] ?? "-", "304hit", "-");
        return new Response(staleEntry.body as unknown as BodyInit, {
          status: staleEntry.status,
          headers: withCacheHeader(new Headers(staleEntry.headers), "304hit"),
        });
      }
      // No entry to serve (first request was conditional): pass the 304 on.
      res.body?.cancel();
      finishDebug(304, "-", "stale", "-");
      return new Response(null, { status: 304, headers: buildForwardHeaders(res, finalUrl) });
    }

    // Redirect chain exhausted server-side: hand the last hop back to the
    // browser with a rewritten Location so it keeps following through Quasar.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        try {
          const next = new URL(loc, finalUrl);
          const headers = new Headers({ location: proxyPath(next.href, encodeCtxSuffix(ctx)) });
          res.body?.cancel();
          console.log(`[quasar] ${method} ${finalUrl} -> ${res.status} (redirect, ${Date.now() - started}ms)`);
          finishDebug(res.status, "redirect", "miss", "-");
          return new Response(null, { status: res.status, headers });
        } catch {
          /* fall through to normal handling */
        }
      }
    }

    const fix = siteFixFor(finalUrl)?.id ?? "-";
    const outcome = await buildResponseBody(res, finalUrl, method, ctx);

    // v2.1.0 static cache: store cacheable final responses (post-rewrite) so
    // future GETs skip both the upstream fetch and every rewrite pass.
    // Small streams with a known content-length (images, fonts — normally
    // binary passthrough) are buffered once so they can be cached; large or
    // unknown-length streams (video, SSE, streamed HTML) never are.
    let finalBody: BodyInit | null = outcome.body;
    if (cacheEligible && outcome.status === 200 && outcome.body != null) {
      const ct = outcome.headers.get("content-type") ?? "";
      if (isCacheableContentType(ct)) {
        try {
          if (typeof outcome.body === "string") {
            cacheStore(parsed.target, outcome.status, outcome.headers, new TextEncoder().encode(outcome.body));
          } else if (outcome.body instanceof ReadableStream) {
            const len = Number(outcome.headers.get("content-length") || 0);
            if (len > 0 && len <= 8 * 1024 * 1024) {
              const bytes = new Uint8Array(await new Response(outcome.body).arrayBuffer());
              if (bytes.byteLength > 0 && bytes.byteLength === len) {
                cacheStore(parsed.target, outcome.status, outcome.headers, bytes);
                finalBody = bytes as unknown as BodyInit;
              }
            }
          } else {
            const bytes =
              outcome.body instanceof ArrayBuffer
                ? new Uint8Array(outcome.body)
                : new Uint8Array(await new Response(outcome.body as BlobPart).arrayBuffer());
            cacheStore(parsed.target, outcome.status, outcome.headers, bytes);
          }
        } catch {
          /* cache store is best-effort — finalBody falls back to the stream */
        }
      }
    }

    const cacheTag = outcome.headers.get("x-quasar-cache") ?? "miss";
    console.log(
      `[quasar] ${method} ${finalUrl} -> ${outcome.status} ${String(res.headers.get("content-type") ?? "").split(";")[0]} (${Date.now() - started}ms)`
    );
    finishDebug(outcome.status, String(res.headers.get("content-type") ?? "-"), cacheTag, fix);
    return new Response(finalBody, { status: outcome.status, headers: outcome.headers });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const parts = raw.split("||");
    const cause = (parts[0] ?? raw).slice(0, 300);
    const hint = parts.length >= 2 ? parts[1] : "";
    const target = parts.length >= 2 ? parts[2] : parsed.target;
    const friendly = SIMPLE_HINTS.find(([re]) => re.test(raw))?.[1] || hint || "The target server could not be reached.";
    console.error(`[quasar] ${method} ${parsed.target} FAILED: ${cause}`);
    finishDebug(502, "error", "miss", "-");
    return errorPageResponse(502, cause || "Upstream request failed.", target, friendly);
  }
}

/** Minimal forward-header set for a bare 304 passthrough. */
function buildForwardHeaders(res: Response, finalUrl: string): Headers {
  const out = new Headers();
  for (const name of ["etag", "last-modified", "cache-control", "vary"]) {
    const v = res.headers.get(name);
    if (v !== null) out.set(name, v);
  }
  out.set("x-quasar-target", finalUrl);
  out.set("x-quasar-version", QUASAR_VERSION);
  return out;
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
