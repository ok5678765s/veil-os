import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { cors, corsOptions } from "@/lib/veil/cors"
import {
  ROULETTE_ORDER,
  isRouletteSpot,
  roulettePayoutFor,
  rouletteColor,
  type RouletteSpot,
} from "@/lib/roulette"
import { staffLuckTrigger } from "@/lib/staff-luck"

export const runtime = "nodejs"

export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/** House limit on the TOTAL staked per spin (same ceiling as coin flip). */
const HOUSE_LIMIT = 10_000

/**
 * POST /api/chat-roulette — spin the wheel against your balance.
 *
 * Body: { token, bets: { "n-17": 25, "red": 100, … } }
 *
 * The server owns the wheel:
 *   - every spot id is validated against the real table;
 *   - the total stake is deducted atomically (balance re-checked inside
 *     the transaction);
 *   - the pocket is drawn with crypto randomness — the client's wheel
 *     animation only CHASES the result we return;
 *   - payouts: straight 36×, dozens 3×, even-money 2× (stake included);
 *   - every spin is recorded (roulette_loss for the stake, roulette_win
 *     for anything returned) so the coin history tells the whole story.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    /* Parse defensively — aborted POSTs mid-unload arrive as empty bodies. */
    let body: { token?: string; bets?: Record<string, unknown> }
    try {
      body = (await req.json()) as typeof body
    } catch {
      return NextResponse.json(
        { ok: false, error: "Malformed request body." },
        { status: 400 },
      )
    }

    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    /* ---- validate the table ---- */
    const raw = body.bets || {}
    const entries: [RouletteSpot, number][] = []
    let total = 0
    for (const [id, rawAmt] of Object.entries(raw)) {
      if (!isRouletteSpot(id)) {
        return NextResponse.json(
          { ok: false, error: `Unknown bet spot: ${id}` },
          { status: 400 },
        )
      }
      const amt = Math.floor(Number(rawAmt) || 0)
      if (amt < 1) {
        return NextResponse.json(
          { ok: false, error: "Every bet must be at least 1 coin." },
          { status: 400 },
        )
      }
      entries.push([id, amt])
      total += amt
    }
    if (entries.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Place at least one bet on the table." },
        { status: 400 },
      )
    }
    if (total > HOUSE_LIMIT) {
      return NextResponse.json(
        { ok: false, error: `House limit: ${HOUSE_LIMIT.toLocaleString()} coins per spin.` },
        { status: 400 },
      )
    }

    /* ---- spin + settle, atomically ---- */
    const result = await db.$transaction(async (tx) => {
      const fresh = await tx.chatAccount.findUnique({
        where: { id: account.id },
      })
      if (!fresh) throw new Error("Account not found.")
      if (fresh.coins < total) throw new Error("Not enough coins for that bet.")

      // The pocket — crypto random over the physical wheel order.
      const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      let winIndex = Number.parseInt(hex, 16) % ROULETTE_ORDER.length
      let number = ROULETTE_ORDER[winIndex]

      let returned = 0
      let hits: { id: RouletteSpot; amount: number; payout: number }[] = []
      const settle = () => {
        returned = 0
        hits = []
        for (const [id, amt] of entries) {
          const payout = amt * roulettePayoutFor(id, number)
          if (payout > 0) {
            returned += payout
            hits.push({ id, amount: amt, payout })
          }
        }
      }
      settle()

      /* House Luck (staff perk): the spin missed every chip on the
       * table — 8% chance the ball hops into a pocket their bets DO
       * cover. Members are completely unaffected. */
      let lucky = false
      if (
        returned === 0 &&
        staffLuckTrigger(account.role)
      ) {
        const covered: number[] = []
        for (let i = 0; i < ROULETTE_ORDER.length; i++) {
          const n = ROULETTE_ORDER[i]
          if (entries.some(([id]) => roulettePayoutFor(id, n) > 0)) {
            covered.push(i)
          }
        }
        if (covered.length > 0) {
          const pick = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
          winIndex = covered[Number.parseInt(pick, 16) % covered.length]
          number = ROULETTE_ORDER[winIndex]
          settle()
          lucky = true
        }
      }

      await tx.chatAccount.update({
        where: { id: account.id },
        data: { coins: { decrement: total } },
      })
      await tx.coinTransaction.create({
        data: {
          fromId: account.id,
          toId: account.id,
          amount: total,
          reason: "roulette_loss",
        },
      })
      if (returned > 0) {
        await tx.chatAccount.update({
          where: { id: account.id },
          data: { coins: { increment: returned } },
        })
        await tx.coinTransaction.create({
          data: {
            fromId: account.id,
            toId: account.id,
            amount: returned,
            reason: "roulette_win",
          },
        })
      }

      return { number, winIndex, returned, hits, lucky }
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
      number: result.number,
      color: rouletteColor(result.number),
      winIndex: result.winIndex,
      returned: result.returned,
      net: result.returned - total,
      staked: total,
      hits: result.hits,
      lucky: result.lucky,
      balance: updated?.coins ?? 0,
      account: updated ? toPublicAccount(updated) : null,
    })
  } catch (err) {
    console.error("[chat-roulette POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error spinning the wheel." },
      { status: 500 },
    )
  }
}
