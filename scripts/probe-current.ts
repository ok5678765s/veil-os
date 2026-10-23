import { db } from "@/lib/db"

async function main() {
  const veil = await db.chatAccount.findUnique({ where: { username: "Veil" } })
  console.log("=== Veil account ===")
  console.log(veil ? { id: veil.id, username: veil.username, coins: veil.coins, tag: veil.tag, pfpAccessory: veil.pfpAccessory, role: veil.role, createdAt: veil.createdAt } : "NOT FOUND")

  const txCount = await db.coinTransaction.count()
  const newest = await db.coinTransaction.findFirst({ orderBy: { createdAt: "desc" } })
  const oldest = await db.coinTransaction.findFirst({ orderBy: { createdAt: "asc" } })
  console.log("\n=== Ledger ===")
  console.log({ txCount, oldest: oldest?.createdAt, newest: newest?.createdAt })

  const accounts = await db.chatAccount.findMany({ orderBy: { coins: "desc" }, take: 15 })
  console.log("\n=== Top balances ===")
  for (const a of accounts) console.log(`${a.username.padEnd(20)} coins=${String(a.coins).padStart(8)} role=${a.role} tag=${a.tag ?? "-"}`)

  const recent = await db.coinTransaction.findMany({ orderBy: { createdAt: "desc" }, take: 15 })
  console.log("\n=== Last 15 txs ===")
  for (const t of recent) {
    const from = t.fromId === veil?.id ? "Veil" : t.fromId?.slice(0, 8) ?? "-"
    const to = t.toId === veil?.id ? "Veil" : t.toId?.slice(0, 8) ?? "-"
    console.log(`${t.createdAt.toISOString()} ${from.padEnd(10)} -> ${to.padEnd(10)} ${String(t.amount).padStart(8)} ${t.reason}`)
  }

  const msgCount = await db.chatMessage.count()
  console.log(`\nmessages: ${msgCount}`)
}

main().finally(() => process.exit(0))
