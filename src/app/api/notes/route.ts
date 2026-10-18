import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { viewerFromRequest } from "@/lib/veil/viewer"

export const runtime = "nodejs"

/**
 * Veil — Notes (viewer-scoped scratchpad; replaced the Updates app).
 *
 *   GET    /api/notes                 → { ok, notes: [...] }
 *   POST   /api/notes                 → create  { title?, body?, pinned? }
 *   PATCH  /api/notes                 → update  { id, title?, body?, pinned? }
 *   DELETE /api/notes?id=<id>         → delete
 *
 * Every record is scoped to the pseudonymous viewer id, exactly like
 * history and FreeTube data — notes never leak across browsers.
 */

const MAX_TITLE = 140
const MAX_BODY = 20000
const MAX_NOTES = 200

function clampTitle(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_TITLE) : ""
}

function clampBody(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_BODY) : ""
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const viewer = viewerFromRequest(req)
    const notes = await db.note.findMany({
      where: { viewer },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      take: MAX_NOTES,
    })
    return NextResponse.json({ ok: true, notes })
  } catch (err) {
    console.error("[notes] list error", err)
    return NextResponse.json(
      { ok: false, error: "Could not load notes." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const viewer = viewerFromRequest(req)
    const body = (await req.json().catch(() => ({}))) as {
      title?: string
      body?: string
      pinned?: boolean
    }
    const count = await db.note.count({ where: { viewer } })
    if (count >= MAX_NOTES) {
      return NextResponse.json(
        { ok: false, error: "Note limit reached — delete a few first." },
        { status: 400 },
      )
    }
    const note = await db.note.create({
      data: {
        viewer,
        title: clampTitle(body.title),
        body: clampBody(body.body),
        pinned: body.pinned === true,
      },
    })
    return NextResponse.json({ ok: true, note })
  } catch (err) {
    console.error("[notes] create error", err)
    return NextResponse.json(
      { ok: false, error: "Could not save that note." },
      { status: 500 },
    )
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  try {
    const viewer = viewerFromRequest(req)
    const body = (await req.json().catch(() => ({}))) as {
      id?: string
      title?: string
      body?: string
      pinned?: boolean
    }
    if (!body.id) {
      return NextResponse.json(
        { ok: false, error: "Missing note id." },
        { status: 400 },
      )
    }
    const data: { title?: string; body?: string; pinned?: boolean } = {}
    if (typeof body.title === "string") data.title = clampTitle(body.title)
    if (typeof body.body === "string") data.body = clampBody(body.body)
    if (typeof body.pinned === "boolean") data.pinned = body.pinned
    const note = await db.note.updateMany({
      where: { id: body.id, viewer },
      data,
    })
    if (note.count === 0) {
      return NextResponse.json(
        { ok: false, error: "Note not found." },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[notes] update error", err)
    return NextResponse.json(
      { ok: false, error: "Could not save that note." },
      { status: 500 },
    )
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  try {
    const viewer = viewerFromRequest(req)
    const id = req.nextUrl.searchParams.get("id")
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "Missing note id." },
        { status: 400 },
      )
    }
    const res = await db.note.deleteMany({ where: { id, viewer } })
    if (res.count === 0) {
      return NextResponse.json(
        { ok: false, error: "Note not found." },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[notes] delete error", err)
    return NextResponse.json(
      { ok: false, error: "Could not delete that note." },
      { status: 500 },
    )
  }
}
