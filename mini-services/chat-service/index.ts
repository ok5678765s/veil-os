import { createServer } from "http"
import { createHmac, timingSafeEqual } from "crypto"
import { readFileSync, statSync } from "fs"
import { Server, Socket } from "socket.io"

/**
 * Veil Chat — real-time WebSocket service.
 *
 * Frontend clients connect via the gateway: `io("/?XTransformPort=3004")`.
 * The Caddy gateway rewrites that to this server (path MUST be "/").
 *
 * AUTH (2026-09 hardening — the "chat leak" fix): `identify` REQUIRES a signed
 * session token minted by /api/chat-auth at login/register. The token is
 * HMAC-SHA256(base64url(payloadJSON), shared secret) and carries the account's
 * identity snapshot; this service verifies the signature + expiry and uses
 * ONLY the payload fields — client-claimed identity is ignored entirely, so
 * a socket can no longer impersonate anyone (including mods/admin). Sockets
 * that never identify successfully cannot subscribe, message, or type.
 *
 * Events handled:
 *   - identify         { token }  (identity comes FROM the token)
 *   - subscribe        { channel } | { channelId }   (presence ON — legacy/git clients)
 *   - unsubscribe      { channel } | { channelId }
 *   - watch            { channel } | { channelId }   (silent — messages only, NO presence)
 *   - unwatch          { channel } | { channelId }
 *   - message          { channel | channelId, content, id?, replyTo?, ... }
 *   - typing           { channel | channelId }
 *   - stop_typing      { channel | channelId }
 *   - message_deleted  { channel | channelId, messageId }
 *   - message_edited   { channel | channelId, messageId, content, editedAt }
 *   - reaction         { channel | channelId, messageId, emoji, added }
 *
 * Events emitted back to clients:
 *   - message, typing, stop_typing, message_deleted, message_edited,
 *     reaction, presence, presence_diff, dm_added, dm_updated, dm_removed
 *
 * "watch" powers the website client's cross-channel unread badges: it
 * joins every channel/DM room WITHOUT registering presence, so the user
 * receives messages everywhere but only appears "present" in the channel
 * they are actually looking at. Legacy clients (git-version copies) keep
 * using subscribe/unsubscribe exactly as before.
 *
 * On identify the socket also joins its private "user:<accountId>" room —
 * the Next.js APIs reach specific users through it (group invites, group
 * updates) via the localhost /emit endpoint below.
 *
 * Persisted messages live in the Next.js Prisma DB (POST /api/chat-data).
 * This service only relays real-time events — but never anonymously.
 */

const PORT = 3004

// Shared with src/lib/chat-auth.ts (same box) — the HMAC signing secret.
// The Next.js side SELF-HEALS a missing key (mints + persists one on first
// use, restoring from the revert-proof spare in upload/veil-kit first), so
// a failed read here is never fatal: we keep the last good secret cached
// and re-check the file whenever its mtime changes (rollback heals + secret
// rotations are picked up live, without a relay restart).
const SECRET_PATH = "/home/z/my-project/db/chat-secret.key"
let cachedSecret: Buffer | null = null
let secretMtimeMs = 0
function sessionSecret(): Buffer | null {
  try {
    const m = statSync(SECRET_PATH).mtimeMs
    if (!cachedSecret || m !== secretMtimeMs) {
      const txt = readFileSync(SECRET_PATH, "utf-8").trim()
      if (txt) {
        cachedSecret = Buffer.from(txt, "utf-8")
        secretMtimeMs = m
      }
      // empty/missing file: KEEP the previous cache — a transient wipe
      // (rollback mid-write, editor save) must not nuke socket auth.
    }
  } catch {
    /* stat/read failed — serve from cache if we have one */
  }
  return cachedSecret
}

interface TokenPayload {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  role: string
  iat: number
  exp: number
}

function verifyToken(token: unknown): TokenPayload | null {
  if (typeof token !== "string" || !token) return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null
  try {
    const secret = sessionSecret()
    if (!secret) return null
    const expected = createHmac("sha256", secret)
      .update(body)
      .digest("base64url")
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"))
    if (!payload || typeof payload.id !== "string" || !payload.id) return null
    if (typeof payload.username !== "string" || !payload.username) return null
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null
    if (typeof payload.displayName !== "string" || !payload.displayName) {
      payload.displayName = payload.username
    }
    if (typeof payload.avatarColor !== "string" || !payload.avatarColor) {
      payload.avatarColor = "#f97316"
    }
    return payload as TokenPayload
  } catch {
    return null
  }
}

// Simple per-socket flood guard: burst 25 messages / 10s window.
const MSG_WINDOW_MS = 10_000
const MSG_BURST = 25

interface AccountSession {
  accountId: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  /** signed role from the token — powers the #announcements gate */
  role: string
}

interface ChannelPresence {
  // socket.id -> AccountSession
  [socketId: string]: AccountSession
}

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path — Caddy uses "/" to route to this service.
  path: "/",
  // Wildcard handshake origin is fine BECAUSE every meaningful event
  // (subscribe/message/typing) now requires a signed session token — an
  // cross-site socket can connect but can neither read nor speak. The
  // offline file build connects from file:// (Origin: "null"), so pinning
  // specific origins would break it.
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// socket.id -> Set<channelId>
const socketChannels = new Map<string, Set<string>>()
// channelId -> Map<socket.id, AccountSession>
const channelPresence = new Map<string, ChannelPresence>()

/* Typing-broadcast throttle (2026-10-19 "whenever i type it freeze"):
 * older chat clients emitted "typing" on EVERY keystroke, and each one
 * was relayed to every other socket in the channel — a keystroke-rate
 * broadcast storm under load. The web client now self-throttles to one
 * emit / 1.2s, and the relay enforces the same floor here (800ms) so
 * stale builds can never re-open the storm. Indicator lifetime on the
 * receiving side is 5s, so an 800ms floor is invisible to users. */
// `${socket.id}:${channelId}` -> last broadcast ms
const typingThrottle = new Map<string, number>()
const TYPING_MIN_INTERVAL_MS = 800

function typingAllowed(key: string): boolean {
  const now = Date.now()
  const last = typingThrottle.get(key) || 0
  if (now - last < TYPING_MIN_INTERVAL_MS) return false
  typingThrottle.set(key, now)
  return true
}

function resolveChannel(payload: { channel?: string; channelId?: string }): string | null {
  const c = payload.channel || payload.channelId
  if (!c || typeof c !== "string") return null
  return c.trim().toLowerCase()
}

function publicPresence(channelId: string) {
  const map = channelPresence.get(channelId)
  if (!map) return []
  return Object.values(map).map((s) => ({
    accountId: s.accountId,
    username: s.username,
    displayName: s.displayName,
    avatarColor: s.avatarColor,
    /* avatarImage deliberately DROPPED (2026-10-20 "laggy when other
     * players join"): it is a multi-KB base64 data URI per user, and the
     * broadcast goes to every client on every join/leave/identify. The
     * client only ever reads accountId from socket presence — avatars
     * render from the members API. */
  }))
}

/* Presence broadcast coalescing (2026-10-20 join-lag fix): a burst of
 * joins/leaves (players arriving together, connect-time identify +
 * subscribe + watch storms) triggers at most ONE presence broadcast per
 * channel per window. Previously every single membership change pushed
 * the full user list to every client immediately. */
const PRESENCE_COALESCE_MS = 300
const presenceDirtyChannels = new Set<string>()
let presenceFlushTimer: ReturnType<typeof setTimeout> | null = null

function broadcastPresence(channelId: string) {
  presenceDirtyChannels.add(channelId)
  if (presenceFlushTimer) return
  presenceFlushTimer = setTimeout(() => {
    presenceFlushTimer = null
    const dirty = [...presenceDirtyChannels]
    presenceDirtyChannels.clear()
    for (const cid of dirty) {
      io.to(cid).emit("presence", {
        channelId: cid,
        users: publicPresence(cid),
      })
    }
  }, PRESENCE_COALESCE_MS)
}

function joinChannel(socket: Socket, channelId: string, account?: AccountSession) {
  socket.join(channelId)
  let set = socketChannels.get(socket.id)
  if (!set) {
    set = new Set()
    socketChannels.set(socket.id, set)
  }
  set.add(channelId)

  if (account) {
    let map = channelPresence.get(channelId)
    if (!map) {
      map = {}
      channelPresence.set(channelId, map)
    }
    map[socket.id] = account
  }
  broadcastPresence(channelId)
}

/* Silent join — the socket receives the room's messages/reactions but is
 * NOT counted as present (no presence broadcast). Used by the website
 * client to watch every channel + DM for unread badges + live DM rows. */
function watchChannel(socket: Socket, channelId: string) {
  socket.join(channelId)
  let set = socketChannels.get(socket.id)
  if (!set) {
    set = new Set()
    socketChannels.set(socket.id, set)
  }
  set.add(channelId)
}

function leaveChannel(socket: Socket, channelId: string) {
  socket.leave(channelId)
  const set = socketChannels.get(socket.id)
  if (set) {
    set.delete(channelId)
    if (set.size === 0) socketChannels.delete(socket.id)
  }
  const map = channelPresence.get(channelId)
  if (map) {
    delete map[socket.id]
    if (Object.keys(map).length === 0) {
      channelPresence.delete(channelId)
    } else {
      broadcastPresence(channelId)
    }
  }
}

io.on("connection", (socket: Socket) => {
  console.log(`[veil-chat] connected: ${socket.id}`)

  // Identity comes ONLY from a verified signed token (set on `identify`).
  let account: AccountSession | undefined
  // Per-socket flood guard state.
  const msgTimestamps: number[] = []

  socket.on("identify", (data: { token?: unknown }) => {
    try {
      // Client-claimed identity fields are IGNORED — only the signed
      // payload's snapshot is trusted.
      const payload = verifyToken(data && (data as { token?: unknown }).token)
      if (!payload) {
        account = undefined
        socket.emit("error", {
          message:
            "identify failed — invalid or expired session. Please sign in again.",
        })
        return
      }
      account = {
        accountId: payload.id,
        username: payload.username,
        displayName: payload.displayName || payload.username,
        avatarColor: payload.avatarColor || "#f97316",
        avatarImage:
          typeof payload.avatarImage === "string" ? payload.avatarImage : null,
        role: typeof payload.role === "string" ? payload.role : "member",
      }
      // Private per-user room — lets the API layer (group invites, group
      // updates, kicks) address THIS user on every socket/tab at once.
      if (account) {
        socket.join("user:" + account.accountId)
      }
      // Update presence for every channel this socket is already in.
      for (const cid of socketChannels.get(socket.id) ?? []) {
        const map = channelPresence.get(cid) ?? {}
        map[socket.id] = account
        channelPresence.set(cid, map)
        broadcastPresence(cid)
      }
      socket.emit("identified", { ok: true })
    } catch (err) {
      console.error("[veil-chat] identify error", err)
      socket.emit("error", { message: "identify failed" })
    }
  })

  socket.on("subscribe", (data: { channel?: string; channelId?: string }) => {
    try {
      // Unauthenticated sockets may not join any channel.
      if (!account) {
        socket.emit("error", { message: "not identified — cannot subscribe" })
        return
      }
      const channelId = resolveChannel(data || {})
      if (!channelId) {
        socket.emit("error", { message: "subscribe requires a channel" })
        return
      }
      joinChannel(socket, channelId, account)
      socket.emit("subscribed", { channelId })
    } catch (err) {
      console.error("[veil-chat] subscribe error", err)
    }
  })

  socket.on("unsubscribe", (data: { channel?: string; channelId?: string }) => {
    try {
      const channelId = resolveChannel(data || {})
      if (!channelId) return
      leaveChannel(socket, channelId)
      socket.emit("unsubscribed", { channelId })
    } catch (err) {
      console.error("[veil-chat] unsubscribe error", err)
    }
  })

  // Silent watch — receive the room's traffic without presence.
  socket.on("watch", (data: { channel?: string; channelId?: string }) => {
    try {
      if (!account) {
        socket.emit("error", { message: "not identified — cannot watch" })
        return
      }
      const channelId = resolveChannel(data || {})
      if (!channelId) {
        socket.emit("error", { message: "watch requires a channel" })
        return
      }
      watchChannel(socket, channelId)
    } catch (err) {
      console.error("[veil-chat] watch error", err)
    }
  })

  socket.on("unwatch", (data: { channel?: string; channelId?: string }) => {
    try {
      if (!account) return
      const channelId = resolveChannel(data || {})
      if (!channelId) return
      // Only leave if the socket isn't PRESENT there (presence implies
      // membership anyway; leaving would break presence-based online lists).
      const map = channelPresence.get(channelId)
      if (map && map[socket.id]) return
      leaveChannel(socket, channelId)
    } catch (err) {
      console.error("[veil-chat] unwatch error", err)
    }
  })

  socket.on("message", (data: {
    channel?: string
    channelId?: string
    id?: string
    content?: string
    replyTo?: string | null
    replyToContent?: string | null
    replyToUsername?: string | null
    [k: string]: unknown
  }) => {
    try {
      // Must be a verified identity to broadcast.
      if (!account) {
        socket.emit("error", { message: "not identified — cannot send" })
        return
      }
      const channelId = resolveChannel(data)
      if (!channelId) {
        socket.emit("error", { message: "message requires a channel" })
        return
      }
      // Must be subscribed to broadcast into a channel.
      const set = socketChannels.get(socket.id)
      if (!set || !set.has(channelId)) {
        socket.emit("error", { message: "not subscribed to channel " + channelId })
        return
      }
      // #links + #announcements — only moderators and the owner may post.
      // The owner is the "Veil" operator (username match, same as the UI's
      // isMod + chat-mod's isSuperAdmin) — role alone is not enough: a wiped
      // db can leave the operator account at role "member", which locked the
      // owner out of the very channels the UI unlocked for them.
      if (
        (channelId === "links" || channelId === "announcements") &&
        account.role !== "moderator" &&
        account.role !== "admin" &&
        account.username.toLowerCase() !== "veil"
      ) {
        socket.emit("error", { message: `only moderators and the owner can post in #${channelId}` })
        return
      }
      // Flood guard: MSG_BURST messages per MSG_WINDOW_MS, then drops.
      const now = Date.now()
      while (msgTimestamps.length && now - msgTimestamps[0] > MSG_WINDOW_MS) {
        msgTimestamps.shift()
      }
      if (msgTimestamps.length >= MSG_BURST) {
        socket.emit("error", { message: "slow down — too many messages" })
        return
      }
      msgTimestamps.push(now)
      const payload = {
        channelId,
        id: data.id || null,
        content: data.content ?? "",
        replyTo: data.replyTo ?? null,
        replyToContent: data.replyToContent ?? null,
        replyToUsername: data.replyToUsername ?? null,
        account: {
          accountId: account.accountId,
          username: account.username,
          displayName: account.displayName,
          avatarColor: account.avatarColor,
          /* avatarImage dropped from the per-message broadcast
           * (2026-10-20 lag fix) — it re-sent the author's multi-KB
           * base64 avatar to every client on EVERY message. The client
           * rehydrates it from its members list (same pattern it
           * already used for role/tag/accessory). */
        },
        ts: Date.now(),
        // NOTE: socket.id is deliberately NOT broadcast — internal session
        // identifiers never leave the relay.
      }
      // Relay to everyone in the channel (including the sender, so clients can
      // confirm delivery & dedupe by id).
      io.to(channelId).emit("message", payload)
    } catch (err) {
      console.error("[veil-chat] message error", err)
    }
  })

  socket.on("typing", (data: { channel?: string; channelId?: string }) => {
    try {
      if (!account) return
      const channelId = resolveChannel(data)
      if (!channelId) return
      const set = socketChannels.get(socket.id)
      if (!set || !set.has(channelId)) return
      if (!typingAllowed(`${socket.id}:${channelId}`)) return
      socket.to(channelId).emit("typing", {
        channelId,
        account: {
          accountId: account.accountId,
          username: account.username,
          displayName: account.displayName,
        },
      })
    } catch (err) {
      console.error("[veil-chat] typing error", err)
    }
  })

  socket.on("stop_typing", (data: { channel?: string; channelId?: string }) => {
    try {
      if (!account) return
      const channelId = resolveChannel(data)
      if (!channelId) return
      const set = socketChannels.get(socket.id)
      if (!set || !set.has(channelId)) return
      socket.to(channelId).emit("stop_typing", {
        channelId,
        account: {
          accountId: account.accountId,
          username: account.username,
          displayName: account.displayName,
        },
      })
    } catch (err) {
      console.error("[veil-chat] stop_typing error", err)
    }
  })

  // A viewer toggled an emoji reaction on a message — relay the change to
  // everyone in the channel so reaction chips update live. The DB write
  // already happened (POST /api/chat-reactions); this is transport only.
  socket.on("reaction", (data: {
    channel?: string
    channelId?: string
    messageId?: string
    emoji?: string
    added?: boolean
  }) => {
    try {
      if (!account) {
        socket.emit("error", { message: "not identified — cannot react" })
        return
      }
      const channelId = resolveChannel(data)
      if (!channelId || !data.messageId || typeof data.emoji !== "string") return
      const set = socketChannels.get(socket.id)
      if (!set || !set.has(channelId)) return
      io.to(channelId).emit("reaction", {
        channelId,
        messageId: data.messageId,
        emoji: data.emoji,
        added: data.added !== false,
        account: {
          accountId: account.accountId,
          username: account.username,
          displayName: account.displayName,
        },
      })
    } catch (err) {
      console.error("[veil-chat] reaction error", err)
    }
  })

  socket.on("message_deleted", (data: {
    channel?: string
    channelId?: string
    messageId?: string
  }) => {
    try {
      if (!account) return
      const channelId = resolveChannel(data)
      if (!channelId || !data.messageId) return
      const set = socketChannels.get(socket.id)
      if (!set || !set.has(channelId)) return
      io.to(channelId).emit("message_deleted", {
        channelId,
        messageId: data.messageId,
      })
    } catch (err) {
      console.error("[veil-chat] message_deleted error", err)
    }
  })

  // An author edited their own message — broadcast the new text + the
  // "(edited)" stamp to everyone in the channel (the editor already
  // patched its own state from the PATCH /api/chat-data response).
  socket.on("message_edited", (data: {
    channel?: string
    channelId?: string
    messageId?: string
    content?: string
    editedAt?: string
  }) => {
    try {
      if (!account) return
      const channelId = resolveChannel(data)
      if (!channelId || !data.messageId || typeof data.content !== "string") return
      const set = socketChannels.get(socket.id)
      if (!set || !set.has(channelId)) return
      io.to(channelId).emit("message_edited", {
        channelId,
        messageId: data.messageId,
        content: data.content,
        editedAt: data.editedAt ?? new Date().toISOString(),
      })
    } catch (err) {
      console.error("[veil-chat] message_edited error", err)
    }
  })

  socket.on("disconnect", () => {
    try {
      const set = socketChannels.get(socket.id)
      if (set) {
        for (const cid of set) {
          leaveChannel(socket, cid)
        }
      }
      socketChannels.delete(socket.id)
      // Drop this socket's typing-throttle entries — socket ids are
      // ephemeral (new one per reconnect) and would otherwise leak.
      for (const key of typingThrottle.keys()) {
        if (key.startsWith(`${socket.id}:`)) typingThrottle.delete(key)
      }
      console.log(`[veil-chat] disconnected: ${socket.id}`)
    } catch (err) {
      console.error("[veil-chat] disconnect error", err)
    }
  })

  socket.on("error", (err: unknown) => {
    console.error(`[veil-chat] socket error (${socket.id})`, err)
  })
})

// ---------------------------------------------------------------------------
// Internal admin endpoint (localhost :3005, shared-secret) — lets the Next.js
// mod API immediately disconnect a banned/muted user's sockets.
// ---------------------------------------------------------------------------

const KICK_PORT = 3005
const KICK_SECRET = "veil-kick-9f3a1c77"

function socketsForUsername(username: string): Socket[] {
  const target = username.trim().toLowerCase()
  const found: Socket[] = []
  for (const [sid, s] of io.sockets.sockets) {
    // The account hint lives in the closure passed to `identify`; recover it
    // from the presence maps instead of reaching into closures.
    for (const map of channelPresence.values()) {
      const session = map[sid]
      if (session && session.username.toLowerCase() === target) {
        found.push(s)
        break
      }
    }
  }
  return found
}

const kickServer = createServer((req, res) => {
  // Two endpoints:
  //   POST /kick  — disconnect a user's sockets (+ optional message purge)
  //   POST /emit  — broadcast an arbitrary event to room(s) from the API
  //                 layer (group invites/updates). Same localhost + secret
  //                 protection as /kick.
  if (req.method !== "POST" || !(req.url?.startsWith("/kick") || req.url?.startsWith("/emit"))) {
    res.statusCode = 404
    res.end()
    return
  }
  // Localhost only + shared secret.
  const remote = req.socket.remoteAddress || ""
  if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(remote)) {
    res.statusCode = 403
    res.end()
    return
  }
  if (req.headers["x-veil-kick-secret"] !== KICK_SECRET) {
    res.statusCode = 403
    res.end()
    return
  }
  let body = ""
  req.on("data", (c: Buffer) => {
    body += c.toString()
    if (body.length > 200_000) req.destroy()
  })
  req.on("end", () => {
    try {
      // /emit — broadcast an event to room(s) on behalf of the API layer.
      // Payload: { rooms: string[], event: string, payload: object }
      // Used by /api/chat-dm (group invites/renames/leaves) so every online
      // member's client refreshes its DM list + the invited user gets a
      // live "you were added" toast. Event names are validated (word chars
      // only) so nothing arbitrary can be smuggled through.
      if (req.url?.startsWith("/emit")) {
        const { rooms, event, payload } = JSON.parse(body || "{}") as {
          rooms?: string[]
          event?: string
          payload?: unknown
        }
        if (
          !Array.isArray(rooms) ||
          rooms.length === 0 ||
          rooms.length > 200 ||
          typeof event !== "string" ||
          !/^[a-z_]{2,32}$/.test(event)
        ) {
          res.statusCode = 400
          res.end(JSON.stringify({ ok: false, error: "rooms[] + event required" }))
          return
        }
        let sent = 0
        for (const room of rooms) {
          if (typeof room !== "string" || !room || room.length > 120) continue
          io.to(room).emit(event, payload ?? {})
          sent++
        }
        console.log(`[veil-chat] emit "${event}" → ${sent} room(s)`)
        res.end(JSON.stringify({ ok: true, sent }))
        return
      }
      // /kick payloads:
      //   { username }                         → kick their sockets
      //   { username, purge: [{channelId, messageId}] }
      //                                       → kick AND broadcast per-message
      //                                         message_deleted events for the
      //                                         banned user's purged messages,
      //                                         so every online client drops
      //                                         them live (no reload needed).
      const { username, purge } = JSON.parse(body || "{}") as {
        username?: string
        purge?: { channelId?: string; messageId?: string }[]
      }
      if (!username) {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: "username required" }))
        return
      }
      const sockets = socketsForUsername(username)
      for (const s of sockets) {
        s.emit("error", { message: "You have been disconnected by a moderator." })
        s.disconnect(true)
      }
      let purged = 0
      if (Array.isArray(purge)) {
        for (const p of purge) {
          if (!p || typeof p.channelId !== "string" || typeof p.messageId !== "string") continue
          io.to(p.channelId).emit("message_deleted", {
            channelId: p.channelId,
            messageId: p.messageId,
          })
          purged++
        }
      }
      console.log(
        `[veil-chat] kicked @${username} (${sockets.length} socket(s))` +
          (purged ? `, purged ${purged} message(s)` : ""),
      )
      res.end(JSON.stringify({ ok: true, kicked: sockets.length, purged }))
    } catch (err) {
      console.error("[veil-chat] kick error", err)
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false }))
    }
  })
})

kickServer.listen(KICK_PORT, "127.0.0.1", () => {
  console.log(`[veil-chat] kick endpoint on 127.0.0.1:${KICK_PORT}`)
})

/* ── PUBLIC PRESENCE POLL (port 3006) ─────────────────────────────────
 *
 * GET /presence                 → { ok, now, channels: { [id]: users[] } }
 * GET /presence?channel=main    → { ok, channel, users: [...] }
 *
 * Why: the website's player tab used to learn online/offline status
 * ONLY from live socket "presence" events — a dropped/blipped socket
 * froze the dots forever ("player tab no update", friends chatting but
 * showing offline). This endpoint lets every client (website chat, the
 * offline single-file build, static mirrors) poll the authoritative
 * presence map on an interval and self-heal. Reachable through the
 * gateway as /presence?XTransformPort=3006 — CORS-open because the
 * offline build calls it from file:// (Origin: null). The data is the
 * same the socket broadcasts to entire rooms — public by design. */
const PRESENCE_PORT = 3006
const presenceServer = createServer((req, res) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }
  if (req.method !== "GET" || !req.url?.startsWith("/presence")) {
    res.writeHead(404, corsHeaders)
    res.end(JSON.stringify({ ok: false, error: "not found" }))
    return
  }
  let channel: string | null = null
  try {
    const u = new URL(req.url, "http://localhost")
    const c = u.searchParams.get("channel")
    if (c && /^[a-z0-9_:.-]{1,120}$/i.test(c)) channel = c.toLowerCase()
  } catch {
    /* no channel filter */
  }
  const now = Date.now()
  if (channel) {
    const users = publicPresence(channel)
    res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders })
    res.end(JSON.stringify({ ok: true, now, channel, users }))
    return
  }
  const channels: Record<string, ReturnType<typeof publicPresence>> = {}
  for (const id of channelPresence.keys()) {
    channels[id] = publicPresence(id)
  }
  res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders })
  res.end(JSON.stringify({ ok: true, now, channels }))
})
presenceServer.listen(PRESENCE_PORT, () => {
  console.log(`[veil-chat] presence poll on port ${PRESENCE_PORT}`)
})

httpServer.listen(PORT, () => {
  console.log(`[veil-chat] WebSocket server running on port ${PORT}`)
})

process.on("SIGTERM", () => {
  console.log("[veil-chat] SIGTERM, shutting down...")
  io.close(() => {
    httpServer.close(() => {
      presenceServer.close(() => process.exit(0))
    })
  })
})

process.on("SIGINT", () => {
  console.log("[veil-chat] SIGINT, shutting down...")
  io.close(() => {
    httpServer.close(() => {
      presenceServer.close(() => process.exit(0))
    })
  })
})
