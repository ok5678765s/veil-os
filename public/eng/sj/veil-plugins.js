/**
 * Veil — Scramjet engine plugin suite (cherrion.top parity).
 *
 * Clean-room port of the readable plugin layer cherrion.top ships on top of
 * Scramjet 2.0.67-alpha.2 (their `proxy-runtime` asset), adapted to the stock
 * globals ($scramjet / $scramjetController) Veil serves from /eng/sj/.
 *
 * Plugins are installed PER FRAME via `controller.createFrame(el, { plugins })`:
 *
 *   - EventHandlerPlugin   — "always last" event-listener machinery a site
 *                            can't defeat with stopPropagation (cherrion's
 *                            event-handler).
 *   - HttpCachePlugin      — Cache-API-backed HTTP cache honoring cache-control,
 *                            max-age / s-maxage / immutable / age — repeat
 *                            visits serve subresources instantly (cherrion's
 *                            _xd1n9s8-http-cache).
 *   - UrlWatcherPlugin     — onUrlChange on every top-level navigation +
 *                            hashchange (cherrion's url-watcher).
 *   - LinkHandlerPlugin    — target=_blank / middle-click on anchors →
 *                            onNewTab(href) so the app opens them as real
 *                            in-app tabs (cherrion's link-handler).
 *   - VeilShellPlugin      — Veil's own shell relays: mouse-near-top reveal,
 *                            Escape, and document.title tracking for the tab
 *                            strip (replaces the boot page's 900ms poller).
 *
 * Load AFTER scramjet.js, controller.api.js (libcurl not required).
 */
(function () {
  "use strict";
  if (window.VeilSjPlugins) return;

  var RUNTIME = window.$scramjet;
  var CONTROLLER = window.$scramjetController;
  if (!RUNTIME || !CONTROLLER) {
    throw new Error("veil-plugins: load scramjet.js and controller.api.js first");
  }
  var ManagedPlugin = CONTROLLER.ManagedPlugin;
  var BareResponse = RUNTIME.BareResponse;

  /* =====================================================================
   * setupAlwaysLastBubble — cherrion proxy-runtime module "event machinery".
   *
   * Wraps the realm's EventTarget.prototype.addEventListener so listeners
   * registered for the captured types are tracked, then installs a NATIVE
   * listener (outside the realm's proxies) that fires our callback after the
   * site's own listeners no matter what — even stopPropagation /
   * stopImmediatePropagation from site code gets deferred past our turn.
   * ===================================================================== */
  function setupAlwaysLastBubble(client, types) {
    var currentlyExecutingDesc = null;
    var descs = new Map();

    client.Proxy("EventTarget.prototype.addEventListener", {
      apply: function (hook) {
        var type = hook.args[0];
        var cb = hook.args[1];
        var opts = hook.args[2];
        var target = hook.this;
        if (
          !types.includes(type) ||
          (typeof opts === "boolean" && opts) ||
          (typeof opts === "object" && opts && opts.capture)
        ) {
          return;
        }
        hook.args[1] = function () {
          var args = Array.prototype.slice.call(arguments);
          var list = descs.get(target);
          var desc = list ? list.find(function (d) { return d.originalcb === cb; }) : null;
          currentlyExecutingDesc = desc;
          if (typeof cb === "function") {
            Reflect.apply(cb, this, args);
          } else if (cb && typeof cb === "object" && typeof cb.handleEvent === "function") {
            Reflect.apply(cb.handleEvent, cb, args);
          }
          if (desc && desc.injectafter) {
            desc.injectafter(args[0]);
            delete desc.injectafter;
          }
          currentlyExecutingDesc = null;
        };
        var d = { originalcb: cb, type: type };
        if (descs.has(target)) descs.get(target).push(d);
        else descs.set(target, [d]);
      },
    });

    return function (target, type, cb) {
      var wrapped = function (e) {
        /* hand the event the realm's real stop* fns back before our turn */
        e.stopPropagation = client.natives.store["Event.prototype.stopPropagation"];
        e.stopImmediatePropagation = client.natives.store["Event.prototype.stopImmediatePropagation"];
        cb(e);
      };
      client.natives.call("EventTarget.prototype.addEventListener", target, type, function (e) {
        var desc;
        var path = e.composedPath ? e.composedPath() : [e.target];
        for (var i = 0; i < path.length; i++) {
          var list = descs.get(path[i]);
          if (list) {
            var filtered = list.filter(function (d) { return d.type === type; });
            desc = filtered[filtered.length - 1];
          }
        }
        if (desc) desc.injectafter = function (ev) { wrapped(ev); };
        else wrapped(e);
        client.RawProxy(e, "stopImmediatePropagation", {
          apply: function () {
            if (!currentlyExecutingDesc) throw new Error("stopImmediatePropagation called but no desc found?");
            currentlyExecutingDesc.injectafter = function (ev) { wrapped(ev); };
          },
        });
        client.RawProxy(e, "stopPropagation", {
          apply: function (hook2) {
            var t = hook2.this;
            if (!t.target) throw new Error("no target");
            var list = descs.get(t.target);
            if (!list) throw new Error("no descs found in stopPropagation()");
            var idx = list.indexOf(currentlyExecutingDesc);
            if (idx === -1) throw new Error("couldn't find currentlyExecutingDesc");
            var rest = list.slice(idx + 1);
            if (rest.length > 0) rest[rest.length - 1].injectafter = function (ev) { wrapped(ev); };
          },
        });
      });
    };
  }

  /* =====================================================================
   * EventHandlerPlugin — cherrion's "event-handler": owns the bubble
   * machinery per realm; other plugins ask it to register bulletproof
   * listeners via addEventListener(el, type, cb).
   * ===================================================================== */
  class EventHandlerPlugin extends ManagedPlugin {
    constructor(options) {
      super("event-handler", []);
      this.options = options || {};
      this.addAlwaysLastEventListeners = new Map();
      this.eventsToCapture = [];
    }
    install(controller) {
      super.install(controller);
      this.tap(controller.hooks.init.post, (ctx) => {
        this.addAlwaysLastEventListeners.set(ctx.window, setupAlwaysLastBubble(ctx.client, this.eventsToCapture));
      });
    }
    addEventToCapture(type) {
      if (!this.eventsToCapture.includes(type)) this.eventsToCapture.push(type);
    }
    getWindow(el) {
      if (!el) return null;
      if (el.ownerDocument && el.ownerDocument.defaultView) return el.ownerDocument.defaultView;
      if (el.constructor && el.constructor.constructor) {
        try {
          return new el.constructor.constructor("return globalThis")();
        } catch (e) {
          return null;
        }
      }
      return null;
    }
    addEventListener(el, type, cb) {
      var win = this.getWindow(el);
      if (!win) return;
      var add = this.addAlwaysLastEventListeners.get(win);
      if (!add) throw new Error("somehow the realm of the target never had addAlwaysLastEventListener installed");
      add(el, type, cb);
    }
  }

  /* =====================================================================
   * HttpCachePlugin — cherrion's "_xd1n9s8-http-cache": a real HTTP cache
   * inside the engine, backed by the Cache API. GET/HEAD responses with
   * cacheable statuses are stored with an x-sj-cached-at marker; fresh
   * entries are served instantly on revisit (max-age / s-maxage / immutable
   * semantics honored, age header maintained, Vary: * respected).
   * ===================================================================== */
  var CACHE_NAME_DEFAULT = "veil-sj-http-cache-v1";
  var CACHED_AT = "x-sj-cached-at";
  var CACHEABLE_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501]);
  var NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

  function parseCacheControl(header) {
    var out = {};
    if (!header) return out;
    var parts = String(header).split(",");
    for (var i = 0; i < parts.length; i++) {
      var raw = parts[i].trim();
      if (!raw) continue;
      var eq = raw.indexOf("=");
      var key = (eq === -1 ? raw : raw.slice(0, eq)).trim().toLowerCase();
      var val = eq === -1 ? "" : raw.slice(eq + 1).trim();
      if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') val = val.slice(1, -1);
      if (key === "max-age" || key === "s-maxage" || key === "stale-while-revalidate" || key === "stale-if-error") {
        var n = parseInt(val, 10);
        if (Number.isFinite(n) && n >= 0) out[key] = n;
      } else {
        out[key] = true;
      }
    }
    return out;
  }

  function isCacheableMethod(method) {
    return method === "GET" || method === "HEAD";
  }

  function cacheKeyFor(url, initialHeaders) {
    var headers = new Headers();
    if (initialHeaders) {
      var raw = initialHeaders.toRawHeaders ? initialHeaders.toRawHeaders() : [];
      for (var i = 0; i < raw.length; i++) {
        try { headers.append(raw[i][0], raw[i][1]); } catch (e) { /* skip bad header */ }
      }
    }
    return new Request("https://sj-cache.invalid/" + encodeURIComponent(url), {
      method: "GET",
      headers: headers,
    });
  }

  function headersFromRaw(rawHeaders) {
    var headers = new Headers();
    if (rawHeaders) {
      for (var i = 0; i < rawHeaders.length; i++) {
        try { headers.append(rawHeaders[i][0], rawHeaders[i][1]); } catch (e) { /* skip */ }
      }
    }
    return headers;
  }

  function freshnessLifetime(headers, cc, cachedAt) {
    if (cc["s-maxage"] !== undefined) return cc["s-maxage"];
    if (cc["max-age"] !== undefined) return cc["max-age"];
    var expires = headers.get("expires");
    if (expires) {
      var t = Date.parse(expires);
      if (Number.isFinite(t)) return Math.max(0, (t - cachedAt) / 1000);
    }
    var lastModified = headers.get("last-modified");
    if (lastModified) {
      var lm = Date.parse(lastModified);
      if (Number.isFinite(lm) && lm <= cachedAt) return ((cachedAt - lm) * 0.1) / 1000;
    }
    return null;
  }

  class HttpCachePlugin extends ManagedPlugin {
    constructor(options) {
      super("http-cache", []);
      options = options || {};
      this.cacheName = options.cacheName != null ? options.cacheName : CACHE_NAME_DEFAULT;
      this.cachePromise = null;
      this.cameFromCache = new WeakMap();
    }
    openCache() {
      if (!this.cachePromise) this.cachePromise = caches.open(this.cacheName);
      return this.cachePromise;
    }
    install(controller) {
      super.install(controller);
      var self = this;
      var fetchHooks = controller.fetchHandler.hooks.fetch;

      /* request side: serve a fresh cached copy without touching the tunnel */
      this.tap(fetchHooks.request, async function (ctx, trap) {
        var request = ctx.request;
        if (!isCacheableMethod(request.method)) return;
        var cacheMode = request.cache;
        if (cacheMode === "no-store" || cacheMode === "reload" || trap.earlyResponse) return;

        var cached = await (await self.openCache()).match(cacheKeyFor(ctx.parsed.url.href, request.initialHeaders));
        if (!cached) return;

        var cachedAt = parseInt(cached.headers.get(CACHED_AT) || "0", 10);
        var cc = parseCacheControl(cached.headers.get("cache-control"));
        var pragmaNoCache = (cached.headers.get("pragma") || "").toLowerCase().includes("no-cache");
        var mustRevalidate = cc["no-cache"] === true || pragmaNoCache || cacheMode === "no-cache";

        var dateMs = (function () {
          var d = cached.headers.get("date");
          if (d) {
            var t = Date.parse(d);
            if (Number.isFinite(t)) return t;
          }
          return cachedAt || Date.now();
        })();

        var ageHeader = parseInt(cached.headers.get("age") || "0", 10) || 0;
        var apparentAge = (Date.now() - cachedAt) / 1000;
        var currentAge = ageHeader + apparentAge;
        var immutable = cc.immutable === true && cacheMode !== "no-cache" && cacheMode !== "reload";
        var lifetime = freshnessLifetime(cached.headers, cc, dateMs);

        var fresh = (!mustRevalidate && lifetime !== null && currentAge < lifetime) || immutable;
        if (!fresh) return;

        var outHeaders = new Headers();
        var entries = cached.headers.entries();
        var entry = entries.next();
        while (!entry.done) {
          if (entry.value[0].toLowerCase() !== CACHED_AT) {
            try { outHeaders.append(entry.value[0], entry.value[1]); } catch (e) { /* skip */ }
          }
          entry = entries.next();
        }
        if (cachedAt) outHeaders.set("age", String(Math.floor((Date.now() - cachedAt) / 1000)));

        var body = NULL_BODY_STATUS.has(cached.status) ? null : await cached.arrayBuffer();
        var response = BareResponse.fromNativeResponse(
          new Response(body, { status: cached.status, statusText: cached.statusText, headers: outHeaders })
        );
        self.cameFromCache.set(request, true);
        trap.earlyResponse = response;
      });

      /* response side: store cacheable responses (after unmasking the body) */
      this.tap(fetchHooks.preresponse, async function (ctx, trap) {
        if (self.cameFromCache.has(ctx.request)) {
          self.cameFromCache.delete(ctx.request);
          return;
        }
        if (ctx.request.cache === "no-store" || !isCacheableMethod(ctx.request.method)) return;

        var rawHeaders = headersFromRaw(trap.response.rawHeaders);
        var storable =
          CACHEABLE_STATUS.has(trap.response.status) &&
          !parseCacheControl(rawHeaders.get("cache-control"))["no-store"];
        if (!storable) return;
        var vary = rawHeaders.get("vary");
        if (vary && vary.split(",").some(function (v) { return v.trim() === "*"; })) return;

        /* buffer the body so the cache copy and the live response both work */
        var status = trap.response.status;
        var nullBody = NULL_BODY_STATUS.has(status);
        var bodyBuffer = nullBody ? null : await trap.response.arrayBuffer();
        trap.response = BareResponse.fromNativeResponse(
          new Response(bodyBuffer, { status: status, statusText: trap.response.statusText, headers: rawHeaders })
        );

        var storeHeaders = new Headers(rawHeaders);
        storeHeaders.set(CACHED_AT, String(Date.now()));
        var storeResponse = new Response(nullBody ? null : bodyBuffer, {
          status: status,
          statusText: trap.response.statusText,
          headers: storeHeaders,
        });
        try {
          await (await self.openCache()).put(cacheKeyFor(ctx.parsed.url.href, ctx.request.initialHeaders), storeResponse);
        } catch (e) {
          /* cache quota / private mode — caching is best effort */
        }
      });
    }
    async bust() {
      try {
        this.cachePromise = null;
        return await caches.delete(this.cacheName);
      } catch (e) {
        return false;
      }
    }
  }

  /* =====================================================================
   * UrlWatcherPlugin — cherrion's "url-watcher": fires onUrlChange on the
   * initial load, every top-level navigation (via the client's lifecycle
   * hook) and hashchange. The instant, event-driven replacement for the
   * old 900ms URL poller.
   * ===================================================================== */
  class UrlWatcherPlugin extends ManagedPlugin {
    constructor(onUrlChange, options) {
      super("url-watcher", []);
      this.onUrlChange = onUrlChange;
      this.options = options || {};
    }
    install(controller) {
      var self = this;
      this.tap(controller.hooks.init.post, function (ctx) {
        if (!ctx.isTopLevel) return;
        var fire = function () {
          try {
            self.onUrlChange(ctx.client.url.href);
          } catch (e) {
            /* shell callback must never break a page */
          }
        };
        fire();
        self.tap(ctx.client.hooks.lifecycle.navigate, function (navCtx, nav) {
          try {
            self.onUrlChange(nav.url);
          } catch (e) {
            /* ignore */
          }
        });
        ctx.window.addEventListener("hashchange", fire, { capture: true });
      });
    }
  }

  /* =====================================================================
   * LinkHandlerPlugin — cherrion's "link-handler", Veil-tuned: anchors
   * that would pop OUT of the app (target=_blank, rel=external, ctrl/cmd
   * click, middle click) open as IN-APP TABS instead of broken popups.
   * Plain left-clicks navigate the tab naturally (the runtime rewrites the
   * href; UrlWatcher keeps the tab bar in sync). Registered through the
   * event-handler machinery so site code can't swallow the click first.
   * Anchors are wired shortly after they appear (the 2s grace mirrors
   * cherrion, letting site handlers register first so ours run truly last).
   * ===================================================================== */
  class LinkHandlerPlugin extends ManagedPlugin {
    constructor(onNewTab, options) {
      super("link-handler", ["event-handler"]);
      this.onNewTab = onNewTab;
      this.options = options || {};
    }
    install(controller) {
      var self = this;
      this.tap(
        controller.hooks.init.post,
        function (ctx) {
          var eventHandler = null;
          for (var i = 0; i < controller.plugins.length; i++) {
            if (controller.plugins[i].name === "event-handler") {
              eventHandler = controller.plugins[i];
              break;
            }
          }
          if (!eventHandler) return;
          var wire = function (a) {
            var open = function () {
              try {
                var href = a.href;
                if (href) self.onNewTab(href);
              } catch (e) {
                /* ignore */
              }
            };
            var wantsTab = function (e) {
              if (e.metaKey || e.ctrlKey) return true;
              var t = a.target;
              if (typeof t === "string" && t && !/^(?:_self|_parent|_top)$/i.test(t)) return true;
              var rel = typeof a.rel === "string" ? a.rel : "";
              return /(?:^|\s)external(?:\s|$)/i.test(rel);
            };
            eventHandler.addEventListener(a, "click", function (e) {
              if (e.button !== 0) return;
              if (!wantsTab(e)) return; /* plain click navigates naturally */
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              open();
            });
            eventHandler.addEventListener(a, "auxclick", function (e) {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              open();
            });
          };
          var wireAll = function () {
            try {
              ctx.window.document.querySelectorAll("a[href]").forEach(wire);
            } catch (e) {
              /* document mid-teardown */
            }
          };
          setTimeout(wireAll, 2000);
          try {
            var MO = ctx.window.MutationObserver || window.MutationObserver;
            new MO(function (mutations) {
              mutations.forEach(function (m) {
                setTimeout(function () {
                  m.addedNodes.forEach(function (n) {
                    if (n && n.tagName === "A") wire(n);
                  });
                }, 2000);
              });
            }).observe(ctx.window.document, { childList: true, subtree: true });
          } catch (e) {
            /* observer unavailable — initial wiring still applied */
          }
        },
        { after: ["event-handler"] }
      );
    }
  }

  /* =====================================================================
   * VeilShellPlugin — Veil's own shell relays, running inside the proxied
   * realm: mouse-near-top (control bar reveal), Escape (leave browse mode)
   * and document.title tracking (tab strip + history titles).
   * ===================================================================== */
  class VeilShellPlugin extends ManagedPlugin {
    constructor(handlers) {
      super("veil-shell", []);
      this.handlers = handlers || {};
    }
    install(controller) {
      var self = this;
      this.tap(controller.hooks.init.post, function (ctx) {
        if (!ctx.isTopLevel) return;
        try {
          ctx.window.addEventListener(
            "mousemove",
            function (e) {
              if (e.clientY <= 120 && self.handlers.onMouseNearTop) self.handlers.onMouseNearTop(e.clientY);
            },
            { capture: true, passive: true }
          );
        } catch (e) {
          /* ignore */
        }
        try {
          ctx.window.addEventListener(
            "keydown",
            function (e) {
              if (e.key === "Escape" && self.handlers.onEscape) self.handlers.onEscape();
            },
            { capture: true }
          );
        } catch (e) {
          /* ignore */
        }
        try {
          var doc = ctx.window.document;
          var fire = function () {
            try {
              var t = doc.title || "";
              if (self.handlers.onTitle) self.handlers.onTitle(t);
            } catch (e) {
              /* ignore */
            }
          };
          fire();
          var MO = ctx.window.MutationObserver || window.MutationObserver;
          new MO(fire).observe(doc.querySelector("head") || doc.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        } catch (e) {
          /* title tracking is best-effort */
        }
      });
    }
  }

  window.VeilSjPlugins = {
    setupAlwaysLastBubble: setupAlwaysLastBubble,
    EventHandlerPlugin: EventHandlerPlugin,
    HttpCachePlugin: HttpCachePlugin,
    UrlWatcherPlugin: UrlWatcherPlugin,
    LinkHandlerPlugin: LinkHandlerPlugin,
    VeilShellPlugin: VeilShellPlugin,
  };
})();
