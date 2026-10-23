import { db } from "@/lib/db"

async function main() {
  // 1. Full ledger inventory
  const all = await db.coinTransaction.findMany({ orderBy: { createdAt: "asc" } })
  console.log(`total live tx rows: ${all.length}`)
  if (all.length) {
    console.log(`earliest: ${all[0].createdAt.toISOString()} ${all[0].reason} ${all[0].amount}`)
    console.log(`latest:   ${all.at(-1)!.createdAt.toISOString()} ${all.at(-1)!.reason} ${all.at(-1)!.amount}`)
  }
  // find any gaps > 30 min
  let gaps = 0
  for (let i = 1; i < all.length; i++) {
    const dt = all[i].createdAt.getTime() - all[i-1].createdAt.getTime()
    if (dt > 30 * 60 * 1000) {
      console.log(`  GAP ${Math.round(dt/60000)}min: ${all[i-1].createdAt.toISOString()} -> ${all[i].createdAt.toISOString()}`)
      gaps++
    }
  }
  console.log(`gaps>30min: ${gaps}`)

  // 2. Veil's key rows still present?
  const veil = await db.chatAccount.findUnique({ where: { username: "Veil" } })
  if (veil) {
    const key = await db.coinTransaction.findMany({
      where: { toId: veil.id, reason: { in: ["staff_grant", "glitch_refund"] } },
      orderBy: { createdAt: "asc" },
    })
    console.log(`\nVeil staff_grant/glitch_refund rows: ${key.length}`)
    for (const k of key) console.log(`  ${k.createdAt.toISOString()} +${k.amount} ${k.reason}`)
  }

  // 3. account count + coin totals
  const accts = await db.chatAccount.findMany({ select: { username: true, role: true, coins: true } })
  console.log(`\naccounts: ${accts.length}, total coins: ${accts.reduce((s,a)=>s+a.coins,0)}`)
}
main().finally(() => db.$disconnect())
