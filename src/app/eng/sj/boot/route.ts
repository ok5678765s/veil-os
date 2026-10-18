/**
 * Veil — Scramjet engine boot page (/eng/sj/boot?target=<real url>).
 *
 * The POPUP / fallback lane of the Scramjet engine (the main lane is the
 * in-app controller from src/lib/veil/sj-engine.ts — cherrion.top's
 * architecture). This page runs a standalone controller with its OWN prefix
 * (/eng/sj/~b/) so a popup booting here can never displace the app's main
 * controller in the service worker's registry. Popups land here through the
 * server-side rescue route for wrapped URLs (src/app/eng/sj/~/...).
 *
 * The page:
 *   1. registers the engine service worker (/api/eng/sj/sw, scope /eng/sj/),
 *   2. probes which wisp transport reaches the wisp-relay mini-service
 *      (gateway query param first, direct localhost port second),
 *   3. boots the Scramjet controller over a libcurl-over-wisp transport
 *      with cherrion's HttpCache plugin for snappy repeat loads,
 *   4. creates the content frame and navigates it to the target URL,
 *   5. relays title/nav/mouse/esc messages to the Veil shell so a popup
 *      embedded inside the app keeps its tab wiring.
 *
 * The page renders edge-to-edge with zero chrome — visually indistinguishable
 * from the built-in engine's iframe.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(target: string, err?: string, noBoot?: boolean): string {
  const enc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${enc(target ? new URL(target).hostname : "Veil · Scramjet")}</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #09090b; overflow: hidden; }
  #content { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  #sj-status {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    font: 13.5px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #a1a1aa; background: #09090b; z-index: 10; text-align: center; padding: 24px;
  }
  #sj-status .bar { width: 180px; height: 3px; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,.08); position: relative; }
  #sj-status .bar::after {
    content: ""; position: absolute; inset: 0; width: 45%; border-radius: 999px;
    background: #34d399; animation: sjslide 1.1s ease-in-out infinite alternate;
  }
  @keyframes sjslide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
  #sj-status.err .bar { display: none; }
  #sj-status .retry {
    display: none; border: 0; border-radius: 10px; padding: 9px 18px; cursor: pointer;
    background: rgba(52,211,153,.14); color: #6ee7b7; font-weight: 600; font-size: 13px;
    outline: 1px solid rgba(52,211,153,.35);
  }
  #sj-status.err .retry { display: inline-block; }
  #sj-status code { color: #71717a; font-size: 11.5px; max-width: 480px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<div id="sj-status">
  <div class="bar"></div>
  <div id="sj-msg">Starting the Scramjet engine…</div>
  <button class="retry" type="button" onclick="location.reload()">Try again</button>
</div>
<iframe id="content" title="Scramjet engine content" allow="fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-read; clipboard-write; gamepad; keyboard-map" referrerpolicy="no-referrer"></iframe>

${noBoot ? "" : `<script src="/eng/sj/scramjet/scramjet.js"></script>
<script src="/eng/sj/controller/controller.api.js"></script>
<script src="/eng/sj/libcurl/index.js"></script>
<script src="/eng/sj/veil-plugins.js"></script>
<script>
(function () {
'use strict';
var TARGET = ${JSON.stringify(target)};
var statusEl = document.getElementById('sj-status');
var msgEl = document.getElementById('sj-msg');
var content = document.getElementById('content');
var lastReal = null, lastTitle = null, startedAt = Date.now();

function fail(msg) {
  statusEl.classList.add('err');
  msgEl.textContent = msg;
  try { window.parent.postMessage({ __veil: 1, type: 'error' }, '*'); } catch (e) {}
}

/* ---- wisp transport probe ------------------------------------------
   Candidate 1 (gateway): ws(s)://<this host>/?XTransformPort=3312 — works
   whenever the app is served through the sandbox gateway. NOTE: when the
   app is opened directly (localhost:3000) this URL hits the Next server,
   which answers HTML — the probe body is the discriminator.
   Candidate 2 (direct): ws://localhost:3312/ — same-machine access. */
function probeWisp() {
  var wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  /* The gateway lane's URL must END WITH "/" (the libcurl wisp client
   * enforces a trailing slash) while keeping XTransformPort parseable —
   * the trailing "&/" adds an empty, ignored query param. */
  var cands = [wsProto + '//' + location.host + '/?XTransformPort=3312&/'];
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    cands.push('ws://' + host + ':3312/');
  }
  var i = 0;
  function tryNext() {
    if (i >= cands.length) return Promise.resolve(cands[0]);
    var c = cands[i++];
    var probeUrl = c.replace(/^ws/, 'http');
    return fetch(probeUrl, { cache: 'no-store' })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, body: t }; }); })
      .then(function (res) {
        if (res.ok && res.body && res.body.indexOf('wisp-server-alive') !== -1) return c;
        return tryNext();
      })
      .catch(function () { return tryNext(); });
  }
  return tryNext();
}

/* ---- Veil shell message bridge ------------------------------------- */
function postUp(msg) {
  try { window.parent.postMessage(msg, '*'); } catch (e) {}
}
function realUrlOfFrame() {
  try {
    var href = content.contentWindow.location.href;
    /* only decode actual engine service URLs — transitional about:blank
     * frames (before the first navigation lands) must never surface as a
     * tab target (they used to hijack the tab into about:blank reloads) */
    if (!href || (href.indexOf(location.origin + '/eng/sj/~/') !== 0 && href.indexOf(location.origin + '/eng/sj/~b/') !== 0)) return null;
    if (typeof $scramjet !== 'undefined' && $scramjet && $scramjet.unrewriteUrl) {
      var real = $scramjet.unrewriteUrl(href);
      if (real && /^https?:\\/\\//.test(real)) return real;
    }
    return null;
  } catch (e) { return null; }
}
function pollFrame() {
  var real = realUrlOfFrame();
  var t = null;
  try { t = content.contentDocument ? content.contentDocument.title : null; } catch (e) {}
  if (real && real !== lastReal) {
    lastReal = real;
    postUp({ __veil: 1, type: 'nav', url: real, d: { title: t || '' } });
  } else if (t && t !== lastTitle) {
    lastTitle = t;
    postUp({ __veil: 1, type: 'title', d: { title: t } });
  }
}
setInterval(pollFrame, 900);

content.addEventListener('load', function () {
  statusEl.style.display = 'none';
  pollFrame();
});

/* control-bar reveal relay: mouse near the top edge of the engine frame */
window.addEventListener('mousemove', function (e) {
  if (e.clientY <= 120) postUp({ __veil: 1, type: 'mouse', d: { y: e.clientY } });
}, { passive: true });

/* Escape relay — the frame owns focus, the shell's own listener never fires */
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') postUp({ __veil: 1, type: 'esc' });
}, true);

/* ---- boot ----------------------------------------------------------- */
function boot() {
  if (typeof $scramjet === 'undefined' || typeof $scramjetController === 'undefined') {
    fail('The Scramjet engine assets did not load.');
    return;
  }
  var LibcurlClient = window.LibcurlTransport && window.LibcurlTransport.LibcurlClient;
  if (!LibcurlClient) {
    fail('The Scramjet transport (libcurl) did not load.');
    return;
  }
  msgEl.textContent = 'Registering the engine worker…';
  navigator.serviceWorker.register('/api/eng/sj/sw', { scope: '/eng/sj/' })
    .then(function (reg) {
      function withSW(sw) {
        msgEl.textContent = 'Connecting the tunnel…';
        probeWisp().then(function (wispUrl) {
          var transport;
          try {
            transport = new LibcurlClient({ wisp: wispUrl });
          } catch (e) {
            fail('The transport could not start: ' + (e && e.message ? e.message : e));
            return;
          }
          msgEl.textContent = 'Starting the controller…';
          var controller = new $scramjetController.Controller({
            serviceworker: sw,
            transport: transport,
            config: {
              /* the boot lane's OWN prefix — never collides with the main
               * in-app controller (/eng/sj/~/) in the worker's registry */
              prefix: '/eng/sj/~b/',
              scramjetPath: '/eng/sj/scramjet/scramjet.js',
              injectPath: '/eng/sj/controller/controller.inject.js',
              wasmPath: '/eng/sj/scramjet/scramjet.wasm'
            }
          });
          controller.ready.then(function () {
            msgEl.textContent = 'Opening ' + (function(){ try { return new URL(TARGET).hostname; } catch (e) { return 'the page'; } })() + '…';
            var plugins = [];
            try {
              var P = window.VeilSjPlugins;
              if (P) plugins.push(new P.HttpCachePlugin());
            } catch (e) {}
            var frame = controller.createFrame(content, plugins.length ? { plugins: plugins } : undefined);
            frame.go(TARGET);
            /* a stuck load surface after 30s — the retry button reloads */
            setTimeout(function () {
              if (statusEl.style.display !== 'none' && Date.now() - startedAt > 28000) {
                fail('The page did not render through the engine in time.');
              }
            }, 30000);
          }).catch(function (e) {
            fail('The engine controller failed: ' + (e && e.message ? e.message : e));
          });
        });
      }
      var sw = navigator.serviceWorker.controller;
      if (sw) { withSW(sw); return; }
      if (reg.active) { withSW(reg.active); return; }
      var installing = reg.installing || reg.waiting;
      if (!installing) { fail('No engine worker became available.'); return; }
      installing.addEventListener('statechange', function onState() {
        if (installing.state === 'activated') {
          installing.removeEventListener('statechange', onState);
          withSW(navigator.serviceWorker.controller || installing);
        }
      });
      navigator.serviceWorker.addEventListener('controllerchange', function once() {
        navigator.serviceWorker.removeEventListener('controllerchange', once);
        var c = navigator.serviceWorker.controller;
        if (c) withSW(c);
      }, { once: true });
    })
    .catch(function (e) {
      fail('The engine worker could not register: ' + (e && e.message ? e.message : e));
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
</script>`}
${err ? `<script>fail(${JSON.stringify(err)});</script>` : ""}
</body>
</html>`;
}

export async function GET(req: Request): Promise<Response> {
  const u = new URL(req.url);
  let target = u.searchParams.get("target") ?? "";
  let valid = false;
  if (target) {
    try {
      const parsed = new URL(target);
      valid = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    /* error variant — no boot script, nothing to navigate */
    return new Response(
      page(
        "",
        target ? "That target URL can't run through the Scramjet engine." : "No target URL was given to the Scramjet engine.",
        true,
      ),
      { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
    );
  }
  return new Response(page(target), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
