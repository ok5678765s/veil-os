import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken } from "@/lib/chat-auth"
import { emitToRooms } from "@/lib/veil/chat-emit"
import { cors, corsOptions } from "@/lib/veil/cors"

export const runtime = "nodejs"

/* Preflight + wildcard origin — same policy as the other chat routes
 * (the CDN front serves the app cross-origin through the zone shim). */
export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/** Slim public projection of an account for friend lists / requests. */
const FRIEND_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarColor: true,
  avatarImage: true,
  role: true,
  tag: true,
  tagColor: true,
  pfpAccessory: true,
  pfpOverlay: true,
} as const

type FriendProfile = {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  role: string
  tag: string | null
  tagColor: string | null
  pfpAccessory: string | null
  pfpOverlay: string | null
}

/** NEVER return a raw account row (it carries passwordHash!). Anything
 * that crosses the wire goes through this slim projection. */
function toFriendProfile(a: {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  role: string
  tag?: string | null
  tagColor?: string | null
  pfpAccessory?: string | null
  pfpOverlay?: string | null
}): FriendProfile {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    avatarColor: a.avatarColor,
    avatarImage: a.avatarImage,
    role: a.role,
    tag: a.tag ?? null,
    tagColor: a.tagColor ?? null,
    pfpAccessory: a.pfpAccessory ?? null,
    pfpOverlay: a.pfpOverlay ?? null,
  }
}

/** Case-insensitive username lookup (SQLite has no `mode: "insensitive"`,
 * so contains + exact-lowercase match — small user table, cheap). */
async function findByUsername(username: string) {
  const needle = username.trim().toLowerCase()
  if (!needle) return null
  const candidates = await db.chatAccount.findMany({
    where: { username: { contains: username.trim() } },
    take: 50,
  })
  return (
    candidates.find((a) => a.username.toLowerCase() === needle) ?? null
  )
}

/** Both ChatFriend rows for a mutual friendship. Upserts (not createMany
 * + skipDuplicates — unsupported on SQLite) so a pre-existing one-way
 * legacy row can never break an accept. */
async function createMutualFriendship(aId: string, bId: string) {
  await db.chatFriend.upsert({
    where: { accountId_friendId: { accountId: aId, friendId: bId } },
    create: { accountId: aId, friendId: bId },
    update: {},
  })
  await db.chatFriend.upsert({
    where: { accountId_friendId: { accountId: bId, friendId: aId } },
    create: { accountId: bId, friendId: aId },
    update: {},
  })
}

export async function GET(req: NextRequest) {
  return cors(await handleGet(req))
}

async function handleGet(req: NextRequest): Promise<Response> {
  try {
    const token = req.nextUrl.searchParams.get("token") || ""
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const [friendRows, incoming, outgoing] = await Promise.all([
      db.chatFriend.findMany({
        where: { accountId: account.id },
        include: { friend: { select: FRIEND_SELECT } },
        orderBy: { createdAt: "desc" },
      }),
      db.chatFriendRequest.findMany({
        where: { toId: account.id, status: "pending" },
        include: { from: { select: FRIEND_SELECT } },
        orderBy: { createdAt: "desc" },
      }),
      db.chatFriendRequest.findMany({
        where: { fromId: account.id, status: "pending" },
        include: { to: { select: FRIEND_SELECT } },
        orderBy: { createdAt: "desc" },
      }),
    ])

    return NextResponse.json({
      ok: true,
      friends: friendRows.map((f) => f.friend),
      incoming: incoming.map((r) => ({
        id: r.id,
        user: r.from,
        createdAt: r.createdAt,
      })),
      outgoing: outgoing.map((r) => ({
        id: r.id,
        user: r.to,
        createdAt: r.createdAt,
      })),
    })
  } catch (err) {
    console.error("[chat-friends GET] error", err)
    return NextResponse.json(
      { ok: false, error: "Couldn't load your friends right now." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      token?: string
      action?: string
      targetUsername?: string
      requestId?: string
    }

    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const action = String(body.action || "")

    /* ------------------------------------------------------------------
     * request (alias: add) — send a friend request. NEVER an instant
     * friendship: the target gets a live notification and must accept.
     * ---------------------------------------------------------------- */
    if (action === "request" || action === "add") {
      const target = await findByUsername(String(body.targetUsername || ""))
      if (!target) {
        return NextResponse.json(
          {
            ok: false,
            error: `No @${String(body.targetUsername || "").trim().replace(/^@/, "")} here — double-check the spelling.`,
          },
          { status: 404 },
        )
      }
      if (target.id === account.id) {
        return NextResponse.json(
          { ok: false, error: "You're already your own best friend 💚" },
          { status: 400 },
        )
      }
      if (target.banned || target.ipBanned) {
        return NextResponse.json(
          { ok: false, error: "That account can't be added." },
          { status: 400 },
        )
      }
      if (target.legacy) {
        return NextResponse.json(
          {
            ok: false,
            error: `@${target.username} hasn't set up their account yet — they need to sign in once first.`,
          },
          { status: 400 },
        )
      }

      // Already mutual friends?
      const [mine, theirs] = await Promise.all([
        db.chatFriend.findUnique({
          where: {
            accountId_friendId: { accountId: account.id, friendId: target.id },
          },
        }),
        db.chatFriend.findUnique({
          where: {
            accountId_friendId: { accountId: target.id, friendId: account.id },
          },
        }),
      ])
      if (mine && theirs) {
        return NextResponse.json({
          ok: true,
          already: "friends",
          friend: toFriendProfile(target),
        })
      }

      // Outgoing request already pending?
      const outPending = await db.chatFriendRequest.findUnique({
        where: {
          fromId_toId: { fromId: account.id, toId: target.id },
        },
      })
      if (outPending) {
        return NextResponse.json({
          ok: true,
          already: "pending",
          friend: toFriendProfile(target),
        })
      }

      /* They already asked US? Two people wanting the same thing is an
       * accept, not a deadlock — link both sides instantly and tell
       * everyone. This is also the "add" → "accept" handshake path. */
      const inPending = await db.chatFriendRequest.findUnique({
        where: {
          fromId_toId: { fromId: target.id, toId: account.id },
        },
      })
      if (inPending) {
        await createMutualFriendship(account.id, target.id)
        await db.chatFriendRequest.deleteMany({
          where: {
            OR: [
              { fromId: account.id, toId: target.id },
              { fromId: target.id, toId: account.id },
            ],
          },
        })
        void emitToRooms(
          ["user:" + account.id, "user:" + target.id],
          "friend_accepted",
          {
            by: account.username,
            friend: {
              id: target.id,
              username: target.username,
              displayName: target.displayName,
            },
            mutual: true,
          },
        )
        return NextResponse.json({
          ok: true,
          accepted: true,
          friend: toFriendProfile(target),
        })
      }

      // Outgoing cap — keeps pending-spam impossible.
      const pendingCount = await db.chatFriendRequest.count({
        where: { fromId: account.id, status: "pending" },
      })
      if (pendingCount >= 25) {
        return NextResponse.json(
          {
            ok: false,
            error: "That's a lot of pending requests — wait for some to clear first.",
          },
          { status: 400 },
        )
      }

      const request = await db.chatFriendRequest.create({
        data: { fromId: account.id, toId: target.id },
      })

      /* Live notification for the target: bell + toast + sidebar badge.
       * Best effort — the relay being down just means they see it on the
       * next poll instead of instantly. */
      void emitToRooms(["user:" + target.id], "friend_request", {
        requestId: request.id,
        from: {
          id: account.id,
          username: account.username,
          displayName: account.displayName || account.username,
          avatarColor: account.avatarColor,
          avatarImage: account.avatarImage,
        },
      })

      return NextResponse.json({
        ok: true,
        sent: true,
        friend: toFriendProfile(target),
      })
    }

    /* ------------------------------------------------------------------
     * accept — the recipient says yes: create BOTH friendship rows,
     * drop the request, and notify both sides live.
     * ---------------------------------------------------------------- */
    if (action === "accept") {
      const requestId = String(body.requestId || "")
      const request = requestId
        ? await db.chatFriendRequest.findUnique({ where: { id: requestId } })
        : null
      if (!request || request.toId !== account.id) {
        // Idempotent: already handled (or never existed) — not an error.
        return NextResponse.json({ ok: true, gone: true })
      }

      const sender = await db.chatAccount.findUnique({
        where: { id: request.fromId },
        select: FRIEND_SELECT,
      })
      await createMutualFriendship(account.id, request.fromId)
      await db.chatFriendRequest.deleteMany({
        where: {
          OR: [
            { fromId: request.fromId, toId: account.id },
            { fromId: account.id, toId: request.fromId },
          ],
        },
      })

      if (sender) {
        void emitToRooms(
          ["user:" + request.fromId],
          "friend_accepted",
          {
            by: account.username,
            friend: {
              id: account.id,
              username: account.username,
              displayName: account.displayName || account.username,
            },
          },
        )
      }
      return NextResponse.json({ ok: true, friend: sender })
    }

    /* ------------------------------------------------------------------
     * decline — the recipient says no. Just deletes the request; nothing
     * is remembered, so the sender can try again later without shame.
     * ---------------------------------------------------------------- */
    if (action === "decline") {
      const requestId = String(body.requestId || "")
      const request = requestId
        ? await db.chatFriendRequest.findUnique({ where: { id: requestId } })
        : null
      if (request && request.toId === account.id) {
        await db.chatFriendRequest.delete({ where: { id: request.id } })
      }
      return NextResponse.json({ ok: true })
    }

    /* ------------------------------------------------------------------
     * cancel — take back an outgoing pending request.
     * ---------------------------------------------------------------- */
    if (action === "cancel") {
      const requestId = String(body.requestId || "")
      const request = requestId
        ? await db.chatFriendRequest.findUnique({ where: { id: requestId } })
        : null
      if (request && request.fromId === account.id) {
        await db.chatFriendRequest.delete({ where: { id: request.id } })
      }
      return NextResponse.json({ ok: true })
    }

    /* ------------------------------------------------------------------
     * remove — unfriend. Deletes BOTH directions (friendship was mutual)
     * plus any stray pending request between the two.
     * ---------------------------------------------------------------- */
    if (action === "remove") {
      const target = await findByUsername(String(body.targetUsername || ""))
      if (!target) {
        return NextResponse.json({ ok: true, gone: true })
      }
      await db.chatFriend.deleteMany({
        where: {
          OR: [
            { accountId: account.id, friendId: target.id },
            { accountId: target.id, friendId: account.id },
          ],
        },
      })
      await db.chatFriendRequest.deleteMany({
        where: {
          OR: [
            { fromId: account.id, toId: target.id },
            { fromId: target.id, toId: account.id },
          ],
        },
      })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json(
      { ok: false, error: "Unknown action." },
      { status: 400 },
    )
  } catch (err) {
    console.error("[chat-friends POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Something hiccuped — try again in a moment." },
      { status: 500 },
    )
  }
}
