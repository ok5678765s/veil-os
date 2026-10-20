import { db } from "../src/lib/db"
import {
  SHOP_CATALOG,
  equippedOwnedIds,
  netOwnedIds,
} from "../src/lib/veil/shop"

/**
 * One-time repair for the 2026-10-20 ledger wipe ("it keeps erasing my
 * items across devices").
 *
 * Platform rollbacks repeatedly reverted the live SQLite file, and the
 * chat backup format (pre-v1.3) never carried coinTransaction rows — so
 * the shop purchase ledger emptied while accounts kept their EQUIPPED
 * tag/accessory fields. The runtime guard in src/lib/veil/shop.ts
 * (equipped ⇒ owned) already puts worn items back in every locker, but
 * the ledger itself stays holey until it is backfilled: a player who
 * takes the item OFF would lose it again (only the ledger counts once
 * nothing is worn).
 *
 * This script backfills a `shop_purchase:<id>` row for every item an
 * account is currently wearing but has no net ledger ownership of.
 * Idempotent — re-running skips rows that already exist.
 *
 *   bun scripts/repair-shop-ledger.ts
 */
async function main(): Promise<void> {
  const accounts = await db.chatAccount.findMany({
    select: {
      id: true,
      username: true,
      tag: true,
      tagColor: true,
      pfpAccessory: true,
    },
  })
  let repaired = 0
  for (const a of accounts) {
    const equipped = equippedOwnedIds(a.tag, a.pfpAccessory)
    if (equipped.size === 0) continue
    /* ledger-only view — deliberately NOT passing the equipped union so
     * we can see exactly which worn items lack a purchase row */
    const ledgerOwned = await netOwnedIds(db, a.id)
    for (const id of equipped) {
      if (ledgerOwned.has(id)) continue
      const item = SHOP_CATALOG.find((i) => i.id === id)
      if (!item) continue
      await db.coinTransaction.create({
        data: {
          fromId: a.id,
          toId: a.id,
          amount: item.price,
          reason: `shop_purchase:${item.id}`,
        },
      })
      repaired++
      console.log(
        `repaired ${a.username}: ${item.label} (${item.id}, ${item.price} 🪙)`,
      )
    }
  }
  console.log(`done — ${repaired} ledger row(s) backfilled`)
  process.exit(0)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
