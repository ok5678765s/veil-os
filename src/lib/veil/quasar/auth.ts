/**
 * Quasar Auth — optional password gate.
 * Enabled by setting the QUASAR_PASSWORD environment variable. The session
 * cookie holds HMAC-SHA256(password, salt) where the salt lives in
 * .quasar-key, so the cookie value is not reusable across deployments.
 */

import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { sessionTokenFor } from "./codec-server";

export const SESSION_COOKIE = "quasar_session";

export function authRequired(): boolean {
  return !!process.env.QUASAR_PASSWORD;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function checkPassword(pw: unknown): boolean {
  const expected = process.env.QUASAR_PASSWORD;
  if (!expected || typeof pw !== "string") return false;
  return safeEqual(pw, expected);
}

export function isAuthedRequest(req: NextRequest): boolean {
  const expected = sessionTokenFor(process.env.QUASAR_PASSWORD ?? "");
  // v2.3.7 — beyond the cookie, the session token may arrive as a header or a
  // query param so the single-file "Quasar Portable" client (which cannot rely
  // on cross-site cookies from file:// or another origin) can attach to a
  // gated server. The token is identical to the cookie value and is only
  // handed out by POST /api/session after a correct password.
  const supplied =
    req.cookies.get(SESSION_COOKIE)?.value ||
    req.headers.get("x-quasar-token") ||
    new URL(req.url).searchParams.get("qk") ||
    "";
  if (!supplied) return false;
  return safeEqual(supplied, expected);
}
