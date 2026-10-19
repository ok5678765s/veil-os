/**
 * Quasar Session API — optional password gate.
 *   GET  /api/session -> { authRequired: boolean, ok: boolean, boot: number }
 *   POST /api/session { password } -> sets the signed session cookie (7d)
 *
 * Only active when the QUASAR_PASSWORD environment variable is set. The
 * cookie holds HMAC-SHA256(password, salt) with the salt from .quasar-key.
 *
 * `boot` is this server process's start time (epoch ms) — the client's
 * boot guard (src/lib/veil/boot-guard.ts) watches it to self-heal tabs
 * that outlive a dev-server restart with a stale bundle.
 */

import { NextRequest } from "next/server";
import { SESSION_COOKIE, authRequired, checkPassword, isAuthedRequest } from "@/lib/veil/quasar/auth";
import { sessionTokenFor } from "@/lib/veil/quasar/codec-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-PROCESS boot stamp — changes only on a real server restart.
 *
 * ROBUSTNESS HISTORY: this used to be a plain `Date.now()` at module
 * scope. In dev mode Next.js INVALIDATES and re-evaluates route modules
 * constantly (every file change, every on-demand route compile — e.g.
 * a NEW PLAYER opening the site compiles routes for the first time),
 * which gave the stamp a NEW value with NO actual restart → every open
 * tab's boot guard saw a "restart", and the site reload-looped to the
 * home page "constantly" (2026-10-19 report).
 *
 * The fix is two-layered:
 *   1. The value is DERIVED from the process (Date.now() minus
 *      process.uptime()), so every re-evaluation recomputes the SAME
 *      number — the process's actual start time.
 *   2. It is cached on globalThis, which SURVIVES module re-evaluation
 *      (only the module scope re-runs; the global object persists for
 *      the whole process lifetime) — so even sub-millisecond jitter
 *      between the two clock reads can never flip the stamp.
 * On a REAL restart the new process has a fresh uptime → a genuinely
 * different stamp, and the client's boot guard reloads as designed. */
const BOOT_GLOBAL = globalThis as typeof globalThis & {
  __veilBootStamp?: number;
};
const BOOTED_AT: number = (BOOT_GLOBAL.__veilBootStamp ??=
  Date.now() - Math.floor(process.uptime() * 1000));

export async function GET(req: NextRequest): Promise<Response> {
  const required = authRequired();
  return Response.json({
    authRequired: required,
    ok: required ? isAuthedRequest(req) : true,
    boot: BOOTED_AT,
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authRequired()) {
    return Response.json({ ok: true, authRequired: false });
  }
  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad-json" }, { status: 400 });
  }
  if (!checkPassword(body.password)) {
    return Response.json({ error: "wrong-password" }, { status: 401 });
  }
  const res = Response.json({ ok: true, authRequired: true });
  res.headers.append(
    "set-cookie",
    `${SESSION_COOKIE}=${sessionTokenFor(String(body.password))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
  );
  return res;
}
