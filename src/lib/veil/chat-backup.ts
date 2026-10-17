import { createHash, randomUUID } from "crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "fs"
import { db } from "../db"

/**
 * Veil Chat — backup / restore engine ("jsDelivr links" idea, 2026-10-03).
 *
 * WHY: the sandbox rolled back and every chat account + message was lost
 * twice. Chat data now gets continuously exported to JSON snapshots under
 * backups/chat/ which are committed to the public GitHub repo
 * (ok5678765s/veil-os) — and therefore permanently reachable
 * through the jsDelivr CDN:
 *
 *   https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/backups/chat/latest.json
 *
 * If the box is wiped again, the owner restores from that link (chat header
 * → Backup panel, or POST /api/chat-backup {action:"restore"}) and the whole
 * community comes back. Password hashes are deliberately NOT exported —
 * restored accounts become "legacy" placeholders that hold the username +
 * messages; the original owner simply registers the name again and the
 * account is upgraded in place, claiming every restored message.
 */

export const BACKUP_REPO = "ok5678765s/veil-os"
export const BACKUP_DIR = "/home/z/my-project/backups/chat"
export const BACKUP_HISTORY_DIR = BACKUP_DIR + "/history"
export const BACKUP_STATE_FILE = BACKUP_DIR + "/.state.json"
export const JSDELIVR_LATEST = `https://cdn.jsdelivr.net/gh/${BACKUP_REPO}@main/backups/chat/latest.json`
export const JSDELIVR_PURGE = `https://purge.jsdelivr.net/gh/${BACKUP_REPO}@main/backups/chat/latest.json`

/* The CDN front stubs (index.html at the repo root, plus the site/, cdn/
 * and m1..m10/ copies that keep every previously-shared public link
 * alive) are served by the same jsDelivr repo. They only change on real
 * deploys, so they are NOT part of the per-message purge rotation — they
 * get purged explicitly on site updates (purgeJSDelivrAll). */
export const SITE_FILES = [
  "index.html",
  "cdn/index.html",
  "site/index.html",
  "m1/index.html",
  "m2/index.html",
  "m3/index.html",
  "m4/index.html",
  "m5/index.html",
  "m6/index.html",
  "m7/index.html",
  "m8/index.html",
  "m9/index.html",
  "m10/index.html",
  "m1/index.xhtml",
  "m2/index.xhtml",
  "m3/index.xhtml",
  "m4/index.xhtml",
  "m5/index.xhtml",
  "m6/index.xhtml",
  "m7/index.xhtml",
  "m8/index.xhtml",
  "m9/index.xhtml",
  "m10/index.xhtml",
  "backups/chat/latest.json",
  "backups/chat/manifest.json",
] as const

export const JSDELIVR_PURGE_URLS: string[] = SITE_FILES.map(
  (f) => `https://purge.jsdelivr.net/gh/${BACKUP_REPO}@main/${f}`,
)

/* jsDelivr THROTTLES purges per path once they get frequent (a chat
 * write every minute or two is enough). Purging all 56 surfaces on
 * every changed message earned a repo-wide throttle and the CDN edge
 * then serves STALE chat data for up to an hour — the exact "messages
 * don't show up without a restart" bug. The loop now purges ONLY the
 * files that actually change with chat content; the pages ride their
 * natural TTL and get purged explicitly on real site updates. */
const JSDELIVR_DATA_PURGE_URLS: string[] = [
  "backups/chat/latest.json",
  "backups/chat/manifest.json",
].map((f) => `https://purge.jsdelivr.net/gh/${BACKUP_REPO}@main/${f}`)

/** Purge every mirror surface on the jsDelivr edge. Never throws —
 * cache purging is an optimization; the branch cache expires by itself. */
export async function purgeJSDelivrAll(): Promise<string[]> {
  const purged: string[] = []
  await Promise.all(
    JSDELIVR_PURGE_URLS.map(async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (r.ok) purged.push(url)
      } catch {
        /* ignore individual purge failures */
      }
    }),
  )
  return purged
}

/** The loop's slim purge — just the chat-data files (see note above). */
export async function purgeJSDelivrData(): Promise<string[]> {
  const purged: string[] = []
  await Promise.all(
    JSDELIVR_DATA_PURGE_URLS.map(async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
        if (r.ok) purged.push(url)
      } catch {
        /* ignore individual purge failures */
      }
    }),
  )
  return purged
}

const HISTORY_KEEP = 100

/* jsDelivr (and only jsDelivr) hosts a restore URL may come from. */
const ALLOWED_RESTORE_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "gcore.jsdelivr.net",
  "testingcf.jsdelivr.net",
])

/** Mirrors the register route's palette so restored members look native. */
const RESTORE_AVATAR_COLORS = [
  "#f97316", "#e67e22", "#16a085", "#2980b9", "#8e44ad", "#c0392b",
  "#27ae60", "#f39c12", "#1abc9c", "#9b59b6", "#e84393", "#2c3e50",
]
function restoreAvatarColor(username: string): string {
  const h = createHash("sha256").update(username.toLowerCase()).digest()
  return RESTORE_AVATAR_COLORS[h[0] % RESTORE_AVATAR_COLORS.length]
}

/** A password hash no real password can ever produce — bcrypt.compare()
 * always fails, so legacy placeholders can never be logged into. */
function unmatchableHash(): string {
  return "!legacy:" + randomUUID().replace(/-/g, "")
}

// ---------------------------------------------------------------------------
// Backup format
// ---------------------------------------------------------------------------

export type ChatBackupAccount = {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  bio: string
  role: string
  muted: boolean
  banned: boolean
  coins: number
  tag: string | null
  tagColor: string | null
  pfpAccessory: string | null
  /* v1.2 — economy + decoration state (optional so pre-streak backups
   * still parse; the streak fields were the "streak doesn't work" bug:
   * every rollback re-seeded accounts with the streak silently wiped). */
  pfpOverlay?: string | null
  dailyRewardStreak?: number
  lastRewardClaim?: string | null
  legacy: boolean
  createdAt: string
  /** bcrypt hash — carried so a restore keeps the account LOGGABLE with
   * the same password (user-requested: usernames + passwords must survive
   * a reset, otherwise someone else could register the name first) */
  passwordHash?: string | null
}

export type ChatBackupMessage = {
  id: string
  channelId: string
  accountId: string
  content: string
  replyTo: string | null
  replyToContent: string | null
  replyToUsername: string | null
  createdAt: string
  editedAt?: string | null
}

export type ChatBackupV1 = {
  veil: "chat-backup"
  version: 1
  exportedAt: string
  note?: string
  counts: { accounts: number; messages: number; dms: number }
  accounts: ChatBackupAccount[]
  messages: ChatBackupMessage[]
  dms: { id: string; name: string | null; isGroup: boolean; ownerId: string | null; createdAt: string }[]
  dmMembers: { dmId: string; accountId: string }[]
  friends: { accountId: string; friendId: string; createdAt: string }[]
  /* v1.1 — emoji reactions (optional so pre-reaction backups still parse) */
  reactions?: { messageId: string; accountId: string; emoji: string }[]
}

export function isChatBackup(data: unknown): data is ChatBackupV1 {
  const d = data as ChatBackupV1 | null
  return !!d &&
    typeof d === "object" &&
    (d as { veil?: unknown }).veil === "chat-backup" &&
    Array.isArray((d as { accounts?: unknown }).accounts) &&
    Array.isArray((d as { messages?: unknown }).messages)
}

// ---------------------------------------------------------------------------
// Collect (DB → backup object)
// ---------------------------------------------------------------------------

export async function collectChatBackup(): Promise<ChatBackupV1> {
  const [accounts, messages, dms, dmMembers, friends, reactions] = await Promise.all([
    db.chatAccount.findMany({ orderBy: { createdAt: "asc" } }),
    db.chatMessage.findMany({ orderBy: { createdAt: "asc" } }),
    db.chatDM.findMany({ orderBy: { createdAt: "asc" } }),
    db.dMMember.findMany(),
    db.chatFriend.findMany(),
    db.chatReaction.findMany(),
  ])
  return {
    veil: "chat-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { accounts: accounts.length, messages: messages.length, dms: dms.length },
    accounts: accounts.map((a) => ({
      id: a.id,
      username: a.username,
      displayName: a.displayName || a.username,
      avatarColor: a.avatarColor,
      avatarImage: a.avatarImage,
      bio: a.bio,
      role: a.role,
      muted: a.muted,
      banned: a.banned,
      coins: a.coins,
      tag: a.tag,
      tagColor: a.tagColor,
      pfpAccessory: a.pfpAccessory,
      pfpOverlay: a.pfpOverlay,
      dailyRewardStreak: a.dailyRewardStreak,
      lastRewardClaim: a.lastRewardClaim ? a.lastRewardClaim.toISOString() : null,
      legacy: a.legacy,
      createdAt: a.createdAt.toISOString(),
      passwordHash: a.passwordHash,
    })),
    messages: messages.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      accountId: m.accountId,
      content: m.content,
      replyTo: m.replyTo,
      replyToContent: m.replyToContent,
      replyToUsername: m.replyToUsername,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    })),
    dms: dms.map((d) => ({
      id: d.id,
      name: d.name,
      isGroup: d.isGroup,
      ownerId: d.ownerId,
      createdAt: d.createdAt.toISOString(),
    })),
    dmMembers: dmMembers.map((m) => ({ dmId: m.dmId, accountId: m.accountId })),
    friends: friends.map((f) => ({
      accountId: f.accountId,
      friendId: f.friendId,
      createdAt: f.createdAt.toISOString(),
    })),
    reactions: reactions.map((r) => ({
      messageId: r.messageId,
      accountId: r.accountId,
      emoji: r.emoji,
    })),
  }
}

/** Cheap change fingerprint — used by the backup loop to skip no-op runs. */
export async function backupSignature(): Promise<string> {
  const [msgCount, accCount, dmCount, reactCount, lastMsg] = await Promise.all([
    db.chatMessage.count(),
    db.chatAccount.count(),
    db.chatDM.count(),
    db.chatReaction.count(),
    db.chatMessage.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } }),
  ])
  return [msgCount, accCount, dmCount, reactCount, lastMsg ? `${lastMsg.id}@${lastMsg.createdAt.getTime()}` : "-"].join("|")
}

// ---------------------------------------------------------------------------
// Write snapshots (latest + history + manifest)
// ---------------------------------------------------------------------------

export function writeBackupFiles(backup: ChatBackupV1): { latestPath: string; historyPath: string } {
  mkdirSync(BACKUP_HISTORY_DIR, { recursive: true })
  const json = JSON.stringify(backup, null, 2)
  const latestPath = `${BACKUP_DIR}/latest.json`
  writeFileSync(latestPath, json + "\n")
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)
  const historyPath = `${BACKUP_HISTORY_DIR}/chat-${stamp}.json`
  writeFileSync(historyPath, json + "\n")
  // Prune old history snapshots (keep the newest HISTORY_KEEP).
  const olds = readdirSync(BACKUP_HISTORY_DIR)
    .filter((f) => /^chat-.*\.json$/.test(f))
    .sort()
  for (const f of olds.slice(0, Math.max(0, olds.length - HISTORY_KEEP))) {
    try { rmSync(`${BACKUP_HISTORY_DIR}/${f}`) } catch { /* best effort */ }
  }
  writeFileSync(
    `${BACKUP_DIR}/manifest.json`,
    JSON.stringify(
      {
        latestWrittenAt: backup.exportedAt,
        sha256: createHash("sha256").update(json).digest("hex"),
        counts: backup.counts,
        jsdelivr: JSDELIVR_LATEST,
      },
      null,
      2,
    ) + "\n",
  )
  return { latestPath, historyPath }
}

// ---------------------------------------------------------------------------
// Restore (backup object → DB), idempotent
// ---------------------------------------------------------------------------

export type RestoreResult = {
  ok: boolean
  error?: string
  accountsCreated: number
  accountsMapped: number
  messagesImported: number
  messagesSkipped: number
  dmsRestored: number
  friendsRestored: number
  reactionsRestored: number
  restoredFrom?: string
}

export async function restoreChatBackup(
  data: unknown,
  opts: { restoredFrom?: string } = {},
): Promise<RestoreResult> {
  const res: RestoreResult = {
    ok: false,
    accountsCreated: 0,
    accountsMapped: 0,
    messagesImported: 0,
    messagesSkipped: 0,
    dmsRestored: 0,
    friendsRestored: 0,
    reactionsRestored: 0,
    restoredFrom: opts.restoredFrom,
  }
  if (!isChatBackup(data)) {
    res.error = "Not a Veil chat backup (expected veil:\"chat-backup\")."
    return res
  }

  // ---- pass 1: accounts → map backup ids onto live rows ------------------
  const existing = await db.chatAccount.findMany()
  const byName = new Map(existing.map((a) => [a.username.toLowerCase(), a]))
  const byId = new Map(existing.map((a) => [a.id, a]))
  const idMap = new Map<string, string>()

  for (const a of data.accounts) {
    if (!a.username || typeof a.username !== "string") continue
    const live = byName.get(a.username.toLowerCase())
    if (live) {
      idMap.set(a.id, live.id)
      res.accountsMapped++
      /* Refresh the row from the backup. The dominant restore case is a
       * platform rollback: the db file reverted to an older moment while
       * the committed backup (written seconds before the rollback) is
       * NEWER — without this refresh, coins / streaks / purchases snap
       * back to the rollback point. Fields the backup omits (pre-v1.2
       * files) are left untouched so old backups still restore cleanly. */
      await db.chatAccount
        .update({
          where: { id: live.id },
          data: {
            displayName: a.displayName || a.username,
            avatarColor: a.avatarColor || live.avatarColor,
            avatarImage: typeof a.avatarImage === "string" ? a.avatarImage : live.avatarImage,
            bio: typeof a.bio === "string" ? a.bio.slice(0, 500) : live.bio,
            muted: !!a.muted,
            banned: !!a.banned,
            coins: Number.isFinite(a.coins) ? Math.max(0, Math.floor(a.coins)) : live.coins,
            tag: a.tag ?? null,
            tagColor: a.tagColor ?? null,
            pfpAccessory: a.pfpAccessory ?? null,
            ...(a.pfpOverlay !== undefined ? { pfpOverlay: a.pfpOverlay ?? null } : {}),
            ...(typeof a.dailyRewardStreak === "number" && Number.isFinite(a.dailyRewardStreak)
              ? { dailyRewardStreak: Math.max(0, Math.floor(a.dailyRewardStreak)) }
              : {}),
            ...(typeof a.lastRewardClaim === "string"
              ? { lastRewardClaim: safeDate(a.lastRewardClaim) ?? null }
              : {}),
          },
        })
        .catch(() => {
          /* row raced away — the create path below won't run either */
        })
      continue
    }
    /* Restore the ORIGINAL password hash when the backup carries one —
     * the user logs back in with the same credentials and nobody can
     * steal the name by registering first. Only bcrypt-style hashes are
     * accepted; anything else falls back to the unmatchable placeholder
     * (old backups, tampered files). */
    const restoredHash =
      typeof a.passwordHash === "string" && /^\$2[aby]\$\d{2}\$.{40,}$/ .test(a.passwordHash)
        ? a.passwordHash
        : null
    // Recreate as a legacy placeholder. Keep the original id when it is free
    // (stable re-imports); otherwise mint one.
    let newId = a.id
    if (!newId || byId.has(newId)) newId = `legacy-${randomUUID().slice(0, 12)}`
    await db.chatAccount.create({
      data: {
        id: newId,
        username: a.username,
        passwordHash: restoredHash ?? unmatchableHash(),
        displayName: a.displayName || a.username,
        avatarColor: a.avatarColor || restoreAvatarColor(a.username),
        avatarImage: typeof a.avatarImage === "string" ? a.avatarImage : null,
        bio: typeof a.bio === "string" ? a.bio.slice(0, 500) : "",
        role: ["member", "moderator", "admin"].includes(a.role) ? a.role : "member",
        muted: !!a.muted,
        banned: !!a.banned,
        coins: Number.isFinite(a.coins) ? Math.max(0, Math.floor(a.coins)) : 100,
        tag: a.tag ?? null,
        tagColor: a.tagColor ?? null,
        pfpAccessory: a.pfpAccessory ?? null,
        pfpOverlay: a.pfpOverlay ?? null,
        dailyRewardStreak:
          typeof a.dailyRewardStreak === "number" && Number.isFinite(a.dailyRewardStreak)
            ? Math.max(0, Math.floor(a.dailyRewardStreak))
            : 0,
        lastRewardClaim: safeDate(a.lastRewardClaim ?? undefined) ?? null,
        /* A restored password = a REAL, loggable account (not a free
         * name) — legacy stays false so the login route accepts it. */
        legacy: restoredHash ? false : true,
        createdAt: safeDate(a.createdAt) ?? new Date(),
      },
    })
    byId.set(newId, { id: newId } as (typeof existing)[number])
    idMap.set(a.id, newId)
    res.accountsCreated++
  }

  // ---- pass 2: DM containers + memberships -------------------------------
  for (const d of data.dms ?? []) {
    if (!d?.id) continue
    const live = await db.chatDM.findUnique({ where: { id: d.id } })
    if (!live) {
      await db.chatDM.create({
        data: {
          id: d.id,
          name: d.name ?? null,
          isGroup: !!d.isGroup,
          ownerId: d.ownerId ? (idMap.get(d.ownerId) ?? null) : null,
          createdAt: safeDate(d.createdAt) ?? new Date(),
        },
      }).catch(() => null)
      res.dmsRestored++
    }
  }
  for (const m of data.dmMembers ?? []) {
    const dmId = m?.dmId
    const accountId = m?.accountId ? idMap.get(m.accountId) : undefined
    if (!dmId || !accountId) continue
    await db.dMMember
      .create({ data: { dmId, accountId } })
      .catch(() => { /* unique (dmId, accountId) — already there */ })
  }
  for (const f of data.friends ?? []) {
    const accountId = f?.accountId ? idMap.get(f.accountId) : undefined
    const friendId = f?.friendId ? idMap.get(f.friendId) : undefined
    if (!accountId || !friendId) continue
    await db.chatFriend
      .create({ data: { accountId, friendId } })
      .catch(() => { /* unique — already friends */ })
    res.friendsRestored++
  }

  // ---- pass 3: messages (skip ids that already exist) --------------------
  const msgIds = new Set(
    (await db.chatMessage.findMany({ select: { id: true }, take: 100000 })).map((m) => m.id),
  )
  for (const m of data.messages) {
    if (!m?.id || !m.content || typeof m.content !== "string") { res.messagesSkipped++; continue }
    if (msgIds.has(m.id)) { res.messagesSkipped++; continue }
    const accountId = idMap.get(m.accountId)
    if (!accountId) { res.messagesSkipped++; continue }
    await db.chatMessage
      .create({
        data: {
          id: m.id,
          channelId: typeof m.channelId === "string" && m.channelId ? m.channelId : "main",
          accountId,
          content: m.content.slice(0, 4000),
          replyTo: m.replyTo ?? null,
          replyToContent: m.replyToContent ? m.replyToContent.slice(0, 400) : null,
          replyToUsername: m.replyToUsername ?? null,
          createdAt: safeDate(m.createdAt) ?? new Date(),
          editedAt: safeDate(m.editedAt),
        },
      })
      .catch(() => {
        /* id / constraint clash on a concurrent import — treat as skipped */
        res.messagesSkipped++
        res.messagesImported--
      })
    msgIds.add(m.id)
    res.messagesImported++
  }

  // ---- pass 4: reactions (skip rows that already exist) ------------------
  for (const r of data.reactions ?? []) {
    const accountId = r?.accountId ? idMap.get(r.accountId) : undefined
    if (!r?.messageId || !accountId || typeof r.emoji !== "string" || !r.emoji) continue
    await db.chatReaction
      .create({ data: { messageId: r.messageId, accountId, emoji: r.emoji } })
      .catch(() => {
        /* unique (message, account, emoji) — already restored */
      })
    res.reactionsRestored++
  }

  res.ok = true
  return res
}

function safeDate(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d
}

// ---------------------------------------------------------------------------
// Loaders (local snapshot / jsDelivr CDN)
// ---------------------------------------------------------------------------

export function readLocalBackup(name: string): { data: unknown; restoredFrom: string } | { error: string } {
  if (!/^[\w.-]+\.json$/.test(name) || name.includes("..")) {
    return { error: "Invalid backup file name." }
  }
  // Allowed locations: backups/chat/<name> and backups/chat/history/<name>
  for (const dir of [BACKUP_DIR, BACKUP_HISTORY_DIR, `${BACKUP_DIR}/seeds`]) {
    const p = `${dir}/${name}`
    if (existsSync(p)) {
      try {
        return { data: JSON.parse(readFileSync(p, "utf-8")), restoredFrom: p }
      } catch {
        return { error: "Backup file is not valid JSON." }
      }
    }
  }
  return { error: `No backup named ${name} found.` }
}

export async function fetchJsDelivrBackup(
  url: string = JSDELIVR_LATEST,
): Promise<{ data: unknown; restoredFrom: string } | { error: string }> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { error: "Invalid URL." }
  }
  if (!ALLOWED_RESTORE_HOSTS.has(u.hostname) || !u.pathname.startsWith("/gh/")) {
    return { error: "Only jsDelivr /gh/ URLs are allowed for restores." }
  }
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: "application/json" },
      cache: "no-store",
    })
    if (!r.ok) return { error: `jsDelivr answered ${r.status}.` }
    return { data: await r.json(), restoredFrom: url }
  } catch (e) {
    return { error: `Could not fetch backup: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Backup loop state (.state.json — local only, gitignored)
// ---------------------------------------------------------------------------

export type BackupLoopState = {
  sig: string
  lastRun: string
  lastBackupAt: string | null
  lastPushOk: boolean | null
  lastPushAt: string | null
  lastPushError: string | null
  lastCounts: { accounts: number; messages: number; dms: number } | null
}

export function readBackupState(): BackupLoopState | null {
  try {
    return JSON.parse(readFileSync(BACKUP_STATE_FILE, "utf-8")) as BackupLoopState
  } catch {
    return null
  }
}

export function writeBackupState(s: BackupLoopState): void {
  mkdirSync(BACKUP_DIR, { recursive: true })
  writeFileSync(BACKUP_STATE_FILE, JSON.stringify(s, null, 2) + "\n")
}
