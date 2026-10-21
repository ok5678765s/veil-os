import { db } from "@/lib/db"

async function main() {
  const veil = await db.chatAccount.findUnique({ where: { username: "Veil" } })
  if (!veil) { console.log("NO VEIL ACCOUNT"); return }
  const GRANT_TS = new Date("2026-10-20T23:34:46.616Z")

  const txs = await db.coinTransaction.findMany({
    where: { OR: [{ fromId: veil.id }, { toId: veil.id }], createdAt: { gt: GRANT_TS } },
    orderBy: { createdAt: "asc" },
  })
  console.log(`txs since staff_grant: ${txs.length}`)
  console.log(`first: ${txs[0]?.createdAt.toISOString()} ${txs[0]?.reason} ${txs[0]?.amount}`)
  console.log(`last:  ${txs.at(-1)?.createdAt.toISOString()} ${txs.at(-1)?.reason} ${txs.at(-1)?.amount}`)

  // net coin movement: for self-transfers (from=to=Veil), wins credit, losses debit.
  // Reconstruct balance by convention: balance starts 200178 after grant.
  let bal = 200_178
  let casinoStake = 0, casinoPayout = 0, shopSpend = 0, shopBack = 0
  for (const t of txs) {
    const r = t.reason
    if (r.endsWith("_win") || r.endsWith("_reward") || r === "glitch_refund" || r === "staff_grant" || r === "blackjack_refund") { bal += t.amount; casinoPayout += r.includes("shop") ? 0 : t.amount }
    else if (r.endsWith("_loss") || r.endsWith("_forfeit")) { bal -= t.amount; casinoStake += t.amount }
    else if (r.startsWith("shop_purchase")) { bal -= t.amount; shopSpend += t.amount }
    else if (r.startsWith("shop_refund")) { bal += t.amount; shopBack += t.amount }
    else { console.log("UNCLASSIFIED", r, t.amount) }
  }
  console.log(`\nreconstructed final balance: ${bal} (actual: ${veil.coins})`)
  console.log(`casino staked: ${casinoStake}, casino payouts: ${casinoPayout}, net casino: ${casinoPayout - casinoStake}`)
  console.log(`shop spent: ${shopSpend}, shop refunded back: ${shopBack}`)

  // any transfers OUT to other accounts?
  const outbound = txs.filter(t => t.fromId === veil.id && t.toId !== veil.id)
  console.log(`\ntransfers to OTHER accounts: ${outbound.length}`)
  for (const t of outbound) console.log(`  ${t.createdAt.toISOString()} -> ${t.toId} ${t.amount} ${t.reason}`)

  // shop rows detail since grant
  const shop = txs.filter(t => t.reason.startsWith("shop_"))
  console.log(`\nshop rows since grant:`)
  for (const t of shop) console.log(`  ${t.createdAt.toISOString()} ${t.reason} ${t.amount}`)
}
main().finally(() => db.$disconnect())
