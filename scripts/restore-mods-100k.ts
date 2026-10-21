/**
 * One-time rollback repair (2026-10-21, ~20:00): the box was suspended
 * overnight (last good backup 02:59:45 = git 089b762) and on resume at
 * 12:21 the platform snapshot-restored an older DB — the coin ledger was
 * emptied (earliest live tx 12:29:28), balances reverted to base, and
 * every staff grant from 2026-10-20 21:21:19 (+100,000 to each of the
 * five staff accounts) vanished. The owner: "give all mods 100k it got
 * reverted for all of them". The rollback auto-heal failed to fire
 * because the reverted .state.json lost lastCounts, which gated the
 * whole heal (fixed separately in scripts/chat-backup.ts).
 *
 * This script undoes the incident's damage:
 *   1. COINS: +100,000 `staff_grant` to each of the five original grant
 *      recipients (canadianspy, spiffyboss5111, The Canadian Spy,
 *      123qwe, Veil) — exactly the reverted grant.
 *   2. ITEMS: compensating `shop_purchase:<id>` ledger rows (no charge —
 *      the coins they were bought with were themselves reverted) for
 *      every item owned per the 02:59 backup but unowned in the live
 *      ledger: Veil (tag-pro, tag-mythic, acc-visor, acc-wolf,
 *      acc-sprout, acc-vrhalo, acc-dragon — acc-fight still worn so the
 *      equipped⇒owned guard covered it, but its row is re-added too) and
 *      The Canadian Spy (tag-legend).
 *   3. EQUIP: restores the pre-revert worn state (Veil: Pro User tag +
 *      dragon accessory; The Canadian Spy: Legend tag).
 *
 * Idempotent: grants guard on any post-resume 100k staff_grant row;
 * item rows guard on live net ownership; equip is a plain field write.
 */
import { db } from "@/lib/db"
import { awardCoins } from "@/lib/coins"
import { netOwnedIds, SHOP_CATALOG } from "@/lib/veil/shop"

// Box resume (platform snapshot-restore landed between 12:21 and 12:29).
const RESUME_TS = new Date("2026-10-21T12:21:00Z")
const GRANT = 100_000

const GRANT_USERNAMES = [
  "canadianspy",
  "spiffyboss5111",
  "The Canadian Spy",
  "123qwe",
  "Veil",
]

// Items to re-own (from the 02:59 backup ledger, net ownership > 0).
const ITEM_REPAIRS: { username: string; itemId: string }[] = [
  { username: "Veil", itemId: "tag-pro" },
  { username: "Veil", itemId: "tag-mythic" },
  { username: "Veil", itemId: "acc-visor" },
  { username: "Veil", itemId: "acc-wolf" },
  { username: "Veil", itemId: "acc-sprout" },
  { username: "Veil", itemId: "acc-vrhalo" },
  { username: "Veil", itemId: "acc-dragon" },
  { username: "Veil", itemId: "acc-fight" },
  { username: "The Canadian Spy", itemId: "tag-legend" },
]

// Pre-revert equipped state (from the 02:59 backup account rows).
const EQUIP_RESTORES: {
  username: string
  tag: string
  tagColor: string
  pfpAccessory: string | null
}[] = [
  { username: "Veil", tag: "Pro User", tagColor: "#16a085", pfpAccessory: "dragon" },
  { username: "The Canadian Spy", tag: "Legend", tagColor: "#c0392b", pfpAccessory: null },
]

async function main() {
  // ---- 1. coin grants -----------------------------------------------------
  for (const username of GRANT_USERNAMES) {
    const acct = await db.chatAccount.findUnique({ where: { username } })
    if (!acct) {
      console.log(`GRANT SKIP: ${username} not found`)
      continue
    }
    const already = await db.coinTransaction.findFirst({
      where: {
        toId: acct.id,
        reason: "staff_grant",
        amount: GRANT,
        createdAt: { gte: RESUME_TS },
      },
    })
    if (already) {
      console.log(`GRANT SKIP: ${username} already has ${GRANT} (balance ${acct.coins})`)
      continue
    }
    await awardCoins(acct.id, GRANT, "staff_grant")
    const after = await db.chatAccount.findUnique({ where: { id: acct.id } })
    console.log(`GRANT OK: ${username} +${GRANT} -> balance ${after?.coins}`)
  }

  // ---- 2. item ownership rows ---------------------------------------------
  for (const { username, itemId } of ITEM_REPAIRS) {
    const acct = await db.chatAccount.findUnique({ where: { username } })
    if (!acct) {
      console.log(`ITEM SKIP: ${username} not found`)
      continue
    }
    const owned = await netOwnedIds(db, acct.id, {
      tag: acct.tag,
      pfpAccessory: acct.pfpAccessory,
    })
    if (owned.has(itemId)) {
      console.log(`ITEM SKIP: ${username} already owns ${itemId}`)
      continue
    }
    const item = SHOP_CATALOG.find((i) => i.id === itemId)
    if (!item) {
      console.log(`ITEM SKIP: unknown catalog id ${itemId}`)
      continue
    }
    await db.coinTransaction.create({
      data: {
        fromId: acct.id,
        toId: acct.id,
        amount: item.price, // bookkeeping only — no charge
        reason: `shop_purchase:${item.id}`,
      },
    })
    console.log(`ITEM OK: ${username} re-owned ${item.label} (${item.id})`)
  }

  // ---- 3. equipped state ---------------------------------------------------
  for (const eq of EQUIP_RESTORES) {
    const acct = await db.chatAccount.findUnique({ where: { username: eq.username } })
    if (!acct) continue
    await db.chatAccount.update({
      where: { id: acct.id },
      data: {
        tag: eq.tag,
        tagColor: eq.tagColor,
        pfpAccessory: eq.pfpAccessory,
      },
    })
    console.log(`EQUIP OK: ${eq.username} -> tag="${eq.tag}", pfp=${eq.pfpAccessory ?? "-"}`)
  }

  console.log("\n=== final staff state ===")
  for (const username of GRANT_USERNAMES) {
    const a = await db.chatAccount.findUnique({ where: { username } })
    if (!a) continue
    const owned = await netOwnedIds(db, a.id, { tag: a.tag, pfpAccessory: a.pfpAccessory })
    console.log(
      `${username}: coins=${a.coins} tag=${a.tag ?? "-"} pfp=${a.pfpAccessory ?? "-"} ownedItems=${owned.size}`,
    )
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
