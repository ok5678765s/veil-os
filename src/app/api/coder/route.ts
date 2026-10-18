import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { viewerFromRequest } from "@/lib/veil/viewer"

export const runtime = "nodejs"

/**
 * Veil — HTML Coder documents (viewer-scoped; replaced the Notes app).
 *
 *   GET    /api/coder                 → { ok, docs: [...] }
 *   POST   /api/coder                 → create  { title?, html?, pinned? }
 *   PATCH  /api/coder                 → update  { id, title?, html?, pinned? }
 *   DELETE /api/coder?id=<id>         → delete
 *
 * Same privacy model as history and the old notes: every record is scoped
 * to the pseudonymous viewer id, so documents never leak across browsers.
 */

const MAX_TITLE = 140
const MAX_HTML = 400_000
const MAX_DOCS = 100

function clampTitle(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_TITLE) : ""
}

function clampHtml(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_HTML) : ""
}

export async function GET(req: NextRequest): Promise<Response> {
  try {
    const viewer = viewerFromRequest(req)
    const docs = await db.coderDoc.findMany({
      where: { viewer },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      take: MAX_DOCS,
    })
    return NextResponse.json({ ok: true, docs })
  } catch (err) {
    console.error("[coder] list error", err)
    return NextResponse.json(
      { ok: false, error: "Could not load documents." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const viewer = viewerFromRequest(req)
    const body = (await req.json().catch(() => ({}))) as {
      title?: string
      html?: string
      pinned?: boolean
    }
    const count = await db.coderDoc.count({ where: { viewer } })
    if (count >= MAX_DOCS) {
      return NextResponse.json(
        { ok: false, error: "Document limit reached — delete a few first." },
        { status: 429 },
      )
    }
    const doc = await db.coderDoc.create({
      data: {
        viewer,
        title: clampTitle(body.title),
        html: clampHtml(body.html),
        pinned: body.pinned === true,
      },
    })
    return NextResponse.json({ ok: true, doc })
  } catch (err) {
    console.error("[coder] create error", err)
    return NextResponse.json(
      { ok: false, error: "Could not create the document." },
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
      html?: string
      pinned?: boolean
    }
    if (typeof body.id !== "string" || !body.id) {
      return NextResponse.json(
        { ok: false, error: "Missing document id." },
        { status: 400 },
      )
    }
    const data: { title?: string; html?: string; pinned?: boolean } = {}
    if (typeof body.title === "string") data.title = clampTitle(body.title)
    if (typeof body.html === "string") data.html = clampHtml(body.html)
    if (typeof body.pinned === "boolean") data.pinned = body.pinned
    const doc = await db.coderDoc.updateMany({
      where: { id: body.id, viewer },
      data,
    })
    if (doc.count === 0) {
      return NextResponse.json(
        { ok: false, error: "Document not found." },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[coder] update error", err)
    return NextResponse.json(
      { ok: false, error: "Could not save the document." },
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
        { ok: false, error: "Missing document id." },
        { status: 400 },
      )
    }
    await db.coderDoc.deleteMany({ where: { id, viewer } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error("[coder] delete error", err)
    return NextResponse.json(
      { ok: false, error: "Could not delete the document." },
      { status: 500 },
    )
  }
}
