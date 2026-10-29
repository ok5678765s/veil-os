import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

const MAX_AVATAR_BYTES = 500 * 1024 // 500 KB
const MAX_BIO_LENGTH = 500
const MAX_DISPLAYNAME_LENGTH = 64

function isDataUrl(s: string): boolean {
  return s.startsWith("data:")
}

function dataUrlByteLength(s: string): number {
  // Approximate byte length of the base64 payload.
  const commaIdx = s.indexOf(",")
  if (commaIdx < 0) return s.length
  const payload = s.slice(commaIdx + 1)
  // base64: 4 chars per 3 bytes, minus padding.
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      avatarImage?: string | null
      bio?: string
      displayName?: string
    }>(req)
    if (!body) return badBody()

    const token = body.token
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const updateData: {
      avatarImage?: string | null
      bio?: string
      displayName?: string
    } = {}

    if (body.avatarImage !== undefined) {
      if (body.avatarImage === null || body.avatarImage === "") {
        updateData.avatarImage = null
      } else {
        const s = String(body.avatarImage)
        if (!isDataUrl(s)) {
          return NextResponse.json(
            {
              ok: false,
              error: "avatarImage must be a data URL (data:image/...).",
            },
            { status: 400 },
          )
        }
        if (!/^data:image\//i.test(s)) {
          return NextResponse.json(
            { ok: false, error: "avatarImage must be an image data URL." },
            { status: 400 },
          )
        }
        const bytes = dataUrlByteLength(s)
        if (bytes > MAX_AVATAR_BYTES) {
          return NextResponse.json(
            {
              ok: false,
              error: `avatarImage is too large (${bytes} bytes > ${MAX_AVATAR_BYTES} max).`,
            },
            { status: 400 },
          )
        }
        updateData.avatarImage = s
      }
    }

    if (body.bio !== undefined) {
      const bio = String(body.bio || "")
      if (bio.length > MAX_BIO_LENGTH) {
        return NextResponse.json(
          {
            ok: false,
            error: `Bio is too long (${bio.length} > ${MAX_BIO_LENGTH} chars).`,
          },
          { status: 400 },
        )
      }
      updateData.bio = bio
    }

    if (body.displayName !== undefined) {
      const displayName = String(body.displayName || "").trim()
      if (displayName.length > MAX_DISPLAYNAME_LENGTH) {
        return NextResponse.json(
          {
            ok: false,
            error: `Display name is too long (max ${MAX_DISPLAYNAME_LENGTH} chars).`,
          },
          { status: 400 },
        )
      }
      updateData.displayName = displayName
    }

    const updated = await db.chatAccount.update({
      where: { id: account.id },
      data: updateData,
    })

    return NextResponse.json({
      ok: true,
      account: toPublicAccount(updated),
    })
  } catch (err) {
    console.error("[chat-profile POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error updating profile." },
      { status: 500 },
    )
  }
}
