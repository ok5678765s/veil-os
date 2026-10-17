import { createHmac, timingSafeEqual, randomBytes } from "crypto"
import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { dirname } from "path"
import { db } from "@/lib/db"

/**
 * Session tokens are HMAC-SHA256 signed: base64url(payloadJSON) + "." + sig.
 * The payload carries the account's identity snapshot (id, username, display
 * name, avatar, role) so the realtime relay (mini-services/chat-service — a
 * separate process that cannot touch the DB) can trust the identity WITHOUT
 * any client-claimed fields. The signing secret lives in db/chat-secret.key,
 * shared with the relay (same box, mode 0600).
 *
 * This replaced the old base64(accountId) token, which was trivially
 * forgeable (anyone who saw an account id — e.g. from a presence broadcast —
 * could mint a working "token" for it, including the admin's).
 */

export type SessionPayload = {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  role: "member" | "moderator" | "admin"
  iat: number
  exp: number // epoch ms — 30 days
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/* 2026-10-10 "it keeps signing me out of chat" fix — the secret is now
 * REVERT-PROOF. Root cause: platform rollbacks periodically lose
 * db/chat-secret.key (a 13:10 snapshot literally captured it missing); the
 * old self-heal then MINTED a fresh secret on the next login, which
 * instantly invalidated every token in every browser ("mass sign-out").
 * Now the secret is triple-homed:
 *   1. db/chat-secret.key          — live copy (also inside tar snapshots)
 *   2. upload/veil-kit/chat-secret.key — SPARE on the revert-proof volume
 *      (same place the GitHub PAT survives; keeper re-syncs every 90s)
 *   3. the running process cache   — always the truth for LIVE sessions
 * Precedence: mid-run, the in-use cache wins (it signed every token that
 * currently works) and both files are re-synced to it. On boot, the spare
 * wins over db/ (a rollback can only make db/ STALE, while the spare is
 * written only by mints + seeding, so it is always freshest-or-equal).
 * A mint now happens only when BOTH copies are gone. */
const SECRET_PATH = "/home/z/my-project/db/chat-secret.key"
const SECRET_SPARE_PATH = "/home/z/my-project/upload/veil-kit/chat-secret.key"
let cachedSecret: Buffer | null = null
let secretMtimeMs = 0

function readSecretFile(path: string): string | null {
  try {
    const txt = readFileSync(path, "utf-8").trim()
    return txt.length >= 32 ? txt : null
  } catch {
    return null
  }
}

function writeSecretFile(path: string, txt: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, txt + "\n", { mode: 0o600 })
  } catch {
    /* best-effort — the other copy + memory cache still carry the secret */
  }
}

function adoptSecret(txt: string): Buffer {
  cachedSecret = Buffer.from(txt, "utf-8")
  try {
    secretMtimeMs = statSync(SECRET_PATH).mtimeMs
  } catch {
    secretMtimeMs = 0
  }
  return cachedSecret
}

function sessionSecret(): Buffer {
  if (cachedSecret) {
    /* Live rollback watch — stat is ~µs; token verify stays hot-path safe.
     * If db/chat-secret.key changed under us (platform rollbacks rewrite
     * the tree mid-run), reconcile WITHOUT dropping the in-use secret: the
     * cache is what every working token verifies against. */
    try {
      const m = statSync(SECRET_PATH).mtimeMs
      if (m !== secretMtimeMs) {
        const cur = readSecretFile(SECRET_PATH)
        if (cur !== null && cur === cachedSecret.toString("utf-8")) {
          secretMtimeMs = m // same secret, new mtime (touch/restore) — noop
        } else {
          // db diverged from the in-use secret. Re-assert the cache as the
          // source of truth on BOTH copies so the next boot + the relay +
          // future rollbacks all converge on the secret live sessions use.
          const live = cachedSecret.toString("utf-8")
          writeSecretFile(SECRET_PATH, live)
          writeSecretFile(SECRET_SPARE_PATH, live)
          secretMtimeMs = 0 // re-stat on next call (file just rewritten)
          console.warn(
            "[chat-auth] db/chat-secret.key changed under us (rollback?) — re-asserted the live secret on db + spare",
          )
        }
      }
    } catch {
      /* stat failed (transient) — keep serving from cache */
    }
    return cachedSecret
  }

  /* ---- boot path: reconcile the two persisted copies, mint only if both
   * are gone. The SPARE wins on mismatch: it lives on the revert-proof
   * volume and is only ever written by seeding/mints, so a mismatch means
   * db/ was rolled back to something stale. ---- */
  const dbSecret = readSecretFile(SECRET_PATH)
  const spareSecret = readSecretFile(SECRET_SPARE_PATH)

  if (dbSecret && spareSecret && dbSecret !== spareSecret) {
    console.warn(
      "[chat-auth] db secret != spare (rollback) — restoring db from the revert-proof spare (existing sessions survive)",
    )
    writeSecretFile(SECRET_PATH, spareSecret)
    return adoptSecret(spareSecret)
  }
  if (dbSecret) {
    // healthy boot (or first run of this fix) — make sure the spare exists
    if (!spareSecret) writeSecretFile(SECRET_SPARE_PATH, dbSecret)
    return adoptSecret(dbSecret)
  }
  if (spareSecret) {
    // db copy lost (rollback) but the spare survived — RESTORE, not mint.
    console.warn(
      "[chat-auth] db/chat-secret.key missing — restored from upload/veil-kit spare (no sign-outs)",
    )
    writeSecretFile(SECRET_PATH, spareSecret)
    return adoptSecret(spareSecret)
  }

  /* Both copies gone — the only path that still mints. Spare first, then
   * db, so a crash between writes leaves the spare freshest-or-equal. */
  const txt = randomBytes(48).toString("hex")
  writeSecretFile(SECRET_SPARE_PATH, txt)
  writeSecretFile(SECRET_PATH, txt)
  console.warn(
    "[chat-auth] chat-secret.key lost everywhere — minted a new one (users sign in once more)",
  )
  return adoptSecret(txt)
}

function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url")
}

function fromB64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8")
}

function sign(data: string): string {
  return createHmac("sha256", sessionSecret()).update(data).digest("base64url")
}

export function makeToken(a: {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  role: string
}): string {
  const payload: SessionPayload = {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    avatarColor: a.avatarColor,
    avatarImage: a.avatarImage,
    role: ("member moderator admin".split(" ").includes(a.role)
      ? a.role
      : "member") as SessionPayload["role"],
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS,
  }
  const body = b64url(JSON.stringify(payload))
  return body + "." + sign(body)
}

/** Verify a token's signature + expiry. Returns the account id, or null for
 *  any bad/legacy/expired token. Old base64 tokens fail here by design. */
export function parseToken(token: string | undefined | null): string | null {
  const p = verifySessionToken(token)
  return p ? p.id : null
}

/** Full-payload verification (signature + expiry). Shared format with the
 *  chat relay, which re-implements the same HMAC check locally. */
export function verifySessionToken(
  token: string | undefined | null,
): SessionPayload | null {
  if (!token || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [body, sig] = parts
  if (!body || !sig) return null
  let expected: string
  try {
    expected = sign(body)
  } catch {
    return null
  }
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(fromB64url(body)) as SessionPayload
    if (!payload || typeof payload.id !== "string" || !payload.id) return null
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null
    if (typeof payload.username !== "string" || !payload.username) return null
    return payload
  } catch {
    return null
  }
}

export type ChatAccountPublic = {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  bio: string
  role: "member" | "moderator" | "admin"
  muted: boolean
  banned: boolean
  banReason: string | null
  ipBanned: boolean
  coins: number
  tag: string | null
  tagColor: string | null
  pfpAccessory: string | null
  /** purchased PFP overlay decoration id ("hearts", "flames", …) */
  pfpOverlay: string | null
  /** true while this row is a restored-from-backup placeholder awaiting
   * re-registration (see register route's legacy reclaim path). */
  legacy: boolean
  createdAt: Date
}

export function toPublicAccount(a: {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  bio: string
  role: string
  muted: boolean
  banned: boolean
  banReason: string | null
  ipBanned: boolean
  coins: number
  tag?: string | null
  tagColor?: string | null
  pfpAccessory?: string | null
  pfpOverlay?: string | null
  legacy?: boolean
  createdAt: Date
}): ChatAccountPublic {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    avatarColor: a.avatarColor,
    avatarImage: a.avatarImage,
    bio: a.bio,
    role: (["member", "moderator", "admin"].includes(a.role)
      ? a.role
      : "member") as ChatAccountPublic["role"],
    muted: a.muted,
    banned: a.banned,
    banReason: a.banReason,
    ipBanned: a.ipBanned,
    coins: typeof a.coins === "number" ? a.coins : 0,
    tag: a.tag ?? null,
    tagColor: a.tagColor ?? null,
    pfpAccessory: a.pfpAccessory ?? null,
    pfpOverlay: a.pfpOverlay ?? null,
    legacy: a.legacy ?? false,
    createdAt: a.createdAt,
  }
}

// Returns the account row (full) or null if token invalid/banned.
// Role/mute state is ALWAYS re-read from the DB here (token role is only a
// snapshot for the realtime relay — never a privilege source for APIs).
export async function getAccountFromToken(
  token: string | undefined | null,
) {
  const id = parseToken(token)
  if (!id) return null
  const account = await db.chatAccount.findUnique({ where: { id } })
  if (!account) return null
  if (account.banned || account.ipBanned) return null
  return account
}
