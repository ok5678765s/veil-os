import { db } from "@/lib/db"

async function main() {
  const mods = await db.chatAccount.findMany({
    where: { role: { in: ["moderator", "admin"] } },
    orderBy: { role: "asc" },
  })
  console.log(`staff accounts: ${mods.length}`)
  for (const m of mods) {
    console.log(`\n=== ${m.username} (role=${m.role}) ===`)
    console.log(`  coins=${m.coins} tag=${m.tag ?? "-"} pfp=${m.pfpAccessory ?? "-"} updatedAt=${m.updatedAt.toISOString()}`)
    const txs = await db.coinTransaction.findMany({
      where: { OR: [{ fromId: m.id }, { toId: m.id }] },
      orderBy: { createdAt: "desc" }, take: 12,
    })
    for (const t of txs) {
      const dir = t.toId === m.id ? "+" : "-"
      console.log(`  ${t.createdAt.toISOString()} ${dir}${t.amount} ${t.reason}`)
    }
    const grants = await db.coinTransaction.findMany({
      where: { toId: m.id, reason: "staff_grant", amount: 100000 },
    })
    console.log(`  -> 100k staff_grant rows in live ledger: ${grants.length}${grants.length ? " (" + grants.map(g => g.createdAt.toISOString()).join(", ") + ")" : ""}`)
  }
}
main().finally(() => db.$disconnect())
