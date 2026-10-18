import { NextRequest, NextResponse } from "next/server"
import { getAccountFromToken } from "@/lib/chat-auth"
import {
  heartbeatAppUser,
  listLiveRoomFresh,
  liveMessageEdited,
  liveMessageText,
  liveMessageUser,
  liveUserOf,
  markRoomHot,
  writeLiveRoom,
} from "@/lib/veil/gh-live"
import { cors, corsOptions } from "@/lib/veil/cors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* Preflight + wildcard origin — same hatch as the other chat routes (the
 * offline single-file build and the static mirrors may probe this route). */
export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

const FALLBACK_COLOR = "#a1a1aa"

/* The owner is the "Veil" operator — username match, exactly like the chat
 * UI's isMod() and chat-mod's isSuperAdmin(). Role alone is not a reliable
 * owner signal: a wiped/restored db can leave the operator account at role
 * "member" (all three layers must agree). */
const SUPER_ADMIN_USERNAME = "Veil"
function isModAccount(a: { username: string; role: string }): boolean {
  return (
    a.role === "moderator" ||
    a.role === "admin" ||
    a.username.toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase()
  )
}

/**
 * GET — the shared GitHub room (static-site #general) mapped into the app's
 * chat shapes. CORS-open, no auth: it only exposes public room data that is
 * already world-readable on the git branch. Bridged lines/accounts are
 * mapped to look NATIVE — no tag, no marker. Messages authored by banned
 * room users are excluded (the ban itself stays visible on the user row so
 * the app's existing banned-filtering applies). On upstream failure it
 * answers { ok: false } with status 200 — the client ignores that and the
 * chat keeps working; the bridge must never break #general.
 */
export async function GET(): Promise<Response> {
  try {
    const room = await listLiveRoomFresh()

    const messages = room.messages
      .filter((m) => {
        const author = liveUserOf(room, liveMessageUser(m))
        return !(author && author.banned)
      })
      .map((m) => {
        const username = liveMessageUser(m)
        const author = liveUserOf(room, username)
        return {
          id: `gh-${m.id}`,
          channelId: "main",
          content: liveMessageText(m),
          replyTo: null,
          replyToContent: null,
          replyToUsername: null,
          createdAt: m.createdAt || new Date().toISOString(),
          editedAt: liveMessageEdited(m),
          account: {
            id: `gh-${username}`,
            username,
            displayName: author?.displayName || author?.name || username,
            avatarColor: m.color || author?.avatarColor || author?.color || FALLBACK_COLOR,
            avatarImage: null,
            role: "member" as const,
            coins: 0,
            tag: null,
            tagColor: null,
            pfpAccessory: null,
            legacy: true,
          },
        }
      })

    /* Users with src:"app" are mirrors of OUR accounts (heartbeat/message
     * writes) — surfacing them back here would duplicate every app user
     * in the players panel, so only native static-site accounts map. */
    const users = Object.entries(room.users)
      .filter(([, u]) => u.src !== "app")
      .map(([username, u]) => {
        const lastSeen = u.lastSeen || new Date().toISOString()
        const online =
          Date.now() - new Date(lastSeen).getTime() < 4 * 60 * 1000
        return {
          id: `gh-${username}`,
          username,
          displayName: u.displayName || u.name || username,
          avatarColor: u.avatarColor || u.color || FALLBACK_COLOR,
          avatarImage: null,
          bio: "",
          role: "member" as const,
          muted: false,
          banned: u.banned === true,
          banReason: null,
          ipBanned: false,
          coins: 0,
          tag: null,
          tagColor: null,
          pfpAccessory: null,
          legacy: true,
          createdAt: lastSeen,
          online,
          lastSeen,
        }
      })

    return cors(NextResponse.json({ ok: true, users, messages }))
  } catch (err) {
    console.error("[chat-live-bridge GET] error", err)
    return cors(NextResponse.json({ ok: false }))
  }
}

type ModActionBody = {
  action?: "deleteMessage" | "banUser" | "unbanUser"
  id?: string
  username?: string
}

/** Apply a moderator action against the shared GitHub room. Authed via
 *  the token query param; only moderators/admins/the owner may act. */
async function applyModAction(
  token: string,
  body: ModActionBody,
): Promise<Response> {
  const account = await getAccountFromToken(token)
  if (!account) {
    return NextResponse.json(
      { ok: false, error: "Invalid or expired token." },
      { status: 401 },
    )
  }
  if (!isModAccount(account)) {
    return NextResponse.json(
      { ok: false, error: "Only moderators and the owner can do that." },
      { status: 403 },
    )
  }

  if (body.action === "deleteMessage") {
    /* The client strips its "gh-" prefix — the room knows the raw id. */
    const id = String(body.id || "").trim()
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "A message id is required." },
        { status: 400 },
      )
    }
    await writeLiveRoom((room) => {
      room.messages = room.messages.filter((m) => m.id !== id)
    })
    // Both CDN read lanes lag (raw is Fastly-cached, jsDelivr purges are
    // rate-limited) — read API-fresh for a while so the delete STICKS in
    // every client instead of resurrecting on the next poll.
    markRoomHot()
    return cors(NextResponse.json({ ok: true, deletedId: id }))
  }

  if (body.action === "banUser" || body.action === "unbanUser") {
    const username = String(body.username || "").trim()
    if (!username) {
      return NextResponse.json(
        { ok: false, error: "A username is required." },
        { status: 400 },
      )
    }
    const ban = body.action === "banUser"
    const now = new Date().toISOString()
    let matchedKey: string | null = null
    await writeLiveRoom((room) => {
      const key = Object.keys(room.users).find(
        (k) => k.toLowerCase() === username.toLowerCase(),
      )
      if (!key) return
      matchedKey = key
      room.users[key] = {
        ...room.users[key],
        banned: ban,
        bannedAt: ban ? now : room.users[key]?.bannedAt,
      }
    })
    if (!matchedKey) {
      return NextResponse.json(
        { ok: false, error: `@${username} is not in the GitHub room.` },
        { status: 404 },
      )
    }
    markRoomHot()
    return cors(
      NextResponse.json({ ok: true, username: matchedKey, banned: ban }),
    )
  }

  return NextResponse.json(
    { ok: false, error: "Unknown action." },
    { status: 400 },
  )
}

/**
 * POST — heartbeat + moderator actions against the shared GitHub room.
 *
 *  { heartbeat: true }                      → push the caller's presence
 *                                             into the room roster (the
 *                                             static-site copies' player
 *                                             list). Fire-and-forget.
 *  { action: "deleteMessage", id }          → remove that exact message id
 *                                             (mods/owner only).
 *  { action: "banUser" | "unbanUser",
 *    username }                             → flip the room user's banned
 *                                             flag (mods/owner only); all
 *                                             other fields are preserved.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const token = req.nextUrl.searchParams.get("token") || ""

    let body: ModActionBody & { heartbeat?: boolean } = {}
    try {
      body = (await req.json()) as ModActionBody & { heartbeat?: boolean }
    } catch {
      /* empty body — treat as plain heartbeat ping */
    }

    if (body.action) {
      return applyModAction(token, body)
    }

    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    if (body.heartbeat !== false) {
      void heartbeatAppUser({
        username: account.username,
        displayName: account.displayName,
        color: account.avatarColor,
      }).catch((err) => {
        console.error("[chat-live-bridge POST] heartbeat failed", err)
      })
    }

    return cors(NextResponse.json({ ok: true }))
  } catch (err) {
    console.error("[chat-live-bridge POST] error", err)
    return cors(NextResponse.json({ ok: false }))
  }
}
