import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import { awardCoins, transferCoins, parseReason, type CoinReason } from "@/lib/coins"

export const runtime = "nodejs"

const REWARD_CAP = 1000
const DAILY_BASE = 10
const DAILY_PER_STREAK = 2
const DAILY_MAX = 70
const DAY_MS = 24 * 60 * 60 * 1000

/* ── Streak math — CALENDAR days, not a rolling 24h window. ──
 *
 * The old rolling-window logic ("eligible 24h after the last claim",
 * "streak continues if claimed within 24–48h") felt broken to players:
 * claim at 11pm Monday, come back 9pm Tuesday → "not eligible yet",
 * button dead, streak frozen. Players expect "one claim per day" — so
 * the day boundary is the CLAIMER'S LOCAL MIDNIGHT (the client sends
 * its timezone offset, getTimezoneOffset() in minutes). A claim on any
 * later local day is eligible; exactly one day later continues the
 * streak; a bigger gap resets it. */
function clampTzMin(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 0
  return Math.max(-840, Math.min(840, n))
}
/** Local-day index of a UTC timestamp for a timezone (offset minutes,
 * west-positive — the JS getTimezoneOffset() convention). */
function dayIndex(ts: number, tzMin: number): number {
  return Math.floor((ts - tzMin * 60_000) / DAY_MS)
}
/** UTC timestamp of local midnight that STARTS the day AFTER the given
 * ts's local day — i.e. the earliest moment the next claim unlocks. */
function nextLocalMidnight(ts: number, tzMin: number): number {
  return (dayIndex(ts, tzMin) + 1) * DAY_MS + tzMin * 60_000
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token") || ""
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    const [sent, received] = await Promise.all([
      db.coinTransaction.findMany({
        where: { fromId: account.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      db.coinTransaction.findMany({
        where: { toId: account.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ])

    // Merge + sort by date desc, cap 100.
    const txs = [...sent, ...received]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 100)

    return NextResponse.json({
      ok: true,
      balance: account.coins,
      account: toPublicAccount(account),
      transactions: txs.map((t) => ({
        id: t.id,
        fromId: t.fromId,
        toId: t.toId,
        amount: t.amount,
        reason: t.reason,
        direction: t.fromId === account.id ? "out" : "in",
        createdAt: t.createdAt,
      })),
    })
  } catch (err) {
    console.error("[chat-coins GET] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error fetching balance." },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      token?: string
      action?: string
      toUsername?: string
      amount?: number
      reason?: string
      limit?: number
      tz?: number
    }

    const token = body.token
    const action = body.action || ""
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    switch (action) {
      case "transfer": {
        const toUsername = (body.toUsername || "").trim()
        const amount = Math.floor(Number(body.amount) || 0)
        if (!toUsername) {
          return NextResponse.json(
            { ok: false, error: "Recipient username is required." },
            { status: 400 },
          )
        }
        if (amount < 1) {
          return NextResponse.json(
            { ok: false, error: "Amount must be at least 1 coin." },
            { status: 400 },
          )
        }
        const _recipients = await db.chatAccount.findMany({ where: { username: { contains: toUsername } }, take: 20 })
        const recipient = _recipients.find((a) => a.username.toLowerCase() === toUsername.toLowerCase())
        if (!recipient) {
          return NextResponse.json(
            { ok: false, error: "Recipient not found." },
            { status: 404 },
          )
        }
        if (recipient.id === account.id) {
          return NextResponse.json(
            { ok: false, error: "Cannot send coins to yourself." },
            { status: 400 },
          )
        }
        const reason = parseReason(body.reason || "gift")
        const tx = await transferCoins(account.id, recipient.id, amount, reason)
        const updated = await db.chatAccount.findFirst({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          transaction: tx,
          balance: updated?.coins ?? 0,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "reward": {
        const amount = Math.floor(Number(body.amount) || 0)
        if (amount < 1) {
          return NextResponse.json(
            { ok: false, error: "Amount must be at least 1 coin." },
            { status: 400 },
          )
        }
        if (amount > REWARD_CAP) {
          return NextResponse.json(
            {
              ok: false,
              error: `Self-reward is capped at ${REWARD_CAP} coins.`,
            },
            { status: 400 },
          )
        }
        const tx = await awardCoins(account.id, amount, "proxy_reward")
        const updated = await db.chatAccount.findFirst({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          transaction: tx,
          balance: updated?.coins ?? 0,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "bet": {
        const amount = Math.floor(Number(body.amount) || 0)
        if (amount < 1) {
          return NextResponse.json(
            { ok: false, error: "Bet amount must be at least 1 coin." },
            { status: 400 },
          )
        }
        // Atomic deduct: re-checks balance inside the transaction.
        const result = await db.$transaction(async (tx) => {
          const fresh = await tx.chatAccount.findFirst({
            where: { id: account.id },
          })
          if (!fresh) throw new Error("Account not found.")
          if (fresh.coins < amount) throw new Error("Insufficient balance.")
          const created = await tx.coinTransaction.create({
            data: {
              fromId: account.id,
              toId: account.id,
              amount,
              reason: "blackjack_loss",
            },
          })
          await tx.chatAccount.update({
            where: { id: account.id },
            data: { coins: { decrement: amount } },
          })
          return created
        }).catch((e: Error) => e)

        if (result instanceof Error) {
          return NextResponse.json(
            { ok: false, error: result.message },
            { status: 400 },
          )
        }
        const updated = await db.chatAccount.findFirst({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          transaction: result,
          balance: updated?.coins ?? 0,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "payout": {
        const amount = Math.floor(Number(body.amount) || 0)
        if (amount < 1) {
          return NextResponse.json(
            { ok: false, error: "Payout must be at least 1 coin." },
            { status: 400 },
          )
        }
        const reason: CoinReason = "blackjack_win"
        const tx = await awardCoins(account.id, amount, reason)
        const updated = await db.chatAccount.findFirst({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          transaction: tx,
          balance: updated?.coins ?? 0,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "daily_reward_status": {
        const tzMin = clampTzMin(body.tz)
        const now = Date.now()
        const last = account.lastRewardClaim?.getTime() ?? null
        const todayIdx = dayIndex(now, tzMin)
        const eligible = last == null || dayIndex(last, tzMin) < todayIdx
        const nextClaimAt = eligible
          ? null
          : new Date(nextLocalMidnight(now, tzMin))
        return NextResponse.json({
          ok: true,
          eligible,
          streak: account.dailyRewardStreak,
          lastRewardClaim: account.lastRewardClaim,
          nextClaimAt,
        })
      }

      case "daily_reward": {
        const tzMin = clampTzMin(body.tz)
        const now = Date.now()
        const last = account.lastRewardClaim?.getTime() ?? null
        const todayIdx = dayIndex(now, tzMin)
        if (last != null && dayIndex(last, tzMin) >= todayIdx) {
          return NextResponse.json(
            {
              ok: false,
              error: "Daily reward already claimed today — come back tomorrow.",
              nextClaimAt: new Date(nextLocalMidnight(now, tzMin)),
            },
            { status: 429 },
          )
        }
        // Streak: claimed exactly yesterday (the local day before today)
        // continues it; any bigger gap resets to 1.
        const continuesStreak =
          last != null && dayIndex(last, tzMin) === todayIdx - 1
        const newStreak = continuesStreak ? account.dailyRewardStreak + 1 : 1
        const reward = Math.min(
          DAILY_MAX,
          DAILY_BASE + DAILY_PER_STREAK * (newStreak - 1),
        )

        const [tx, updated] = await db.$transaction([
          db.coinTransaction.create({
            data: {
              fromId: account.id,
              toId: account.id,
              amount: reward,
              reason: "daily_reward",
            },
          }),
          db.chatAccount.update({
            where: { id: account.id },
            data: {
              coins: { increment: reward },
              dailyRewardStreak: newStreak,
              lastRewardClaim: new Date(),
            },
          }),
        ])

        return NextResponse.json({
          ok: true,
          transaction: tx,
          reward,
          streak: newStreak,
          balance: updated.coins,
          account: toPublicAccount(updated),
        })
      }

      case "history": {
        const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
        const [sent, received] = await Promise.all([
          db.coinTransaction.findMany({
            where: { fromId: account.id },
            orderBy: { createdAt: "desc" },
            take: limit,
          }),
          db.coinTransaction.findMany({
            where: { toId: account.id },
            orderBy: { createdAt: "desc" },
            take: limit,
          }),
        ])
        const txs = [...sent, ...received]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
        return NextResponse.json({
          ok: true,
          balance: account.coins,
          transactions: txs.map((t) => ({
            id: t.id,
            fromId: t.fromId,
            toId: t.toId,
            amount: t.amount,
            reason: t.reason,
            direction: t.fromId === account.id ? "out" : "in",
            createdAt: t.createdAt,
          })),
        })
      }

      default:
        return NextResponse.json(
          { ok: false, error: `Unknown action: ${action}` },
          { status: 400 },
        )
    }
  } catch (err) {
    console.error("[chat-coins POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error processing coin action." },
      { status: 500 },
    )
  }
}
