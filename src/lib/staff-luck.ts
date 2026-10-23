/**
 * Veil Casino — "House Luck", the staff perk.
 *
 * Owner directive (2026-10-20): mods (and the owner) get an 8% higher
 * chance in the gambling games. Mechanic, uniform across all four games:
 *
 *   When a staff member's gamble would LOSE, there is an 8% chance the
 *   house tips the game in their favor —
 *     • Coin Flip: the coin lands their call after all.
 *     • Roulette: the ball hops into a pocket their chips cover.
 *     • Slots:    the last reel re-spins to match one of the first two
 *                 (any pair pays ×2).
 *     • Blackjack: the house burns a card that would bust the player and
 *                 deals the next one instead.
 *
 * The boost is applied SERVER-SIDE only (the server owns all randomness
 * and the wallet), and the routes report `lucky: true` so the client can
 * celebrate it. Members are completely unaffected — same odds as ever.
 *
 * Effective edge: a 50/50 coin flip becomes 54% for staff (+8% relative,
 * the "8% chance higher" the owner asked for); roulette/slots/blackjack
 * gain the same 8% rescue slice on their losing outcomes.
 */

/** The size of the luck boost — an 8% rescue chance on would-be losses. */
export const STAFF_LUCK_BOOST = 0.08

/** Staff = moderators + the owner (admin). */
export function isStaffRole(role: string | null | undefined): boolean {
  return role === "moderator" || role === "admin"
}

/** Crypto-backed uniform [0,1) — same randomness class as the games. */
function cryptoRand(): number {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  return Number.parseInt(hex, 16) / 0x1_0000_0000
}

/**
 * The luck roll: true with probability STAFF_LUCK_BOOST for staff,
 * ALWAYS false for members (zero behavior change for regular players).
 */
export function staffLuckTrigger(role: string | null | undefined): boolean {
  if (!isStaffRole(role)) return false
  return cryptoRand() < STAFF_LUCK_BOOST
}
