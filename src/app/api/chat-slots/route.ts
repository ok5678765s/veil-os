import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { cors, corsOptions } from "@/lib/veil/cors"
import {
  pickSlotSymbol,
  resolveSlotSpin,
  type SlotSymbol,
} from "@/lib/roulette"
import { staffLuckTrigger } from "@/lib/staff-luck"

export const runtime = "nodejs"

export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

/** House limit per pull (same ceiling as the coin flip). */
const HOUSE_LIMIT = 10_000

/** Crypto-backed uniform [0,1) for the weighted reel picks. */
function cryptoRand(): number {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  return Number.parseInt(hex, 16) / 0x1_0000_0000
}

/**
 * POST /api/chat-slots — pull the Golden Sevens lever against your balance.
 *
 * Body: { token, bet }
 *
 * The server owns the reels (the client's strips are pure choreography):
 *   - each of the 3 symbols is drawn from the owner's weight table
 *     (cherry 6 · lemon 5 · horseshoe 4 · bell 4 · bar 3 · diamond 2 ·
 *     seven 1) with crypto randomness;
 *   - triples pay the paytable (seven ×100 … cherry ×6), any pair pays
 *     ×2, stake included;
 *   - the bet is deducted atomically (balance re-checked inside the
 *     transaction) and every pull is recorded (slots_loss for the stake,
 *     slots_win for the return).
 */
export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    /* Parse defensively — aborted POSTs mid-unload arrive as empty bodies. */
    let body: { token?: string; bet?: number }
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

    const bet = Math.floor(Number(body.bet) || 0)
    if (bet < 1) {
      return NextResponse.json(
        { ok: false, error: "Bet at least 1 coin." },
        { status: 400 },
      )
    }
    if (bet > HOUSE_LIMIT) {
      return NextResponse.json(
        { ok: false, error: `House limit: ${HOUSE_LIMIT.toLocaleString()} coins per pull.` },
        { status: 400 },
      )
    }

    const result = await db.$transaction(async (tx) => {
      const fresh = await tx.chatAccount.findUnique({
        where: { id: account.id },
      })
      if (!fresh) throw new Error("Account not found.")
      if (fresh.coins < bet) throw new Error("Not enough coins for that bet.")

      // The reels — server-side, weighted, crypto random.
      const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [
        pickSlotSymbol(cryptoRand),
        pickSlotSymbol(cryptoRand),
        pickSlotSymbol(cryptoRand),
      ]
      let { mult, label } = resolveSlotSpin(reels)

      /* House Luck (staff perk): the pull came up empty — 8% chance the
       * last reel re-spins to match one of the first two (any pair pays
       * ×2). Members are completely unaffected. */
      let lucky = false
      if (mult === 0 && staffLuckTrigger(account.role)) {
        const match = cryptoRand() < 0.5 ? reels[0] : reels[1]
        reels[2] = match
        ;({ mult, label } = resolveSlotSpin(reels))
        lucky = true
      }
      const returned = bet * mult

      await tx.chatAccount.update({
        where: { id: account.id },
        data: { coins: { decrement: bet } },
      })
      await tx.coinTransaction.create({
        data: {
          fromId: account.id,
          toId: account.id,
          amount: bet,
          reason: "slots_loss",
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
            reason: "slots_win",
          },
        })
      }

      return { reels, mult, label, returned, lucky }
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
      reels: result.reels,
      mult: result.mult,
      label: result.label,
      returned: result.returned,
      net: result.returned - bet,
      lucky: result.lucky,
      balance: updated?.coins ?? 0,
      account: updated ? toPublicAccount(updated) : null,
    })
  } catch (err) {
    console.error("[chat-slots POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error pulling the lever." },
      { status: 500 },
    )
  }
}
