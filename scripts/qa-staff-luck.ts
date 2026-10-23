/**
 * QA script — House Luck verification.
 *
 * 1. Registers a throwaway QA account (member) → flips N times.
 * 2. Promotes it to moderator (the staff perk) → flips N times.
 * 3. Roulette + slots + blackjack smoke runs as the moderator.
 * 4. Prints win rates; the mod rate should sit ~4 points above the
 *    member rate (50% → ~54%).
 * 5. Cleans the QA account up at the end.
 */
import { db } from "@/lib/db"

const BASE = "http://127.0.0.1:3000"
const N_FLIPS = 400

async function register(username: string): Promise<string> {
  const res = await fetch(`${BASE}/api/chat-auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "qapass123456" }),
  })
  const data = (await res.json()) as { ok: boolean; token?: string; error?: string }
  if (!data.ok || !data.token) throw new Error(`register failed: ${data.error}`)
  return data.token
}

async function flips(token: string, n: number) {
  let wins = 0
  let luckyCount = 0
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? "heads" : "tails"
    const res = await fetch(`${BASE}/api/chat-coinflip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, bet: 1, side }),
    })
    const data = (await res.json()) as { ok: boolean; won?: boolean; lucky?: boolean; error?: string }
    if (!data.ok) throw new Error(`flip failed: ${data.error}`)
    if (data.won) wins++
    if (data.lucky) luckyCount++
  }
  return { wins, luckyCount }
}

async function main() {
  const uname = `qaluck${Date.now().toString().slice(-6)}`
  const token = await register(uname)
  const acct = await db.chatAccount.findUnique({ where: { username: uname } })
  if (!acct) throw new Error("account not found")
  console.log(`QA account ${uname} registered (member)`)

  /* ---- phase 1: member flips (baseline, NO luck) ---- */
  const m = await flips(token, N_FLIPS)
  console.log(
    `MEMBER : ${m.wins}/${N_FLIPS} wins = ${((100 * m.wins) / N_FLIPS).toFixed(1)}%  (lucky rescues: ${m.luckyCount} — must be 0)`,
  )

  /* ---- phase 2: promote to moderator, flips again ---- */
  await db.chatAccount.update({ where: { id: acct.id }, data: { role: "moderator" } })
  console.log(`promoted ${uname} to moderator`)
  const s = await flips(token, N_FLIPS)
  console.log(
    `MOD    : ${s.wins}/${N_FLIPS} wins = ${((100 * s.wins) / N_FLIPS).toFixed(1)}%  (lucky rescues: ${s.luckyCount} — expect ~${Math.round(0.08 * (N_FLIPS - m.wins))})`,
  )

  /* ---- roulette smoke (2 spins on red, bet 1) ---- */
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${BASE}/api/chat-roulette`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, bets: { red: 1 } }),
    })
    const d = (await res.json()) as { ok: boolean; number?: number; net?: number; lucky?: boolean; error?: string }
    console.log(`ROULETTE: ok=${d.ok} number=${d.number} net=${d.net} lucky=${d.lucky} ${d.error ?? ""}`)
  }

  /* ---- slots smoke (3 pulls, bet 1) ---- */
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/api/chat-slots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, bet: 1 }),
    })
    const d = (await res.json()) as { ok: boolean; mult?: number; label?: string; lucky?: boolean; error?: string }
    console.log(`SLOTS   : ok=${d.ok} mult=${d.mult} label=${d.label} lucky=${d.lucky} ${d.error ?? ""}`)
  }

  /* ---- blackjack smoke: start + stand ---- */
  const startRes = await fetch(`${BASE}/api/chat-blackjack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, action: "start", bet: 1 }),
  })
  const sd = (await startRes.json()) as { ok: boolean; game?: { status: string; result: string | null }; error?: string }
  console.log(`BJ START: ok=${sd.ok} status=${sd.game?.status} result=${sd.game?.result} ${sd.error ?? ""}`)
  if (sd.ok && sd.game?.status === "playing") {
    const hitRes = await fetch(`${BASE}/api/chat-blackjack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, action: "hit" }),
    })
    const hd = (await hitRes.json()) as { ok: boolean; lucky?: boolean; game?: { status: string }; error?: string }
    console.log(`BJ HIT  : ok=${hd.ok} lucky=${hd.lucky} status=${hd.game?.status} ${hd.error ?? ""}`)
    if (hd.ok && hd.game?.status === "playing") {
      const standRes = await fetch(`${BASE}/api/chat-blackjack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action: "stand" }),
      })
      const std = (await standRes.json()) as { ok: boolean; game?: { result: string | null }; error?: string }
      console.log(`BJ STAND: ok=${std.ok} result=${std.game?.result} ${std.error ?? ""}`)
    }
  }

  /* ---- cleanup ---- */
  await db.chatAccount.delete({ where: { id: acct.id } })
  console.log(`QA account ${uname} deleted — clean.`)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e)
  process.exit(1)
})
