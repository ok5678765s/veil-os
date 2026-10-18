import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { ownerPasswordOk } from "@/lib/veil/owner-auth"

export const runtime = "nodejs"

/**
 * Veil — site updates feed ("add updates to the site through the website").
 *
 *   GET    /api/updates                → { ok, updates: [...] }   (public)
 *   POST   /api/updates                → create  (password required)
 *          { password, title, body, kind? }
 *   DELETE /api/updates?id=<id>        → delete  (password required)
 *
 * The owner password is checked with a timing-safe compare. GET responses
 * are cached 60s in memory so the feed is cheap to poll.
 */

const MAX_TITLE = 140
const MAX_BODY = 4000
const MAX_UPDATES = 60

let cache: { at: number; data: unknown } | null = null

export async function GET(): Promise<Response> {
  try {
    if (cache && Date.now() - cache.at < 60_000) {
      return NextResponse.json({ ok: true, ...(cache.data as object) })
    }
    const updates = await db.siteUpdate.findMany({
      orderBy: { createdAt: "desc" },
      take: MAX_UPDATES,
    })
    cache = { at: Date.now(), data: { updates } }
    return NextResponse.json({ ok: true, updates })
  } catch (err) {
    console.error("[updates] list error", err)
    return NextResponse.json(
      { ok: false, error: "Could not load updates." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      password?: string
      title?: string
      body?: string
      kind?: string
    }
    if (!(await ownerPasswordOk(body.password))) {
      return NextResponse.json(
        { ok: false, error: "Wrong password." },
        { status: 403 },
      )
    }
    const title = (body.title || "").trim().slice(0, MAX_TITLE)
    const text = (body.body || "").trim().slice(0, MAX_BODY)
    if (!title || !text) {
      return NextResponse.json(
        { ok: false, error: "Title and body are required." },
        { status: 400 },
      )
    }
    const kindRaw = (body.kind || "feature").trim().toLowerCase()
    const kind = ["feature", "fix", "notice"].includes(kindRaw) ? kindRaw : "feature"

    const update = await db.siteUpdate.create({
      data: { title, body: text, kind },
    })
    cache = null
    return NextResponse.json({ ok: true, update })
  } catch (err) {
    console.error("[updates] create error", err)
    return NextResponse.json(
      { ok: false, error: "Could not save the update." },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    const password = req.nextUrl.searchParams.get("password")
    const id = req.nextUrl.searchParams.get("id")
    if (!(await ownerPasswordOk(password))) {
      return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 403 })
    }
    if (!id) {
      return NextResponse.json({ ok: false, error: "id required." }, { status: 400 })
    }
    await db.siteUpdate.delete({ where: { id } })
    cache = null
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[updates] delete error", err)
    return NextResponse.json(
      { ok: false, error: "Could not delete the update." },
      { status: 500 },
    )
  }
}
