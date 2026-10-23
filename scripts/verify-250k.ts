import { db } from "@/lib/db"
async function main() {
  const v = await db.chatAccount.findUnique({ where: { username: "Veil" } })
  console.log("Veil:", { coins: v?.coins, tag: v?.tag, pfp: v?.pfpAccessory, role: v?.role })
  const t = await db.coinTransaction.findFirst({
    where: { toId: v!.id, reason: "staff_grant", amount: 250_000 },
    orderBy: { createdAt: "desc" },
  })
  console.log("ledger row:", t && { amount: t.amount, reason: t.reason, createdAt: t.createdAt })
}
main().finally(() => process.exit(0))
