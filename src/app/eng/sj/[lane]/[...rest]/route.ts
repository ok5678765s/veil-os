/**
 * Veil — Scramjet engine popup rescue (both engine URL lanes).
 *
 * Wrapped engine URLs (/eng/sj/~/{frameId}/{encoded} and /eng/sj/~b/…) are
 * normally intercepted by the engine service worker and never reach the app
 * server. They DO reach it when a browsing context isn't controlled by the
 * worker — the classic case being window.open() from inside a proxied page
 * (cherrion.top handles this with its SPA fallback; Veil redirects to the
 * standalone boot lane instead, which boots its own controller and loads the
 * target). Without this route those popups would 404.
 *
 * The [lane] segment only ever matches "~" or "~b" — anything else 404s.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function rescue(req: Request): Response {
  const u = new URL(req.url);
  /* /eng/sj/{lane}/{ids…}/{encoded target} — under the lane marker sit one
   * or more id segments (frame id, client id, …) and then the percent-encoded
   * real URL, which never contains a literal "/" — so the encoded target is
   * simply the LAST path segment (the lane marker itself is validated by the
   * regex; anything else 404s). */
  const laneOk = /^\/eng\/sj\/~b?\//.test(u.pathname);
  const encoded = laneOk ? u.pathname.slice(u.pathname.lastIndexOf("/") + 1) : "";
  let target = "";
  try {
    target = decodeURIComponent(encoded);
  } catch {
    target = "";
  }
  if (target && u.search) target += u.search;
  const notFound = (why: string) =>
    new Response(`Veil engine: ${why}`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  if (!laneOk) {
    return notFound("unknown engine lane");
  }
  if (!/^https?:\/\//i.test(target)) {
    return notFound("this engine URL doesn't carry a resolvable target");
  }
  const dest = new URL(`/eng/sj/boot?target=${encodeURIComponent(target)}`, u.origin);
  return new Response(null, {
    status: 302,
    headers: { location: `${dest.pathname}${dest.search}`, "cache-control": "no-store" },
  });
}

export async function GET(req: Request): Promise<Response> {
  return rescue(req);
}

/* form submissions can arrive as POST navigations — the 302 turns them into
 * plain GET loads of the target through the boot lane. */
export async function POST(req: Request): Promise<Response> {
  return rescue(req);
}
