/**
 * Veil — browsing history API (scoped per viewer).
 * GET    /api/history        -> recent visits + aggregate stats (this viewer)
 * POST   /api/history        -> record a visit (upsert, increments counter)
 * DELETE /api/history?id=x   -> remove one visit
 * DELETE /api/history?all=1  -> clear history (this viewer only)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { viewerFromRequest, stampViewerCookie } from "@/lib/veil/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const viewer = viewerFromRequest(req);
  try {
    const [visits, sites, agg] = await Promise.all([
      db.siteVisit.findMany({ where: { viewer }, orderBy: { updatedAt: "desc" }, take: 18 }),
      db.siteVisit.count({ where: { viewer } }),
      db.siteVisit.aggregate({ where: { viewer }, _sum: { visitCount: true } }),
    ]);
    return stampViewerCookie(
      { visits, stats: { sites, pageVisits: agg._sum.visitCount ?? 0 } },
      viewer
    );
  } catch (e) {
    console.error("history GET failed", e);
    return NextResponse.json({ visits: [], stats: { sites: 0, pageVisits: 0 } });
  }
}

export async function POST(req: NextRequest) {
  const viewer = viewerFromRequest(req);
  try {
    const body = (await req.json().catch(() => null)) as
      | { url?: unknown; title?: unknown }
      | null;
    const url: unknown = body?.url;
    const title: string | null =
      typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;

    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return NextResponse.json({ error: "A valid http(s) URL is required." }, { status: 400 });
    }
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return NextResponse.json({ error: "Invalid URL." }, { status: 400 });
    }

    const visit = await db.siteVisit.upsert({
      where: { viewer_url: { viewer, url } },
      create: { viewer, url, host, title },
      update: { title: title ?? undefined, visitCount: { increment: 1 } },
    });
    return stampViewerCookie({ visit }, viewer);
  } catch (e) {
    console.error("history POST failed", e);
    return NextResponse.json({ error: "Failed to record visit." }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const viewer = viewerFromRequest(req);
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get("all")) {
      await db.siteVisit.deleteMany({ where: { viewer } });
      return NextResponse.json({ ok: true, cleared: "all" });
    }
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id or all is required." }, { status: 400 });
    await db.siteVisit.deleteMany({ where: { id, viewer } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("history DELETE failed", e);
    return NextResponse.json({ error: "Failed to delete." }, { status: 500 });
  }
}
