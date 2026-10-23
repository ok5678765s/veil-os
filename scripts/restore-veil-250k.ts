/**
 * Owner-directed grant, 2026-10-22 — "give me 250k no one lossed it i just
 * need it and it snt getting from github when i click restore".
 *
 * Context: Veil's balance is 0 (today's 19:12–20:18 gambling spree burned
 * the restored 100k, items refunded for chips, final blackjack_loss
 * 20,500 @ 20:18:30). The owner then hand-edited the GitHub backup
 * (commit ab787c9 "Update user coins from 0 to 250000") and clicked the
 * mod Restore button — but the jsDelivr edge served the pre-edit cached
 * copy, so nothing landed. This script makes the 250k REAL in the live
 * DB with a proper ledger row (the hand edit carries none), matching the
 * owner's own edited value exactly: 0 + 250,000 = 250,000.
 *
 * Idempotent: skips if a post-loss staff_grant of 250,000 to Veil already
 * exists (re-running never double-pays).
 */
import { db } from "@/lib/db"
import { awardCoins } from "@/lib/coins"

const GRANT_AMOUNT = 250_000
const USERNAME = "Veil"
const LOSS_TS = new Date("2026-10-22T20:18:30.453Z") // final blackjack_loss → 0

async function main() {
  const acct = await db.chatAccount.findUnique({ where: { username: USERNAME } })
  if (!acct) throw new Error(`Account ${USERNAME} not found`)

  const already = await db.coinTransaction.findFirst({
    where: {
      toId: acct.id,
      reason: "staff_grant",
      amount: GRANT_AMOUNT,
      createdAt: { gte: LOSS_TS },
    },
  })
  if (already) {
    console.log(
      `SKIP — post-loss staff_grant of ${GRANT_AMOUNT} already exists @ ${already.createdAt.toISOString()}`,
    )
    console.log(`Current balance: ${acct.coins}`)
    return
  }

  const before = acct.coins
  const bal = await awardCoins(acct.id, GRANT_AMOUNT, "staff_grant")
  console.log(
    `GRANTED +${GRANT_AMOUNT.toLocaleString()} staff_grant to ${USERNAME}: ${before} -> ${bal.coins}`,
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
