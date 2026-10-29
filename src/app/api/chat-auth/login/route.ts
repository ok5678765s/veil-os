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

export async function POST(req: Request): Promise<Response> {
  return cors(await handleLogin(req))
}

async function handleLogin(req: Request): Promise<Response> {
  try {
    const body = await readJsonBody<{
      username?: string
      password?: string
    }>(req)
    if (!body) return badBody()

    const username = (body.username || "").trim()
    const password = body.password || ""

    if (!username || !password) {
      return NextResponse.json(
        { ok: false, error: "Username and password are required." },
        { status: 400 },
      )
    }

    // Case-insensitive username lookup (SQLite doesn't support mode: "insensitive")
    const allAccounts = await db.chatAccount.findMany({
      where: { username: { contains: username } },
      take: 20,
    })
    const account = allAccounts.find(
      (a) => a.username.toLowerCase() === username.toLowerCase(),
    )

    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid username or password." },
        { status: 401 },
      )
    }

    /* Restored-from-backup placeholder: the snapshot it came from predates
     * password hashing, so there is no password to compare — but the
     * account's messages, coins, role and friends are all intact. Instead
     * of bouncing the returning member to Register, LOG THEM IN directly
     * by claiming the account with the password they just typed (hashed,
     * stored, legacy flag cleared). Security is identical to the register
     * reclaim path — first claim wins — with none of the confusion. */
    if (account.legacy) {
      if (password.length < 6) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Welcome back! This account was restored from a backup — log in with any password of 6+ characters to reclaim it (your messages, coins and role are waiting).",
          },
          { status: 403 },
        )
      }
      const passwordHash = await bcrypt.hash(password, 10)
      const claimed = await db.chatAccount.update({
        where: { id: account.id },
        data: {
          passwordHash,
          legacy: false,
          coins: account.coins < 100 ? 100 : account.coins,
        },
      })
      const token = makeToken(claimed)
      return NextResponse.json({
        ok: true,
        reclaimed: true,
        account: toPublicAccount(claimed),
        token,
      })
    }

    const valid = await bcrypt.compare(password, account.passwordHash)
    if (!valid) {
      return NextResponse.json(
        { ok: false, error: "Invalid username or password." },
        { status: 401 },
      )
    }

    if (account.banned || account.ipBanned) {
      return NextResponse.json(
        {
          ok: false,
          error: account.banReason
            ? `You are banned: ${account.banReason}`
            : "You are banned.",
        },
        { status: 403 },
      )
    }

    const token = makeToken(account)
    return NextResponse.json({
      ok: true,
      account: toPublicAccount(account),
      token,
    })
  } catch (err) {
    console.error("[chat-auth/login] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error during login." },
      { status: 500 },
    )
  }
}
