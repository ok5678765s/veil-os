/**
 * freetube-service — index.ts (bun)
 *
 * HTTP face of the REAL FreeTube program (running in runtime.js under a
 * stubbed electron). Serves the program's own renderer (dist/) as a web
 * app and bridges window.ftElectron calls over HTTP/SSE to the program's
 * ipcMain handlers.
 *
 * PER-VIEWER ISOLATION: one FreeTube process per viewer key, each with its
 * own private data dir (data/viewers/<key>). Searches, watch history,
 * playlists, profiles and settings are NEVER shared between visitors of
 * the instance. The key comes from the request (mirrors the site's
 * viewer.ts): x-veil-viewer header → ?vv= query → veil_viewer cookie →
 * per-client anon bucket. Idle viewer processes are culled after 15 min
 * and respawn on demand (~2s boot).
 *
 * Routes:
 *   GET  /            → dist/index.html (patched with the browser bridge)
 *   GET  /static/*    → program static assets
 *   POST /ipc/invoke  → { channel, args } → real ipcMain handler result
 *                       (routed to the calling viewer's program process)
 *   GET  /ipc/events  → SSE stream of webContents.send broadcasts
 *                       (scoped to the calling viewer's process)
 *   GET  /healthz     → { ok, viewers, handlers }
 *
 * Port: fixed 3031 (gateway rule: no PORT env).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { createHash } from "node:crypto";
import { handleInvidious } from "./invidious-compat";
import { handleGrayjay } from "./grayjay-relay";

const PORT = 3031;
const ROOT = import.meta.dir;
const DIST = join(ROOT, "app", "dist");
const VIEWERS_ROOT = join(ROOT, "data", "viewers");
mkdirSync(VIEWERS_ROOT, { recursive: true });

/* ------------------------------------------------------------------ */
/* viewer key — mirrors src/lib/veil/viewer.ts                         */
/* ------------------------------------------------------------------ */

const VIEWER_RE = /^[A-Za-z0-9_-]{6,64}$/;

function cleanViewer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v.length < 6 || v.length > 64 || !VIEWER_RE.test(v)) return null;
  return v;
}

function fallbackViewer(req: Request): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  const ua = req.headers.get("user-agent") || "";
  const h = createHash("sha256").update(`${ip}\n${ua}`).digest("hex").slice(0, 24);
  return `anon-${h}`;
}

function viewerOf(req: Request, url: URL): string {
  const fromHeader = cleanViewer(req.headers.get("x-veil-viewer"));
  if (fromHeader) return fromHeader;
  try {
    const fromQuery = cleanViewer(url.searchParams.get("vv"));
    if (fromQuery) return fromQuery;
  } catch { /* not parseable */ }
  const cookieHeader = req.headers.get("cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== "veil_viewer") continue;
    const fromCookie = cleanViewer(part.slice(eq + 1).trim());
    if (fromCookie) return fromCookie;
  }
  return fallbackViewer(req);
}

/* ------------------------------------------------------------------ */
/* per-viewer program processes                                        */
/* ------------------------------------------------------------------ */

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };

type Proc = {
  viewer: string;
  child: ChildProcess;
  booted: boolean;
  handlers: string[];
  pending: Map<number, Pending>;
  seq: number;
  lastUsed: number;
  /** SSE responses watching THIS viewer's process */
  sse: Set<import("node:http").ServerResponse>;
  /** Resolves once the boot SEED is written — renderer invokes wait on it
   * so the program never reads settings before the seeds land (a race
   * that left fresh viewers on an empty Subscriptions page). */
  gate: Promise<void>;
  openGate?: () => void;
  intentional?: boolean;
};

/* Registry on globalThis so a bun --hot re-eval kills the previous module
 * instance's children instead of leaking them (5 orphans were found live). */
type G = typeof globalThis & { __veilFtProcs?: Map<string, Proc>; __veilFtInit?: boolean };
const G = globalThis as G;
if (G.__veilFtProcs) {
  for (const p of G.__veilFtProcs.values()) {
    p.intentional = true;
    try { p.child.kill(); } catch { /* already gone */ }
  }
}
const procs: Map<string, Proc> = (G.__veilFtProcs = new Map());

const IDLE_CULL_MS = 5 * 60_000; // viewer untouched for 5 min → culled (was 15:
// each live FreeTube program holds ~0.4-1.4GB on the 3.9GB no-swap box,
// and a long cull window strangled the box into watchdog emergencies
// that restarted the dev server under the user — the "it keeps
// restarting to home screen" bug; respawn on demand is ~2s)
const MAX_LIVE_VIEWERS = 8;       // hard cap; LRU evicted beyond this
const BOX_PRESSURE_KB = 600_000;  // MemAvailable under ~600MB → cull LRU

/** Box-level memory guard — culls the least-recently-used viewer when the
 * machine itself is running out (same signal the dev watchdog uses). One
 * viewer session must never take the whole site down with it. */
function boxMemAvailKb(): number {
  try {
    const mi = readFileSync("/proc/meminfo", "utf8");
    const m = /MemAvailable:\s+(\d+) kB/.exec(mi);
    return m ? parseInt(m[1], 10) : 9_999_999;
  } catch {
    return 9_999_999;
  }
}

function dataDirFor(viewer: string): string {
  // viewer keys are validated [A-Za-z0-9_-]{6,64} — safe as a dir name
  return join(VIEWERS_ROOT, viewer);
}

function startProc(viewer: string): Proc {
  const proc: Proc = {
    viewer,
    child: null as unknown as ChildProcess,
    booted: false,
    handlers: [],
    pending: new Map(),
    seq: 1,
    lastUsed: Date.now(),
    sse: new Set(),
    gate: null as unknown as Promise<void>,
  };
  // fail-safe: the gate opens by itself after 45s even if seeding hangs
  const bootGate = new Promise<void>((res) => { proc.openGate = res; });
  proc.gate = Promise.race([bootGate, new Promise<void>((r) => setTimeout(r, 45_000).unref?.())]);
  procs.set(viewer, proc);

  const child = spawn("node", [join(ROOT, "runtime.js"), dataDirFor(viewer)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.child = child;

  const rl = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let msg: any;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.type === "invoke-result") {
        const p = proc.pending.get(msg.id);
        if (p) {
          proc.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.value);
          else p.reject(new Error(msg.error?.message || "ipc error"));
        }
      } else if (msg.type === "event") {
        // broadcasts from THIS viewer's program → only that viewer's pages
        broadcastSSE(viewer, { channel: msg.channel, args: msg.args });
      } else if (msg.type === "boot") {
        proc.booted = true;
        proc.handlers = msg.handlers || [];
        console.log(`[freetube-service] program booted for viewer ${viewer}:`, proc.handlers.length, "handlers");
        // Pages left open across a child crash/restart reload themselves
        // (the browser bridge listens for this channel) — no more stuck
        // spinners after an internal restart.
        broadcastSSE(viewer, { channel: "veil-restart", args: [Date.now()] });
        // Seed first, THEN open the invoke gate (renderer's first settings
        // read must see the seeded landing page/format prefs).
        void seedDefaults(proc).catch(() => {}).finally(() => { try { proc.openGate?.(); } catch { /* already open */ } });
      } else if (msg.type === "boot-error") {
        console.error(`[freetube-service] BOOT ERROR (${viewer}):`, String(msg.error).slice(0, 600));
      }
    }
  };
  child.stdout!.on("data", rl);
  child.stderr!.on("data", (c: Buffer) => {
    for (const l of c.toString("utf8").split("\n")) {
      const t = l.trim();
      if (t && !t.startsWith("[freetube-runtime] invoke") && !t.includes("proxy no-op")) {
        console.log("[runtime:" + viewer + "]", t.slice(0, 200));
      }
    }
  });
  child.on("exit", (code) => {
    // rejects still-pending invokes so callers get a real error
    for (const p of proc.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("program process exited"));
    }
    proc.pending.clear();
    proc.booted = false;
    broadcastSSE(viewer, { channel: "veil-restart", args: [Date.now()] });
    if (proc.intentional || !procs.has(viewer)) return; // culled / replaced
    console.warn(`[freetube-service] program for viewer ${viewer} exited`, code, "— restarting in 1.5s");
    setTimeout(() => {
      if (!procs.has(viewer)) return;
      procs.delete(viewer);
      startProc(viewer);
    }, 1500);
  });
  return proc;
}

/** The process for a viewer — spawned on demand, warmed if already alive. */
function procFor(viewer: string, touch = true): Proc {
  let p = procs.get(viewer);
  if (!p) {
    if (procs.size >= MAX_LIVE_VIEWERS) {
      // LRU eviction — least-recently-used non-culled viewer
      let oldest: Proc | null = null;
      for (const cand of procs.values()) if (!oldest || cand.lastUsed < oldest.lastUsed) oldest = cand;
      if (oldest) {
        console.log(`[freetube-service] evicting LRU viewer ${oldest.viewer} (cap ${MAX_LIVE_VIEWERS})`);
        killProc(oldest);
      }
    }
    p = startProc(viewer);
  }
  if (touch) p.lastUsed = Date.now();
  return p;
}

function killProc(p: Proc): void {
  p.intentional = true;
  procs.delete(p.viewer);
  try { p.child.kill(); } catch { /* already gone */ }
}

/* Culling + liveness pings (kept alive across --hot reloads: the child's
 * own 3-min silent-stdin guard reaps anything the timers miss). */
if (!G.__veilFtInit) {
  G.__veilFtInit = true;
  setInterval(() => {
    const now = Date.now();
    for (const p of [...procs.values()]) {
      if (now - p.lastUsed > IDLE_CULL_MS) {
        console.log(`[freetube-service] culling idle viewer ${p.viewer}`);
        killProc(p);
      }
    }
    // Box-pressure eviction: with viewers still alive but the box out of
    // memory, drop the LRU viewer (never the just-used one) so the dev
    // server survives. The evicted viewer respawns in ~2s on next use.
    if (procs.size > 0 && boxMemAvailKb() < BOX_PRESSURE_KB) {
      let oldest: Proc | null = null;
      for (const cand of procs.values()) if (!oldest || cand.lastUsed < oldest.lastUsed) oldest = cand;
      if (oldest) {
        console.log(`[freetube-service] box memory pressure — evicting LRU viewer ${oldest.viewer}`);
        killProc(oldest);
      }
    }
  }, 60_000).unref?.();
  setInterval(() => {
    for (const p of procs.values()) {
      try { p.child.stdin?.write("\n"); } catch { /* dead — culler handles */ }
    }
  }, 30_000).unref?.();
  /* A floating rejection (e.g. a piped() gate error surfaced late) must
   * never kill the whole service: the crash-restart loop resets every
   * in-memory cache and reloads every open page — that read as "videos
   * never load". Log, keep serving. */
  process.on("unhandledRejection", (err) => {
    console.error("[freetube-service] UNHANDLED rejection:", String((err as Error)?.message || err).slice(0, 400));
  });
  process.on("uncaughtException", (err) => {
    console.error("[freetube-service] UNCAUGHT exception:", String((err as Error)?.message || err).slice(0, 400));
  });
}

function childInvoke(viewer: string, channel: string, args: unknown[]): Promise<unknown> {
  const proc = procFor(viewer);
  return (async () => {
    // renderer invokes wait for the boot seed (the SEED itself bypasses
    // this via rawInvoke — see seedDefaults)
    await proc.gate.catch(() => { /* gate is fail-safe anyway */ });
    return new Promise<unknown>((resolve, reject) => {
      if (!proc.child.stdin?.writable) return reject(new Error("program not running"));
      const id = proc.seq++;
      const timer = setTimeout(() => {
        proc.pending.delete(id);
        reject(new Error(`ipc timeout: ${channel}`));
      }, 45000);
      proc.pending.set(id, { resolve, reject, timer });
      proc.child.stdin.write(JSON.stringify({ type: "invoke", id, channel, args }) + "\n");
    });
  })();
}

/** Ungated invoke for the boot seed itself (chicken-and-egg escape). */
function rawInvoke(proc: Proc, channel: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!proc.child.stdin?.writable) return reject(new Error("program not running"));
    const id = proc.seq++;
    const timer = setTimeout(() => {
      proc.pending.delete(id);
      reject(new Error(`ipc timeout: ${channel}`));
    }, 45000);
    proc.pending.set(id, { resolve, reject, timer });
    proc.child.stdin.write(JSON.stringify({ type: "invoke", id, channel, args }) + "\n");
  });
}

/* ------------------------------------------------------------------ */
/* SSE — scoped per viewer                                             */
/* ------------------------------------------------------------------ */

function broadcastSSE(viewer: string, payload: unknown): void {
  const set = procs.get(viewer)?.sse;
  if (!set || set.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { set.delete(res); /* dropped */ }
  }
}

/* ------------------------------------------------------------------ */
/* settings seed — make the program usable from a browser origin       */
/* ------------------------------------------------------------------ */

const SEED: Array<{ _id: string; value: unknown }> = [
  { _id: "backendPreference", value: "invidious" },
  { _id: "defaultInvidiousInstance", value: "https://freetube-instance.veil.local" },
  { _id: "backendFallback", value: false }, // local API is CORS-blocked in browsers
  // First open shows content: Most Popular (Invidious trending) instead of
  // an empty subscriptions list — the user can change it in Settings any time.
  { _id: "landingPage", value: "popular" },
  // The player's default is "dash": it builds a data:-URL DASH manifest from
  // adaptiveFormats — but the upstream gate often hands Piped ONLY a combined
  // (video+audio) progressive format, which cannot form a working DASH
  // manifest, so MSE stalls at readyState 0 with a blob: src and no data.
  // "legacy" makes the player use formatStreams directly (video.src =
  // the progressive URL), which streams fine (verified: HTTP 206 video/mp4).
  { _id: "defaultVideoFormat", value: "legacy" },
  // Videos should play in 4K, not 1080p: the quality selector defaults
  // to the program's "720" otherwise (and auto caps by viewport). 2160
  // makes the player grab the highest stream ≤ 4K — falling back down
  // the ladder when a video has no 4K format. (User-togglable in the
  // player's own quality menu any time.)
  { _id: "defaultQuality", value: "2160" },
  // History/search privacy is the service's contract — the program's
  // remember-history/search defaults would persist cross-session otherwise.
  // (Both stay user-togglable: a viewer can flip them back in Settings.)
  { _id: "rememberHistory", value: true },
  { _id: "saveSearchHistory", value: true },
];

async function seedDefaults(proc: Proc): Promise<void> {
  try {
    // action 1 = find, 2 = upsert (program's numeric DB actions)
    const existing = (await rawInvoke(proc, "db-settings", [{ action: 1 }])) as Array<{ _id: string; value: unknown }>;
    const have = new Set((existing || []).map((d) => d._id));
    for (const doc of SEED) {
      if (!have.has(doc._id)) {
        await rawInvoke(proc, "db-settings", [{ action: 2, data: doc }]);
        console.log(`[freetube-service] seeded setting (${proc.viewer}):`, doc._id, "=", String(doc.value));
      }
    }
  } catch (err) {
    console.error(`[freetube-service] seed failed (${proc.viewer}):`, String(err));
  }
}

/* ------------------------------------------------------------------ */
/* static file serving (the program's own renderer)                    */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-ico",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/* The renderer's index.html, patched to load our browser bridge first.
 * Cache keyed on the bridge file's mtime: the bridge is read with
 * readFileSync (NOT a module import), so bun --hot does not reload it —
 * an mtime check makes bridge edits take effect on the very next page
 * load instead of serving a stale patch forever. */
let patchedIndex: { at: number; body: Buffer } | null = null;
function getPatchedIndex(): Buffer {
  const bridgePath = join(ROOT, "ft-electron-bridge.js");
  const mtime = statSync(bridgePath).mtimeMs;
  if (patchedIndex && patchedIndex.at === mtime) return patchedIndex.body;
  let html = readFileSync(join(DIST, "index.html"), "utf8");
  const bridge = readFileSync(bridgePath, "utf8");
  const tag = `<script>\n${bridge}\n</script>\n`;
  if (html.includes("renderer.js")) {
    // inject before the renderer bundle so window.ftElectron exists first
    html = html.replace(/<script[^>]*src="renderer\.js"[^>]*>\s*<\/script>/, `${tag}$&`);
  }
  if (!html.includes("ftElectron")) {
    html = html.replace("</head>", `${tag}</head>`);
  }
  // No "About" in the program: the side-nav entry (and any /about link)
  // is hidden, and a #/about hash is scrubbed to the settings page before
  // the router can land on it. Requested by the owner — the veil keeps its
  // own Settings; the program's About page (version, licenses, external
  // links) does not exist as far as visitors can tell.
  const aboutScrub = `<style>a[href="#/about"]{display:none !important;}</style>
<script>
(function () {
  function scrubAboutHash() {
    var h = location.hash || "";
    if (/^#\\/about\\/?(\\?|#|$)/.test(h)) {
      location.replace(location.pathname + location.search + "#/settings");
      return true;
    }
    return false;
  }
  scrubAboutHash();
  window.addEventListener("hashchange", scrubAboutHash);
})();
</script>
`;
  html = html.replace("</head>", `${aboutScrub}</head>`);
  // Give the app a real title
  html = html.replace("<title></title>", "<title>FreeTube — Veil YouTube</title>");
  patchedIndex = { at: mtime, body: Buffer.from(html, "utf8") };
  return patchedIndex.body;
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const server = Bun.serve({
  port: PORT,
  // Bun's DEFAULT idleTimeout is 10s — it killed in-flight requests whose
  // upstream (Piped, slow under Google's rotating gate + retry pass) takes
  // longer: socket reset mid-request → Next's rewrite proxy answered
  // plain-text "Internal Server Error" → the renderer's res.json() crashed
  // with "Unexpected token 'I'". 120s covers the slowest legitimate request
  // (IPC handler timeout 45s; Piped 2 instances × 8s + retry pass ≈ 33s).
  idleTimeout: 120,
  // ANY error thrown by fetch() must surface as JSON, never plain text.
  error: (err) => new Response(
    JSON.stringify({ ok: false, error: { message: String((err as Error)?.message || err) } }),
    { status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
  ),
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);

    // Grayjay innertube relay (plugin player calls patched to /gj/* and
    // the patched web player's /gjmedia/* lookups)
    if (p.startsWith("/gj/") || p.startsWith("/gjmedia/")) {
      const handled = await handleGrayjay(p, req, url);
      if (handled) return handled;
    }

    // The Veil-signed Grayjay YouTube plugin package (self-hosted so the
    // program's script-signature verification passes with our relay patch).
    if (p.startsWith("/gj-plugin/")) {
      const rel = normalize(p).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]/, "").replace(/^gj-plugin\//, "");
      const filePath = join(ROOT, "gj-plugin", rel);
      if (filePath.startsWith(join(ROOT, "gj-plugin")) && existsSync(filePath)) {
        const body = readFileSync(filePath);
        return new Response(body, {
          headers: {
            "content-type": extname(filePath) === ".json" ? "application/json" : MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
            "cache-control": "no-cache",
            "access-control-allow-origin": "*",
          },
        });
      }
      return new Response("plugin file not found", { status: 404 });
    }

    // CORS preflight — the offline file's app frame is cross-origin, and its
    // JSON POSTs (content-type: application/json) preflight. Answer once,
    // generously cached, so the per-request cost is zero.
    if (req.method === "OPTIONS" && (p === "/ipc/invoke" || p === "/ipc/events")) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
    }

    // IPC bridge — routed to the calling viewer's program process
    if (req.method === "POST" && p === "/ipc/invoke") {
      const viewer = viewerOf(req, url);
      try {
        const { channel, args } = (await req.json()) as { channel?: string; args?: unknown[] };
        if (!channel || typeof channel !== "string" || !/^[a-z0-9-]{2,48}$/.test(channel)) {
          return new Response(JSON.stringify({ ok: false, error: { message: "bad channel" } }), { status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
        }
        const value = await childInvoke(viewer, channel, Array.isArray(args) ? args : []);
        return new Response(JSON.stringify({ ok: true, value: value === undefined ? null : value }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: { message: String((err as Error)?.message || err) } }), {
          status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "GET" && p === "/ipc/events") {
      // SSE — events from the CALLING viewer's process only (cross-origin
      // callers pass ?vv=; same-origin ones ride the veil_viewer cookie).
      const viewer = viewerOf(req, url);
      procFor(viewer); // make sure the program for this viewer is alive
      const proc = procs.get(viewer)!;
      return new Response(new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const queue = (data: string) => { try { controller.enqueue(enc.encode(data)); } catch { /* gone */ } };
          queue("retry: 3000\n\n");
          const res = {
            write: (d: string) => queue(d),
            end: () => { try { controller.close(); } catch { /* already closed */ } },
          } as unknown as import("node:http").ServerResponse;
          proc.sse.add(res);
          proc.lastUsed = Date.now();
          // @ts-expect-error cleanup hook
          controller.onAbort = () => {
            proc.sse.delete(res);
            proc.lastUsed = Date.now();
          };
        },
      }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "access-control-allow-origin": "*", connection: "keep-alive" } });
    }

    if (p === "/healthz") {
      return new Response(JSON.stringify({
        ok: true,
        viewers: procs.size,
        live: [...procs.values()].map((pr) => ({ viewer: pr.viewer, booted: pr.booted, idleMin: Math.round((Date.now() - pr.lastUsed) / 60000) })),
        handlers: procs.size > 0 ? [...procs.values()][0].handlers.length : 0,
        app: "FreeTube 0.25.3 (veil, per-viewer)",
      }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Invidious-compatible API (the program's data source) — a failure here
    // must always produce an Invidious-shaped JSON error so the program's
    // own error/retry UX handles it (never a plain-text 500).
    if (p.startsWith("/ft-invidious/") || p.startsWith("/api/v1/")) {
      const invidiousPath = p.replace(/^\/ft-invidious/, "");
      try {
        return await handleInvidious(invidiousPath, url, req);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: String((err as Error)?.message || err), errorType: "api_request_failed" }),
          { status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
        );
      }
    }

    // The app entry: patched index.html with the browser bridge
    if (p === "/" || p === "/index.html" || p === "/ft" || p === "/ft/") {
      const body = getPatchedIndex();
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }

    // Static: the program's own renderer (guard against traversal)
    if (p.endsWith("/")) p += "index.html";
    const rel = normalize(p).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]/, "");
    const filePath = join(DIST, rel);
    if (!filePath.startsWith(DIST)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = extname(filePath).toLowerCase();
      /* The program ships its locales as .json.br — the renderer fetches
       * them and calls res.json(), so the browser must transparently
       * decompress: label the inner type + content-encoding: br. Serving
       * them as opaque octet-streams left the whole UI on raw i18n keys
       * ("Subscriptions.Subscriptions", "Trending.Trending"). */
      const isBr = ext === ".br";
      const innerExt = isBr ? extname(filePath.slice(0, -3)).toLowerCase() : ext;
      return new Response(file, {
        headers: {
          "content-type": isBr ? (MIME[innerExt] || "application/json") : (MIME[ext] || "application/octet-stream"),
          ...(isBr ? { "content-encoding": "br", "vary": "accept-encoding" } : {}),
          "cache-control": "public, max-age=3600",
          // cross-origin readers (the offline file's app frame) fetch these
          "access-control-allow-origin": "*",
        },
      });
    }
    // SPA-ish fallback for extension-less paths (hash router handles them)
    if (!extname(p)) {
      const idx = Bun.file(join(DIST, "index.html"));
      if (await idx.exists()) return new Response(idx, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[freetube-service] listening on :${PORT} — the real FreeTube program, per-viewer isolation ON`);

/* allow bun --hot restarts to clean up */
process.on("exit", () => {
  for (const p of procs.values()) {
    p.intentional = true;
    try { p.child.kill(); } catch { /* already gone */ }
  }
});
