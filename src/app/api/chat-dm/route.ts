import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { emitToRooms } from "@/lib/veil/chat-emit"
import { cors, corsOptions } from "@/lib/veil/cors"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/** Mutual-friend check — DMs are a friends-only space (owner ask):
 * every person pulled into a NEW conversation must already be a mutual
 * friend of the creator. Returns the usernames that are NOT friends. */
async function nonFriendUsernames(
  myId: string,
  targets: { id: string; username: string }[],
): Promise<string[]> {
  if (targets.length === 0) return []
  const rows = await db.chatFriend.findMany({
    where: {
      accountId: myId,
      friendId: { in: targets.map((t) => t.id) },
    },
  })
  const theyAlsoAddedMe = await db.chatFriend.findMany({
    where: {
      friendId: myId,
      accountId: { in: targets.map((t) => t.id) },
    },
  })
  const mutual = new Set(
    rows
      .filter((r) => theyAlsoAddedMe.some((b) => b.accountId === r.friendId))
      .map((r) => r.friendId),
  )
  return targets.filter((t) => !mutual.has(t.id)).map((t) => t.username)
}

// GET /api/chat-dm?token=...        — list DMs the current account is a member of.
// Each DM is returned with its member accounts (projected through toPublicAccount).
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

    const memberships = await db.dMMember.findMany({
      where: { accountId: account.id },
      include: {
        dm: {
          include: {
            members: {
              include: {
                account: true,
              },
            },
          },
        },
      },
      orderBy: { dm: { createdAt: "desc" } },
    })

    const dms = memberships
      .filter((m) => m.dm)
      .map((m) => ({
        id: m.dm.id,
        name: m.dm.name,
        isGroup: m.dm.isGroup,
        ownerId: m.dm.ownerId,
        createdAt: m.dm.createdAt,
        members: m.dm.members
          .filter((mem) => mem.account && !mem.account.banned)
          .map((mem) => toPublicAccount(mem.account)),
      }))

    return NextResponse.json({ ok: true, dms })
  } catch (err) {
    console.error("[chat-dm GET] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error fetching DMs." },
      { status: 500 },
    )
  }
}

// POST /api/chat-dm
// Body: { token, targetUsername } — create (or reuse) a 1:1 DM with target user.
// Body: { token, targetUsernames: string[], name?: string } — create a group DM.
export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      targetUsername?: string
      targetUsernames?: string[]
      name?: string
      /** Explicit group intent — the Groups panel / offline build create
       * named groups even with a single friend ("Squad" with one person
       * is a group, NOT a silent reuse of the 1:1 DM). */
      makeGroup?: boolean
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

    const rawTargets = Array.isArray(body.targetUsernames) && body.targetUsernames.length > 0
      ? body.targetUsernames
      : body.targetUsername
        ? [body.targetUsername]
        : []
    const targetUsernames = Array.from(
      new Set(
        rawTargets
          .map((u) => (u || "").trim())
          .filter((u) => u && u !== account.username),
      ),
    )

    if (targetUsernames.length === 0) {
      return NextResponse.json(
        { ok: false, error: "At least one target username is required." },
        { status: 400 },
      )
    }

    const targetAccounts = await db.chatAccount.findMany({
      where: { username: { in: targetUsernames } },
    })
    if (targetAccounts.length !== targetUsernames.length) {
      return NextResponse.json(
        { ok: false, error: "One or more target users were not found." },
        { status: 404 },
      )
    }

    /* A group when 2+ targets, OR when the caller explicitly asks for
     * one — the reuse path below must never swallow a deliberate group. */
    const isGroup = targetUsernames.length > 1 || body.makeGroup === true
    const allMemberIds = [account.id, ...targetAccounts.map((a) => a.id)]

    // For 1:1 DMs: try to find an existing non-group DM with exactly these 2 members.
    if (!isGroup) {
      const target = targetAccounts[0]
      const existing = await db.chatDM.findFirst({
        where: { isGroup: false },
        include: { members: true },
      })
      // Scan all non-group DMs the current user is in for an exact 2-member match.
      const myDms = await db.dMMember.findMany({
        where: { accountId: account.id },
        include: {
          dm: { include: { members: true } },
        },
      })
      const match = myDms.find((m) => {
        const dm = m.dm
        if (dm.isGroup) return false
        if (dm.members.length !== 2) return false
        return dm.members.some((mem) => mem.accountId === target.id)
      })
      if (match) {
        const refreshed = await db.chatDM.findUnique({
          where: { id: match.dmId },
          include: {
            members: {
              include: { account: true },
            },
          },
        })
        return NextResponse.json({
          ok: true,
          dm: {
            id: refreshed!.id,
            name: refreshed!.name,
            isGroup: refreshed!.isGroup,
            ownerId: refreshed!.ownerId,
            createdAt: refreshed!.createdAt,
            members: refreshed!.members.map((mem) =>
              toPublicAccount(mem.account),
            ),
          },
          reused: true,
        })
      }
      // Suppress unused-var warning for `existing` (kept for clarity).
      void existing
    }

    /* Friends-only gate (owner ask): DMs and groups are for people you
     * actually know. This sits AFTER the reuse check, so re-opening an
     * existing conversation always works (even if you two unfriended
     * since) — only MINTING a new conversation needs friendship. */
    const notFriends = await nonFriendUsernames(
      account.id,
      targetAccounts.map((a) => ({ id: a.id, username: a.username })),
    )
    if (notFriends.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            notFriends.length === 1
              ? `@${notFriends[0]} isn't your friend yet — send them a friend request first.`
              : `Not friends yet: @${notFriends.join(", @")} — friend requests come first.`,
        },
        { status: 403 },
      )
    }

    // Create a new DM with all members.
    const created = await db.chatDM.create({
      data: {
        name: body.name || null,
        isGroup,
        ownerId: account.id,
        members: {
          create: allMemberIds.map((id) => ({ accountId: id })),
        },
      },
      include: {
        members: {
          include: { account: true },
        },
      },
    })

    /* Live heads-up for the OTHER members — their clients refetch the DM
     * list and toast "@you opened a chat", instead of waiting for the
     * 30s poll. Best effort (relay down never fails the create). */
    void emitToRooms(
      targetAccounts.map((t) => "user:" + t.id),
      "dm_added",
      {
        dmId: created.id,
        name: created.name,
        invitedBy: account.username,
        members: created.members.length,
      },
    )

    return NextResponse.json({
      ok: true,
      dm: {
        id: created.id,
        name: created.name,
        isGroup: created.isGroup,
        ownerId: created.ownerId,
        createdAt: created.createdAt,
        members: created.members.map((mem) => toPublicAccount(mem.account)),
      },
      reused: false,
    })
  } catch (err) {
    console.error("[chat-dm POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error creating DM." },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/chat-dm — rename a group chat.
 * Body: { token, dmId, name }
 *
 * Any member of the group can rename it (casual-chat policy). The new
 * name (1–64 chars) is broadcast to the group's room as `dm_updated` so
 * every online member's DM list + header retitle instantly.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  return cors(await handlePatch(req))
}

async function handlePatch(req: NextRequest): Promise<Response> {
  try {
    const body = await readJsonBody<{
      token?: string
      dmId?: string
      name?: string
    }>(req)
    if (!body) return badBody()

    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const dmId = (body.dmId || "").trim()
    const name = (body.name || "").trim().slice(0, 64)
    if (!dmId) {
      return NextResponse.json(
        { ok: false, error: "A dmId is required." },
        { status: 400 },
      )
    }
    if (!name) {
      return NextResponse.json(
        { ok: false, error: "A group name is required." },
        { status: 400 },
      )
    }

    const dm = await db.chatDM.findUnique({
      where: { id: dmId },
      include: { members: true },
    })
    if (!dm) {
      return NextResponse.json(
        { ok: false, error: "This conversation no longer exists." },
        { status: 404 },
      )
    }
    if (!dm.members.some((m) => m.accountId === account.id)) {
      return NextResponse.json(
        { ok: false, error: "You are not a member of this conversation." },
        { status: 403 },
      )
    }
    if (!dm.isGroup) {
      return NextResponse.json(
        { ok: false, error: "Only group chats can be renamed." },
        { status: 400 },
      )
    }

    await db.chatDM.update({ where: { id: dmId }, data: { name } })

    void emitToRooms([dmId], "dm_updated", {
      dmId,
      reason: "rename",
      name,
      by: account.username,
    })

    return NextResponse.json({ ok: true, name })
  } catch (err) {
    console.error("[chat-dm PATCH] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error renaming the group." },
      { status: 500 },
    )
  }
}
