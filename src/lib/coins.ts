import { db } from "@/lib/db"

/**
 * Veil Coins — the Veil Chat economy helpers.
 *
 * Written for Task 46 from the route usage in the Veil Chat source
 * (the original zip's @/lib/coins was not included):
 *
 *   awardCoins(accountId, amount, reason)   — mint coins to one account
 *   transferCoins(fromId, toId, amount, …)  — atomic account→account move
 *   parseReason(reason)                     — sanitize a caller-supplied
 *                                             reason string
 */

export type CoinReason =
  | "gift"
  | "blackjack_win"
  | "blackjack_loss"
  | "blackjack_forfeit"
  | "coinflip_win"
  | "coinflip_loss"
  | "message_reward"
  | "proxy_reward"
  | "daily_reward"
  | `shop_purchase:${string}`

const KNOWN_REASONS = new Set([
  "gift",
  "blackjack_win",
  "blackjack_loss",
  "blackjack_forfeit",
  "coinflip_win",
  "coinflip_loss",
  "message_reward",
  "proxy_reward",
  "daily_reward",
])

export function parseReason(reason: string | undefined | null): CoinReason {
  const r = (reason || "").trim()
  if (r.startsWith("shop_purchase:")) return r as CoinReason
  if (KNOWN_REASONS.has(r)) return r as CoinReason
  return "gift"
}

/** Mint `amount` coins to `accountId` and record the transaction. */
export async function awardCoins(
  accountId: string,
  amount: number,
  reason: CoinReason,
) {
  const amt = Math.max(0, Math.floor(amount))
  const [tx] = await db.$transaction([
    db.coinTransaction.create({
      data: { fromId: accountId, toId: accountId, amount: amt, reason },
    }),
    db.chatAccount.update({
      where: { id: accountId },
      data: { coins: { increment: amt } },
    }),
  ])
  return tx
}

/**
 * Move `amount` coins from → to atomically. Throws (rejects) when the
 * sender cannot cover the amount — callers map that to a 400.
 */
export async function transferCoins(
  fromId: string,
  toId: string,
  amount: number,
  reason: CoinReason,
) {
  const amt = Math.floor(amount)
  if (amt < 1) throw new Error("Amount must be at least 1 coin.")

  const result = await db.$transaction(async (tx) => {
    const fresh = await tx.chatAccount.findUnique({ where: { id: fromId } })
    if (!fresh) throw new Error("Account not found.")
    if (fresh.coins < amt) throw new Error("Insufficient balance.")

    const created = await tx.coinTransaction.create({
      data: { fromId, toId, amount: amt, reason },
    })
    await tx.chatAccount.update({
      where: { id: fromId },
      data: { coins: { decrement: amt } },
    })
    await tx.chatAccount.update({
      where: { id: toId },
      data: { coins: { increment: amt } },
    })
    return created
  })
  return result
}
