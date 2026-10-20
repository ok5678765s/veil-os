import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { cors, corsOptions } from "@/lib/veil/cors"
import { staffLuckTrigger } from "@/lib/staff-luck"

export const runtime = "nodejs"

export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/**
 * POST /api/chat-coinflip — flip the golden coin against your balance.
 *
 * Body: { token, bet, side: "heads" | "tails" }
 *
 * The server owns the randomness (client flips are cosmetic only):
 *   - the bet is deducted atomically (balance re-checked in-transaction);
 *   - a correct call pays 2× the bet back (net +bet);
 *   - a wrong call pays nothing (net −bet);
 *   - every flip is recorded as a coin transaction (coinflip_win /
 *     coinflip_loss) so the history shows the whole story.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = (await req.json()) as {
      token?: string
      bet?: number
      side?: string
    }

    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const bet = Math.floor(Number(body.bet) || 0)
    const side = body.side === "heads" || body.side === "tails" ? body.side : null

    if (!side) {
      return NextResponse.json(
        { ok: false, error: "Pick heads or tails first." },
        { status: 400 },
      )
    }
    if (bet < 1) {
      return NextResponse.json(
        { ok: false, error: "Bet at least 1 coin." },
        { status: 400 },
      )
    }
    if (bet > 10000) {
      return NextResponse.json(
        { ok: false, error: "House limit: 10,000 coins per flip." },
        { status: 400 },
      )
    }

    const result = await db.$transaction(async (tx) => {
      const fresh = await tx.chatAccount.findUnique({
        where: { id: account.id },
      })
      if (!fresh) throw new Error("Account not found.")
      if (fresh.coins < bet) throw new Error("Not enough coins for that bet.")

      // Server-side flip — crypto random when available.
      const heads = crypto.randomUUID().charCodeAt(0) % 2 === 0
      let landed = heads ? "heads" : "tails"
      let won = landed === side
      /* House Luck (staff perk): a losing call gets an 8% rescue — the
       * coin tips to the staff member's side after all. Members are
       * completely unaffected. */
      let lucky = false
      if (!won && staffLuckTrigger(account.role)) {
        landed = side
        won = true
        lucky = true
      }
      const payout = won ? bet * 2 : 0

      await tx.chatAccount.update({
        where: { id: account.id },
        data: { coins: { decrement: bet } },
      })
      await tx.coinTransaction.create({
        data: {
          fromId: account.id,
          toId: account.id,
          amount: bet,
          reason: "coinflip_loss",
        },
      })
      if (payout > 0) {
        await tx.chatAccount.update({
          where: { id: account.id },
          data: { coins: { increment: payout } },
        })
        await tx.coinTransaction.create({
          data: {
            fromId: account.id,
            toId: account.id,
            amount: payout,
            reason: "coinflip_win",
          },
        })
      }

      return { landed, won, payout, lucky }
    }).catch((e: Error) => e)

    if (result instanceof Error) {
      return NextResponse.json(
        { ok: false, error: result.message },
        { status: 400 },
      )
    }

    const updated = await db.chatAccount.findUnique({
      where: { id: account.id },
    })
    return NextResponse.json({
      ok: true,
      landed: result.landed,
      won: result.won,
      payout: result.payout,
      lucky: result.lucky,
      balance: updated?.coins ?? 0,
      account: updated ? toPublicAccount(updated) : null,
    })
  } catch (err) {
    console.error("[chat-coinflip POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error flipping the coin." },
      { status: 500 },
    )
  }
}
