import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import {
  createDeck,
  shuffle,
  handValue,
  isBlackjack,
  isBust,
  parseCards,
  stringifyCards,
  type Card,
} from "@/lib/blackjack"
import { staffLuckTrigger } from "@/lib/staff-luck"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

/* Error thrown inside settle transactions when another request (double-tap
 * or a second device) claimed the hand first — mapped to a friendly 409. */
class HandSettledElsewhere extends Error {
  constructor() {
    super("This hand was already settled.")
  }
}

// Dealer stands on all 17s (including soft 17).
const DEALER_STAND = 17

// Payout multipliers (relative to bet):
//   blackjack  -> 2.5x (i.e. bet * 2.5 winnings incl. original bet returned)
//   regular win -> 2x  (bet returned + equal winnings)
//   push       -> 1x  (bet returned)
//   lose/forfeit -> 0x
function payoutFor(
  result: "win" | "lose" | "push" | "blackjack",
  bet: number,
): number {
  switch (result) {
    case "blackjack":
      return Math.floor(bet * 2.5)
    case "win":
      return Math.floor(bet * 2)
    case "push":
      return bet
    case "lose":
    default:
      return 0
  }
}

// Dealer plays standard rules: draw until value >= DEALER_STAND.
function dealerPlay(deck: Card[], dealerHand: Card[]): { hand: Card[]; deck: Card[] } {
  const hand = dealerHand.slice()
  const d = deck.slice()
  while (handValue(hand).total < DEALER_STAND) {
    if (d.length === 0) break
    hand.push(d.shift()!)
  }
  return { hand, deck: d }
}

function serializeGame(g: {
  id: string
  playerId: string
  bet: number
  playerHand: string
  dealerHand: string
  deck: string
  status: string
  result: string | null
  payout: number
  createdAt: Date
}) {
  /* While the hand is live, the dealer's HOLE CARD never crosses the
   * wire (a peeker in devtools could not be allowed to see it — this is
   * a real-money… err, real-coin game). The client renders a face-down
   * card for the redacted slot. */
  const dealerHand =
    g.status === "playing" ? parseCards(g.dealerHand).slice(0, 1) : parseCards(g.dealerHand)
  return {
    id: g.id,
    playerId: g.playerId,
    bet: g.bet,
    playerHand: parseCards(g.playerHand),
    dealerHand,
    holeHidden: g.status === "playing" && parseCards(g.dealerHand).length > 1,
    deck: parseCards(g.deck),
    status: g.status,
    result: g.result,
    payout: g.payout,
    createdAt: g.createdAt,
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      action?: string
      bet?: number
    }>(req)
    if (!body) return badBody()

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
      case "start": {
        const bet = Math.floor(Number(body.bet) || 0)
        if (bet < 1) {
          return NextResponse.json(
            { ok: false, error: "Bet must be at least 1 coin." },
            { status: 400 },
          )
        }

        // Atomic bet deduction — re-check balance inside the transaction.
        const startResult = await db.$transaction(async (tx) => {
          /* A hand stranded mid-play by a restart/reload is unreachable:
           * every action targets the NEWEST game, so its stake would sit
           * frozen forever. Return it before dealing the new hand. */
          const stranded = await tx.blackjackGame.findFirst({
            where: { playerId: account.id, status: "playing" },
            orderBy: { createdAt: "desc" },
          })
          if (stranded) {
            await tx.blackjackGame.update({
              where: { id: stranded.id },
              data: { status: "done", result: "push", payout: stranded.bet },
            })
            await tx.chatAccount.update({
              where: { id: account.id },
              data: { coins: { increment: stranded.bet } },
            })
            await tx.coinTransaction.create({
              data: {
                fromId: account.id,
                toId: account.id,
                amount: stranded.bet,
                reason: "blackjack_refund",
              },
            })
          }

          const fresh = await tx.chatAccount.findUnique({
            where: { id: account.id },
          })
          if (!fresh) throw new Error("Account not found.")
          if (fresh.coins < bet) throw new Error("Insufficient balance for bet.")

          const deck = shuffle(createDeck())
          const playerHand: Card[] = [deck.shift()!, deck.shift()!]
          const dealerHand: Card[] = [deck.shift()!, deck.shift()!]

          const playerBJ = isBlackjack(playerHand)
          const dealerBJ = isBlackjack(dealerHand)

          let status: "playing" | "done" = "playing"
          let result: "win" | "lose" | "push" | "blackjack" | null = null
          let payout = 0

          if (playerBJ || dealerBJ) {
            status = "done"
            if (playerBJ && dealerBJ) {
              result = "push"
              payout = bet // bet returned
            } else if (playerBJ) {
              result = "blackjack"
              payout = payoutFor("blackjack", bet)
            } else {
              result = "lose"
              payout = 0
            }
          }

          const game = await tx.blackjackGame.create({
            data: {
              playerId: account.id,
              bet,
              playerHand: stringifyCards(playerHand),
              dealerHand: stringifyCards(dealerHand),
              deck: stringifyCards(deck),
              status,
              result,
              payout,
            },
          })

          // Deduct the bet up-front; if terminal and won, payout below.
          await tx.chatAccount.update({
            where: { id: account.id },
            data: { coins: { decrement: bet } },
          })
          await tx.coinTransaction.create({
            data: {
              fromId: account.id,
              toId: account.id,
              amount: bet,
              reason: "blackjack_loss",
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
                reason: "blackjack_win",
              },
            })
          }

          return game
        }).catch((e: Error) => e)

        if (startResult instanceof Error) {
          return NextResponse.json(
            { ok: false, error: startResult.message },
            { status: 400 },
          )
        }

        const updated = await db.chatAccount.findUnique({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          game: serializeGame(startResult),
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "hit": {
        const game = await db.blackjackGame.findFirst({
          where: { playerId: account.id, status: "playing" },
          orderBy: { createdAt: "desc" },
        })
        if (!game) {
          return NextResponse.json(
            { ok: false, error: "No active game to hit." },
            { status: 404 },
          )
        }

        const deck = parseCards(game.deck)
        const playerHand = parseCards(game.playerHand)
        if (deck.length === 0) {
          return NextResponse.json(
            { ok: false, error: "Deck is empty." },
            { status: 400 },
          )
        }
        /* House Luck (staff perk): if the next card would bust the
         * player, 8% chance the house BURNS it (removed from the deck)
         * and deals the following one instead. Members unaffected. */
        let lucky = false
        let card = deck.shift()!
        if (
          isBust([...playerHand, card]) &&
          deck.length > 0 &&
          staffLuckTrigger(account.role)
        ) {
          card = deck.shift()!
          lucky = true
        }
        playerHand.push(card)
        const v = handValue(playerHand)

        let status: "playing" | "done" = "playing"
        let result: "win" | "lose" | "push" | "blackjack" | null = null
        let payout = 0

        if (isBust(playerHand)) {
          status = "done"
          result = "lose"
          payout = 0
        } else if (v.total === 21) {
          // Auto-stand on 21.
          const dealer = dealerPlay(deck, parseCards(game.dealerHand))
          const dv = handValue(dealer.hand)
          if (isBust(dealer.hand) || dv.total < v.total) {
            result = "win"
            payout = payoutFor("win", game.bet)
          } else if (dv.total > v.total) {
            result = "lose"
            payout = 0
          } else {
            result = "push"
            payout = game.bet
          }
          status = "done"
          deck.length = 0
          deck.push(...dealer.deck)
        }

        /* Atomic claim: the write only lands if the hand is still EXACTLY
         * as we read it (same cards, same deck, still playing). A racing
         * double-tap or second device gets count 0 — no double payout. */
        const settled = await db.$transaction(async (tx) => {
          const claim = await tx.blackjackGame.updateMany({
            where: {
              id: game.id,
              status: "playing",
              playerHand: game.playerHand,
              deck: game.deck,
            },
            data: {
              playerHand: stringifyCards(playerHand),
              deck: stringifyCards(deck),
              status,
              result,
              payout,
            },
          })
          if (claim.count === 0) throw new HandSettledElsewhere()
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
                reason: "blackjack_win",
              },
            })
          }
          return true
        }).catch((e: Error) => e)
        if (settled instanceof Error) {
          const status2 = settled instanceof HandSettledElsewhere ? 409 : 400
          const fresh = await db.blackjackGame.findUnique({
            where: { id: game.id },
          })
          return NextResponse.json(
            {
              ok: false,
              error: settled.message,
              game: fresh ? serializeGame(fresh) : null,
            },
            { status: status2 },
          )
        }

        const finalGame = await db.blackjackGame.findUnique({
          where: { id: game.id },
        })
        const updated = await db.chatAccount.findUnique({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          game: finalGame ? serializeGame(finalGame) : null,
          lucky,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "double": {
        /* The whole double — extra stake, one card, dealer settle, payout —
         * runs in ONE transaction with an atomic claim on the hand. A racing
         * double-tap or second device either doubles once or not at all;
         * the extra stake can never be taken without the hand updating. */
        const dblResult = await db.$transaction(async (tx) => {
          const game = await tx.blackjackGame.findFirst({
            where: { playerId: account.id, status: "playing" },
            orderBy: { createdAt: "desc" },
          })
          if (!game) throw new Error("No active game to double.")

          const deck = parseCards(game.deck)
          const playerHand = parseCards(game.playerHand)
          if (playerHand.length !== 2) {
            throw new Error("You can only double on your first two cards.")
          }
          if (deck.length === 0) throw new Error("Deck is empty.")

          const fresh = await tx.chatAccount.findUnique({
            where: { id: account.id },
          })
          if (!fresh) throw new Error("Account not found.")
          if (fresh.coins < game.bet) {
            throw new Error("Not enough coins to double.")
          }

          /* One card, then the dealer settles it — with House Luck: a
           * busting card is burned (8%, staff only) and the next dealt. */
          let lucky = false
          let card = deck.shift()!
          if (
            isBust([...playerHand, card]) &&
            deck.length > 0 &&
            staffLuckTrigger(account.role)
          ) {
            card = deck.shift()!
            lucky = true
          }
          playerHand.push(card)
          const pv = handValue(playerHand)

          let dealerHand = parseCards(game.dealerHand)
          let result: "win" | "lose" | "push" | "blackjack"
          let payout: number
          if (isBust(playerHand)) {
            result = "lose"
            payout = 0
          } else {
            const dealer = dealerPlay(deck, dealerHand)
            dealerHand = dealer.hand
            const dv = handValue(dealerHand)
            if (isBust(dealerHand) || dv.total < pv.total) {
              result = "win"
              payout = payoutFor("win", game.bet * 2)
            } else if (dv.total > pv.total) {
              result = "lose"
              payout = 0
            } else {
              result = "push"
              payout = game.bet * 2
            }
          }

          const claim = await tx.blackjackGame.updateMany({
            where: {
              id: game.id,
              status: "playing",
              playerHand: game.playerHand,
              deck: game.deck,
            },
            data: {
              bet: game.bet * 2,
              playerHand: stringifyCards(playerHand),
              dealerHand: stringifyCards(dealerHand),
              deck: stringifyCards(deck),
              status: "done",
              result,
              payout,
            },
          })
          if (claim.count === 0) throw new HandSettledElsewhere()

          await tx.chatAccount.update({
            where: { id: account.id },
            data: { coins: { decrement: game.bet } },
          })
          await tx.coinTransaction.create({
            data: {
              fromId: account.id,
              toId: account.id,
              amount: game.bet,
              reason: "blackjack_loss",
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
                reason: "blackjack_win",
              },
            })
          }
          return { gameId: game.id, lucky }
        }).catch((e: Error) => e)

        if (dblResult instanceof Error) {
          const status2 = dblResult instanceof HandSettledElsewhere ? 409 : 400
          let freshGame = null
          if (dblResult instanceof HandSettledElsewhere) {
            const latest = await db.blackjackGame.findFirst({
              where: { playerId: account.id },
              orderBy: { createdAt: "desc" },
            })
            freshGame = latest ? serializeGame(latest) : null
          }
          return NextResponse.json(
            { ok: false, error: dblResult.message, game: freshGame },
            { status: status2 },
          )
        }

        const finalGame = await db.blackjackGame.findUnique({
          where: { id: dblResult.gameId },
        })
        const updated = await db.chatAccount.findUnique({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          game: finalGame ? serializeGame(finalGame) : null,
          lucky: dblResult.lucky,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "stand": {
        const game = await db.blackjackGame.findFirst({
          where: { playerId: account.id, status: "playing" },
          orderBy: { createdAt: "desc" },
        })
        if (!game) {
          return NextResponse.json(
            { ok: false, error: "No active game to stand." },
            { status: 404 },
          )
        }

        const deck = parseCards(game.deck)
        const playerHand = parseCards(game.playerHand)
        const dealer = dealerPlay(deck, parseCards(game.dealerHand))
        const pv = handValue(playerHand)
        const dv = handValue(dealer.hand)

        let result: "win" | "lose" | "push" | "blackjack"
        let payout: number
        if (isBust(dealer.hand) || dv.total < pv.total) {
          result = "win"
          payout = payoutFor("win", game.bet)
        } else if (dv.total > pv.total) {
          result = "lose"
          payout = 0
        } else {
          result = "push"
          payout = game.bet
        }

        /* Atomic claim (see hit) — no double payout on races. */
        const settled = await db.$transaction(async (tx) => {
          const claim = await tx.blackjackGame.updateMany({
            where: {
              id: game.id,
              status: "playing",
              playerHand: game.playerHand,
              deck: game.deck,
            },
            data: {
              dealerHand: stringifyCards(dealer.hand),
              deck: stringifyCards(dealer.deck),
              status: "done",
              result,
              payout,
            },
          })
          if (claim.count === 0) throw new HandSettledElsewhere()
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
                reason: "blackjack_win",
              },
            })
          }
          return true
        }).catch((e: Error) => e)
        if (settled instanceof Error) {
          const status2 = settled instanceof HandSettledElsewhere ? 409 : 400
          const fresh = await db.blackjackGame.findUnique({
            where: { id: game.id },
          })
          return NextResponse.json(
            {
              ok: false,
              error: settled.message,
              game: fresh ? serializeGame(fresh) : null,
            },
            { status: status2 },
          )
        }

        const finalGame = await db.blackjackGame.findUnique({
          where: { id: game.id },
        })
        const updated = await db.chatAccount.findUnique({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          game: finalGame ? serializeGame(finalGame) : null,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "forfeit": {
        const game = await db.blackjackGame.findFirst({
          where: { playerId: account.id, status: "playing" },
          orderBy: { createdAt: "desc" },
        })
        if (!game) {
          return NextResponse.json(
            { ok: false, error: "No active game to forfeit." },
            { status: 404 },
          )
        }

        // Bet was already deducted at start; just mark as lost — atomically.
        const settled = await db.$transaction(async (tx) => {
          const claim = await tx.blackjackGame.updateMany({
            where: {
              id: game.id,
              status: "playing",
              playerHand: game.playerHand,
              deck: game.deck,
            },
            data: { status: "done", result: "lose", payout: 0 },
          })
          if (claim.count === 0) throw new HandSettledElsewhere()
          await tx.coinTransaction.create({
            data: {
              fromId: account.id,
              toId: account.id,
              amount: game.bet,
              reason: "blackjack_forfeit",
            },
          })
          return true
        }).catch((e: Error) => e)
        if (settled instanceof Error) {
          const status2 = settled instanceof HandSettledElsewhere ? 409 : 400
          const fresh = await db.blackjackGame.findUnique({
            where: { id: game.id },
          })
          return NextResponse.json(
            {
              ok: false,
              error: settled.message,
              game: fresh ? serializeGame(fresh) : null,
            },
            { status: status2 },
          )
        }

        const finalGame = await db.blackjackGame.findUnique({
          where: { id: game.id },
        })
        const updated = await db.chatAccount.findUnique({
          where: { id: account.id },
        })
        return NextResponse.json({
          ok: true,
          game: finalGame ? serializeGame(finalGame) : null,
          account: updated ? toPublicAccount(updated) : null,
        })
      }

      case "status": {
        const game = await db.blackjackGame.findFirst({
          where: { playerId: account.id },
          orderBy: { createdAt: "desc" },
        })
        if (!game) {
          return NextResponse.json({ ok: true, game: null })
        }
        return NextResponse.json({ ok: true, game: serializeGame(game) })
      }

      default:
        return NextResponse.json(
          { ok: false, error: `Unknown action: ${action}` },
          { status: 400 },
        )
    }
  } catch (err) {
    console.error("[chat-blackjack POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error processing blackjack action." },
      { status: 500 },
    )
  }
}
