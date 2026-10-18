/**
 * One-shot recovery merge (owner request 2026-10-18: "bring back the
 * messages and accounts at all costs").
 *
 * The platform rollback on 2026-10-18 reverted db/custom.db to the Oct-2-era
 * seed, orphaning the community that lived until 2026-10-17 19:23 — 56
 * accounts / 87 messages / 3 DMs, all snapshotted in
 * backups/chat/history/chat-2026-10-17-19-23-15.json.
 *
 * The stock restoreChatBackup() matches accounts by exact lowercase
 * username, but the two DB lineages spell names differently
 * ("Canadian Spy" vs "canadianspy") — that would duplicate accounts.
 * This script merges on a normalized username key instead:
 *
 *   - matched accounts keep their live row/id (messages from both
 *     lineages land on one account) and get REFRESHED from the backup
 *     (its state is newer: coins, streaks, bio, decorations)
 *   - unmatched backup accounts are recreated with their ORIGINAL ids and
 *     password hashes (bcrypt only) so everyone can log straight back in
 *   - messages dedupe by id AND by (author, content, minute) so the
 *     overlapping early messages don't double-post
 *   - DMs / memberships / friends / reactions restored idempotently
 *
 * Run: node scripts/restore-merge.cjs [backup.json]
 */
const { PrismaClient } = require("@prisma/client")
const fs = require("fs")
const crypto = require("crypto")

const db = new PrismaClient()
const BACKUP =
  process.argv[2] || "backups/chat/history/chat-2026-10-17-19-23-15.json"

const normKey = (u) => (u || "").toLowerCase().replace(/[^a-z0-9]/g, "")
const isBcrypt = (h) =>
  typeof h === "string" && /^\$2[aby]\$\d{2}\$.{40,}$/.test(h)

async function main() {
  const backup = JSON.parse(fs.readFileSync(BACKUP, "utf8"))
  console.log(
    `[merge] backup: ${backup.counts.accounts} acc / ${backup.counts.messages} msg / ${backup.counts.dms} dms (${backup.exportedAt})`,
  )

  const existing = await db.chatAccount.findMany()
  const byNorm = new Map(existing.map((a) => [normKey(a.username), a]))
  const byId = new Map(existing.map((a) => [a.id, a]))
  const idMap = new Map() // backup account id -> live row id
  let refreshed = 0
  let created = 0

  // ---- pass 1: accounts ---------------------------------------------------
  for (const a of backup.accounts) {
    if (!a.username || typeof a.username !== "string") continue
    const live = byNorm.get(normKey(a.username))
    if (live) {
      idMap.set(a.id, live.id)
      await db.chatAccount
        .update({
          where: { id: live.id },
          data: {
            displayName: a.displayName || live.displayName,
            avatarColor: a.avatarColor || live.avatarColor,
            avatarImage:
              typeof a.avatarImage === "string" ? a.avatarImage : live.avatarImage,
            bio: typeof a.bio === "string" ? a.bio.slice(0, 500) : live.bio,
            muted: !!a.muted,
            banned: !!a.banned,
            coins: Number.isFinite(a.coins)
              ? Math.max(0, Math.floor(a.coins))
              : live.coins,
            tag: a.tag ?? live.tag,
            tagColor: a.tagColor ?? live.tagColor,
            pfpAccessory: a.pfpAccessory ?? live.pfpAccessory,
            ...(a.pfpOverlay !== undefined ? { pfpOverlay: a.pfpOverlay ?? null } : {}),
            ...(typeof a.dailyRewardStreak === "number" && Number.isFinite(a.dailyRewardStreak)
              ? { dailyRewardStreak: Math.max(0, Math.floor(a.dailyRewardStreak)) }
              : {}),
            ...(typeof a.lastRewardClaim === "string" && a.lastRewardClaim
              ? { lastRewardClaim: new Date(a.lastRewardClaim) }
              : {}),
            // The backup lineage is NEWER (Oct 17 vs Oct 2 seed) — adopt its
            // password when it's a real bcrypt hash; never downgrade a live
            // real password to a !legacy: placeholder.
            ...(isBcrypt(a.passwordHash) ? { passwordHash: a.passwordHash } : {}),
            ...(isBcrypt(a.passwordHash) ? { legacy: false } : {}),
          },
        })
        .catch((e) => console.log(`[merge] refresh fail ${a.username}: ${e.message}`))
      refreshed++
      continue
    }
    let newId = a.id
    if (!newId || byId.has(newId))
      newId = "legacy-" + crypto.randomUUID().slice(0, 12)
    const restoredHash = isBcrypt(a.passwordHash) ? a.passwordHash : null
    const acc = await db.chatAccount
      .create({
        data: {
          id: newId,
          username: a.username,
          passwordHash:
            restoredHash ?? "!legacy:" + crypto.randomUUID().replace(/-/g, ""),
          displayName: a.displayName || a.username,
          avatarColor: a.avatarColor || "#2980b9",
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
          lastRewardClaim: a.lastRewardClaim ? new Date(a.lastRewardClaim) : null,
          legacy: restoredHash ? false : true,
          createdAt: a.createdAt ? new Date(a.createdAt) : new Date(),
        },
      })
      .catch((e) => {
        console.log(`[merge] create fail ${a.username}: ${e.message}`)
        return null
      })
    if (acc) {
      byId.set(newId, acc)
      byNorm.set(normKey(a.username), acc)
      idMap.set(a.id, newId)
      created++
    }
  }

  // ---- pass 2: messages ----------------------------------------------------
  const curMsgs = await db.chatMessage.findMany()
  const idSet = new Set(curMsgs.map((m) => m.id))
  const contentSet = new Set(
    curMsgs.map(
      (m) =>
        m.accountId + "|" + m.content + "|" + m.createdAt.toISOString().slice(0, 16),
    ),
  )
  let imported = 0
  let skipped = 0
  for (const m of backup.messages) {
    if (!m?.id || !m.content || typeof m.content !== "string") {
      skipped++
      continue
    }
    const accountId = idMap.get(m.accountId)
    if (!accountId) {
      skipped++
      console.log(`[merge] no author for ${m.id} (${m.accountId})`)
      continue
    }
    const ck = accountId + "|" + m.content + "|" + String(m.createdAt || "").slice(0, 16)
    if (idSet.has(m.id) || contentSet.has(ck)) {
      skipped++
      continue
    }
    await db.chatMessage
      .create({
        data: {
          id: m.id,
          channelId:
            typeof m.channelId === "string" && m.channelId ? m.channelId : "main",
          accountId,
          content: m.content.slice(0, 4000),
          replyTo: m.replyTo ?? null,
          replyToContent: m.replyToContent ? m.replyToContent.slice(0, 400) : null,
          replyToUsername: m.replyToUsername ?? null,
          createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
          editedAt: m.editedAt ? new Date(m.editedAt) : null,
        },
      })
      .catch(() => {
        skipped++
      })
    idSet.add(m.id)
    contentSet.add(ck)
    imported++
  }

  // ---- pass 3: DMs / members / friends / reactions -------------------------
  let dms = 0
  let members = 0
  let friends = 0
  let reactions = 0
  for (const d of backup.dms ?? []) {
    if (!d?.id) continue
    const live = await db.chatDM.findUnique({ where: { id: d.id } }).catch(() => null)
    if (!live) {
      await db.chatDM
        .create({
          data: {
            id: d.id,
            name: d.name ?? null,
            isGroup: !!d.isGroup,
            ownerId: d.ownerId ? (idMap.get(d.ownerId) ?? null) : null,
            createdAt: d.createdAt ? new Date(d.createdAt) : new Date(),
          },
        })
        .catch(() => null)
      dms++
    }
  }
  for (const mm of backup.dmMembers ?? []) {
    const dmId = mm?.dmId
    const accountId = mm?.accountId ? idMap.get(mm.accountId) : undefined
    if (!dmId || !accountId) continue
    await db.dMMember
      .create({ data: { dmId, accountId } })
      .catch(() => {})
    members++
  }
  for (const f of backup.friends ?? []) {
    const accountId = f?.accountId ? idMap.get(f.accountId) : undefined
    const friendId = f?.friendId ? idMap.get(f.friendId) : undefined
    if (!accountId || !friendId) continue
    await db.chatFriend
      .create({ data: { accountId, friendId } })
      .catch(() => {})
    friends++
  }
  for (const r of backup.reactions ?? []) {
    const accountId = r?.accountId ? idMap.get(r.accountId) : undefined
    if (!r?.messageId || !accountId || typeof r.emoji !== "string" || !r.emoji) continue
    await db.chatReaction
      .create({ data: { messageId: r.messageId, accountId, emoji: r.emoji } })
      .catch(() => {})
    reactions++
  }

  const finalCounts = {
    accounts: await db.chatAccount.count(),
    messages: await db.chatMessage.count(),
    dms: await db.chatDM.count(),
  }
  console.log(
    JSON.stringify(
      { refreshed, created, imported, skipped, dms, members, friends, reactions, finalCounts },
      null,
      2,
    ),
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
