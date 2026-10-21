import { db } from "@/lib/db"
import fs from "node:fs"
import { netOwnedIds, SHOP_CATALOG } from "@/lib/veil/shop"

// The last good pre-suspension backup, extracted from git history
const BACKUP = JSON.parse(fs.readFileSync("/tmp/at-0259.json", "utf8"))

async function main() {
  const liveAccounts = await db.chatAccount.findMany()
  const byName = new Map(liveAccounts.map(a => [a.username, a]))

  // net shop ownership in the BACKUP (per username)
  const backupOwned = new Map<string, Map<string, number>>() // username -> itemId -> net
  for (const t of BACKUP.coinTxs as { fromId: string; toId: string; reason: string; amount: number }[]) {
    const purchase = t.reason.startsWith("shop_purchase:")
    const refund = t.reason.startsWith("shop_refund:")
    if (!purchase && !refund) continue
    const id = t.reason.slice(t.reason.split(":")[0].length + 1)
    // resolve username via backup accounts
    const acc = (BACKUP.accounts as { id: string; username: string }[]).find(a => a.id === t.fromId)
    if (!acc) continue
    const m = backupOwned.get(acc.username) ?? new Map()
    m.set(id, (m.get(id) ?? 0) + (purchase ? 1 : -1))
    backupOwned.set(acc.username, m)
  }

  console.log("=== backup shop ownership (net>0) vs LIVE ===")
  for (const [username, items] of backupOwned) {
    const live = byName.get(username)
    if (!live) { console.log(`  ${username}: NOT LIVE (skip)`); continue }
    const liveLedger = await netOwnedIds(db, live.id) // ledger-only
    const equipped = new Set<string>()
    if (live.tag || live.pfpAccessory) {
      for (const it of SHOP_CATALOG) {
        if (it.type === "tag" && live.tag && it.tagText === live.tag) equipped.add(it.id)
        if (it.type === "accessory" && live.pfpAccessory && it.accessory === live.pfpAccessory) equipped.add(it.id)
      }
    }
    for (const [itemId, net] of items) {
      if (net <= 0) continue
      const still = liveLedger.has(itemId) || equipped.has(itemId)
      const item = SHOP_CATALOG.find(i => i.id === itemId)
      console.log(`  ${username}: ${itemId} (${item?.label}) net=${net} -> ${still ? "OK (owned/equipped)" : "LOST"}`)
    }
  }

  console.log("\n=== staff balances: backup(02:59) vs live ===")
  for (const username of ["Veil", "123qwe", "canadianspy", "spiffyboss5111", "The Canadian Spy"]) {
    const b = (BACKUP.accounts as { username: string; coins: number; tag: string | null; pfpAccessory: string | null }[]).find(a => a.username === username)
    const live = byName.get(username)
    console.log(`  ${username}: backup=${b?.coins} (tag=${b?.tag}, pfp=${b?.pfpAccessory}) | live=${live?.coins} (tag=${live?.tag}, pfp=${live?.pfpAccessory})`)
  }
}
main().finally(() => db.$disconnect())
