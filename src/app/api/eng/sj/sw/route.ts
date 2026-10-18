/**
 * Veil — Scramjet engine service worker (served at /api/eng/sj/sw).
 *
 * Mirrors cherrion.top's worker: it imports the real controller
 * (controller.sw.js), takes over instantly (skipWaiting + clients.claim —
 * the stock controller also pings every client to revive controllers on
 * activation), and adds cherrion's escape catcher:
 *
 * A navigate-mode request from a controlled engine client whose URL is NOT
 * an engine URL would leave the proxy — a raw same-origin path 404s against
 * the app server (or boots the whole SPA inside the frame), a cross-origin
 * URL dumps the real site into the frame, unproxied. Instead, the worker
 * derives the client's frame prefix from its own (wrapped) URL and bounces
 * the navigation back into the engine with a 302. Same-origin escapes are
 * resolved against the site's real origin first (the site's own /path was
 * the intent, not the app's).
 *
 * Registered with scope "/eng/sj/", so the worker only ever controls the
 * engine lane — never the Veil app itself.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SW_SOURCE = `
importScripts("/eng/sj/controller/controller.sw.js");

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

/* Engine lanes: /eng/sj/~/… (main controller) and /eng/sj/~b/… (the
 * standalone boot lane). Under the lane marker sit one or more id segments
 * (frame id, client id, …) followed by the percent-encoded real URL — the
 * encoded URL never contains a literal "/", so the session prefix is simply
 * everything up to and including the LAST slash of the client's pathname. */
function sessionPrefixOf(pathname) {
  if (pathname.indexOf("/eng/sj/~/") !== 0 && pathname.indexOf("/eng/sj/~b/") !== 0) return null;
  return pathname.slice(0, pathname.lastIndexOf("/") + 1);
}

function isEngineUrl(url) {
  try {
    var u = new URL(url);
    return u.origin === self.location.origin && u.pathname.indexOf("/eng/sj/") === 0;
  } catch (e) {
    return true; /* unparsable — never touch */
  }
}

addEventListener("fetch", function (e) {
  if ($scramjetController.shouldRoute(e)) {
    e.respondWith($scramjetController.route(e));
    return;
  }
  var req = e.request;
  if (req.mode !== "navigate") return;
  try {
    var u = new URL(req.url);
  } catch (err) {
    return;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return;
  if (isEngineUrl(req.url)) return;

  e.respondWith(
    (async function () {
      try {
        var client = e.clientId ? await clients.get(e.clientId) : null;
        if (!client) return fetch(req);
        var cu = new URL(client.url);
        var prefix = sessionPrefixOf(cu.pathname);
        if (!prefix) return fetch(req);

        var target = req.url;
        if (u.origin === self.location.origin) {
          /* same-origin escape: the site meant ITS OWN origin, not ours —
             resolve the path against the wrapped site URL of this client. */
          try {
            var siteUrl = decodeURIComponent(cu.pathname.slice(prefix.length));
            if (siteUrl) {
              var site = new URL(siteUrl);
              target = new URL(u.pathname + u.search + u.hash, site.origin).href;
            }
          } catch (e2) {
            target = req.url;
          }
        }
        var loc = new URL(prefix + encodeURIComponent(target), self.location.origin).href;
        return Response.redirect(loc, 302);
      } catch (err2) {
        return fetch(req);
      }
    })()
  );
});
`;

export async function GET(): Promise<Response> {
  return new Response(SW_SOURCE, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "service-worker-allowed": "/eng/sj/",
      "cache-control": "no-store",
    },
  });
}
