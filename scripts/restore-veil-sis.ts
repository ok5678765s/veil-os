/**
 * One-time owner restoration #3 (2026-10-21, ~03:00): family-member spree
 * round 2. After the 23:34:46 staff_grant (200,178), a 119-transaction
 * gambling spree ran 00:31:37 → 02:26:25 (blackjack + roulette + coinflip,
 * escalating stakes, both shop items refund-liquidated mid-spree for extra
 * chips, final all-in coinflip 5,722) and took the balance to EXACTLY 0.
 * The owner asked for "57k" believing that was the damage — the ledger
 * shows the full balance went, so this restores the complete pre-spree
 * state:
 *
 *   1. Coins: +200,178 as `staff_grant` (0 → 200,178)
 *   2. Fight Logo: compensating `shop_purchase:acc-fight` row (no charge —
 *      the original 1,600 purchase from 22:09 still stands; the spree's
 *      refund is undone by the full coin restore) + re-equip.
 *
 * tag-pro needs NO repair: it was bought AND refunded inside the spree
 * (net 0, and it wasn't owned before the spree).
 *
 * Idempotent: both steps guard on rows created after the final loss
 * (2026-10-21T02:26:25.151Z), so re-running can never double-pay.
 */
import { db } from "@/lib/db"
import { awardCoins } from "@/lib/coins"

const USERNAME = "Veil"
const RESTORE_AMOUNT = 200_178
const LOSS_TS = new Date("2026-10-21T02:26:25.151Z")

async function main() {
  const acct = await db.chatAccount.findUnique({ where: { username: USERNAME } })
  if (!acct) throw new Error(`Account ${USERNAME} not found.`)

  // --- Step 1: coins ---
  const alreadyCoins = await db.coinTransaction.findFirst({
    where: {
      toId: acct.id,
      reason: "staff_grant",
      amount: RESTORE_AMOUNT,
      createdAt: { gte: LOSS_TS },
    },
  })
  if (alreadyCoins) {
    console.log(`coins already restored (${alreadyCoins.createdAt.toISOString()}) — skipping`)
  } else {
    await awardCoins(acct.id, RESTORE_AMOUNT, "staff_grant")
    console.log(`restored ${RESTORE_AMOUNT} coins`)
  }

  // --- Step 2: Fight Logo ownership + equip ---
  const alreadyItem = await db.coinTransaction.findFirst({
    where: {
      fromId: acct.id,
      toId: acct.id,
      reason: "shop_purchase:acc-fight",
      createdAt: { gte: LOSS_TS },
    },
  })
  if (alreadyItem) {
    console.log("acc-fight already re-purchased (ledger) — skipping")
  } else {
    await db.coinTransaction.create({
      data: {
        fromId: acct.id,
        toId: acct.id,
        amount: 1600, // catalog price; bookkeeping row only — no charge
        reason: "shop_purchase:acc-fight",
      },
    })
    await db.chatAccount.update({
      where: { id: acct.id },
      data: { pfpAccessory: "fight" },
    })
    console.log("restored acc-fight ownership + re-equipped")
  }

  const after = await db.chatAccount.findUnique({ where: { id: acct.id } })
  console.log(`\nfinal state: coins=${after?.coins}, pfpAccessory=${after?.pfpAccessory}, tag=${after?.tag}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
