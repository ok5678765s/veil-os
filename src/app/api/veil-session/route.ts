/**
 * Veil — server-side session sync (the "different place" permanent fix).
 *
 * The open section + browser tabs used to live ONLY in the client's
 * localStorage/sessionStorage — so opening Veil from a different browser,
 * device, or after cleared storage always landed on the home screen. This
 * route mirrors the live session server-side, scoped to the same
 * pseudonymous viewer id as history/notes (src/lib/veil/viewer.ts), so
 * any browser that carries the identity — the stamped cookie, a ?vv=
 * share link, or the Settings › Browsing Veil Key — reopens exactly
 * where the user left off.
 *
 *   GET    /api/veil-session            → { viewer, state } + cookie stamp
 *   GET    /api/veil-session?key=<id>   → { ok, viewer, state } — pull
 *                                          another place's session by key
 *   POST   /api/veil-session            → upsert this viewer's mirror
 *   DELETE /api/veil-session            → drop the mirror (privacy opt-out)
 *
 * state = { section: string | null, tabs: { tabs, activeId } | null,
 *           keep: boolean }. keep=false mirrors the Settings › Browsing
 * "Start page" choice: those viewers get no server mirror at all.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { viewerFromRequest, stampViewerCookie } from "@/lib/veil/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* Canonical section ids (kept in sync with page.tsx SECTIONS). */
const SECTIONS = new Set([
  "ai", "arcade", "stream", "chat", "wallpapers",
  "music", "links", "history", "coder", "settings",
]);

const MAX_BODY = 100_000; // 100 KB — 8 tabs × 24 urls × 2 KB + slack
const MAX_TABS = 8;
const MAX_STACK = 24;
const KEY_RE = /^[A-Za-z0-9_-]{6,64}$/;

interface TabLike {
  id: string;
  stack: string[];
  idx: number;
  reloadKey: number;
  title: string;
  container: string;
  egress: string;
  ua: string;
  pinned: boolean;
  muted: boolean;
}

/** http(s) URLs — or Veil's local freetube pseudo-host entries. */
function okUrl(u: unknown): u is string {
  return (
    typeof u === "string" &&
    u.length <= 2000 &&
    (/^https?:\/\//i.test(u) || /^freetube\.veil\.local\//i.test(u))
  );
}

/** Hard-sanitize a client-sent tab list; null when nothing usable. */
function sanitizeTabs(raw: unknown): { tabs: TabLike[]; activeId: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { tabs?: unknown; activeId?: unknown };
  if (!Array.isArray(r.tabs) || r.tabs.length === 0) return null;
  const out: TabLike[] = [];
  for (const item of r.tabs.slice(0, MAX_TABS)) {
    if (!item || typeof item !== "object") continue;
    const tab = item as Record<string, unknown>;
    const id = typeof tab.id === "string" ? tab.id.slice(0, 64) : "";
    if (!id) continue;
    const stack = Array.isArray(tab.stack)
      ? tab.stack.filter(okUrl).slice(0, MAX_STACK)
      : [];
    if (stack.length === 0) continue;
    const idxRaw = typeof tab.idx === "number" && Number.isFinite(tab.idx) ? Math.floor(tab.idx) : 0;
    const container =
      typeof tab.container === "string" && /^[a-z0-9-]{1,24}$/i.test(tab.container)
        ? tab.container.toLowerCase()
        : "default";
    out.push({
      id,
      stack,
      idx: Math.min(Math.max(idxRaw, 0), stack.length - 1),
      reloadKey: 0, // restored tabs always load fresh
      title: typeof tab.title === "string" ? tab.title.slice(0, 200) : "",
      container,
      egress: tab.egress === "direct" || tab.egress === "upstream" ? tab.egress : "auto",
      ua: typeof tab.ua === "string" ? tab.ua.slice(0, 200) : "",
      pinned: tab.pinned === true,
      muted: tab.muted === true,
    });
  }
  if (out.length === 0) return null;
  const activeId =
    typeof r.activeId === "string" && out.some((t) => t.id === r.activeId)
      ? r.activeId
      : out[0].id;
  return { tabs: out, activeId };
}

/** Parse the stored row into the wire shape (nulls for "home screen"). */
function rowState(row: { section: string | null; tabs: string; keep: boolean } | null) {
  if (!row) return null;
  let tabs: { tabs: TabLike[]; activeId: string } | null = null;
  if (row.tabs) {
    try {
      tabs = JSON.parse(row.tabs) as { tabs: TabLike[]; activeId: string };
    } catch {
      tabs = null;
    }
  }
  const section = row.section && SECTIONS.has(row.section) ? row.section : null;
  return { section, tabs, keep: row.keep };
}

/** Best-effort prune of long-dead mirrors (keeps SQLite tiny). */
async function pruneOld(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 180 * 24 * 3600 * 1000);
    await db.veilSession.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  } catch {
    /* never fatal */
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const key = req.nextUrl.searchParams.get("key");
  if (key) {
    // Cross-device pull by Veil Key: return that viewer's stored session
    // (the client adopts the id + stages the state, then reloads).
    if (!KEY_RE.test(key)) {
      return NextResponse.json({ ok: false, error: "That doesn't look like a Veil Key." }, { status: 400 });
    }
    try {
      const row = await db.veilSession.findUnique({ where: { viewer: key } });
      if (!row) {
        return NextResponse.json(
          { ok: false, error: "No session found for that key — check it on the other device." },
          { status: 404 }
        );
      }
      return NextResponse.json({ ok: true, viewer: key, state: rowState(row) });
    } catch (e) {
      console.error("veil-session GET?key failed", e);
      return NextResponse.json({ ok: false, error: "The session store is unavailable." }, { status: 500 });
    }
  }

  const viewer = viewerFromRequest(req);
  try {
    const row = await db.veilSession.findUnique({ where: { viewer } });
    return stampViewerCookie({ viewer, state: rowState(row) }, viewer);
  } catch (e) {
    console.error("veil-session GET failed", e);
    // Degraded mode: report "no state" instead of failing the boot.
    return stampViewerCookie({ viewer, state: null }, viewer);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const viewer = viewerFromRequest(req);
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY) {
    return NextResponse.json({ ok: false, error: "Session too large." }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const keep = body.keep !== false;
  const sectionRaw = body.section;
  const section =
    typeof sectionRaw === "string" && SECTIONS.has(sectionRaw) ? sectionRaw : null;
  const tabs = sanitizeTabs(body.tabs);

  try {
    if (!keep) {
      // Privacy opt-out ("Start page" in Settings › Browsing): no mirror.
      await db.veilSession.deleteMany({ where: { viewer } });
      return stampViewerCookie({ ok: true, cleared: true }, viewer);
    }
    await db.veilSession.upsert({
      where: { viewer },
      create: { viewer, section, tabs: tabs ? JSON.stringify(tabs) : "", keep: true },
      update: { section, tabs: tabs ? JSON.stringify(tabs) : "", keep: true },
    });
    if (Math.random() < 0.05) void pruneOld();
    return stampViewerCookie({ ok: true }, viewer);
  } catch (e) {
    console.error("veil-session POST failed", e);
    return NextResponse.json({ ok: false, error: "Failed to save the session." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const viewer = viewerFromRequest(req);
  try {
    await db.veilSession.deleteMany({ where: { viewer } });
    return stampViewerCookie({ ok: true }, viewer);
  } catch (e) {
    console.error("veil-session DELETE failed", e);
    return NextResponse.json({ ok: false, error: "Failed to clear the session." }, { status: 500 });
  }
}
