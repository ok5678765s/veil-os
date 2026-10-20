/**
 * One-time owner restoration #2 (2026-10-20, ~23:35): the owner's little
 * brother took the account after the 23:19 glitch_refund restore and went
 * all-in twice — 200,178 WIN (→400,356) at 23:31:57, then all-in 400,356
 * LOSS (→0) at 23:32:14. The owner asked to be made whole again for the
 * 200k the brother gambled away. Grants exactly the pre-spree balance
 * (200,178) back, recorded as `staff_grant` (deliberate owner grant, NOT a
 * glitch this time). Idempotent: an existing post-loss staff_grant row of
 * this amount skips, so re-running can never double-pay.
 */
import { db } from "@/lib/db"
import { awardCoins } from "@/lib/coins"

const RESTORE_AMOUNT = 200_178
const USERNAME = "Veil"
// The brother's losing all-in landed at 23:32:14.900Z — anything granted
// after that timestamp is this restoration.
const LOSS_TS = new Date("2026-10-20T23:32:14.900Z")

async function main() {
  const acct = await db.chatAccount.findUnique({ where: { username: USERNAME } })
  if (!acct) throw new Error(`Account ${USERNAME} not found.`)

  const already = await db.coinTransaction.findFirst({
    where: {
      toId: acct.id,
      reason: "staff_grant",
      amount: RESTORE_AMOUNT,
      createdAt: { gte: LOSS_TS },
    },
  })
  if (already) {
    console.log(
      `already restored (${already.amount} on ${already.createdAt.toISOString()}) — skipping`,
    )
    return
  }

  await awardCoins(acct.id, RESTORE_AMOUNT, "staff_grant")
  const after = await db.chatAccount.findUnique({ where: { id: acct.id } })
  console.log(`restored ${RESTORE_AMOUNT} to ${USERNAME}; balance now ${after?.coins}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
