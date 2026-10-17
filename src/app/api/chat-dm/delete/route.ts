import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken } from "@/lib/chat-auth"
import { emitToRooms } from "@/lib/veil/chat-emit"
import { cors, corsOptions } from "@/lib/veil/cors"

export const runtime = "nodejs"

export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/**
 * POST /api/chat-dm/delete — the OWNER permanently deletes a GROUP for
 * every member (owner ask: "delete groups you made").
 *
 * Body: { token, dmId }
 *
 * Rules:
 *   - only GROUP chats can be deleted this way (1:1 DMs have no shared
 *     lifetime — each side closes their own copy via /api/chat-dm/leave);
 *   - only the group's OWNER can delete it — members who didn't make it
 *     "remove it from their sight" instead (leave, which keeps the room
 *     alive for everyone else);
 *   - deleting drops every membership, every message in the room, and the
 *     ChatDM row itself;
 *   - every member (including the owner's other tabs) gets a live
 *     `dm_removed` through their private user room, so the row vanishes
 *     without a reload.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as { token?: string; dmId?: string }

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

    if (!dm.isGroup) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "DMs are closed per-person — use “Close DM” to remove it from your sight.",
        },
        { status: 400 },
      )
    }

    if (dm.ownerId !== account.id) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Only the person who made this group can delete it — you can leave it instead.",
        },
        { status: 403 },
      )
    }

    const memberUserIds = dm.members.map((m) => "user:" + m.accountId)

    await db.$transaction([
      db.chatMessage.deleteMany({ where: { channelId: dmId } }),
      db.dMMember.deleteMany({ where: { dmId } }),
      db.chatDM.delete({ where: { id: dmId } }),
    ])

    /* Everyone's row disappears instantly — the room channel + each
     * member's private room. Best effort (relay down just means the next
     * DM-list poll drops it). */
    void emitToRooms([...memberUserIds, dmId], "dm_removed", {
      dmId,
      reason: "deleted",
      by: account.username,
      name: dm.name,
    })

    return NextResponse.json({ ok: true, deleted: true })
  } catch (err) {
    console.error("[chat-dm/delete POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error deleting the group." },
      { status: 500 },
    )
  }
}
