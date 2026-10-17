/**
 * Veil — motionbgs.com media accelerator.
 *
 * motionbgs.com's Cloudflare front issues a managed challenge ("Just a
 * moment…") for every request to its /media/*.mp4 video files that does not
 * come from a curl-like HTTP client — the Node/Bun `fetch` TLS+HTTP
 * fingerprint is flagged even with a perfect Chrome UA and referer, while
 * the same URL fetched with curl sails through (verified both ways from
 * this server). Listing pages and thumbnail images are not challenged, so
 * only the video path needs special treatment.
 *
 * This module fetches those videos with a curl subprocess instead and
 * keeps them in a bounded disk cache, serving subsequent requests (HTTP
 * range requests included) straight from disk — a looping wallpaper is
 * downloaded from motionbgs exactly once, ever, per video.
 *
 * Cold requests STREAM while curl downloads: the first GET on an
 * uncached file pipes the bytes to the client the moment curl writes
 * them (chunked 200), instead of holding the connection until the whole
 * file lands. Awaiting the full download answered nothing for up to
 * 120s per variant (×3 fallback variants) — through the single shared
 * gateway port that ate the browser's entire 6-connection HTTP/1.1
 * budget, which froze the page: no popups, no thumbnails, no previews.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { runtimeCacheDir } from "./runtime-cache-dir";

/* 2026-10-17 "restarts to home screen every minute": this cache used to
 * live at <project>/.mbgs-cache — INSIDE the tree `next dev` watches.
 * Every wallpaper/live-media fetch that landed a file there recompiled
 * every route importing this module and force-reloaded all viewers via
 * Fast Refresh. It now lives outside the watched tree (see
 * lib/veil/runtime-cache-dir.ts). */
const CACHE_DIR = runtimeCacheDir("mbgs-cache", process.env.MBGS_CACHE_DIR);
/** Hard cap for the whole cache directory (LRU-evicted by mtime). */
const MAX_CACHE_BYTES = 400 * 1024 * 1024;
/** Single files larger than this are served but never committed to cache. */
const MAX_CACHED_FILE_BYTES = 150 * 1024 * 1024;
/** curl wall-clock budget for one video download. */
const CURL_TIMEOUT_S = 120;
/** Hard wall-clock budget for one live-streaming response (client side). */
const LIVE_STREAM_MAX_MS = 180_000;
/** How often the live streamer polls the growing file (ms). */
const LIVE_POLL_MS = 150;
/** Max bytes pushed to the client per pull cycle (smooths memory). */
const LIVE_CHUNK_BYTES = 2 * 1024 * 1024;

const CURL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** motionbgs hosts whose /media/*.mp4 files we accelerate. */
const MBGS_HOSTS = new Set(["motionbgs.com", "www.motionbgs.com"]);

/** 4kwallpapers hosts whose catalog thumbnails we accelerate (same curl
 *  cache + retry chain: their CDN intermittently challenges the runtime
 *  fetch too, and with no durable cache + no browser caching every
 *  gallery open re-fought the CDN roulette — the "no thumbnails" bug). */
const WALL4K_HOSTS = new Set(["4kwallpapers.com", "www.4kwallpapers.com"]);

/** True for a 4kwallpapers catalog thumb: /images/walls/thumbs/<id>.<ext>. */
export function is4kWallpaperThumb(u: URL): boolean {
  if (u.protocol !== "https:" || !WALL4K_HOSTS.has(u.hostname.toLowerCase())) {
    return false;
  }
  return /^\/images\/walls\/thumbs(?:_2t)?\/\d+\.(jpe?g|png|webp)$/i.test(u.pathname);
}

export function isMotionbgsMedia(u: URL): boolean {
  if (u.protocol !== "https:" || !MBGS_HOSTS.has(u.hostname.toLowerCase())) {
    return false;
  }
  const p = u.pathname;
  // Thumbnail images live under /i/c/…/media/…, pages live at /{slug} —
  // only a top-level /media/{id}/{file} path is a video.
  if (!p.startsWith("/media/")) {
    // Catalog thumbnails: /i/c/{W}x{H}/media/{id}/{slug}.3840x2160.jpg —
    // Cloudflare challenges the runtime's fetch on these intermittently
    // (the same bot wall the videos hit), so they ride the curl cache.
    return /^\/i\/c\/\d+x\d+\/media\/\d+\/[a-z0-9][a-z0-9.-]*\.jpe?g$/i.test(p);
  }
  const rest = p.slice("/media/".length);
  if (!/^\d+\/[a-z0-9][a-z0-9.-]*$/i.test(rest)) return false;
  // Either the real .mp4 file or the extension-less page-style video path
  // that older Veil builds saved into localStorage (those must be healed
  // server-side too, or Cloudflare 403s them and the backdrop dies).
  return rest.toLowerCase().endsWith(".mp4") || !rest.includes(".");
}

/**
 * Canonical video URL for a motionbgs /media request.
 *
 * motionbgs transcodes every wallpaper into multiple resolutions —
 * 3840x2160 (4K), 1920x1080, and 960x540 (verified live across the
 * catalog). Older Veil builds requested the 960x540 file, which reads
 * soft on any modern display; the quality fix is to canonicalize every
 * /media request — extension-less stale paths AND low-res variants —
 * to the 4K file, with a resolution fallback chain at download time for
 * the rare entry that lacks a 4K render.
 */
const MBGS_VARIANTS = ["3840x2160", "1920x1080", "960x540"] as const;

function canonicalMediaUrl(
  u: URL,
  res: (typeof MBGS_VARIANTS)[number] = "3840x2160"
): URL {
  // /media/{id}/{slug}[.{W}x{H}]?.mp4 (or extension-less) → canonical key
  const m = /^\/media\/(\d+)\/([a-z0-9][a-z0-9.-]*?)(?:\.\d{3,4}x\d{3,4})?\.mp4$/i.exec(
    u.pathname
  );
  if (m) {
    const fixed = new URL(u.href);
    fixed.pathname = `/media/${m[1]}/${m[2]}.${res}.mp4`;
    // Serving hints (?vw=…) are instructions, not asset identity — strip
    // them so cache keys and etags stay clean.
    fixed.searchParams.delete("vw");
    return fixed;
  }
  // Extension-less /media/{id}/{slug} (stale saved path) — heal it too.
  const extless = /^\/media\/(\d+)\/([a-z0-9-]+)$/i.exec(u.pathname);
  if (extless) {
    const fixed = new URL(u.href);
    fixed.pathname = `/media/${extless[1]}/${extless[2]}.${res}.mp4`;
    fixed.searchParams.delete("vw");
    return fixed;
  }
  const bare = new URL(u.href);
  bare.searchParams.delete("vw");
  return bare;
}

/**
 * The download chain for a canonical href. Preview-canonical requests
 * (the 1920x1080 key used by hover previews / the preview popup) fall
 * back LIGHT: 1080p → 540p → 4K, so a missing render never turns a
 * hover into a full 4K download. Full-canonical requests (Apply /
 * Download / the applied backdrop) keep 4K first. Thumbnail URLs are
 * single-variant — they pass through untouched.
 */
function variantHrefs(canonicalHref: string): string[] {
  const m = /\.(\d{3,4}x\d{3,4})\.mp4$/i.exec(canonicalHref);
  if (!m) return [canonicalHref];
  const preferred = m[1].toLowerCase();
  if (!(MBGS_VARIANTS as readonly string[]).includes(preferred)) return [canonicalHref];
  const order =
    preferred === "1920x1080"
      ? ["1920x1080", "960x540", "3840x2160"] // preview: stay light
      : ["3840x2160", "1920x1080", "960x540"];
  return order.map((v) => canonicalHref.replace(/\.\d{3,4}x\d{3,4}\.mp4$/i, `.${v}.mp4`));
}

/** True when the (canonical) href is a catalog thumbnail image (motionbgs
 *  /i/c/ jpgs or 4kwallpapers /images/walls/thumbs/ jpg/png/webp). */
function isImageHref(href: string): boolean {
  return (
    /\/i\/c\/\d+x\d+\/media\//i.test(href) ||
    /\/images\/walls\/thumbs(?:_2t)?\//i.test(href) ||
    /\.(jpe?g|png|webp)(\?|$)/i.test(href)
  );
}

/* ------------------------------------------------------------------ */
/* cache plumbing                                                      */
/* ------------------------------------------------------------------ */

function cacheFileFor(href: string): string {
  const h = createHash("sha256").update(href).digest("hex").slice(0, 32);
  const m = /\.(jpe?g|png|webp)(\?|$)/i.exec(href);
  const ext = m ? `.${m[1].toLowerCase().replace("jpeg", "jpg")}` : ".mp4";
  return path.join(CACHE_DIR, `${h}${ext}`);
}

/* ------------------------------------------------------------------ */
/* Download queue                                                      */
/* ------------------------------------------------------------------ */

/** Max simultaneous curl subprocesses — a mouse sweep across the live
 *  grid (or several viewers) can request a dozen cold videos at once;
 *  unbounded parallel curls hammer the CDN into rate-limiting and starve
 *  this box, so extra downloads wait their turn instead.
 *
 *  High-priority (client GET) downloads may use every slot; low-priority
 *  warm-ups (HEAD pre-heat) only run while at most half the slots are
 *  busy — so an actual hover/click preview never queues behind six
 *  background warm-up downloads. */
const MAX_CONCURRENT_CURLS = 6;
let activeCurls = 0;
const highWaiters: (() => void)[] = [];
const lowWaiters: (() => void)[] = [];

function wakeCurlWaiter(): void {
  const high = highWaiters.shift();
  if (high) return high();
  if (activeCurls < Math.ceil(MAX_CONCURRENT_CURLS / 2)) {
    const low = lowWaiters.shift();
    if (low) low();
  }
}

async function withCurlSlot<T>(fn: () => Promise<T>, high = true): Promise<T> {
  const limit = high ? MAX_CONCURRENT_CURLS : Math.ceil(MAX_CONCURRENT_CURLS / 2);
  if (activeCurls >= limit) {
    await new Promise<void>((resolve) => (high ? highWaiters : lowWaiters).push(resolve));
  }
  activeCurls++;
  try {
    return await fn();
  } finally {
    activeCurls--;
    wakeCurlWaiter();
  }
}

/** Fetch `href` with curl into a file; resolve on success. The referer
 *  is derived from the href's own origin (motionbgs media gets its
 *  motionbgs referer; 4kwallpapers thumbs get theirs). */
function curlDownload(href: string, destTmp: string): Promise<void> {
  const origin = /^https:\/\/([^/]+)/i.exec(href)?.[1] ?? "motionbgs.com";
  return new Promise((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "-sS", // quiet, but surface errors
        "--max-time",
        String(CURL_TIMEOUT_S),
        "--retry",
        "2",
        "--retry-delay",
        "1",
        "-A",
        CURL_UA,
        "-H",
        "accept: */*",
        "-H",
        "accept-language: en-US,en;q=0.9",
        "-H",
        `referer: https://${origin}/`,
        "-w",
        "%{http_code}", // status → stdout, body → file
        "-o",
        destTmp,
        href,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let code = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (code += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (exit) => {
      const status = Number.parseInt(code.trim(), 10);
      if (exit === 0 && status >= 200 && status < 400) return resolve();
      reject(
        new Error(
          `curl exit ${exit}, http ${code.trim() || "?"}${err ? `: ${err.trim().slice(0, 160)}` : ""}`
        )
      );
    });
  });
}

/**
 * Validate that a downloaded body is the media it claims to be. A CDN
 * front occasionally answers a bot challenge (HTML) with a 2xx-ish body
 * or an error page slips through as 200 — committing that as ".jpg"
 * would poison the cache with a file no <img> can ever decode. JPEG
 * (FFD8), PNG (89504E47), WEBP (RIFF…WEBP) and MP4 (ftyp at offset 4)
 * magic bytes are the cheap ground truth.
 */
async function assertLooksLikeMedia(p: string, isImage: boolean): Promise<void> {
  const fh = await fsp.open(p, "r");
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (bytesRead < 12) throw new Error("truncated body");
    if (isImage) {
      const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      const png =
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const webp =
        buf.slice(0, 4).toString("latin1") === "RIFF" &&
        buf.slice(8, 12).toString("latin1") === "WEBP";
      if (!jpeg && !png && !webp) {
        throw new Error("body is not an image (challenge/error page?)");
      }
    } else if (buf.slice(4, 8).toString("latin1") !== "ftyp") {
      throw new Error("body is not an MP4 (challenge/error page?)");
    }
  } finally {
    await fh.close();
  }
}

/** Delete oldest files until the directory is under the size cap. */
async function trimCache(): Promise<void> {
  const files = await fsp.readdir(CACHE_DIR).catch(() => [] as string[]);
  const entries: { p: string; mtimeMs: number; size: number }[] = [];
  let total = 0;
  for (const f of files) {
    if (f.endsWith(".part") || f.endsWith(".live")) continue; // in progress
    const p = path.join(CACHE_DIR, f);
    try {
      const st = await fsp.stat(p);
      entries.push({ p, mtimeMs: st.mtimeMs, size: st.size });
      total += st.size;
    } catch {
      /* raced with an eviction — ignore */
    }
  }
  if (total <= MAX_CACHE_BYTES) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of entries) {
    if (total <= MAX_CACHE_BYTES) break;
    await fsp.rm(e.p, { force: true }).catch(() => {});
    total -= e.size;
  }
}

/* ------------------------------------------------------------------ */
/* live download tasks — one curl chain per canonical href              */
/* ------------------------------------------------------------------ */

interface LiveTask {
  /** The growing file curl writes into (one per href, not per attempt). */
  partPath: string;
  /** Final cache destination (committed when the download completes). */
  dest: string;
  /** Sync flag: the variant chain finished (set with `ok` atomically). */
  settled: boolean;
  /** Settled outcome — true when some variant downloaded successfully. */
  ok: boolean;
  /** A real client GET arrived for this href — upgrade scheduling. */
  priority: "high" | "low";
  /** Resolves when the chain finishes (never rejects). */
  done: Promise<boolean>;
}

const liveTasks = new Map<string, LiveTask>();

/**
 * Start (or get) the one download task for a canonical href. The task
 * walks the variant chain into `partPath`; concurrent GETs subscribe to
 * the same growing file instead of piling up duplicate downloads.
 */
function getLiveTask(href0: string, priority: "high" | "low" = "high"): LiveTask {
  const existing = liveTasks.get(href0);
  if (existing) {
    // A real client GET behind an existing warm-up — upgrade it so the
    // preview never waits in the low-priority half of the queue.
    if (priority === "high") existing.priority = "high";
    return existing;
  }

  const dest = cacheFileFor(href0);
  const partPath = `${dest}.${process.pid}.live`;
  const task: LiveTask = {
    partPath,
    dest,
    settled: false,
    ok: false,
    priority,
    done: null as unknown as Promise<boolean>,
  };

  const cleanup = () => {
    // Keep the entry a moment so racing subscribers can read the settled
    // flags; future requests then take the disk path (committed) or start
    // a fresh task. Failed tasks clear faster — a client retry (the
    // poster self-heal) should get a FRESH download chain, not the
    // settled failure, once a second has passed.
    setTimeout(
      () => {
        if (liveTasks.get(href0) === task) liveTasks.delete(href0);
      },
      task.ok ? 2500 : 1000
    );
    if (!task.ok) void fsp.rm(partPath, { force: true }).catch(() => {});
  };

  task.done = (async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    let lastErr: unknown = null;
    // Images (thumbnails) are tiny and single-variant — their failure mode
    // is Cloudflare's intermittent bot challenge, which clears on a plain
    // same-UA retry (verified against their listing pages). Give them one
    // extra attempt with a short backoff so a challenged thumb self-heals
    // server-side instead of surfacing a broken card.
    const attemptsPerVariant = isImageHref(href0) ? 2 : 1;
    for (const href of variantHrefs(href0)) {
      for (let attempt = 1; attempt <= attemptsPerVariant; attempt++) {
        try {
          await fsp.rm(partPath, { force: true }).catch(() => {});
          await withCurlSlot(() => curlDownload(href, partPath), task.priority === "high");
          const st = await fsp.stat(partPath);
          if (st.size === 0) throw new Error("empty body");
          await assertLooksLikeMedia(partPath, isImageHref(href0));
          if (st.size > MAX_CACHED_FILE_BYTES) {
            return true; // serve from part, do not commit
          }
          await fsp.rename(partPath, dest);
          // Best-effort LRU trim once a new file lands.
          void trimCache().catch(() => {});
          return true;
        } catch (e) {
          lastErr = e;
          if (attempt < attemptsPerVariant) {
            await sleep(700); // challenge roulette → immediate retry
            continue;
          }
          // next variant starts clean; subscribers attached to the removed
          // part file see ENOENT and keep waiting for it to reappear.
        }
      }
    }
    throw lastErr ?? new Error("all motionbgs variants failed");
  })().then(
    () => {
      task.ok = true;
      task.settled = true;
      cleanup();
      return true;
    },
    () => {
      task.ok = false;
      task.settled = true;
      cleanup();
      return false;
    }
  );

  liveTasks.set(href0, task);
  return task;
}

/**
 * Ensure the href is downloaded and return a servable local path —
 * the committed cache file, or the still-complete part file for
 * oversized bodies. Returns null when every variant failed.
 */
async function ensureCached(
  href0: string,
  priority: "high" | "low" = "high"
): Promise<string | null> {
  const dest = cacheFileFor(href0);
  try {
    const st = await fsp.stat(dest);
    if (st.isFile() && st.size > 0) return dest; // cache hit
  } catch {
    /* miss — download below */
  }

  const task = getLiveTask(href0, priority);
  const ok = await task.done;
  if (!ok) return null;
  try {
    const st = await fsp.stat(dest);
    if (st.isFile() && st.size > 0) return dest;
  } catch {
    /* oversized body — serve the part file */
  }
  try {
    const st = await fsp.stat(task.partPath);
    if (st.isFile() && st.size > 0) return task.partPath;
  } catch {
    /* gone */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* serving                                                             */
/* ------------------------------------------------------------------ */

interface ParsedRange {
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): ParsedRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
  if (!m) return "invalid";
  const start = Number.parseInt(m[1], 10);
  const end = m[2] ? Math.min(Number.parseInt(m[2], 10), size - 1) : size - 1;
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** Start offset of a range header, without knowing the size. -1 = a
 *  suffix/open-ended spec we cannot satisfy blindly (wait for the file). */
function rangeStartOf(header: string | null): number {
  if (!header) return 0;
  const m = /^bytes=(\d+)-(\d*)$/i.exec(header.trim());
  if (!m) return -1;
  return Number.parseInt(m[1], 10);
}

function toWebStream(filePath: string, range?: ParsedRange): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath, range ? { start: range.start, end: range.end } : undefined);
  // Readable.toWeb is available on both Node and Bun runtimes; fall back to
  // a manual adapter if a runtime ever lacks it.
  const toWeb = (Readable as unknown as { toWeb?: (r: Readable) => ReadableStream }).toWeb;
  if (typeof toWeb === "function") {
    return toWeb(nodeStream as unknown as Parameters<typeof toWeb>[0]) as ReadableStream<Uint8Array>;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) =>
        controller.enqueue(
          new Uint8Array(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
        )
      );
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (e) => controller.error(e));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

/** Read [start, end) from a file in one shot. */
async function readFileSlice(p: string, start: number, end: number): Promise<Uint8Array> {
  const fh = await fsp.open(p, "r");
  try {
    const len = end - start;
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A chunked 200 that follows the growing part file: bytes flow to the
 * client the moment curl writes them, so <video> elements start playing
 * while the download runs and the connection is productive from the
 * first ~200ms — never a black hole that holds a browser slot for the
 * length of a full download.
 */
function streamLiveResponse(task: LiveTask, href: string): Response {
  const isImage = isImageHref(href);
  const deadline = Date.now() + LIVE_STREAM_MAX_MS;
  let offset = 0;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (cancelled) return;
        if (Date.now() > deadline) {
          controller.error(new Error("veil: live stream deadline"));
          return;
        }
        let st: Awaited<ReturnType<typeof fsp.stat>> | null = null;
        try {
          st = await fsp.stat(task.partPath);
        } catch {
          /* ENOENT — between variant retries; poll again */
        }
        if (st && st.size > offset) {
          const end = Math.min(st.size, offset + LIVE_CHUNK_BYTES);
          const chunk = await readFileSlice(task.partPath, offset, end).catch(() => null);
          if (!chunk || chunk.byteLength === 0) {
            // raced with a retry/commit — poll again
            await sleep(LIVE_POLL_MS);
            continue;
          }
          try {
            controller.enqueue(chunk);
          } catch {
            cancelled = true; // stream was cancelled mid-enqueue
            return;
          }
          offset += chunk.byteLength;
          return; // pull() is invoked again when the consumer wants more
        }
        if (task.settled) {
          if (task.ok) {
            // Commit renamed partPath → dest; any bytes we have not sent
            // yet live in the committed file. Sending them from there
            // closes the race where a fast small download completes
            // entirely between two 150ms polls — the part file vanishes
            // before a single poll sees it, and a blind close() used to
            // hand the client an EMPTY 200 (a body no <img> can decode,
            // i.e. every cold thumbnail intermittently "failed to
            // load"). Oversized uncommitted bodies keep using partPath.
            const dstSt = await fsp.stat(task.dest).catch(() => null);
            const source = dstSt && dstSt.size > offset ? task.dest : null;
            const fallbackSt = source ? null : await fsp.stat(task.partPath).catch(() => null);
            const src = source ?? (fallbackSt && fallbackSt.size > offset ? task.partPath : null);
            if (src) {
              const size = (dstSt ?? fallbackSt)!.size;
              const end = Math.min(size, offset + LIVE_CHUNK_BYTES);
              const chunk = await readFileSlice(src, offset, end).catch(() => null);
              if (chunk && chunk.byteLength > 0) {
                try {
                  controller.enqueue(chunk);
                } catch {
                  cancelled = true; // stream was cancelled mid-enqueue
                  return;
                }
                offset += chunk.byteLength;
                return; // next pull continues / closes
              }
            }
            controller.close();
          } else {
            controller.error(new Error("veil: motionbgs download failed"));
          }
          return;
        }
        await sleep(LIVE_POLL_MS);
      }
    },
    cancel() {
      cancelled = true; // the poll loop exits on its next iteration
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": isImage ? "image/jpeg" : "video/mp4",
      // The streamed body is not the canonical cached representation —
      // the committed file (served later with immutable caching + etag)
      // is. Never let an intermediate cache pin the partial identity.
      "cache-control": "no-store",
      "x-veil-mbgs": "stream",
    },
  });
}

/** Media mime type by file extension (jpg/png/webp/mp4). */
function mediaMimeFor(filePath: string): string {
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  if (/\.(jpe?g|jpg)$/i.test(filePath)) return "image/jpeg";
  return "video/mp4";
}

/** Serve a complete local file with ranges, etag and immutable caching. */
async function serveFromDisk(
  filePath: string,
  req: Request,
  opts: { noStore?: boolean } = {}
): Promise<Response> {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) {
    return Response.json({ error: "motionbgs video is empty" }, { status: 502 });
  }

  const size = stat.size;
  const etag = `"mbgs-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs / 1000).toString(16)}"`;
  const baseHeaders: Record<string, string> = {
    "content-type": mediaMimeFor(filePath),
    "accept-ranges": "bytes",
    // Video URLs are content-stable (id + slug + resolution) — let the
    // browser cache them so repeat visits never touch the server either.
    // Thumbnails are tiny and equally content-stable; caching them kills
    // the repeat cold-start thumb storm on every gallery open.
    "cache-control": opts.noStore ? "no-store" : "public, max-age=86400, immutable",
    etag,
    "x-veil-mbgs": opts.noStore ? "temp" : "cache",
  };

  const inm = req.headers.get("if-none-match");
  if (inm && inm.includes(etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const range = parseRange(req.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "content-range": `bytes */${size}` },
    });
  }

  const headers = { ...baseHeaders };
  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["content-length"] = String(range.end - range.start + 1);
    return new Response(toWebStream(filePath, range), { status: 206, headers });
  }

  headers["content-length"] = String(size);
  return new Response(toWebStream(filePath), { status: 200, headers });
}

/**
 * Serve a motionbgs media URL: fetch via curl (fingerprint the CDN
 * actually allows) into the disk cache and answer the client — cold
 * requests stream the bytes live with the download, warm requests are
 * served entirely locally with byte-range support so <video> elements
 * can seek.
 */
export async function serveMotionbgsMedia(targetUrl: URL, req: Request): Promise<Response> {
  // Preview-quality hint (?vw=1080): serve the 1920x1080 render instead of
  // the 4K file. A 4K H.264 decode allocates several hundred MB of renderer
  // memory per video pipeline — hover cards and preview popups only need
  // 1080p (a quarter of the pixels), while Apply / Download still request
  // the plain URL and get the full 4K file. The hint is stripped before
  // cache/disk, so both variants live side by side in the disk cache.
  const wantsPreview = targetUrl.searchParams.get("vw") === "1080";
  // Heal extension-less /media/{id}/{slug} paths and upgrade low-res
  // variants (960x540 saved by older builds) before touching cache/disk.
  const target = canonicalMediaUrl(
    targetUrl,
    wantsPreview ? "1920x1080" : "3840x2160"
  );
  const href = target.href;

  // HEAD = warm-up ping, never a full wait. It either confirms the cache
  // or kicks the background download (streaming GETs attach to it) and
  // returns instantly — a HEAD must never hold a browser connection for
  // the length of a download.
  if (req.method === "HEAD") {
    const cached = await fsp
      .stat(cacheFileFor(href))
      .then((st) => st.isFile() && st.size > 0)
      .catch(() => false);
    if (!cached) {
      // Low priority: warm-ups must never crowd out a live hover/click
      // stream — a GET for the same href upgrades the task.
      void ensureCached(href, "low").catch(() => {
        /* best-effort warm-up — the real GET retries on demand */
      });
    }
    return new Response(null, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        // Zero-length body, declared explicitly: without content-length
        // a HEAD answer looks like a body that never arrives, and strict
        // clients / relays hold the connection open until their idle
        // timeout.
        "content-length": "0",
        "x-veil-mbgs": cached ? "cache" : "warmup",
      },
    });
  }

  const dest = cacheFileFor(href);

  // Warm: full local serve (ranges, etag, immutable caching).
  const warm = await fsp
    .stat(dest)
    .then((st) => st.isFile() && st.size > 0)
    .catch(() => false);
  if (warm) return serveFromDisk(dest, req);

  // Thumbnails (image hrefs) are tiny — waiting for the complete file is
  // strictly better than live-streaming: the client gets a real status,
  // the full body, etag and immutable browser caching, and the commit
  // race that produced empty 200s / pre-header connection resets (both
  // surfaced to users as broken thumbnails) cannot happen. The task's
  // own retry chain rides out Cloudflare's challenge roulette; a hard
  // failure answers a clean 502 the card's self-heal can retry.
  if (isImageHref(href)) {
    const served = await ensureCached(href);
    if (!served) {
      return Response.json(
        { error: "motionbgs thumbnail temporarily unavailable" },
        { status: 502, headers: { "cache-control": "no-store" } }
      );
    }
    return serveFromDisk(served, req);
  }

  // Cold (or mid-download). A seek beyond byte 0 needs the complete
  // file — wait for the commit, then serve from disk. This is the rare
  // path (a seek while a cold download runs); initial opens take the
  // live stream below.
  const start = rangeStartOf(req.headers.get("range"));
  if (start > 0 || start === -1) {
    const task = getLiveTask(href);
    const ok = await task.done;
    if (!ok) {
      return Response.json(
        { error: "motionbgs video is temporarily unavailable" },
        { status: 502, headers: { "cache-control": "no-store" } }
      );
    }
    const served = await ensureCached(href);
    if (!served) {
      return Response.json({ error: "motionbgs video unavailable" }, { status: 502 });
    }
    return serveFromDisk(served, req, { noStore: served !== dest });
  }

  // Initial open (no range, or bytes=0-): stream the download live —
  // first bytes reach the client as soon as curl starts writing, and a
  // bare Range: bytes=0- is legally answered with a full 200 stream.
  // Concurrent requests for the same file attach to the same growing
  // download (deduped by the live task map).
  const task = getLiveTask(href);
  // A task that already settled as failed (a retry inside the 1s hold
  // window) must answer a real 502 — erroring a stream before its first
  // chunk kills the connection with NO response at all, which browsers
  // surface as a network error.
  if (task.settled && !task.ok) {
    return Response.json(
      { error: "motionbgs video is temporarily unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
  return streamLiveResponse(task, href);
}
