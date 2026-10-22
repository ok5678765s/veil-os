import { db } from "@/lib/db"
async function main() {
  const txs = await db.coinTransaction.findMany({
    where: { createdAt: { gte: new Date("2026-10-22T20:29:00Z") } },
    orderBy: { createdAt: "asc" },
  })
  for (const t of txs) console.log(t.createdAt.toISOString(), t.reason, t.amount)
}
main().finally(() => process.exit(0))
