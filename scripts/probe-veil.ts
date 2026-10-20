import { db } from "@/lib/db"

async function main() {
  const veil = await db.chatAccount.findUnique({ where: { username: "Veil" } })
  if (!veil) { console.log("NO VEIL ACCOUNT"); return }
  console.log("=== Veil account ===")
  console.log({ id: veil.id, username: veil.username, coins: veil.coins, tag: veil.tag, pfpAccessory: veil.pfpAccessory, updatedAt: veil.updatedAt })
  console.log("\n=== last 40 coin txs involving Veil ===")
  const txs = await db.coinTransaction.findMany({
    where: { OR: [{ fromId: veil.id }, { toId: veil.id }] },
    orderBy: { createdAt: "desc" }, take: 40,
  })
  for (const t of txs) {
    const dir = t.toId === veil.id ? "+" : "-"
    console.log(`${t.createdAt.toISOString()} ${dir}${t.amount} ${t.reason} (from=${t.fromId === veil.id ? "Veil" : t.fromId.slice(-6)} to=${t.toId === veil.id ? "Veil" : t.toId.slice(-6)})`)
  }
  console.log("\n=== last 15 blackjack games ===")
  const games = await db.blackjackGame.findMany({ where: { playerId: veil.id }, orderBy: { createdAt: "desc" }, take: 15 })
  for (const g of games) console.log(`${g.createdAt.toISOString()} bet=${g.bet} status=${g.status} result=${g.result} payout=${g.payout}`)
}
main().finally(() => db.$disconnect())
