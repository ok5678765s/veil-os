import { createReadStream, statSync, existsSync, openSync, readSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

/**
 * The offline HTML version of Veil — the split single-file build
 * (scripts/build-veil.mjs):
 *
 *   download/veil-offline.html     the BASE (~235 MB): shell + engine +
 *                                  wallpapers + the light/mid games + the
 *                                  full title catalog — runs from file://
 *   download/veil-ext-games-N.html  drop-in EXTENSION packs (~210 MB
 *                                  each): the heavy titles, installed by
 *                                  dragging the file onto the offline
 *                                  page (or "add extension" in the stash)
 *
 *   The files live OUTSIDE public/ on purpose: everything Next serves
 *   from public/ is a password-less static URL. Keeping the downloads
 *   here means /api/offline?pw= is the ONLY door to them.
 *
 * GET /api/offline?pw=<pass>     → the base file, as an attachment download
 * GET /api/offline?ext=<packId>&pw=<pass> → that extension pack, as an
 *                                 attachment — same password
 * GET /api/offline?status=1     → { ready, bytes, packs:[…] } so the
 *                                 start-page button can list everything
 * GET /api/offline?verify=1&pw=… → { ok } — lets the UI check the
 *                                 download password before handing the
 *                                 multi-hundred-MB file to the browser
 */

const DL = join(process.cwd(), "download");
const FILE = join(DL, "veil-offline.html");
const SIZE_LIMIT = 1024 * 1024 * 1024; // sanity cap (1 GiB)
const PACK_CACHE_MS = 60_000; // pack discovery cache

/* the download password — every download (base file AND extension
 * packs) requires it. Checked before a single byte is streamed. */
const DL_PASS = "Barqz1";

function passOk(req: Request): boolean {
  try {
    return new URL(req.url).searchParams.get("pw") === DL_PASS;
  } catch {
    return false;
  }
}

export const dynamic = "force-dynamic";

function fileStat(p: string) {
  try {
    if (!existsSync(p)) return null;
    const st = statSync(p);
    if (!st.isFile() || st.size < 1024) return null; // partial/empty build
    if (st.size > SIZE_LIMIT) return null;
    return st;
  } catch {
    return null;
  }
}

interface PackManifest {
  sig: "VEIL-EXT";
  id: string;
  name?: string;
  desc?: string;
  games?: number;
  apps?: number;
  bytes?: number;
  /** asset keys — "stash:…" are games, "app:…" are apps */
  assets?: string[];
  /** richer per-app manifest (the newer pack builder emits it) */
  appList?: { key?: string }[];
}

interface PackEntry {
  id: string;
  name: string;
  desc: string;
  file: string;
  games: number;
  apps: number;
  bytes: number; // final file size on disk
  raw: number; // embedded game bytes
}

/* read the VEIL-EXT manifest out of a pack's head (it's the first
   <script> in <body>, well inside the first 8 KB) */
function readPackManifest(p: string): PackManifest | null {
  let fd: number | null = null;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    const head = buf.subarray(0, n).toString("utf8");
    const m = /<script type="text\/veil-ext-manifest"[^>]*>([\s\S]*?)<\/script>/.exec(head);
    if (!m) return null;
    return JSON.parse(m[1]) as PackManifest;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

let packCache: { at: number; packs: PackEntry[] } | null = null;

function discoverPacks(): PackEntry[] {
  if (packCache && Date.now() - packCache.at < PACK_CACHE_MS) return packCache.packs;
  const packs: PackEntry[] = [];
  try {
    const files = readdirSync(DL).filter((f) => /^veil-ext-.*\.html$/i.test(f));
    for (const f of files) {
      const p = join(DL, f);
      const st = fileStat(p);
      if (!st) continue; // still writing
      const man = readPackManifest(p);
      if (!man || man.sig !== "VEIL-EXT" || !man.id) continue;
      /* derive the counts when the manifest doesn't carry them —
       * older builders emitted only assets/appList, which used to show
       * as "0 games · 0 apps" for packs that obviously have content */
      const assets = Array.isArray(man.assets) ? man.assets : [];
      const appList = Array.isArray(man.appList) ? man.appList : [];
      const games =
        man.games ?? assets.filter((a) => String(a).startsWith("stash:")).length;
      const apps =
        man.apps ??
        (appList.length > 0
          ? appList.length
          : assets.filter((a) => String(a).startsWith("app:")).length);
      packs.push({
        id: man.id,
        name: man.name || man.id,
        desc: man.desc || "",
        file: f,
        games,
        apps,
        bytes: st.size,
        raw: man.bytes ?? 0,
      });
    }
    /* stable order: the BIG packs lead (they're what people come for —
     * a 300 MB stash pack should never be buried under 100 KB decks),
     * then the rest newest-heavy first */
    packs.sort(
      (a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file, undefined, { numeric: true }),
    );
  } catch {
    /* download dir unreadable — no packs */
  }
  packCache = { at: Date.now(), packs };
  return packs;
}

function attachmentHeaders(name: string, size: number) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Content-Length": String(size),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function streamFile(p: string, name: string, size: number, origin?: string) {
  /* origin-stamping: the shell's VEIL_ORIGIN literal lives in the first
     ~4MB (engine + shell, well before the giant asset blocks) — patch
     the head in memory, stream the rest straight from disk. The head
     window is capped at the file size so SMALL builds (the lightweight
     living-room file is ~45KB) get stamped too. */
  const LITERAL = "__VEIL_ORIGIN__";
  const HEAD = Math.min(6 * 1024 * 1024, size);
  if (origin && size > 1024) {
    try {
      const fd = openSync(p, "r");
      let patched: string | null = null;
      let read = 0;
      try {
        const buf = Buffer.alloc(HEAD);
        read = readSync(fd, buf, 0, HEAD, 0);
        const head = buf.subarray(0, read).toString("utf8");
        if (head.includes(LITERAL)) patched = head.split(LITERAL).join(origin);
      } finally {
        closeSync(fd);
      }
      if (patched) {
        const headChunk = Buffer.from(patched, "utf8");
        const realSize = headChunk.length + (size - read);
        const tail = Readable.toWeb(
          createReadStream(p, { start: read })
        ) as unknown as ReadableStream<Uint8Array>;
        const combined = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(headChunk));
            const reader = tail.getReader();
            const pump = (): Promise<void> =>
              reader.read().then(({ done, value }) => {
                if (done) {
                  controller.close();
                  return;
                }
                if (value) controller.enqueue(value);
                return pump();
              });
            return pump().catch((err) => controller.error(err));
          },
        });
        return new Response(combined, { headers: attachmentHeaders(name, realSize) });
      }
    } catch {
      /* fall through to plain streaming */
    }
  }
  const nodeStream = createReadStream(p);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, { headers: attachmentHeaders(name, size) });
}

/* the public origin this download was born from (the preview host the
   user is actually on). The Host header is the client-facing one — the
   gateway chain preserves it, while x-forwarded-host can carry an
   INTERNAL hop's hostname (e.g. the fcapp.run host), which would stamp
   a dead origin into the downloaded file. */
function requestOrigin(req: Request): string {
  try {
    const host = req.headers.get("host") || req.headers.get("x-forwarded-host");
    if (host) {
      const proto =
        req.headers.get("x-forwarded-proto") ||
        (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
      return `${proto}://${host}`;
    }
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  /* Explicit origin from the downloader's own address bar — the ONLY
     reliable source through the proxy chain (every hop rewrites Host /
     x-forwarded-host to internal hostnames, so the server-side guess
     stamps dead origins). Validated hard: https (or localhost http). */
  function downloadOrigin(): string {
    const explicit = url.searchParams.get("origin") || "";
    if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(explicit)) return explicit;
    if (/^http:\/\/(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/i.test(explicit)) return explicit;
    return requestOrigin(req);
  }

  /* status probe — the home-screen button polls this while the
     offline build is still packing */
  if (url.searchParams.get("status")) {
    const st = fileStat(FILE);
    const packs = discoverPacks();
    return Response.json(
      {
        ready: Boolean(st),
        bytes: st ? st.size : 0,
        name: "veil-offline.html",
        packs: st ? packs : [], // packs only mean anything once the base is real
      },
      {
        headers: {
          "Cache-Control": "no-store",
          /* CORS-open: the offline copy's catalog probes this from its
             file:// birth (a null origin) */
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  /* password check — a tiny round trip so the UI can validate before
     committing the browser to a huge attachment download.
     A known non-password (the start page's splash easter-egg string) gets
     a pointed rejection instead of the generic wrong-password line. */
  if (url.searchParams.get("verify")) {
    const supplied = url.searchParams.get("pw") ?? "";
    const ok = supplied === DL_PASS;
    const noLol = !ok && supplied === "5rew21";
    return Response.json(
      {
        ok,
        hint: ok
          ? "unlocked"
          : noLol
            ? "no lol"
            : "wrong password — downloads stay locked",
      },
      {
        status: ok ? 200 : 401,
        headers: {
          "Cache-Control": "no-store",
          /* CORS-open: the offline file (file://, null origin) verifies
             from its own extension catalog; the answer only says ok/not */
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  /* every download (base file AND extension packs) needs the password —
     checked BEFORE any file is opened or streamed */
  if (!passOk(req)) {
    const noLol = (url.searchParams.get("pw") ?? "") === "5rew21";
    return Response.json(
      {
        error: "Downloads are password-protected.",
        hint: noLol
          ? "no lol"
          : "Add ?pw=<password> to the URL once you have it.",
      },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  /* extension pack download — ?ext=<packId> (or the pack's filename) */
  const ext = url.searchParams.get("ext");
  if (ext) {
    const packs = discoverPacks();
    const want = ext.toLowerCase();
    const pack = packs.find((p) => p.id.toLowerCase() === want || p.file.toLowerCase() === want);
    if (!pack) {
      return Response.json(
        {
          error: "Unknown extension pack.",
          hint: `Known packs: ${packs.map((p) => p.id).join(", ") || "(none built yet)"}.`,
        },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }
    const st = fileStat(join(DL, pack.file));
    if (!st) {
      return Response.json(
        { error: "That pack is still packing.", hint: "Try again in a minute." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    return streamFile(join(DL, pack.file), pack.file, st.size);
  }

  const st = fileStat(FILE);
  if (!st) {
    return Response.json(
      {
        error: "The offline build is not ready yet.",
        hint: "It is packing in the background — try again in a minute.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  /* stream it — never buffer a big file into memory. The base gets
     its birth origin stamped in-flight so the offline copy can still
     reach this site's chat / roster / presence / extension downloads. */
  return streamFile(FILE, "veil-offline.html", st.size, downloadOrigin());
}
