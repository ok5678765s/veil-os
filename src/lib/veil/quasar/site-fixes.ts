/**
 * Quasar Per-Site Fix Database
 * ----------------------------
 * Declarative compatibility overrides consulted by the engine on every
 * request, keyed by hostname suffix (longest match wins). Three consumers:
 *
 *   - fetcher.ts     → requestHeaders / stripRequestHeaders merged into the
 *                      upstream request; flags gate body rewriting.
 *   - rewriter.ts    → flags + the client-hook list injected into HTML.
 *   - hooks bundle   → clientHooks executed at document-start (__QUASAR_SITE__).
 *
 * Philosophy: only record what is KNOWN to differ. Flags are escape hatches —
 * when a site breaks under the AST rewriter, `noAst` drops it back to runtime
 * hooks instead of shipping a broken page.
 */

export interface SiteFlags {
  /** Skip acorn-based JS rewriting for this site (runtime hooks still apply). */
  noAst?: boolean;
  /** Skip the streaming HTML rewriter and use the buffered pipeline. */
  noStream?: boolean;
  /** Skip conservative JSON media-URL rewriting. */
  noJsonMedia?: boolean;
  /**
   * v2.0.4 — virtual location layer. The AST rewriter renames every free
   * `location` / `window.location` / `document.location` reference to the
   * `__quasar_loc$` shim whose href/origin/host/protocol/... getters report
   * the REAL target URL while navigation (href=, assign/replace) stays inside
   * the tunnel. Gated per site because `location === window.location`
   * identity checks can still see through the shim.
   */
  virtLoc?: boolean;
}

export interface SiteFix {
  id: string;
  /** Hostname suffixes this fix applies to ("youtube.com" matches www.youtube.com). */
  match: string[];
  /** Extra headers merged into the upstream request. */
  requestHeaders?: Record<string, string>;
  /** Headers removed from the upstream request. */
  stripRequestHeaders?: string[];
  flags?: SiteFlags;
  /** Names of client-side fixes (see hooks.ts CLIENT_FIXES) to run on page load. */
  clientHooks?: string[];
  note?: string;
}

const FIXES: SiteFix[] = [
  {
    id: "google",
    match: ["google.com", "googleapis.com", "gstatic.com", "googleusercontent.com", "googlevideo.com"],
    flags: { noAst: true },
    note: "Enormous anti-tamper bundles — AST pass is skipped; runtime hooks + SW carry the load.",
  },
  {
    id: "youtube",
    match: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
    flags: { noAst: true },
    clientHooks: ["fixHasFocus"],
    note: "Search/UI/browse work via URL repair; playback needs poToken (target-side anti-bot, affects all proxies).",
  },
  {
    id: "discord",
    match: ["discord.com", "discordapp.com", "discordapp.net"],
    flags: { virtLoc: true },
    clientHooks: ["fakeNotifications", "fixHasFocus", "pmOrigins"],
    note: "v2.0.4: virtual location layer (webpack runtime reads location.origin for asset/API URLs) + postMessage origin unwrap for OAuth popups; WS bridge dials with the real Origin/User-Agent; voice/RTC is native WebRTC.",
  },
  {
    id: "spotify",
    match: ["spotify.com", "scdn.co", "spotifycdn.com"],
    flags: { noAst: true },
    clientHooks: ["fixHasFocus"],
  },
  {
    id: "x-twitter",
    match: ["twitter.com", "x.com", "twimg.com"],
    flags: { noAst: true },
    clientHooks: ["fixHasFocus"],
    note: "Login-gated; heavy integrity checks on scripts.",
  },
  {
    id: "meta",
    match: ["facebook.com", "instagram.com", "cdninstagram.com", "fbcdn.net"],
    flags: { noAst: true },
    clientHooks: ["fixHasFocus"],
    note: "Login + bot walls are target-side; page rendering is kept intact.",
  },
  {
    id: "reddit",
    match: ["reddit.com", "redditstatic.com", "redd.it"],
    flags: { noAst: true },
    note: "Datacenter-IP rate limits are target-side.",
  },
  {
    id: "twitch",
    match: ["twitch.tv", "twitchcdn.net", "ttvnw.net"],
    flags: { noAst: true },
    clientHooks: ["fixHasFocus"],
    note: "Live playback uses HLS (m3u8 rewriting covers manifests).",
  },
  {
    id: "github",
    match: ["github.com", "githubusercontent.com", "github.io"],
    note: "Full AST + streaming pipeline stays on; GitHub is the regression canary.",
  },
  {
    id: "netflix",
    match: ["netflix.com", "nflxvideo.net", "nflxext.com"],
    clientHooks: ["fixHasFocus"],
    note: "Widevine DRM streams cannot be decrypted by any rewriting proxy.",
  },
  {
    id: "wikipedia",
    match: ["wikipedia.org", "wikimedia.org", "wiktionary.org", "wikidata.org"],
    note: "Rate limits against datacenter IPs are target-side.",
  },
  {
    id: "roblox",
    match: ["roblox.com", "rbxcdn.com", "roblox-api.com", "rbx.com"],
    flags: { noAst: true },
    clientHooks: ["fakeNotifications"],
    note: "v2.4.1: SPA runs unrewritten (noAst) — the SW + runtime fetch/XHR hooks tunnel its runtime-built apis.roblox.com URLs; framebusters neutralized in the HTML pipelines; x-csrf-token exposed; Domain=.roblox.com cookies shared across subdomains. Game LAUNCH needs the native player (roblox-player://), browsing/search/login work.",
  },
  {
    id: "duckduckgo",
    match: ["duckduckgo.com", "ddg.gg"],
    note: "lite/html endpoints proxy well; js endpoint bot-walls datacenter IPs.",
  },
  {
    id: "hackernews",
    match: ["news.ycombinator.com", "ycombinator.com"],
    note: "Plain HTML — the streaming rewriter's easiest case.",
  },
  {
    id: "openstreetmap",
    match: ["openstreetmap.org", "osm.org"],
    note: "Leaflet tiles + JS survive the full pipeline; good AST canary.",
  },
];

/* ------------------------------------------------------------------ */
/* v2.0.4 — direct-media hosts (browser-fetched, never tunneled)       */
/* ------------------------------------------------------------------ */

/**
 * v2.0.4 — direct-media hosts (browser-fetched, never tunneled).
 * Configured via QUASAR_DIRECT_MEDIA_HOSTS (comma-separated suffix list).
 * Empty by default: googlevideo.com — the motivating host — withholds CORS
 * headers on its SABR (UMP POST) streaming responses for third-party
 * origins, so MSE playback starves in browser-direct mode; proxied
 * streaming (server-side fetch) is the proven working default. Deployments
 * that prefer direct media (real Chrome TLS + real client IP, e.g. for
 * <video src> progressive playback) can opt in with
 * QUASAR_DIRECT_MEDIA_HOSTS=googlevideo.com. Rewriters, the AST pass, the
 * client hooks and the service worker all consult this list.
 */
export const DIRECT_MEDIA_HOSTS: string[] = (process.env.QUASAR_DIRECT_MEDIA_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isDirectMediaHost(url: string | URL): boolean {
  if (!DIRECT_MEDIA_HOSTS.length) return false;
  try {
    const host = (url instanceof URL ? url : new URL(url)).hostname.toLowerCase();
    return DIRECT_MEDIA_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

const cache = new Map<string, SiteFix | null>();

function suffixMatch(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

/** Resolve the fix for a URL (null when no entry matches). Cached per hostname. */
export function siteFixFor(url: string | URL): SiteFix | null {
  let host: string;
  try {
    host = (url instanceof URL ? url : new URL(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (cache.has(host)) return cache.get(host) ?? null;
  let found: SiteFix | null = null;
  let bestLen = -1;
  for (const fix of FIXES) {
    for (const suffix of fix.match) {
      if (suffixMatch(host, suffix) && suffix.length > bestLen) {
        found = fix;
        bestLen = suffix.length;
      }
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(host, found);
  return found;
}

/** All client hook names referenced by the database (validation aid). */
export const CLIENT_HOOK_NAMES: string[] = Array.from(
  new Set(FIXES.flatMap((f) => f.clientHooks ?? []))
);

/* ------------------------------------------------------------------ */
/* v2.1.0 — site-fix packs from disk (community contributions)          */
/* ------------------------------------------------------------------ */
/**
 * JSON fix packs live in QUASAR_SITE_FIXES_DIR (default ./site-fixes.d).
 * Each *.json file holds one SiteFix object or an array of them; entries are
 * spliced BEFORE the built-ins so a pack can override on suffix-length ties
 * (longest suffix still wins regardless). Reload: files' combined mtime is
 * polled every 30s — drop a pack in, it goes live without a restart. Invalid
 * entries are skipped with a log line; nothing here can throw at runtime.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

function packsDir(): string {
  return process.env.QUASAR_SITE_FIXES_DIR
    ? pathResolve(process.env.QUASAR_SITE_FIXES_DIR)
    : join(process.cwd(), "site-fixes.d");
}

function dirStamp(dir: string): string {
  try {
    let stamp = "";
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".json")) continue;
      stamp += f + ":" + statSync(join(dir, f)).mtimeMs + ";";
    }
    return stamp;
  } catch {
    return "";
  }
}

function coerceFix(raw: unknown, source: string): SiteFix | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !Array.isArray(r.match) || !r.match.length) return null;
  const match = r.match.filter((m): m is string => typeof m === "string" && m.length > 1);
  if (!match.length) return null;
  const fix: SiteFix = { id: r.id.slice(0, 60), match };
  if (r.note && typeof r.note === "string") fix.note = r.note.slice(0, 400);
  if (r.requestHeaders && typeof r.requestHeaders === "object") {
    const rh: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.requestHeaders as Record<string, unknown>)) {
      if (typeof v === "string") rh[k.slice(0, 60)] = v.slice(0, 400);
    }
    if (Object.keys(rh).length) fix.requestHeaders = rh;
  }
  if (Array.isArray(r.stripRequestHeaders)) {
    fix.stripRequestHeaders = r.stripRequestHeaders
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.slice(0, 60));
  }
  if (Array.isArray(r.clientHooks)) {
    fix.clientHooks = r.clientHooks
      .filter((s): s is string => typeof s === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(s));
  }
  if (r.flags && typeof r.flags === "object") {
    const f = r.flags as Record<string, unknown>;
    fix.flags = {
      noAst: f.noAst === true,
      noStream: f.noStream === true,
      noJsonMedia: f.noJsonMedia === true,
      virtLoc: f.virtLoc === true,
    };
  }
  console.log(
    `[quasar] site-fix pack entry "${fix.id}" loaded (${fix.match.length} hosts) from ${source}`
  );
  return fix;
}

let lastStamp = "";
let packsWatcher: ReturnType<typeof setInterval> | null = null;
/** Pack entries currently spliced into FIXES (removed again on reload). */
let loadedPacks: SiteFix[] = [];

export function reloadSiteFixes(): number {
  const dir = packsDir();
  let count = 0;
  const fixes: SiteFix[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          const fix = coerceFix(item, f);
          if (fix) fixes.push(fix);
        }
      } catch (err) {
        console.error(`[quasar] site-fix pack ${f} unreadable:`, err);
      }
    }
  }
  // Swap out previously loaded packs, splice the fresh set in front of the
  // built-ins (equal-length suffix ties resolve to the pack; everything else
  // still follows longest-suffix-wins), then invalidate the lookup cache.
  for (let i = FIXES.length - 1; i >= 0; i--) {
    if (loadedPacks.includes(FIXES[i])) FIXES.splice(i, 1);
  }
  FIXES.unshift(...fixes);
  loadedPacks = fixes;
  count = fixes.length;
  cache.clear();
  return count;
}

(function initPacks() {
  try {
    const n = reloadSiteFixes();
    if (n) console.log(`[quasar] ${n} site-fix pack entr${n === 1 ? "y" : "ies"} loaded from ${packsDir()}`);
    lastStamp = dirStamp(packsDir());
  } catch {
    return;
  }
  if (packsWatcher) return;
  packsWatcher = setInterval(() => {
    try {
      const stamp = dirStamp(packsDir());
      if (stamp !== lastStamp) {
        lastStamp = stamp;
        const n = reloadSiteFixes();
        console.log(`[quasar] site-fix packs reloaded: ${n} active entr${n === 1 ? "y" : "ies"}`);
      }
    } catch {
      /* watcher is best-effort */
    }
  }, 30_000);
  try {
    (packsWatcher as unknown as { unref?: () => void }).unref?.();
  } catch {}
})();
