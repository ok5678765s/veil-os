import { NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { db } from "@/lib/db"
import { makeToken, toPublicAccount } from "@/lib/chat-auth"
import { cors, corsOptions } from "@/lib/veil/cors"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

/* Preflight + wildcard origin — Veil Chat also runs from the single-file
 * HTML build (file:// sends Origin: null). Tokens live in the body, so
 * a wildcard origin is safe. */
export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

const AVATAR_COLORS = [
  "#f97316",
  "#e67e22",
  "#16a085",
  "#2980b9",
  "#8e44ad",
  "#c0392b",
  "#27ae60",
  "#f39c12",
  "#1abc9c",
  "#9b59b6",
  "#e84393",
  "#2c3e50",
]

function randomAvatarColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]
}

export async function POST(req: Request): Promise<Response> {
  return cors(await handleRegister(req))
}

async function handleRegister(req: Request): Promise<Response> {
  try {
    const body = await readJsonBody<{
      username?: string
      password?: string
      displayName?: string
    }>(req)
    if (!body) return badBody()

    const username = (body.username || "").trim()
    const password = body.password || ""
    const displayName = (body.displayName || "").trim()

    if (username.length < 3) {
      return NextResponse.json(
        { ok: false, error: "Username must be at least 3 characters." },
        { status: 400 },
      )
    }
    if (password.length < 6) {
      return NextResponse.json(
        { ok: false, error: "Password must be at least 6 characters." },
        { status: 400 },
      )
    }

    const passwordHash = await bcrypt.hash(password, 10)

    // Case-insensitive uniqueness (SQLite's unique constraint is exact-match,
    // but login resolves usernames case-insensitively — registering "veil"
    // when an account "Veil" exists would hijack its login).
    const clashing = await db.chatAccount.findMany({
      where: { username: { contains: username } },
      take: 20,
    })
    const existing = clashing.find(
      (a) => a.username.toLowerCase() === username.toLowerCase(),
    )

    /* LEGACY RECLAIM (2026-10-03 wipe-recovery): accounts restored from a
     * chat backup are placeholders — they hold the username and its
     * message history but can never log in. Registering the name UPGRADES
     * the placeholder in place (same row id), so every restored message
     * instantly belongs to the returning user. The name is therefore never
     * "taken" by the restore. */
    if (existing && existing.legacy) {
      const adminExists = await db.chatAccount.findFirst({
        where: { role: "admin" },
        select: { id: true },
      })
      const account = await db.chatAccount.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          legacy: false,
          displayName: displayName || existing.displayName || username,
          coins: existing.coins < 100 ? 100 : existing.coins,
          role: adminExists ? existing.role : "admin",
        },
      })
      const token = makeToken(account)
      return NextResponse.json({
        ok: true,
        reclaimed: true,
        account: toPublicAccount(account),
        token,
      })
    }
    if (existing) {
      return NextResponse.json(
        { ok: false, error: "That username is already taken." },
        { status: 409 },
      )
    }

    /* Wipe self-heal (2026-10-03): a rolled-back/restored db can arrive
     * with NO admin account at all (the operator seed may not have run,
     * or its account landed as a plain member) — locking everyone out of
     * every mod tool forever. When no admin exists, the FIRST account to
     * register claims owner. On a healthy box the seeded operator ("Veil",
     * admin) exists, so this never triggers. */
    const adminExists = await db.chatAccount.findFirst({
      where: { role: "admin" },
      select: { id: true },
    })
    const account = await db.chatAccount.create({
      data: {
        username,
        passwordHash,
        displayName: displayName || username,
        avatarColor: randomAvatarColor(),
        coins: 100,
        role: adminExists ? "member" : "admin",
      },
    })

    const token = makeToken(account)
    return NextResponse.json({
      ok: true,
      account: toPublicAccount(account),
      token,
    })
  } catch (err) {
    console.error("[chat-auth/register] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error during registration." },
      { status: 500 },
    )
  }
}
