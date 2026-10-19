/**
 * Veil Chat — Roulette engine (server + client shared constants).
 *
 * Ported from the owner's roulette.html: European single-zero wheel,
 * same pocket order, same table spots, same payouts (straight 36×,
 * dozens 3×, even-money 2× — all "returned including stake", so the
 * house edge is the classic 1/37 ≈ 2.7% on every spot).
 *
 * The SERVER owns the spin (crypto random); the client only animates
 * its wheel to the pocket the server landed on.
 */

/** Physical pocket order on the wheel, clockwise from top (0). */
export const ROULETTE_ORDER: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]

/** Red numbers on a European wheel (everything else non-zero is black). */
export const ROULETTE_RED = new Set<number>([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
])

/** Betting-spot ids the table accepts. */
export type RouletteSpot =
  | `n-${number}` // straight up: n-0 … n-36
  | "red"
  | "black"
  | "odd"
  | "even"
  | "low" // 1–18
  | "high" // 19–36
  | "d1" // 1st 12
  | "d2" // 2nd 12
  | "d3" // 3rd 12

export function isRouletteSpot(id: string): id is RouletteSpot {
  if (/^n-(\d|[12]\d|3[0-6])$/.test(id)) return true
  return ["red", "black", "odd", "even", "low", "high", "d1", "d2", "d3"].includes(id)
}

/** Payout MULTIPLIER (stake included) for a spot given the winning number.
 *  0 → only the straight n-0 bet pays. */
export function roulettePayoutFor(spot: RouletteSpot, n: number): number {
  if (spot.startsWith("n-")) return Number(spot.slice(2)) === n ? 36 : 0
  if (n === 0) return 0
  switch (spot) {
    case "red":
      return ROULETTE_RED.has(n) ? 2 : 0
    case "black":
      return ROULETTE_RED.has(n) ? 0 : 2
    case "odd":
      return n % 2 === 1 ? 2 : 0
    case "even":
      return n % 2 === 0 ? 2 : 0
    case "low":
      return n <= 18 ? 2 : 0
    case "high":
      return n >= 19 ? 2 : 0
    case "d1":
      return n <= 12 ? 3 : 0
    case "d2":
      return n >= 13 && n <= 24 ? 3 : 0
    case "d3":
      return n >= 25 ? 3 : 0
  }
  return 0
}

export function rouletteColor(n: number): "red" | "black" | "green" {
  if (n === 0) return "green"
  return ROULETTE_RED.has(n) ? "red" : "black"
}

/* ------------------------- Slots engine ------------------------- */

export type SlotSymbol =
  | "cherry"
  | "lemon"
  | "horseshoe"
  | "bell"
  | "bar"
  | "diamond"
  | "seven"

/** Symbol bag weights — identical to the owner's slots.html. */
export const SLOT_SYMBOLS: readonly SlotSymbol[] = [
  "cherry", "lemon", "horseshoe", "bell", "bar", "diamond", "seven",
]

export const SLOT_WEIGHTS: Record<SlotSymbol, number> = {
  cherry: 6, lemon: 5, horseshoe: 4, bell: 4, bar: 3, diamond: 2, seven: 1,
}

/** Triple-symbol payouts (stake ×N returned). Same as the paytable card. */
export const SLOT_TRIPLE_PAY: Record<SlotSymbol, number> = {
  seven: 100, diamond: 40, bar: 25, bell: 15, horseshoe: 10, lemon: 8, cherry: 6,
}

export const SLOT_TRIPLE_NAME: Record<SlotSymbol, string> = {
  seven: "Triple Sevens", diamond: "Three Diamonds", bar: "Three Bars",
  bell: "Three Bells", horseshoe: "Three Horseshoes", lemon: "Three Lemons",
  cherry: "Three Cherries",
}

/** Weighted single-reel pick — the server's dice, not the client's. */
export function pickSlotSymbol(rand: () => number): SlotSymbol {
  let total = 0
  for (const s of SLOT_SYMBOLS) total += SLOT_WEIGHTS[s]
  let r = rand() * total
  for (const s of SLOT_SYMBOLS) {
    r -= SLOT_WEIGHTS[s]
    if (r < 0) return s
  }
  return "cherry"
}

/** Resolve a spin: returns the multiplier (stake included) + what happened. */
export function resolveSlotSpin(
  reels: [SlotSymbol, SlotSymbol, SlotSymbol],
): { mult: number; label: string } {
  const [a, b, c] = reels
  if (a === b && b === c) {
    return { mult: SLOT_TRIPLE_PAY[a], label: SLOT_TRIPLE_NAME[a] }
  }
  if (a === b || b === c || a === c) {
    return { mult: 2, label: "A pair" }
  }
  return { mult: 0, label: "No luck" }
}
