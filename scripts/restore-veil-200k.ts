/**
 * One-time owner restoration (2026-10-20, ~23:06): the owner lost their
 * entire 200,178-coin balance on an all-in blackjack hand right after a
 * planned server restart force-reloaded their client (boot-guard). The
 * hand itself was a legit bust, but the restart + bet-persistence + MAX
 * button made it feel (and function) like a glitch — the owner asked to
 * be made whole. Grants exactly the pre-loss peak balance back, recorded
 * as `glitch_refund`. Idempotent: an existing glitch_refund row skips.
 */
import { db } from "@/lib/db"
import { awardCoins } from "@/lib/coins"

const RESTORE_AMOUNT = 200_178
const USERNAME = "Veil"

async function main() {
  const acct = await db.chatAccount.findUnique({ where: { username: USERNAME } })
  if (!acct) throw new Error(`Account ${USERNAME} not found.`)

  const already = await db.coinTransaction.findFirst({
    where: { toId: acct.id, reason: "glitch_refund" },
  })
  if (already) {
    console.log(`already restored (${already.amount} on ${already.createdAt.toISOString()}) — skipping`)
    return
  }

  await awardCoins(acct.id, RESTORE_AMOUNT, "glitch_refund")
  const after = await db.chatAccount.findUnique({ where: { id: acct.id } })
  console.log(`restored ${RESTORE_AMOUNT} to ${USERNAME}; balance now ${after?.coins}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
