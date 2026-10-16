/**
 * Veil — client-side helpers shared by the landing page and browser view.
 */

export const ROUTE_PREFIX = "/api/p/";

/* ── Viewer identity (per-browser pseudonymous id) ────────────────────── */

const VIEWER_KEY = "veil.viewer";
const VIEWER_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Stable per-browser viewer id. Priority:
 *   1. url ?vv= param   (shareable/offline links)
 *   2. localStorage     (stamped by /api/viewer on first load)
 *   3. veil_viewer cookie (server-stamped — a cleared localStorage must
 *      not orphan the viewer's server-side session/history mirror)
 * The server also recognizes these and falls back to an IP+UA hash, so the
 * id converges even if both stores are gone.
 */
export function getViewerId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const vv = new URLSearchParams(window.location.search).get("vv");
    if (vv && VIEWER_RE.test(vv)) {
      localStorage.setItem(VIEWER_KEY, vv);
      return vv;
    }
    const stored = localStorage.getItem(VIEWER_KEY);
    if (stored && VIEWER_RE.test(stored)) return stored;
    // localStorage was cleared (or this is a storage-partitioned frame):
    // adopt the id the server stamped as a cookie so the session mirror,
    // history and notes survive the wipe instead of resetting to a fresh
    // anonymous viewer (the "cleared storage → home screen" hole).
    if (typeof document !== "undefined" && document.cookie) {
      const m = /(?:^|;\s*)veil_viewer=([A-Za-z0-9_-]{6,64})/.exec(document.cookie);
      if (m) {
        localStorage.setItem(VIEWER_KEY, m[1]);
        return m[1];
      }
    }
    const fresh = "v-" + uid().replace(/-/g, "").slice(0, 12);
    localStorage.setItem(VIEWER_KEY, fresh);
    return fresh;
  } catch {
    return "v-localfallback";
  }
}

/** Headers to attach to every API call so the server scopes data to us. */
export function viewerHeaders(): Record<string, string> {
  return { "x-veil-viewer": getViewerId() };
}

/** Convert a bare user input into a navigable target URL (or a search). */
export function normalizeInput(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  if (/^https?:\/\//i.test(input)) return input;

  // Strip accidental prefix like "example.com/page" being pasted with scheme omitted
  const looksLikeDomain =
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(
      input
    );
  if (looksLikeDomain && !input.includes(" ")) {
    return `https://${input}`;
  }

  // Anything else becomes a search on the configured engine.
  return searchUrlFor(input);
}

/* ── Search engines (Settings › Appearance › Search engine) ───────────── */

export interface SearchEngine {
  label: string;
  /** Build the search results URL for a query. */
  query: (q: string) => string;
}

export const SEARCH_ENGINES: Record<string, SearchEngine> = {
  brave: {
    label: "Brave",
    // Server-rendered results — Veil parses them and renders its own SERP;
    // the most reliable engine through the veil.
    query: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  },
  bing: {
    label: "Bing",
    // The HTML SERP needs JS — through the veil, Veil fetches Bing's RSS
    // feed instead and renders its own results page (looser relevance).
    query: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
  duckduckgo: {
    label: "DuckDuckGo",
    // The html edition renders without JS (unreachable from some networks).
    query: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  },
  google: {
    label: "Google",
    query: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  ecosia: {
    label: "Ecosia",
    query: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`,
  },
};

export const DEFAULT_ENGINE_ID = "brave";
const ENGINE_KEY = "veil:search-engine";

/** The persisted engine id (validated, defaults to Brave). */
export function searchEngineId(): string {
  if (typeof window === "undefined") return DEFAULT_ENGINE_ID;
  try {
    const id = window.localStorage.getItem(ENGINE_KEY);
    if (id && id in SEARCH_ENGINES) return id;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_ENGINE_ID;
}

/** Search URL for the given engine (default: the persisted selection). */
export function searchUrlFor(query: string, engineId?: string): string {
  const id = engineId ?? searchEngineId();
  const engine = SEARCH_ENGINES[id] ?? SEARCH_ENGINES[DEFAULT_ENGINE_ID];
  return engine.query(query);
}

/* ── Proxy engines (Settings › Browsing › Proxy engine) ──────────────────
 *
 * The browsing overlay is engine-agnostic: whatever the user picks here
 * decides which machinery renders remote pages inside the browser iframe.
 * The Veil shell (tabs, history, control bar, URL pill) is identical on
 * every engine — only the lane under the iframe changes.
 *
 *   veil (built-in) — the /api/p/ server-side rewriting proxy. Still the
 *                     engine behind search results, favicons and the
 *                     start-page quick links; always available.
 *   quasar          — the user-uploaded Quasar engine: server-side
 *                     HTML/CSS rewriting + injected runtime hooks + a /p/
 *                     service worker safety net, WebSockets bridged through
 *                     the quasar-bridge mini-service (:3310). */

export type ProxyEngineId = "veil" | "quasar";

export interface ProxyEngine {
  label: string;
  /** One-line description shown in Settings. */
  desc: string;
}

export const PROXY_ENGINES: Record<ProxyEngineId, ProxyEngine> = {
  veil: {
    label: "Veil (built-in)",
    desc: "Server-side rewriting on this origin — the classic lane",
  },
  quasar: {
    label: "Quasar",
    desc: "Rewriting proxy with runtime hooks, a service-worker safety net and WebSocket bridging",
  },
};

export const DEFAULT_PROXY_ENGINE: ProxyEngineId = "quasar";
/* v2 — the storage key was bumped when Quasar became the default, so
 * browsers that stored an earlier pick start fresh on the new
 * default instead of pinning the old choice forever. */
const PROXY_ENGINE_KEY = "veil:proxy-engine:v2";

/** The persisted proxy engine id (validated, defaults to Quasar). */
export function proxyEngineId(): ProxyEngineId {
  if (typeof window === "undefined") return DEFAULT_PROXY_ENGINE;
  try {
    const id = window.localStorage.getItem(PROXY_ENGINE_KEY);
    if (id && id in PROXY_ENGINES) return id as ProxyEngineId;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_PROXY_ENGINE;
}

export function setProxyEngineId(id: ProxyEngineId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROXY_ENGINE_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

/** Quasar blob for a URL's origin (client-side twin of the engine codec). */
function quasarOriginBlob(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const origin = u.origin;
    const key = new TextEncoder().encode("quasar-v1");
    const bytes = new TextEncoder().encode(origin);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ^ key[i % key.length]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

/* ── Quasar v2.1.0 — per-tab context encoding ─────────────────────────
 *
 * The 2.1.0 engine bakes the tab's context (cookie container, egress mode,
 * UA override) into the AES-encrypted proxied-path blob at encode time, so
 * isolation survives navigations, SPA routing and SW-relayed subresources.
 * Encoding happens server-side (/api/codec — the only holder of the key);
 * this client helper just asks it, with a small memo cache because the
 * browser re-derives frame sources on every render pass. */
export type TabEgress = "auto" | "direct" | "upstream";

export interface QuasarTabCtx {
  container: string;
  egress: TabEgress;
  ua: string;
}

export const DEFAULT_TAB_CTX: QuasarTabCtx = { container: "default", egress: "auto", ua: "" };

/** True when any 2.1.0 context lever is engaged (needs the async encoder). */
export function quasarCtxActive(ctx: QuasarTabCtx): boolean {
  return ctx.container !== "default" || ctx.egress !== "auto" || ctx.ua !== "";
}

const quasarPathCache = new Map<string, string>();

/** Encode a real URL into a Quasar proxied path WITH the tab context.
 * Resolves to null on any failure — callers fall back to the legacy
 * context-less blob (engine still works, just without the ctx levers). */
export async function encodeQuasarPath(url: string, ctx: QuasarTabCtx): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const container = ctx.container !== "default" ? ctx.container : "";
  const egress = ctx.egress === "direct" || ctx.egress === "upstream" ? ctx.egress : "";
  const ua = ctx.ua || "";
  const key = `${container}|${egress}|${ua}|${url}`;
  const hit = quasarPathCache.get(key);
  if (hit) return hit;
  try {
    const r = await fetch("/api/codec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "encode",
        urls: [url],
        ...(container ? { container } : {}),
        ...(egress ? { egress } : {}),
        ...(ua ? { ua } : {}),
      }),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { paths?: unknown };
    const path = Array.isArray(data.paths) ? data.paths[0] : null;
    if (typeof path !== "string" || !path.startsWith("/p/")) return null;
    if (quasarPathCache.size > 400) quasarPathCache.clear();
    quasarPathCache.set(key, path);
    return path;
  } catch {
    return null;
  }
}

/** The iframe source for the browsing overlay, honoring the engine choice.
 *
 *   veil      → the built-in /api/p/ route (as before)
 *   quasar    → /p/<blob>/<path> through the Quasar engine route
 *
 * Veil-local programs (the FreeTube mount at freetube.veil.local) never
 * proxy — the /ft mount wins on every engine. Real youtube.com URLs are
 * NOT remapped anymore: they load through the selected engine exactly
 * like any other site (the xylora behavior); video SEARCHES still land on
 * the local library via the command bar's video-search row. */
export function engineFrameSrc(target: string): string {
  if (!target) return target;
  if (isVeilAppUrl(target)) return veilAppFrameSrc(target);
  const engine = proxyEngineId();
  if (engine === "quasar") {
    const blob = quasarOriginBlob(target);
    if (blob) {
      try {
        const u = new URL(target);
        return `/p/${blob}${u.pathname}${u.search}${u.hash}`;
      } catch {
        /* fall through */
      }
    }
    return routeUrl(target);
  }
  return routeUrl(target);
}

/* ── Arcade frame registry ─────────────────────────────────────────── */

/**
 * Routed arcade iframes (the title player AND the portal app frames) run
 * the same control script as veiled pages, so their postMessages
 * (nav/title/error) must NOT drive the browser tab state. The arcade
 * registers its running frames here; page.tsx ignores messages whose
 * source is registered. Several frames can be alive at once (a tucked
 * title plus an open portal), so this is a registry, not a single slot.
 */
const arcadeFrames = new Set<unknown>();
let singleSlotFrame: unknown = null;

/** Legacy single-slot registration (the title player): a new window
 * replaces the previous one; null clears it. */
export function setArcadeFrame(win: Window | null): void {
  if (singleSlotFrame !== null) arcadeFrames.delete(singleSlotFrame);
  singleSlotFrame = win;
  if (win !== null) arcadeFrames.add(win);
}

/** Register an additional arcade frame (portal app iframes — several may
 * stay alive at once while tucked away). Idempotent. */
export function registerArcadeFrame(win: Window | null): void {
  if (win !== null) arcadeFrames.add(win);
}

/** Remove a frame registered via registerArcadeFrame. */
export function unregisterArcadeFrame(win: Window | null): void {
  if (win !== null) arcadeFrames.delete(win);
}

export function isArcadeSource(source: unknown): boolean {
  return arcadeFrames.size > 0 && arcadeFrames.has(source);
}

/** Absolute target URL -> route URL served by this app.
 *
 * Idempotent: the proxy rewrites URLs inside the JSON/HTML it returns
 * (oEmbed `thumbnail_url`, API payloads…), so values that are ALREADY
 * route URLs pass through untouched — otherwise each hop through the
 * client would stack another `/api/p/` prefix and 400. */
export function routeUrl(target: string): string {
  if (!target || target.startsWith(ROUTE_PREFIX)) return target;
  const replaced = target.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//, "$1/");
  // encodeURI would re-encode existing %XX escapes, compounding the encoding
  // on every navigation cycle (space → %20 → %2520 → %252520 …). Encode only
  // characters that are unsafe in a URL while preserving valid escapes.
  // Fragments are intentionally kept so in-page anchors still work.
  const encoded = replaced.replace(
    /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?#%]/g,
    (ch: string) => (ch === "%" ? "%25" : encodeURIComponent(ch))
  );
  return ROUTE_PREFIX + encoded;
}

/** Favicon URL served through the same route (same-origin, no external calls). */
export function faviconFor(host: string): string {
  return routeUrl(`https://icons.duckduckgo.com/ip3/${host}.ico`);
}

/**
 * Favicon URLs to try in order: the subdomain first, then the apex domain
 * (DuckDuckGo's icon service often has no entry for `html.duckduckgo.com`
 * but does for `duckduckgo.com`). The component cycles through these on error.
 */
export function faviconUrls(host: string): string[] {
  const urls = [faviconFor(host)];
  const parts = host.split(".");
  if (parts.length > 2) {
    const apex = parts.slice(-2).join(".");
    if (apex && apex !== host) urls.push(faviconFor(apex));
  }
  return urls;
}

/** Generate a unique id (browser-safe, no crypto import needed). */
export function uid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** "3m ago" style relative time. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export interface Visit {
  id: string;
  url: string;
  host: string;
  title: string | null;
  visitCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryResponse {
  visits: Visit[];
  stats: { sites: number; pageVisits: number };
}

/** Quick-launch sites that render well through the veil. */
export interface QuickLink {
  name: string;
  url: string;
  host: string;
  desc: string;
  /** Featured rows get the emerald accent rail + tag chip. */
  featured?: boolean;
  /** Small uppercase chip next to the name (e.g. "READS WELL"). */
  tag?: string;
  /** Extra search terms matched by the command bar (comma-separated,
   *  lowercase) — e.g. "youtube yt videos" on the FreeTube entry. */
  aliases?: string;
}

export const QUICK_LINKS: QuickLink[] = [
  {
    name: "Wikipedia",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    host: "en.wikipedia.org",
    desc: "The free encyclopedia",
    featured: true,
    tag: "Reads well",
  },
  {
    name: "Hacker News",
    url: "https://news.ycombinator.com/",
    host: "news.ycombinator.com",
    desc: "Tech news, distilled",
    tag: "Reads well",
  },
  { name: "MDN Docs", url: "https://developer.mozilla.org/en-US/", host: "developer.mozilla.org", desc: "Web documentation" },
  { name: "BBC News", url: "https://www.bbc.com/news", host: "www.bbc.com", desc: "World headlines" },
  { name: "Lite CNN", url: "https://lite.cnn.com/", host: "lite.cnn.com", desc: "Text-only edition" },
  { name: "Bing", url: "https://www.bing.com/", host: "www.bing.com", desc: "Web search" },
  // FreeTube removed from quick links at the owner's request — the YouTube
  // search it offered only ever hit gated public instances ("no results").
];

/* ── Veil-local programs (FreeTube) ───────────────────────────────────
 *
 * freetube.veil.local is a pseudo-host: it never leaves this origin.
 * The real FreeTube program (the desktop client, per-viewer) runs as a
 * service and is mounted same-origin at /ft — the browser renders the
 * pseudo-URL in its URL pill while the iframe loads the /ft mount, so
 * tabs/history keep readable "freetube.veil.local/#/watch/…" entries.
 * Real YouTube URLs map onto the same program as deep links, exactly
 * like the offline file version does. */

export const VEIL_FT_HOST = "freetube.veil.local";

/** Is this URL one of Veil's local programs (never proxied)? */
export function isVeilAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.hostname.toLowerCase() === VEIL_FT_HOST;
  } catch {
    return false;
  }
}

/** Pseudo-URL → the same-origin /ft mount the iframe should load. */
export function veilAppFrameSrc(raw: string): string {
  if (!isVeilAppUrl(raw)) return raw;
  try {
    const u = new URL(raw);
    return "/ft/" + (u.hash || "");
  } catch {
    return "/ft/";
  }
}

/** Real YouTube URLs are no longer remapped onto the program — they load
 *  through the selected proxy engine, exactly like xylora.org's embedded
 *  browser treats them. The program itself keeps existing at the
 *  freetube.veil.local pseudo-host (quick link, video-search rows, the
 *  Stream section, history entries). */

/* ------------------------------------------------------------------ */
/* Safe JSON fetch                                                      */
/* ------------------------------------------------------------------ */

/**
 * Fetch JSON from a same-origin API route with the guards every call
 * site used to skip:
 *  - the content-type is checked BEFORE res.json() — an HTML error page
 *    from a restarting dev server can never surface as
 *    "Unexpected token '<', \"<!DOCTYPE\"…" again;
 *  - one automatic retry (1.5s later) for transient transport trouble
 *    (5xx, HTML pages, network drop) so brief restart windows heal
 *    themselves without a visible error.
 */
export async function fetchJsonSafe<T>(url: string, init?: RequestInit, attempts = 2): Promise<T> {
  const run = async (): Promise<T> => {
    const res = await fetch(url, init);
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("application/json")) {
      throw new Error(
        `the site answered a web page instead of JSON (HTTP ${res.status}) — it is probably restarting`
      );
    }
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  };
  try {
    return await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const transient = /restarting|network|Failed to fetch|HTTP 5\d\d|Load failed|web page/i.test(msg);
    if (attempts > 1 && transient) {
      await new Promise((r) => setTimeout(r, 1500));
      return fetchJsonSafe<T>(url, init, attempts - 1);
    }
    throw e;
  }
}
