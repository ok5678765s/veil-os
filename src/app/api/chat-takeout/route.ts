import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

/**
 * Chat Takeout — export/import the signed-in chat account's data.
 *
 *   GET  ?token=…&summary=1  → light stats card payload (no avatar, no msgs)
 *   GET  ?token=…            → full portable bundle (veil.chat.takeout.v1)
 *   POST { token, profile }  → restore profile customization onto the
 *                              signed-in account (name / bio / avatar /
 *                              avatar color only — coins, purchased tag and
 *                              PFP accessory can never be imported; that
 *                              would mint cosmetics for free).
 */

const FORMAT = "veil.chat.takeout.v1"
const MAX_MESSAGES_EXPORT = 1000
const MAX_AVATAR_BYTES = 500 * 1024
const MAX_BIO_LENGTH = 500
const MAX_DISPLAYNAME_LENGTH = 64

function isDataUrl(s: string): boolean {
  return s.startsWith("data:")
}

function dataUrlByteLength(s: string): number {
  const commaIdx = s.indexOf(",")
  if (commaIdx < 0) return s.length
  const payload = s.slice(commaIdx + 1)
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token") || ""
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    // ----- light summary (for the Settings → Data stat chips) -----
    if (req.nextUrl.searchParams.get("summary") === "1") {
      const [messages, friends, dms] = await Promise.all([
        db.chatMessage.count({ where: { accountId: account.id } }),
        db.chatFriend.count({ where: { accountId: account.id } }),
        db.dMMember.count({ where: { accountId: account.id } }),
      ])
      return NextResponse.json({
        ok: true,
        summary: {
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          coins: account.coins,
          messages,
          friends,
          dms,
          joinedAt: account.createdAt,
          hasAvatar: !!account.avatarImage,
        },
      })
    }

    // ----- full takeout bundle -----
    const [messages, friendRows, dmRows] = await Promise.all([
      db.chatMessage.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: "desc" },
        take: MAX_MESSAGES_EXPORT,
        select: {
          id: true,
          channelId: true,
          content: true,
          replyToUsername: true,
          createdAt: true,
        },
      }),
      db.chatFriend.findMany({
        where: { accountId: account.id },
        include: { friend: { select: { username: true } } },
      }),
      db.dMMember.findMany({
        where: { accountId: account.id },
        include: { dm: { select: { id: true, name: true, isGroup: true } } },
      }),
    ])

    return NextResponse.json({
      ok: true,
      takeout: {
        format: FORMAT,
        exportedAt: new Date().toISOString(),
        account: {
          ...toPublicAccount(account),
          username: account.username,
          dailyRewardStreak: account.dailyRewardStreak,
        },
        stats: {
          messages,
          friends: friendRows.length,
          dms: dmRows.length,
        },
        // Own-message archive, newest first, capped at MAX_MESSAGES_EXPORT.
        messages: messages.map((m) => ({
          id: m.id,
          channel: m.channelId,
          content: m.content,
          replyToUsername: m.replyToUsername,
          at: m.createdAt,
        })),
        // Friends by username (ids are server-internal).
        friends: friendRows.map((f) => f.friend.username),
        // DM conversations this account belongs to (ids only — content of
        // other people stays theirs; re-joining happens by id on import
        // is intentionally NOT offered).
        dms: dmRows.map((d) => ({
          id: d.dmId,
          name: d.dm.name,
          isGroup: d.dm.isGroup,
        })),
      },
    })
  } catch (err) {
    console.error("[chat-takeout GET] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error building the export." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      profile?: {
        displayName?: unknown
        bio?: unknown
        avatarColor?: unknown
        avatarImage?: unknown
      }
    }>(req)
    if (!body) return badBody()

    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const p = body.profile || {}
    const updateData: {
      displayName?: string
      bio?: string
      avatarColor?: string
      avatarImage?: string | null
    } = {}
    const imported: string[] = []

    if (typeof p.displayName === "string") {
      const displayName = p.displayName.trim().slice(0, MAX_DISPLAYNAME_LENGTH)
      updateData.displayName = displayName
      imported.push("display name")
    }

    if (typeof p.bio === "string") {
      updateData.bio = p.bio.slice(0, MAX_BIO_LENGTH)
      imported.push("bio")
    }

    if (typeof p.avatarColor === "string") {
      if (!/^#[0-9a-fA-F]{6}$/.test(p.avatarColor)) {
        return NextResponse.json(
          { ok: false, error: "avatarColor must be a #rrggbb hex color." },
          { status: 400 },
        )
      }
      updateData.avatarColor = p.avatarColor.toLowerCase()
      imported.push("avatar color")
    }

    if (typeof p.avatarImage === "string" && p.avatarImage.length > 0) {
      const s = p.avatarImage
      if (!isDataUrl(s) || !/^data:image\//i.test(s)) {
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
      imported.push("profile picture")
    }

    if (imported.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No importable profile fields found in that file." },
        { status: 400 },
      )
    }

    const updated = await db.chatAccount.update({
      where: { id: account.id },
      data: updateData,
    })

    return NextResponse.json({
      ok: true,
      account: toPublicAccount(updated),
      imported,
      note:
        "Coins, purchased tags and PFP accessories are server-side and cannot be imported.",
    })
  } catch (err) {
    console.error("[chat-takeout POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error restoring the profile." },
      { status: 500 },
    )
  }
}
