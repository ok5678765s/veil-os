import { NextResponse } from "next/server"
import { readLiveRoom, type LiveMessage, type LiveUser } from "@/lib/veil/live-room"

/**
 * /api/chat-live — the git version's shared chat room, mapped into the
 * website chat's row shapes so the two rooms render as ONE.
 *
 * The static CDN copies (jsDelivr / GitHub Pages / Vercel static) write
 * their chat through the GitHub Contents API into
 * site/data/chat-live.json; this route reads the freshest copy and hands
 * it to the website's chat (which merges by id). Bridged users render
 * like any other member — same avatar colors, same roles, no special
 * tag. Their ids are "live:<username>" so moderation can route deletes
 * and bans back through /api/chat-mod's live branch.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS })
}

function msgAccount(u: LiveUser | undefined) {
  const username = (u?.username ?? "").toLowerCase()
  return {
    id: `live:${username}`,
    username,
    displayName: u?.displayName || username,
    avatarColor: /^#[0-9a-f]{3,8}$/i.test(u?.avatarColor ?? "") ? (u?.avatarColor as string) : "#22d3ee",
    avatarImage: null,
    role: "member" as const,
    coins: 0,
    tag: null,
    tagColor: null,
    pfpAccessory: null,
    pfpOverlay: null,
  }
}

export async function GET(): Promise<Response> {
  try {
    const room = await readLiveRoom()
    const now = Date.now()
    const messages = room.messages
      .filter((m: LiveMessage) => m && typeof m.id === "string" && typeof m.content === "string")
      .slice(-100)
      .map((m: LiveMessage) => ({
        id: m.id,
        channelId: "general",
        content: m.content,
        replyTo: null,
        replyToContent: null,
        replyToUsername: null,
        createdAt: m.createdAt,
        editedAt: m.editedAt ?? null,
        account: msgAccount(room.users[(m.username ?? "").toLowerCase()]),
      }))
    /* NOTE: banned users are INCLUDED (with their flags) — the mod
     * panel needs to see them to lift a ban. Rosters filter them out
     * client-side. */
    const users = Object.values(room.users)
      .filter((u) => u?.username)
      .map((u) => {
        const seen = u.lastSeen ? Date.parse(u.lastSeen) : 0
        return {
          accountId: `live:${u.username.toLowerCase()}`,
          username: u.username.toLowerCase(),
          displayName: u.displayName || u.username,
          avatarColor: /^#[0-9a-f]{3,8}$/i.test(u.avatarColor ?? "") ? (u.avatarColor as string) : "#22d3ee",
          avatarImage: null,
          lastSeen: seen || 0,
          online: seen > 0 && now - seen < 4 * 60_000 && !u.banned,
          muted: !!u.muted,
          banned: !!u.banned,
          banReason: u.banReason ?? null,
        }
      })
    return NextResponse.json(
      { ok: true, messages, users },
      { headers: { ...CORS, "cache-control": "no-store" } },
    )
  } catch {
    return NextResponse.json(
      { ok: false, messages: [], users: [] },
      { status: 200, headers: { ...CORS, "cache-control": "no-store" } },
    )
  }
}
