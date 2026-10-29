import { NextResponse } from "next/server";

/**
 * Veil — robust JSON body parsing for API routes.
 *
 * Empty / truncated / invalid POST bodies used to crash `await req.json()`
 * into each route's catch-all, surfacing as synthetic 500 "Server error"
 * responses + console noise. Real-world sources (seen in dev.log):
 *   · sends aborted mid-flight on page unload (fetch keepalive cut off)
 *   · browser extensions probing endpoints with zero-byte POSTs
 *   · double-submitted forms racing the first request's teardown
 *
 * readJsonBody() returns null for any of those; the caller answers with
 * badBody()'s clean 400 (a client problem, not a server problem).
 *
 * Accepts plain Request (chat-auth routes) and NextRequest alike.
 */

export async function readJsonBody<T extends object>(
  req: Request,
): Promise<T | null> {
  try {
    const text = await req.text();
    if (!text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Standard 400 for an unparseable request body. */
export function badBody(message = "Invalid or empty request body."): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}
