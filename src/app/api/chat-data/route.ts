import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { awardCoins } from "@/lib/coins"
import { cors, corsOptions } from "@/lib/veil/cors"
import { readJsonBody, badBody } from "@/lib/veil/body"
import { liveEditMessage } from "@/lib/veil/live-room"

export const runtime = "nodejs"

/* Preflight + wildcard origin — Veil Chat also runs from the single-file
 * HTML build (file:// sends Origin: null). Tokens live in the body/query,
 * so a wildcard origin is safe. */
export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

// Only #general for now — extend this list (and CHANNELS in the chat UI)
// when more channels come back.
const PUBLIC_CHANNELS = [
  "main",
  "sharelinks",
  "suggestions",
  "links",
  "announcements",
] as const

/** #general keeps a rolling window of the latest 100 messages — when
 * someone sends the 101st, the 1st is deleted (user-requested cap; the
 * git room does the same). */
const MAIN_CHANNEL_MAX = 100

/** Channels where only moderators and the owner may post. */
const MOD_ONLY_CHANNELS = ["links", "announcements"] as const

/* The owner is the "Veil" operator — username match, exactly like the
 * chat UI's isMod() and chat-mod's isSuperAdmin(). Role alone is not a
 * reliable owner signal: a wiped/restored db can leave the operator
 * account at role "member", which 403'd the owner in the very channels
 * the UI had unlocked for them (all three layers must agree). */
const SUPER_ADMIN_USERNAME = "Veil"
function isModAccount(a: { username: string; role: string }): boolean {
  return (
    a.role === "moderator" ||
    a.role === "admin" ||
    a.username.toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase()
  )
}

function isPublicChannel(channelId: string): boolean {
  return (PUBLIC_CHANNELS as readonly string[]).includes(channelId)
}

export async function GET(req: NextRequest): Promise<Response> {
  return cors(await handleGet(req))
}

async function handleGet(req: NextRequest): Promise<Response> {
  try {
    const channelId = req.nextUrl.searchParams.get("channel") || "main"
    /* "before" (ISO timestamp) — cursor for the "Load older" button: the
     * client passes the oldest loaded message's createdAt and gets the
     * 100 rows BEFORE it, prepended under the visible history. */
    const beforeRaw = req.nextUrl.searchParams.get("before")
    const before = beforeRaw ? new Date(beforeRaw) : null
    const beforeOk = before && !Number.isNaN(before.getTime()) ? before : null

    // For DM channels, require membership (validated by token below).
    // For public channels, anyone can read.
    let token = req.nextUrl.searchParams.get("token") || undefined
    if (!isPublicChannel(channelId)) {
      if (!token) {
        return NextResponse.json(
          { ok: false, error: "Authentication required for this channel." },
          { status: 401 },
        )
      }
      const account = await getAccountFromToken(token)
      if (!account) {
        return NextResponse.json(
          { ok: false, error: "Invalid or expired token." },
          { status: 401 },
        )
      }
      const membership = await db.dMMember.findUnique({
        where: { dmId_accountId: { dmId: channelId, accountId: account.id } },
      })
      if (!membership) {
        return NextResponse.json(
          { ok: false, error: "You are not a member of this DM." },
          { status: 403 },
        )
      }
    }

    const messages = await db.chatMessage.findMany({
      where: {
        channelId,
        ...(beforeOk ? { createdAt: { lt: beforeOk } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        account: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarColor: true,
            avatarImage: true,
            role: true,
            coins: true,
            tag: true,
            tagColor: true,
            pfpAccessory: true,
            pfpOverlay: true,
            legacy: true,
          },
        },
        reactions: {
          select: { emoji: true, accountId: true },
        },
      },
    })

    // Reverse so oldest is first (we fetched desc to get the latest 100).
    const ordered = messages.slice().reverse()

    // Aggregate raw reaction rows into per-emoji chips once, server-side.
    const withReactions = ordered.map((m) => {
      const byEmoji = new Map<string, string[]>()
      for (const r of m.reactions) {
        const list = byEmoji.get(r.emoji) ?? []
        list.push(r.accountId)
        byEmoji.set(r.emoji, list)
      }
      return {
        id: m.id,
        channelId: m.channelId,
        content: m.content,
        replyTo: m.replyTo,
        replyToContent: m.replyToContent,
        replyToUsername: m.replyToUsername,
        createdAt: m.createdAt,
        editedAt: m.editedAt ?? null,
        account: m.account,
        reactions: [...byEmoji.entries()].map(([emoji, usernames]) => ({
          emoji,
          usernames,
        })),
      }
    })

    return NextResponse.json({
      ok: true,
      messages: withReactions,
      /* "the fetch window was full" → older rows probably exist beyond it */
      hasMore: messages.length === 100,
    })
  } catch (err) {
    console.error("[chat-data GET] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error fetching messages." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = await readJsonBody<{
      token?: string
      channelId?: string
      content?: string
      replyTo?: string | null
      replyToContent?: string | null
      replyToUsername?: string | null
    }>(req)
    if (!body) return badBody()

    const token = body.token
    const channelId = (body.channelId || "").trim()
    const content = (body.content || "").trim()

    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "You must be signed in to send messages." },
        { status: 401 },
      )
    }

    if (account.muted) {
      return NextResponse.json(
        { ok: false, error: "You are muted and cannot send messages." },
        { status: 403 },
      )
    }

    if (!channelId) {
      return NextResponse.json(
        { ok: false, error: "A channelId is required." },
        { status: 400 },
      )
    }

    // #links + #announcements — only moderators and the owner may post.
    if (
      (MOD_ONLY_CHANNELS as readonly string[]).includes(channelId) &&
      !isModAccount(account)
    ) {
      return NextResponse.json(
        { ok: false, error: `Only moderators and the owner can post in #${channelId}.` },
        { status: 403 },
      )
    }

    if (!content) {
      return NextResponse.json(
        { ok: false, error: "Message content cannot be empty." },
        { status: 400 },
      )
    }

    if (content.length > 2000) {
      return NextResponse.json(
        { ok: false, error: "Message is too long (2000 char max)." },
        { status: 400 },
      )
    }

    // For non-public channels, verify DM membership.
    if (!isPublicChannel(channelId)) {
      const membership = await db.dMMember.findUnique({
        where: { dmId_accountId: { dmId: channelId, accountId: account.id } },
      })
      if (!membership) {
        return NextResponse.json(
          { ok: false, error: "You are not a member of this DM." },
          { status: 403 },
        )
      }
    }

    const message = await db.chatMessage.create({
      data: {
        channelId,
        accountId: account.id,
        content,
        replyTo: body.replyTo || null,
        replyToContent: body.replyToContent || null,
        replyToUsername: body.replyToUsername || null,
      },
      include: {
        account: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarColor: true,
            avatarImage: true,
            role: true,
            coins: true,
            tag: true,
            tagColor: true,
            pfpAccessory: true,
            pfpOverlay: true,
            legacy: true,
          },
        },
        reactions: {
          select: { emoji: true, accountId: true },
        },
      },
    })

    // Reward 1 coin per message (small, capped naturally by message rate).
    try {
      await awardCoins(account.id, 1, "message_reward")
    } catch (coinErr) {
      // Coin reward failure shouldn't block the message.
      console.error("[chat-data POST] coin reward failed", coinErr)
    }

    // #general rolling cap — the 101st message deletes the 1st.
    if (channelId === "main") {
      try {
        const total = await db.chatMessage.count({ where: { channelId: "main" } })
        if (total > MAIN_CHANNEL_MAX) {
          const oldest = await db.chatMessage.findMany({
            where: { channelId: "main" },
            orderBy: { createdAt: "asc" },
            take: total - MAIN_CHANNEL_MAX,
            select: { id: true },
          })
          if (oldest.length > 0) {
            await db.chatMessage.deleteMany({
              where: { id: { in: oldest.map((m) => m.id) } },
            })
          }
        }
      } catch (capErr) {
        console.error("[chat-data POST] rolling cap failed", capErr)
      }
    }

    // Re-fetch account to get updated coin balance for the response payload.
    const updated = await db.chatAccount.findUnique({ where: { id: account.id } })

    return NextResponse.json({
      ok: true,
      message: {
        id: message.id,
        channelId: message.channelId,
        content: message.content,
        replyTo: message.replyTo,
        replyToContent: message.replyToContent,
        replyToUsername: message.replyToUsername,
        createdAt: message.createdAt,
        editedAt: message.editedAt ?? null,
        account: message.account,
        reactions: [], // fresh message — nobody has reacted yet
      },
      account: updated ? toPublicAccount(updated) : null,
    })
  } catch (err) {
    console.error("[chat-data POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error sending message." },
      { status: 500 },
    )
  }
}

/* PATCH — edit your own message. Body: { token, messageId, content }.
 * Works for DB messages AND live-room (git version, "lv-*") messages
 * when the live message belongs to your username — the edit stamps
 * editedAt so every surface renders the "(edited)" marker. */
export async function PATCH(req: NextRequest): Promise<Response> {
  return cors(await handlePatch(req))
}

async function handlePatch(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      messageId?: string
      content?: string
    }>(req)
    if (!body) return badBody()
    const messageId = (body.messageId || "").trim()
    const content = (body.content || "").trim()

    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "You must be signed in to edit messages." },
        { status: 401 },
      )
    }
    if (!messageId) {
      return NextResponse.json(
        { ok: false, error: "messageId is required." },
        { status: 400 },
      )
    }
    if (!content) {
      return NextResponse.json(
        { ok: false, error: "Message content cannot be empty." },
        { status: 400 },
      )
    }
    if (content.length > 2000) {
      return NextResponse.json(
        { ok: false, error: "Message is too long (2000 char max)." },
        { status: 400 },
      )
    }

    /* A live-room (git version) message — ownership is the shared
     * file's username, not a DB row. */
    if (messageId.startsWith("lv-")) {
      const edited = await liveEditMessage(
        messageId,
        account.username,
        content,
      ).catch(() => null)
      if (!edited) {
        return NextResponse.json(
          { ok: false, error: "You can only edit your own messages." },
          { status: 403 },
        )
      }
      return NextResponse.json({
        ok: true,
        message: {
          id: edited.id,
          channelId: "main",
          content: edited.content,
          replyTo: null,
          replyToContent: null,
          replyToUsername: null,
          createdAt: edited.createdAt,
          editedAt: edited.editedAt ?? null,
        },
        live: true,
      })
    }

    const message = await db.chatMessage.findUnique({
      where: { id: messageId },
    })
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Message not found." },
        { status: 404 },
      )
    }
    if (message.accountId !== account.id) {
      return NextResponse.json(
        { ok: false, error: "You can only edit your own messages." },
        { status: 403 },
      )
    }
    const updated = await db.chatMessage.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
    })
    return NextResponse.json({
      ok: true,
      message: {
        id: updated.id,
        channelId: updated.channelId,
        content: updated.content,
        replyTo: updated.replyTo,
        replyToContent: updated.replyToContent,
        replyToUsername: updated.replyToUsername,
        createdAt: updated.createdAt,
        editedAt: updated.editedAt ?? null,
      },
    })
  } catch (err) {
    console.error("[chat-data PATCH] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error editing message." },
      { status: 500 },
    )
  }
}
