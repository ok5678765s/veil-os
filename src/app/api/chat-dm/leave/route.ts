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

/**
 * POST /api/chat-dm/leave — leave a group chat (or close a 1:1 DM).
 *
 * Body: { token, dmId }
 *
 * Rules:
 *   - the caller must be a member (their membership row is deleted);
 *   - the last member out deletes the conversation AND its messages
 *     (nobody left to read them);
 *   - if the OWNER leaves while others remain, ownership transfers to
 *     the longest-standing remaining member;
 *   - remaining members get a live `dm_updated` (member list refresh),
 *     the leaver gets `dm_removed` (their other tabs drop the row).
 */
export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = await readJsonBody<{ token?: string; dmId?: string }>(req)
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
      include: { members: true },
    })
    if (!dm) {
      return NextResponse.json({ ok: true, gone: true })
    }

    const membership = dm.members.find((m) => m.accountId === account.id)
    if (!membership) {
      return NextResponse.json(
        { ok: false, error: "You are not a member of this conversation." },
        { status: 403 },
      )
    }

    await db.dMMember.delete({ where: { id: membership.id } })

    const remaining = await db.dMMember.findMany({
      where: { dmId },
      orderBy: { id: "asc" }, // longest-standing first (cuids sort by time)
    })

    if (remaining.length === 0) {
      // Last one out — drop the conversation and its messages.
      await db.chatMessage.deleteMany({ where: { channelId: dmId } })
      await db.chatDM.delete({ where: { id: dmId } })
      void emitToRooms(["user:" + account.id], "dm_removed", {
        dmId,
        reason: "empty",
      })
      return NextResponse.json({ ok: true, gone: true })
    }

    // Ownership transfer if the owner just left.
    if (dm.ownerId === account.id) {
      await db.chatDM.update({
        where: { id: dmId },
        data: { ownerId: remaining[0].accountId },
      })
    }

    const refreshed = await db.chatDM.findUnique({
      where: { id: dmId },
      include: { members: { include: { account: true } } },
    })
    const dmPayload = refreshed
      ? {
          id: refreshed.id,
          name: refreshed.name,
          isGroup: refreshed.isGroup,
          createdAt: refreshed.createdAt,
          members: refreshed.members
            .filter((mem) => mem.account && !mem.account.banned)
            .map((mem) => toPublicAccount(mem.account)),
        }
      : null

    void emitToRooms([dmId], "dm_updated", {
      dmId,
      reason: "leave",
      left: account.username,
    })
    void emitToRooms(["user:" + account.id], "dm_removed", {
      dmId,
      reason: "left",
    })

    return NextResponse.json({ ok: true, dm: dmPayload })
  } catch (err) {
    console.error("[chat-dm/leave POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error leaving the conversation." },
      { status: 500 },
    )
  }
}
