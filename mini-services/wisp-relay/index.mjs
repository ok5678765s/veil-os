/**
 * veil wisp-relay — wisp protocol server for the Scramjet engine (port 3312).
 *
 * The Scramjet proxy engine runs client-side (a service worker rewrites and
 * routes requests), but its network transport still needs a server-side
 * tunnel: the browser opens ONE WebSocket here and speaks the wisp protocol,
 * and this server dials the real TCP hosts on its behalf.
 *
 *   browser (Scramjet engine)  ⇄  Caddy gateway (?XTransformPort=3312)  ⇄  this service  ⇄  real hosts
 *
 * Reaching this service from the browser (tried in order by the boot page):
 *   1. wss://<gateway-host>/?XTransformPort=3312   — the sandbox gateway
 *   2. ws://localhost:3312/                        — direct port (same machine)
 *
 * A plain GET on any path answers 200 "wisp-server-alive" (CORS-open) so the
 * boot page can probe which transport works before constructing the
 * transport — Veil's own Next server would answer HTML on candidate 1 when
 * the app is accessed without the gateway, and the probe text is the
 * discriminator.
 *
 * Security posture: wisp-js defaults (private/loopback destination IPs
 * blocked, direct IP dialing allowed for real sites) — the SSRF surface
 * matches what Veil's own byte proxy allows.
 */

import http from "node:http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const PORT = 3312;

logging.set_level(logging.NONE);

const httpServer = http.createServer((req, res) => {
  // Probe/liveness answer — see header comment.
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end("wisp-server-alive");
});

httpServer.on("upgrade", (req, socket, head) => {
  try {
    wisp.routeRequest(req, socket, head);
  } catch (err) {
    console.error("[wisp-relay] upgrade failed:", String(err));
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
});

httpServer.on("error", (err) => {
  console.error("[wisp-relay] http server error:", String(err));
});

httpServer.listen(PORT, () => {
  console.log(`[wisp-relay] listening on :${PORT} — wisp tunnel for the Scramjet engine`);
});
