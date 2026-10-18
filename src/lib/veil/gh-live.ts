/**
 * Veil — GitHub live-room bridge.
 *
 * The static-site copies of Veil OS (jsDelivr mirrors + Vercel deploy) run
 * their #general chat out of a JSON file on the `presence` git branch of
 * ok5678765s/veil-os (site/data/chat-live.json) instead of Prisma. This
 * module is the two-way bridge for the real app:
 *
 *   reads  — readLiveRoom()/listLiveRoom() fetch the shared room so the app
 *            can show static-site messages + accounts in its own #general.
 *   writes — mirrorAppMessage()/heartbeatAppUser() push app-originated
 *            messages + presence back into the shared room (src:"app") so
 *            static-site users see them.
 *
 * Field-name note: the room's native writers (site/assets/live.js) use
 * { username, content, displayName, avatarColor } while the bridge spec
 * describes { user, text, name, color }. Every read accepts BOTH shapes and
 * every write emits BOTH shapes — unknown fields round-trip cleanly through
 * the static site's cleanState(), which never strips extras.
 */

import { readFileSync } from "fs"
import path from "path"

const GH_OWNER = "ok5678765s"
const GH_REPO = "veil-os"
const GH_BRANCH = "presence"
const ROOM_PATH = "site/data/chat-live.json"

const CDN_URL = `https://cdn.jsdelivr.net/gh/${GH_OWNER}/${GH_REPO}@${GH_BRANCH}/${ROOM_PATH}`
const RAW_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${ROOM_PATH}`
const API_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${ROOM_PATH}`
const PURGE_URL = `https://purge.jsdelivr.net/gh/${GH_OWNER}/${GH_REPO}@${GH_BRANCH}/${ROOM_PATH}`

/** Read timeout — the bridge must never hang a chat request. */
const READ_TIMEOUT_MS = 6000
/** Conflict retries for the read-modify-PUT loop (409 = someone wrote first). */
const WRITE_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 400
/** Message cap — matches the static site's CFG.maxMessages. */
const MAX_MESSAGES = 250

/* Site-wide presence — the shared "N online" state the static copies
 * (site/assets/live.js) and this app both heartbeat into. Same side branch
 * as the room, so presence writes never touch main. */
const PRESENCE_PATH = "site/data/presence.json"
const PRESENCE_CDN_URL = `https://cdn.jsdelivr.net/gh/${GH_OWNER}/${GH_REPO}@${GH_BRANCH}/${PRESENCE_PATH}`
const PRESENCE_RAW_URL = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${PRESENCE_PATH}`
const PRESENCE_API_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${PRESENCE_PATH}`
const PRESENCE_PURGE_URL = `https://purge.jsdelivr.net/gh/${GH_OWNER}/${GH_REPO}@${GH_BRANCH}/${PRESENCE_PATH}`
/** Freshness window — the static sites' os.js uses the same 4 minutes. */
const PRESENCE_WINDOW_MS = 4 * 60 * 1000
/** Prune horizon for writes (window + 1 min, like live.js). */
const PRESENCE_PRUNE_MS = PRESENCE_WINDOW_MS + 60_000
/** Visitors cap — matches the static writer. */
const PRESENCE_CAP = 250
/** In-memory heartbeat throttle — the static writer uses 55s. */
const PRESENCE_THROTTLE_MS = 55_000
/** Read cache for presence.json — the app pill polls every ~15s. */
const PRESENCE_CACHE_MS = 15_000

// ---------------------------------------------------------------------------
// Types — tolerant of both field-name conventions.
// ---------------------------------------------------------------------------

export type LiveRoomUser = {
  /** original-case username (static writers store it inside the entry) */
  username?: string
  displayName?: string
  /** spec-shape alias for displayName */
  name?: string
  avatarColor?: string
  /** spec-shape alias for avatarColor */
  color?: string
  /** sha256 password hash — static-site credentials, never written by us */
  pw?: string
  createdAt?: string
  lastSeen?: string
  role?: string
  /** set by the app's mod actions — banned authors' lines are hidden */
  banned?: boolean
  bannedAt?: string
  /** "app" marks entries mirrored from the real app (us) */
  src?: string
}

export type LiveRoomMessage = {
  id: string
  /** lowercase username (room convention) */
  username?: string
  /** spec-shape alias (original case) */
  user?: string
  content?: string
  /** spec-shape alias for content */
  text?: string
  color?: string
  createdAt?: string
  /** set when the author edited the line on the static site */
  editedAt?: string
  /** "app" marks messages mirrored from the real app (us) */
  src?: string
}

export type LiveRoom = {
  users: Record<string, LiveRoomUser>
  messages: LiveRoomMessage[]
}

/* site/data/presence.json on the `presence` branch — written by the static
 * copies (live.js) AND this app (writePresenceVisitor), read by everyone's
 * "N online" pill. { veil, version, visitors: { id: {lastSeen,user,host} } } */
export type PresenceVisitor = {
  lastSeen?: string
  user?: string | null
  host?: string
}

export type PresenceFile = {
  veil?: string
  version?: number
  visitors: Record<string, PresenceVisitor>
}

function emptyPresence(): PresenceFile {
  return { veil: "presence", version: 1, visitors: {} }
}

function cleanPresence(data: unknown): PresenceFile {
  if (!data || typeof data !== "object") return emptyPresence()
  const raw = data as { visitors?: unknown }
  if (!raw.visitors || typeof raw.visitors !== "object" || Array.isArray(raw.visitors)) {
    return emptyPresence()
  }
  const visitors: Record<string, PresenceVisitor> = {}
  for (const [key, value] of Object.entries(raw.visitors as Record<string, unknown>)) {
    if (value && typeof value === "object") visitors[key] = value as PresenceVisitor
  }
  return { ...(data as PresenceFile), visitors }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function cleanRoom(data: unknown): LiveRoom {
  if (!data || typeof data !== "object") return { users: {}, messages: [] }
  const raw = data as { users?: unknown; messages?: unknown }
  const users: Record<string, LiveRoomUser> = {}
  if (raw.users && typeof raw.users === "object" && !Array.isArray(raw.users)) {
    for (const [key, value] of Object.entries(
      raw.users as Record<string, unknown>,
    )) {
      if (value && typeof value === "object") users[key] = value as LiveRoomUser
    }
  }
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter(
        (m): m is LiveRoomMessage =>
          !!m && typeof m === "object" && typeof (m as LiveRoomMessage).id === "string",
      )
    : []
  return { users, messages }
}

/** Resolve a message author's display fields across both naming shapes. */
export function liveUserOf(room: LiveRoom, username: string): LiveRoomUser | null {
  if (!username) return null
  const direct =
    room.users[username] ||
    room.users[username.toLowerCase()] ||
    null
  if (direct) return direct
  // Case-insensitive scan — message usernames are lowercase by convention,
  // but older entries may be keyed differently.
  const want = username.toLowerCase()
  for (const [key, value] of Object.entries(room.users)) {
    if (key.toLowerCase() === want) return value
  }
  return null
}

/** Author username of a room message (either field shape). */
export function liveMessageUser(m: LiveRoomMessage): string {
  return String(m.username || m.user || "user")
}

/** Text of a room message (either field shape). */
export function liveMessageText(m: LiveRoomMessage): string {
  return String(m.content ?? m.text ?? "")
}

/** Edit timestamp of a room message, or null when it was never edited. */
export function liveMessageEdited(m: LiveRoomMessage): string | null {
  return typeof m.editedAt === "string" && m.editedAt ? m.editedAt : null
}

// ---------------------------------------------------------------------------
// Token — NEVER hardcoded, NEVER committed. env var or tmp/gh-token.txt
// (gitignored). Reads fall back so a rotated token file is picked up live.
// ---------------------------------------------------------------------------

let cachedToken: string | null = null

export function tokenForWrites(): string {
  if (cachedToken) return cachedToken
  const fromEnv = (process.env.VEIL_GH_TOKEN || "").trim()
  if (fromEnv) {
    cachedToken = fromEnv
    return fromEnv
  }
  try {
    const fromFile = readFileSync(
      path.join(process.cwd(), "tmp", "gh-token.txt"),
      "utf-8",
    ).trim()
    if (fromFile) {
      cachedToken = fromFile
      return fromFile
    }
  } catch {
    /* no token file — mirror writes disabled, reads keep working */
  }
  return ""
}

// ---------------------------------------------------------------------------
// Reads — CDN first (fast, unmetered), raw.githubusercontent fallback.
// ---------------------------------------------------------------------------

export async function readLiveRoom(): Promise<LiveRoom> {
  try {
    const res = await fetch(`${CDN_URL}?t=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    if (res.ok) return cleanRoom(await res.json())
  } catch {
    /* CDN cold/stale — fall through to raw */
  }
  const res = await fetch(`${RAW_URL}?t=${Date.now()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`gh-live: room read failed (${res.status})`)
  return cleanRoom(await res.json())
}

/**
 * Same as readLiveRoom, but messages with src:"app" are filtered OUT —
 * those originated here and already live in Prisma, so re-injecting them
 * into the merged #general list would duplicate every app-side line.
 */
export async function listLiveRoom(): Promise<LiveRoom> {
  const room = await readLiveRoom()
  return withoutAppMessages(room)
}

function withoutAppMessages(room: LiveRoom): LiveRoom {
  return {
    users: room.users,
    messages: room.messages.filter((m) => m.src !== "app"),
  }
}

/* Source-of-truth lane for the bridge GET: raw.githubusercontent is always
 * fresh, while the CDN copy can lag minutes when purge.jsdelivr.net is
 * rate-limited (this box's backup loop purges hundreds of paths, and the
 * static sites hit the same wall — they reconcile via the API every ~60s,
 * cdn-10 FIX E). We keep a short-lived raw cache so the 15s client poll
 * stays cheap, and fall back to the plain CDN-first read when raw is
 * unreachable. readLiveRoom() above stays the spec-shaped CDN-first read
 * for direct callers. */
const RAW_CACHE_MS = 20_000
let rawCache: { at: number; room: LiveRoom } | null = null
let rawInflight: Promise<LiveRoom> | null = null

async function fetchRawRoom(): Promise<LiveRoom> {
  const res = await fetch(`${RAW_URL}?t=${Date.now()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`gh-live: raw read failed (${res.status})`)
  return cleanRoom(await res.json())
}

/* Always-fresh read lane: the GitHub Contents API. Both CDN lanes lag —
 * raw.githubusercontent is Fastly-cached for up to 300s and jsDelivr's
 * purge is rate-limited under load — so after a write whose effect the
 * app must see quickly (mod actions), the room is marked "hot" and
 * freshRoom() reads API-first for a few minutes. Needs the write token;
 * unauthenticated callers simply stay on the raw lane. */
async function fetchApiRoom(): Promise<LiveRoom> {
  const token = tokenForWrites()
  if (!token) throw new Error("gh-live: no write token")
  const res = await fetch(`${API_URL}?t=${Date.now()}&ref=${GH_BRANCH}`, {
    cache: "no-store",
    headers: authHeaders(token),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`gh-live: api read failed (${res.status})`)
  const info = (await res.json()) as {
    content?: string
    encoding?: string
  }
  const decoded =
    info.encoding === "base64" && info.content
      ? Buffer.from(info.content.replace(/\s/g, ""), "base64").toString("utf-8")
      : info.content || ""
  return cleanRoom(JSON.parse(decoded))
}

let roomHotUntil = 0

/** Mark the room "hot" — for the next `ms` (default 6 min, covering the
 *  raw lane's 300s cache) bridge reads prefer the always-fresh API lane. */
export function markRoomHot(ms = 6 * 60_000): void {
  roomHotUntil = Date.now() + ms
}

async function freshRoom(): Promise<LiveRoom> {
  const hot = Date.now() < roomHotUntil
  const ttl = hot ? 5_000 : RAW_CACHE_MS
  if (rawCache && Date.now() - rawCache.at < ttl) return rawCache.room
  if (!rawInflight) {
    const read = hot && tokenForWrites() ? fetchApiRoom() : fetchRawRoom()
    rawInflight = read
      .then((room) => {
        rawCache = { at: Date.now(), room }
        return room
      })
      .finally(() => {
        rawInflight = null
      })
  }
  try {
    return await rawInflight
  } catch {
    /* preferred lane unreachable — plain CDN-first read (CDN, then raw) */
    return readLiveRoom()
  }
}

/** Fresh room for the bridge GET — raw-primary with a 20s cache, CDN
 *  fallback, app-originated messages filtered out. */
export async function listLiveRoomFresh(): Promise<LiveRoom> {
  return withoutAppMessages(await freshRoom())
}

// ---------------------------------------------------------------------------
// Writes — conflict-safe read-modify-PUT through the GitHub Contents API,
// for any JSON file on the side branch (chat room, site presence).
// ---------------------------------------------------------------------------

/** Everything the generic writer needs about one branch file. */
type GhJsonFile = {
  apiUrl: string
  purgeUrl: string
}

const ROOM_FILE: GhJsonFile = { apiUrl: API_URL, purgeUrl: PURGE_URL }
const PRESENCE_FILE: GhJsonFile = {
  apiUrl: PRESENCE_API_URL,
  purgeUrl: PRESENCE_PURGE_URL,
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

async function purgeCdn(purgeUrl: string): Promise<void> {
  try {
    const res = await fetch(purgeUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return
    /* purge.jsdelivr.net rate-limits bursts: a throttled purge does nothing,
     * but the body says when the window resets (SECONDS) — retry once when
     * that is close enough to be worth it. Long resets are skipped: the
     * write has already landed and the CDN copy expires on its own. */
    const info = (await res.json().catch(() => null)) as {
      paths?: Record<string, { throttled?: boolean; throttlingReset?: number }>
    } | null
    const own = info?.paths?.[new URL(purgeUrl).pathname]
    const resetMs =
      typeof own?.throttlingReset === "number"
        ? own.throttlingReset * 1000
        : null
    if (own?.throttled && resetMs !== null && resetMs <= 5000) {
      await new Promise((r) => setTimeout(r, resetMs + 150))
      await fetch(purgeUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
  } catch {
    /* purge is best-effort — the CDN copy expires on its own anyway */
  }
}

/* Coalesced purge queue per file (mirrors live.js): the first purge fires
 * after a short debounce, and anything written inside the following 2.5s
 * window joins ONE trailing call — a purge per chat message starves
 * purge.jsdelivr.net's rate limit. Writers await their own segment, and
 * every segment's git write has already landed before it is scheduled, so
 * each purge always refreshes a complete state. The room and presence
 * files purge on independent queues so one can't delay the other. */
const purgeQueues = new Map<
  string,
  { lastAt: number; chain: Promise<void> }
>()

function flushPurge(purgeUrl: string): Promise<void> {
  let queue = purgeQueues.get(purgeUrl)
  if (!queue) {
    queue = { lastAt: 0, chain: Promise.resolve() }
    purgeQueues.set(purgeUrl, queue)
  }
  const state = queue
  const delay = Math.max(0, state.lastAt + 2500 - Date.now())
  state.chain = state.chain.then(async () => {
    await new Promise((r) => setTimeout(r, delay))
    await purgeCdn(purgeUrl)
    state.lastAt = Date.now()
  })
  return state.chain
}

/**
 * Generic conflict-safe write for one JSON file on the `presence` branch:
 * read (API, 404 = fresh file) → mutate → finalize (cap/prune) → PUT with
 * the sha, retrying the whole loop on 409. `parse` must be tolerant — an
 * undecodable file starts from `empty()` rather than failing the write.
 */
async function writeGhJson<T>(
  file: GhJsonFile,
  empty: () => T,
  parse: (text: string) => T,
  finalize: (state: T) => T,
  mutator: (state: T) => void,
): Promise<void> {
  const token = tokenForWrites()
  if (!token) {
    throw new Error("gh-live: no write token (VEIL_GH_TOKEN or tmp/gh-token.txt)")
  }

  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    // Fresh state every attempt — a 409 means someone else's write won.
    let sha: string | undefined
    let state = empty()
    const getRes = await fetch(`${file.apiUrl}?t=${Date.now()}&ref=${GH_BRANCH}`, {
      cache: "no-store",
      headers: authHeaders(token),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    if (getRes.status === 404) {
      /* no file yet — the PUT below creates it */
    } else if (!getRes.ok) {
      throw new Error(`gh-live: read-for-write failed (${getRes.status})`)
    } else {
      const info = (await getRes.json()) as {
        sha?: string
        content?: string
        encoding?: string
      }
      sha = info.sha
      try {
        const decoded =
          info.encoding === "base64" && info.content
            ? Buffer.from(info.content.replace(/\s/g, ""), "base64").toString("utf-8")
            : info.content || ""
        state = parse(decoded)
      } catch {
        /* undecodable file — start from an empty one rather than failing */
      }
    }

    mutator(state)
    state = finalize(state)

    const putRes = await fetch(file.apiUrl, {
      method: "PUT",
      cache: "no-store",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "live-chat: bridge",
        content: Buffer.from(JSON.stringify(state), "utf-8").toString("base64"),
        ...(sha ? { sha } : {}),
        branch: GH_BRANCH,
      }),
    })

    if (putRes.status === 409 && attempt < WRITE_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS))
      continue
    }
    if (!putRes.ok) {
      throw new Error(`gh-live: write failed (${putRes.status})`)
    }

    // Fresh CDN copy for every reader (static sites poll the CDN lane) —
    // coalesced so bursts of writes share one purge.
    await flushPurge(file.purgeUrl)
    return
  }
}

export async function writeLiveRoom(
  mutator: (room: LiveRoom) => void,
): Promise<void> {
  await writeGhJson(
    ROOM_FILE,
    () => ({ users: {}, messages: [] }),
    (text) => cleanRoom(JSON.parse(text)),
    (room) => {
      room.messages = room.messages.slice(-MAX_MESSAGES)
      return room
    },
    mutator,
  )
}

// ---------------------------------------------------------------------------
// App → room mirroring
// ---------------------------------------------------------------------------

/** Upsert the app user into the room's roster (both field shapes; pw and
 *  createdAt from a pre-existing entry are always preserved). */
function upsertAppUser(
  room: LiveRoom,
  username: string,
  displayName: string,
  color: string,
  now: string,
): void {
  const key = username.toLowerCase()
  const existing = room.users[key]
  room.users[key] = {
    ...existing,
    username: existing?.username || username,
    displayName: displayName || username,
    name: displayName || username,
    avatarColor: color,
    color,
    createdAt: existing?.createdAt || now,
    lastSeen: now,
    role: existing?.role || "member",
    src: "app",
  }
}

/**
 * Mirror a #general message sent from the real app into the shared GitHub
 * room so the static-site copies render it. Idempotent per message id
 * (send retries / replayed requests never duplicate lines).
 */
export async function mirrorAppMessage(input: {
  id: string
  username: string
  displayName: string
  color: string
  text: string
}): Promise<void> {
  const now = new Date().toISOString()
  const lower = input.username.toLowerCase()
  await writeLiveRoom((room) => {
    const mid = `app-${input.id}`
    if (room.messages.some((m) => m.id === mid)) return
    room.messages.push({
      id: mid,
      username: lower,
      user: input.username,
      content: input.text,
      text: input.text,
      color: input.color,
      createdAt: now,
      src: "app",
    })
    upsertAppUser(room, input.username, input.displayName, input.color, now)
  })
}

/**
 * Presence heartbeat: keeps the app user visible in the static-site rosters
 * (fresh lastSeen). Touches only name/color/lastSeen of the user entry.
 */
export async function heartbeatAppUser(input: {
  username: string
  displayName: string
  color: string
}): Promise<void> {
  const now = new Date().toISOString()
  await writeLiveRoom((room) => {
    upsertAppUser(room, input.username, input.displayName, input.color, now)
  })
}

// ---------------------------------------------------------------------------
// Site-wide presence — ONE shared "N online" number for the static GitHub
// versions and this app (site/data/presence.json on the `presence` branch).
// Semantics mirror the static writers (site/assets/live.js + os.js): 4-minute
// freshness window, ~60s heartbeat throttle, prune > 5 min, cap 250, dedupe
// the count by `user` when set else the visitor id.
// ---------------------------------------------------------------------------

let presenceCache: { at: number; file: PresenceFile } | null = null
let presenceInflight: Promise<PresenceFile> | null = null
let presenceEtag: string | null = null

/** Read presence.json — API-first (the git ref IS the source of truth;
 * a conditional GET makes repeat reads a free 304, so the pill's poll
 * never dents the token's rate limit), then raw.githubusercontent, then
 * the CDN edge (which can serve a minutes-stale purge-lagged copy).
 * 15s in-memory cache, tolerant parse. Throws only when every lane
 * fails, so callers can fall back to their own local count. */
export async function readPresence(): Promise<PresenceFile> {
  if (presenceCache && Date.now() - presenceCache.at < PRESENCE_CACHE_MS) {
    return presenceCache.file
  }
  if (!presenceInflight) {
    presenceInflight = (async () => {
      const token = tokenForWrites()
      if (token) {
        try {
          const headers: Record<string, string> = authHeaders(token)
          if (presenceEtag) headers["If-None-Match"] = presenceEtag
          const res = await fetch(
            `${PRESENCE_API_URL}?t=${Date.now()}&ref=${GH_BRANCH}`,
            { headers, cache: "no-store", signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
          )
          if (res.status === 304 && presenceCache) return presenceCache.file
          if (res.ok) {
            const info = (await res.json()) as {
              content?: string
              encoding?: string
            }
            presenceEtag = res.headers.get("etag")
            const text =
              info.encoding === "base64" && info.content
                ? Buffer.from(info.content.replace(/\s/g, ""), "base64").toString("utf-8")
                : info.content || ""
            return cleanPresence(JSON.parse(text))
          }
        } catch {
          /* API lane failed — fall through to raw */
        }
      }
      try {
        const res = await fetch(`${PRESENCE_RAW_URL}?t=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        })
        if (res.ok) return cleanPresence(await res.json())
      } catch {
        /* raw failed — try the CDN edge */
      }
      const res = await fetch(`${PRESENCE_CDN_URL}?t=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`gh-live: presence read failed (${res.status})`)
      return cleanPresence(await res.json())
    })()
      .then((file) => {
        presenceCache = { at: Date.now(), file }
        return file
      })
      .finally(() => {
        presenceInflight = null
      })
  }
  return presenceInflight
}

/** Last-write throttle state per visitor id (skip beats < 55s apart). */
const presenceWriteAt = new Map<string, number>()

/**
 * Heartbeat one app visitor into the shared presence file — conflict-safe
 * upsert of `visitors[id]` with host "app", pruning entries older than 5
 * minutes and capping at 250 (newest first), exactly like the static writer.
 * The same id is throttled in-memory to one write per ~55s (the app's page
 * heartbeat runs every 15s; presence.json only needs the slower cadence).
 */
export async function writePresenceVisitor(input: {
  id: string
  user: string | null
}): Promise<void> {
  const id = input.id.trim()
  if (!id) return
  const last = presenceWriteAt.get(id) || 0
  if (Date.now() - last < PRESENCE_THROTTLE_MS) return
  presenceWriteAt.set(id, Date.now())

  const now = new Date().toISOString()
  const user = input.user ? input.user.trim().toLowerCase() || null : null
  await writeGhJson(
    PRESENCE_FILE,
    emptyPresence,
    (text) => cleanPresence(JSON.parse(text)),
    (file) => {
      // Prune expired + cap, newest first — same semantics as live.js
      // (our just-upserted entry is the newest, so it always survives).
      const entries = Object.entries(file.visitors).sort(
        (a, b) => seenAt(b[1]) - seenAt(a[1]),
      )
      const keep: Record<string, PresenceVisitor> = {}
      for (let i = 0; i < entries.length && i < PRESENCE_CAP; i++) {
        const [key, visitor] = entries[i]
        const t = seenAt(visitor)
        if (isFinite(t) && Date.now() - t > PRESENCE_PRUNE_MS) continue
        keep[key] = visitor
      }
      file.visitors = keep
      return file
    },
    (file) => {
      file.visitors[id] = { lastSeen: now, user, host: "app" }
    },
  )
}

function seenAt(v: PresenceVisitor): number {
  const t = v?.lastSeen ? new Date(v.lastSeen).getTime() : NaN
  return isFinite(t) ? t : 0
}

/** Host bucket for a presence entry — the same split the static pill's
 *  tooltip shows (jsDelivr mirrors, the Vercel deploy, this app, others). */
function presenceHostBucket(host: string): "jsDelivr" | "Vercel" | "app" | "elsewhere" {
  if (host === "app") return "app"
  if (/(^|\.)jsdelivr\.net$/.test(host)) return "jsDelivr"
  if (/(^|\.)vercel\.app$/.test(host)) return "Vercel"
  return "elsewhere"
}

/**
 * The unified online count: fresh presence.json visitors (lastSeen within
 * 4 minutes), deduped by `user` when set else the visitor id — the same
 * identity space the static sites' pill counts, so both sides render the
 * same number. `byHost` buckets the fresh visitors per platform.
 */
export async function countPresence(): Promise<{
  count: number
  byHost: Record<string, number>
}> {
  const file = await readPresence()
  const now = Date.now()
  const ids = new Set<string>()
  const byHost: Record<string, number> = {}
  for (const [id, v] of Object.entries(file.visitors)) {
    const t = seenAt(v)
    if (now - t >= PRESENCE_WINDOW_MS) continue
    const user = typeof v.user === "string" && v.user ? v.user : null
    ids.add(user || id)
    const bucket = presenceHostBucket(String(v.host || ""))
    byHost[bucket] = (byHost[bucket] || 0) + 1
  }
  return { count: ids.size, byHost }
}
