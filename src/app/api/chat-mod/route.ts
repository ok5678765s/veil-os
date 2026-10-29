import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import {
  liveDeleteMessage,
  liveFindUser,
  liveSetUserFlag,
  readLiveRoom,
} from "@/lib/veil/live-room"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

const SUPER_ADMIN_USERNAME = "Veil"

// Internal admin hook on the chat relay (localhost + shared secret) — used to
// immediately disconnect banned/muted users instead of waiting for their next
// API call to fail.
const CHAT_RELAY_KICK_URL = "http://127.0.0.1:3005/kick"
const CHAT_RELAY_KICK_SECRET = "veil-kick-9f3a1c77"

async function kickUser(username: string, purge?: { channelId: string; messageId: string }[]) {
  try {
    await fetch(CHAT_RELAY_KICK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veil-kick-secret": CHAT_RELAY_KICK_SECRET,
      },
      body: JSON.stringify({ username, purge }),
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Best-effort only — the ban itself is already persisted (and the
    // messages are already deleted; late clients drop them on reload).
  }
}

/** A ban is also a purge: delete every message the banned account ever
 *  sent (all channels, main + DMs) and broadcast the deletions so online
 *  clients drop them live. Returns the purged (channelId, messageId)
 *  pairs for the relay broadcast. */
async function purgeMessagesBy(
  accountId: string,
): Promise<{ channelId: string; messageId: string }[]> {
  try {
    const rows = await db.chatMessage.findMany({
      where: { accountId },
      select: { id: true, channelId: true },
    })
    if (rows.length === 0) return []
    await db.chatMessage.deleteMany({ where: { accountId } })
    return rows.map((r) => ({ channelId: r.channelId, messageId: r.id }))
  } catch (err) {
    console.error("[chat-mod] purge error", err)
    return []
  }
}

/** Resolve a moderation target. Accepts "name", "@name", display names,
 * and any casing — whatever the moderator typed should just work. */
async function resolveTarget(raw: string) {
  const name = raw.trim().replace(/^@+/, "").toLowerCase()
  if (!name) return null
  const byUsername = await db.chatAccount.findUnique({
    where: { username: name },
  })
  if (byUsername) return byUsername
  // Display-name fallback — matched case-insensitively in JS because SQLite
  // has no `mode: "insensitive"`. The accounts table is tiny, so this is free.
  const byDisplay = await db.chatAccount.findFirst({
    where: { displayName: raw.trim() },
  })
  if (byDisplay) return byDisplay
  const all = await db.chatAccount.findMany({
    select: { id: true, displayName: true },
  })
  const lower = raw.trim().toLowerCase()
  const hit = all.find(
    (a) => (a.displayName || "").trim().toLowerCase() === lower,
  )
  return hit ? db.chatAccount.findUnique({ where: { id: hit.id } }) : null
}

const SUPER_ADMIN_ONLY_ACTIONS = new Set([
  "add_mod",
  "remove_mod",
  "create_mod",
  "ip_ban",
])

const MOD_ACTIONS = new Set([
  "ban",
  "unban",
  "mute",
  "unmute",
  "delete_message",
  ...SUPER_ADMIN_ONLY_ACTIONS,
])

function isSuperAdmin(account: { username: string }): boolean {
  return account.username.toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase()
}

function isMod(account: { role: string; username: string }): boolean {
  return (
    isSuperAdmin(account) ||
    account.role === "moderator" ||
    account.role === "admin"
  )
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      action?: string
      targetUsername?: string
      reason?: string
      messageId?: string
      password?: string
      displayName?: string
      durationMins?: number
    }>(req)
    if (!body) return badBody()

    const token = body.token
    const action = body.action || ""
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    if (!isMod(account)) {
      // Non-mods are allowed exactly ONE action: deleting their own
      // messages (the chat UI's Delete button is shown for your own
      // messages — it used to 403 here for regular members).
      if (action !== "delete_message") {
        return NextResponse.json(
          { ok: false, error: "You do not have moderator privileges." },
          { status: 403 },
        )
      }
      const ownId = (body.messageId || "").trim()
      if (ownId.startsWith("lv-")) {
        // A LIVE-room (git version) message — ownership is the shared
        // file's username, not a DB row.
        const room = await readLiveRoom()
        const liveMsg = room.messages.find((m) => m.id === ownId)
        if (
          !liveMsg ||
          (liveMsg.username || "").toLowerCase() !== account.username.toLowerCase()
        ) {
          return NextResponse.json(
            { ok: false, error: "You can only delete your own messages." },
            { status: 403 },
          )
        }
      } else {
        const own = ownId
          ? await db.chatMessage.findUnique({ where: { id: ownId } })
          : null
        if (!own || own.accountId !== account.id) {
          return NextResponse.json(
            { ok: false, error: "You can only delete your own messages." },
            { status: 403 },
          )
        }
      }
    }

    if (!MOD_ACTIONS.has(action)) {
      return NextResponse.json(
        { ok: false, error: `Unknown mod action: ${action}` },
        { status: 400 },
      )
    }

    if (SUPER_ADMIN_ONLY_ACTIONS.has(action) && !isSuperAdmin(account)) {
      return NextResponse.json(
        {
          ok: false,
          error: "That action is restricted to the super-admin.",
        },
        { status: 403 },
      )
    }

    switch (action) {
      case "add_mod": {
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        const target = await resolveTarget(body.targetUsername)
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { role: "moderator" },
        })
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
        })
      }

      case "remove_mod": {
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        if (
          body.targetUsername.trim().replace(/^@+/, "").toLowerCase() ===
          SUPER_ADMIN_USERNAME.toLowerCase()
        ) {
          return NextResponse.json(
            { ok: false, error: "Cannot demote the super-admin." },
            { status: 400 },
          )
        }
        const target = await resolveTarget(body.targetUsername)
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { role: "member" },
        })
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
        })
      }

      case "create_mod": {
        // Create a brand-new moderator account (super-admin only).
        const username = (body.targetUsername || "").trim().toLowerCase()
        const password = body.password || ""
        const displayName = (body.displayName || "").trim() || username
        if (username.length < 3) {
          return NextResponse.json(
            { ok: false, error: "Username must be at least 3 characters." },
            { status: 400 },
          )
        }
        if (password.length < 6) {
          return NextResponse.json(
            { ok: false, error: "Password must be at least 6 characters." },
            { status: 400 },
          )
        }
        const existing = await db.chatAccount.findUnique({
          where: { username },
        })
        if (existing) {
          return NextResponse.json(
            { ok: false, error: "That username already exists." },
            { status: 409 },
          )
        }
        // Lazy-load bcrypt only here to keep cold-start light.
        const bcrypt = (await import("bcryptjs")).default
        const passwordHash = await bcrypt.hash(password, 10)
        const created = await db.chatAccount.create({
          data: {
            username,
            passwordHash,
            displayName,
            role: "moderator",
            coins: 100,
          },
        })
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(created),
        })
      }

      case "mute": {
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        let target = await resolveTarget(body.targetUsername)
        let liveUser = null
        if (!target) {
          // Not a website account — maybe a LIVE-room (git version) user.
          liveUser = await liveFindUser(body.targetUsername)
          if (liveUser) {
            const updated = await liveSetUserFlag(liveUser.username, "muted", true)
            return NextResponse.json({
              ok: true,
              account: {
                id: `live:${liveUser.username.toLowerCase()}`,
                username: liveUser.username.toLowerCase(),
                displayName: updated?.displayName || liveUser.username,
                muted: true,
              },
            })
          }
        }
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        if (isMod(target) && !isSuperAdmin(account)) {
          return NextResponse.json(
            { ok: false, error: "Cannot mute another moderator." },
            { status: 403 },
          )
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { muted: true },
        })
        void kickUser(target.username)
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
        })
      }

      case "unmute": {
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        let target = await resolveTarget(body.targetUsername)
        if (!target) {
          const liveUser = await liveFindUser(body.targetUsername)
          if (liveUser) {
            const updated = await liveSetUserFlag(liveUser.username, "muted", false)
            return NextResponse.json({
              ok: true,
              account: {
                id: `live:${liveUser.username.toLowerCase()}`,
                username: liveUser.username.toLowerCase(),
                displayName: updated?.displayName || liveUser.username,
                muted: false,
              },
            })
          }
        }
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { muted: false },
        })
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
        })
      }

      case "ban": {
        const reason = (body.reason || "").trim()
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        let target = await resolveTarget(body.targetUsername)
        if (!target) {
          // A LIVE-room (git version) user: ban travels in the shared
          // file, live.js enforces it, and the ban purges their messages
          // exactly like a website ban does.
          const liveUser = await liveFindUser(body.targetUsername)
          if (liveUser) {
            await liveSetUserFlag(liveUser.username, "banned", true, reason || undefined, true)
            return NextResponse.json({
              ok: true,
              account: {
                id: `live:${liveUser.username.toLowerCase()}`,
                username: liveUser.username.toLowerCase(),
                displayName: liveUser.displayName || liveUser.username,
                banned: true,
                banReason: reason || "banned by a moderator",
              },
            })
          }
        }
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        if (isMod(target) && !isSuperAdmin(account)) {
          return NextResponse.json(
            { ok: false, error: "Cannot ban another moderator." },
            { status: 403 },
          )
        }
        // The super-admin banning a fellow mod: strip the mod role first so
        // the ban sticks cleanly ("add mod" then "ban" now just works).
        if (isMod(target) && target.role !== "member") {
          await db.chatAccount.update({
            where: { id: target.id },
            data: { role: "member" },
          })
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { banned: true, banReason: reason || null },
        })
        // Drop their live sessions AND their messages — a ban is a purge.
        const purge = await purgeMessagesBy(target.id)
        void kickUser(target.username, purge)
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
          purgedMessages: purge.length,
        })
      }

      case "unban": {
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        let target = await resolveTarget(body.targetUsername)
        if (!target) {
          const liveUser = await liveFindUser(body.targetUsername)
          if (liveUser) {
            const updated = await liveSetUserFlag(liveUser.username, "banned", false)
            return NextResponse.json({
              ok: true,
              account: {
                id: `live:${liveUser.username.toLowerCase()}`,
                username: liveUser.username.toLowerCase(),
                displayName: updated?.displayName || liveUser.username,
                banned: false,
              },
            })
          }
        }
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { banned: false, banReason: null },
        })
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
        })
      }

      case "ip_ban": {
        const reason = (body.reason || "").trim()
        if (!body.targetUsername?.trim()) {
          return NextResponse.json(
            { ok: false, error: "targetUsername is required." },
            { status: 400 },
          )
        }
        const target = await resolveTarget(body.targetUsername)
        if (!target) {
          return NextResponse.json(
            { ok: false, error: "Target user not found." },
            { status: 404 },
          )
        }
        if (isMod(target) && !isSuperAdmin(account)) {
          return NextResponse.json(
            { ok: false, error: "Cannot IP-ban another moderator." },
            { status: 403 },
          )
        }
        // Super-admin IP-banning a fellow mod: strip the role first.
        if (isMod(target) && target.role !== "member") {
          await db.chatAccount.update({
            where: { id: target.id },
            data: { role: "member" },
          })
        }
        const updated = await db.chatAccount.update({
          where: { id: target.id },
          data: { ipBanned: true, banned: true, banReason: reason || null },
        })
        const purge = await purgeMessagesBy(target.id)
        void kickUser(target.username, purge)
        return NextResponse.json({
          ok: true,
          account: toPublicAccount(updated),
          purgedMessages: purge.length,
        })
      }

      case "delete_message": {
        const messageId = (body.messageId || "").trim()
        if (!messageId) {
          return NextResponse.json(
            { ok: false, error: "messageId is required." },
            { status: 400 },
          )
        }
        if (messageId.startsWith("lv-")) {
          // A LIVE-room (git version) message — removed from the shared
          // file; every CDN copy drops it on its next poll and the
          // website chat drops it on its next /api/chat-live merge.
          const removed = await liveDeleteMessage(messageId).catch(() => false)
          if (!removed) {
            return NextResponse.json(
              { ok: false, error: "Message not found (it may already be gone)." },
              { status: 404 },
            )
          }
          return NextResponse.json({ ok: true, deletedId: messageId, live: true })
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
        await db.chatMessage.delete({ where: { id: messageId } })
        return NextResponse.json({ ok: true, deletedId: messageId })
      }

      default:
        return NextResponse.json(
          { ok: false, error: `Unknown action: ${action}` },
          { status: 400 },
        )
    }
  } catch (err) {
    console.error("[chat-mod POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error processing moderation action." },
      { status: 500 },
    )
  }
}
