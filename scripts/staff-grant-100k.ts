/**
 * One-time owner directive (2026-10-20): "give every mod and owner 100k".
 *
 * Grants +100,000 coins to every chat account with the moderator or admin
 * (owner) role, recorded as a `staff_grant` coin transaction. Idempotent:
 * an account that already has a staff_grant transaction is skipped, so
 * re-running never double-pays.
 */
import { db } from "@/lib/db"

const GRANT_AMOUNT = 100_000

async function main() {
  const staff = await db.chatAccount.findMany({
    where: { role: { in: ["moderator", "admin"] } },
    select: { id: true, username: true, role: true, coins: true },
  })
  console.log(`staff accounts found: ${staff.length}`)

  for (const s of staff) {
    const already = await db.coinTransaction.findFirst({
      where: { toId: s.id, reason: "staff_grant" },
      select: { id: true },
    })
    if (already) {
      console.log(`SKIP ${s.username} (${s.role}) — already granted`)
      continue
    }
    const [tx] = await db.$transaction([
      db.coinTransaction.create({
        data: {
          fromId: s.id,
          toId: s.id,
          amount: GRANT_AMOUNT,
          reason: "staff_grant",
        },
      }),
      db.chatAccount.update({
        where: { id: s.id },
        data: { coins: { increment: GRANT_AMOUNT } },
      }),
    ])
    void tx
    const after = await db.chatAccount.findUnique({
      where: { id: s.id },
      select: { coins: true },
    })
    console.log(
      `GRANTED ${s.username} (${s.role}) +${GRANT_AMOUNT.toLocaleString()} → balance ${after?.coins.toLocaleString()}`,
    )
  }
  console.log("done.")
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})
