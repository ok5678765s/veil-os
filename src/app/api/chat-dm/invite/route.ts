import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { emitToRooms } from "@/lib/veil/chat-emit"
import { cors, corsOptions } from "@/lib/veil/cors"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

/* Preflight + wildcard origin — same policy as the other chat routes. */
export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/**
 * POST /api/chat-dm/invite — invite people to a group chat.
 *
 * Body: { token, dmId, targetUsernames: string[] }
 *
 * Rules:
 *   - the inviter must already be a member of the DM;
 *   - inviting into a 1:1 DM converts it into a group (name becomes the
 *     joined display names until someone renames it);
 *   - targets must exist, not be banned, and not already be members
 *     (silently skipped otherwise);
 *   - targets must be mutual FRIENDS of the inviter (owner ask — the
 *     same friends-only rule as creating conversations);
 *   - the invited users' clients get a live `dm_added` toast via the
 *     relay's private user rooms; the group's existing members get
 *     `dm_updated` so member lists refresh without a reload.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = await readJsonBody<{
      token?: string
      dmId?: string
      targetUsernames?: string[]
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
    if (!dmId) {
      return NextResponse.json(
        { ok: false, error: "A dmId is required." },
        { status: 400 },
      )
    }

    const dm = await db.chatDM.findUnique({
      where: { id: dmId },
      include: { members: { include: { account: true } } },
    })
    if (!dm) {
      return NextResponse.json(
        { ok: false, error: "This conversation no longer exists." },
        { status: 404 },
      )
    }

    // The inviter must be a member.
    if (!dm.members.some((m) => m.accountId === account.id)) {
      return NextResponse.json(
        { ok: false, error: "You are not a member of this conversation." },
        { status: 403 },
      )
    }

    const raw = Array.isArray(body.targetUsernames) ? body.targetUsernames : []
    const names = Array.from(
      new Set(raw.map((u) => (u || "").trim()).filter(Boolean)),
    )
    if (names.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Pick at least one person to invite." },
        { status: 400 },
      )
    }
    if (names.length > 25) {
      return NextResponse.json(
        { ok: false, error: "You can invite at most 25 people at once." },
        { status: 400 },
      )
    }

    const existingIds = new Set(dm.members.map((m) => m.accountId))
    const targets = (
      await db.chatAccount.findMany({ where: { username: { in: names } } })
    ).filter((t) => !existingIds.has(t.id) && !t.banned)

    if (targets.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Those people are already in the group (or don't exist).",
        },
        { status: 400 },
      )
    }

    /* Friends-only gate (owner ask) — same rule as creating a
     * conversation: you can only pull mutual friends into a group. */
    const [myRows, theirRows] = await Promise.all([
      db.chatFriend.findMany({
        where: {
          accountId: account.id,
          friendId: { in: targets.map((t) => t.id) },
        },
      }),
      db.chatFriend.findMany({
        where: {
          friendId: account.id,
          accountId: { in: targets.map((t) => t.id) },
        },
      }),
    ])
    const mutualIds = new Set(
      myRows
        .filter((r) => theirRows.some((b) => b.accountId === r.friendId))
        .map((r) => r.friendId),
    )
    const notFriends = targets.filter((t) => !mutualIds.has(t.id))
    if (notFriends.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            notFriends.length === 1
              ? `@${notFriends[0].username} isn't your friend yet — send them a friend request first.`
              : `Not friends yet: @${notFriends.map((t) => t.username).join(", @")} — friend requests come first.`,
        },
        { status: 403 },
      )
    }

    // A 1:1 DM grows into a group the moment a third person joins.
    const becomesGroup = !dm.isGroup
    if (becomesGroup) {
      await db.chatDM.update({ where: { id: dm.id }, data: { isGroup: true } })
    }

    await db.dMMember.createMany({
      data: targets.map((t) => ({ dmId: dm.id, accountId: t.id })),
    })

    const refreshed = await db.chatDM.findUnique({
      where: { id: dm.id },
      include: { members: { include: { account: true } } },
    })

    const dmPayload = {
      id: refreshed!.id,
      name: refreshed!.name,
      isGroup: refreshed!.isGroup,
      createdAt: refreshed!.createdAt,
      members: refreshed!.members
        .filter((mem) => mem.account && !mem.account.banned)
        .map((mem) => toPublicAccount(mem.account)),
    }

    // Live notifications — best effort (relay down never fails the invite).
    void emitToRooms(
      targets.map((t) => "user:" + t.id),
      "dm_added",
      {
        dmId: dm.id,
        name: refreshed!.name,
        invitedBy: account.username,
        members: dmPayload.members.length,
      },
    )
    void emitToRooms([dm.id], "dm_updated", {
      dmId: dm.id,
      reason: "invite",
      invited: targets.map((t) => t.username),
      invitedBy: account.username,
    })

    return NextResponse.json({
      ok: true,
      dm: dmPayload,
      invited: targets.map((t) => t.username),
      becameGroup: becomesGroup,
    })
  } catch (err) {
    console.error("[chat-dm/invite POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error inviting to the group." },
      { status: 500 },
    )
  }
}
