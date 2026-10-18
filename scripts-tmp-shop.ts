import { db } from "./src/lib/db"
async function main() {
  const accts = await db.chatAccount.findMany({ select: { id: true, username: true, coins: true, pfpAccessory: true, createdAt: true } })
  console.log("ACCOUNTS:", JSON.stringify(accts, null, 1))
  const txs = await db.coinTransaction.findMany({ where: { reason: { contains: "shop" } }, orderBy: { id: "desc" }, take: 80 })
  console.log("SHOP TXS:", JSON.stringify(txs, null, 1))
  await db.$disconnect()
}
main()
