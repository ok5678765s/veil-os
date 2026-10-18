/* ============================================================
   Veil OS — shared runtime for the static copy of the real site.

   Built to render EXACTLY like the live app:
   - same clock/date/greeting/splash rules the start page uses
   - same weather pill (Open-Meteo direct, WMO text + lucide glyphs)
   - same presence pill, command bar + suggestions, dock, hide-UI
   - same wallpaper selection (localStorage "veil.wallpaper")
   - real data from data/*.json (same-origin first, CDN fallback)

   Works on every host that serves this site/ directory:
   Vercel / Cloudflare Pages (site/ is the web root) and the
   gh CDN layout (.../site/<page>).
   ============================================================ */
(function () {
  "use strict";

  /* ---------- base + data resolution ---------- */
  var HERE = window.location.href.split("#")[0].split("?")[0];
  var SITE_BASE = HERE.replace(/[^/]*$/, "");          // .../site/ or /
  var REPO_BASE = SITE_BASE.replace(/[^/]*\/$/, "");   // .../veil-os@main/
  /* mirror folders (m1..m10) share the canonical site/ assets+data:
     the page sets window.VEILOS_SHARED_BASE="../site/" before os.js */
  var SHARED = (typeof window.VEILOS_SHARED_BASE === "string" && window.VEILOS_SHARED_BASE) || SITE_BASE;
  var ON_REPO_HOST = /githubusercontent\.com|githack\.com|jsdelivr\.net/.test(HERE) && SITE_BASE !== "/";

  window.VEILOS = {
    base: SITE_BASE,
    asset: function (p) { return SITE_BASE.replace(/[^/]*$/, "") + p; },
    page: function (name) {
      /* keep the entry extension (.xhtml on jsDelivr — .html is served
         as text/plain there) and carry this build's stamp so a pushed
         update can't be blocked by the 7-day browser cache */
      var ext = /\.xhtml$/.test(window.location.pathname) ? ".xhtml" : ".html";
      var v = document.documentElement.getAttribute("data-veil-build") || "";
      return SITE_BASE + name + ext + (v ? "?v=" + encodeURIComponent(v) : "");
    },
    shared: SHARED,
    data: function (f) { return SHARED + "data/" + f; },
    cdnData: function (f) { return "https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/data/" + f; },
    repoData: function (f) { return REPO_BASE + "site/data/" + f; },
    onRepoHost: ON_REPO_HOST,
    fetchJson: fetchJson,
    esc: esc,
    ls: lsGet,
    lsSet: lsSet,
  };

  function fetchJson(urls) {
    var i = 0;
    function tryNext() {
      if (i >= urls.length) return Promise.reject(new Error("all sources failed"));
      var url = urls[i++];
      return fetch(url, { cache: "no-store" }).then(function (r) {
        if (r.ok) return r.json();
        return tryNext();
      }, tryNext);
    }
    return tryNext();
  }
  /* raw.githubusercontent serves straight from origin (~5 min edge
     cache, CORS-open) — it stays fresh WITHOUT any purge, which matters
     because jsDelivr throttles purges once we push often. */
  var RAW_BASE = "https://raw.githubusercontent.com/ok5678765s/veil-os/";

  function dataOf(file) {
    var urls = [SHARED + "data/" + file, window.VEILOS.cdnData(file), window.VEILOS.repoData(file)];
    if (file === "latest.json") {
      /* the chat backup is purged on the CDN after every push, but a
         static host's same-origin copy can lag minutes behind (or sit
         frozen on the build that shipped) — and the old order tried
         same-origin FIRST, so a stale 200 shadowed the fresh copies
         forever. Race all three, keep whichever exportedAt is newest. */
      var lanes = [
        fetchJson([SHARED + "data/" + file]).catch(function () { return null; }),
        fetchJson([window.VEILOS.cdnData(file)]).catch(function () { return null; }),
        fetchJson([RAW_BASE + "main/site/data/" + file]).catch(function () { return null; }),
      ];
      return Promise.all(lanes).then(function (all) {
        var best = null;
        var bestAt = -1;
        all.forEach(function (d) {
          if (!d) return;
          var t = new Date(d.exportedAt || 0).getTime() || 0;
          if (t > bestAt) { bestAt = t; best = d; }
        });
        if (best) return best;
        return fetchJson([window.VEILOS.repoData(file)]);
      });
    }
    if (file !== "chat-live.json") return fetchJson(urls);
    /* chat-live.json's live lane is the `presence` branch (main's copy is
       the frozen legacy lane — old builds still write there). The primary
       lane reads raw.githubusercontent (origin-fresh, purge-independent);
       the legacy lane rides the usual url list. Read BOTH, merge users by
       freshest lastSeen + messages by id, so the presence estimate counts
       everyone no matter which lane they landed on. */
    var live = RAW_BASE + "presence/site/data/chat-live.json";
    return fetchJson([live]).catch(function () { return null; }).then(function (p) {
      return fetchJson(urls).catch(function () { return null; }).then(function (l) {
        if (!p && !l) throw new Error("all sources failed");
        if (!p) return l;
        if (!l) return p;
        var out = { users: {}, messages: [] };
        var names = {};
        [p, l].forEach(function (src) {
          (src.messages || []).forEach(function (m) {
            if (m && m.id && !names[m.id]) { names[m.id] = 1; out.messages.push(m); }
          });
        });
        out.messages.sort(function (a, b) {
          return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
        });
        out.messages = out.messages.slice(-100);
        [l, p].forEach(function (src) { /* presence wins ties (second) */
          for (var k in (src.users || {})) {
            var u = src.users[k];
            if (!u) continue;
            var cur = out.users[k];
            if (!cur) { out.users[k] = u; continue; }
            var ct = cur.lastSeen ? new Date(cur.lastSeen).getTime() : 0;
            var nt = u.lastSeen ? new Date(u.lastSeen).getTime() : 0;
            if (nt > ct) out.users[k] = u;
          }
        });
        return out;
      });
    });
  }
  window.VEILOS.dataOf = dataOf;

  /* ============================================================
     THE REAL APP'S API — the static copy calls the live app's
     endpoints (all CORS-open) for everything the baked JSONs can't
     do: real AI answers, the YouTube feed, music search + streaming,
     wallpaper search, chat sign-in, and the SHARED presence count.

     The base is resolved once, in priority order:
       1. window.VEILOS_API_BASE (page/build-time override)
       2. localStorage "veil:api-base" (user-set in Settings)
       3. "" — same origin (when this copy is served behind the same
          gateway as the app)
     When nothing answers, V.api() resolves to null and every page
     falls back to its baked static data — the copy never looks broken.
     ============================================================ */
  var API_BASE; /* undefined = unresolved, null = unreachable, string = live */
  var API_PROMISE = null;

  function apiBaseResolve(force) {
    if (!force && API_PROMISE) return API_PROMISE;
    var candidates = [];
    if (typeof window.VEILOS_API_BASE === "string" && /^https?:\/\//i.test(window.VEILOS_API_BASE)) {
      candidates.push(window.VEILOS_API_BASE.replace(/\/+$/, ""));
    }
    var saved = lsGet("veil:api-base");
    if (saved && /^https?:\/\//i.test(saved)) candidates.push(saved.replace(/\/+$/, ""));
    candidates.push(""); /* same-origin probe — works when served behind
                             the app's own gateway */
    API_PROMISE = new Promise(function (resolve) {
      var i = 0;
      function tryNext() {
        if (i >= candidates.length) {
          API_BASE = null;
          resolve(null);
          return;
        }
        var base = candidates[i++];
        var opts = { cache: "no-store" };
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
          opts.signal = AbortSignal.timeout(6000);
        }
        fetch(base + "/api/presence", opts)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && typeof j.total === "number") {
              API_BASE = base;
              resolve(base);
            } else tryNext();
          })
          .catch(function () { tryNext(); });
      }
      tryNext();
    });
    return API_PROMISE;
  }

  window.VEILOS.api = apiBaseResolve;
  /* only meaningful after V.api() resolved to a base ("" = same origin) */
  window.VEILOS.apiUrl = function (p) { return (API_BASE || "") + p; };
  window.VEILOS.apiBase = function () { return API_BASE !== undefined ? API_BASE : null; };
  /* route any absolute image through the app's proxy (same treatment
     the website gives every remote image) */
  window.VEILOS.apiImg = function (u) {
    if (!/^https?:\/\//i.test(u)) return u;
    var m = /^(https?):\/\/(.+)$/.exec(u);
    return window.VEILOS.apiUrl("/api/p/" + m[1] + "/" + m[2]);
  };
  /* a YouTube thumbnail, proxied exactly like the website does it */
  window.VEILOS.ytImg = function (videoId, quality) {
    var q = quality || "hqdefault";
    return window.VEILOS.apiUrl(
      "/api/yt/s?u=" + encodeURIComponent("https://i.ytimg.com/vi/" + videoId + "/" + q + ".jpg")
    );
  };

  /* ---------- tiny helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsJson(k, d) {
    try { var r = window.localStorage.getItem(k); return r ? JSON.parse(r) : d; } catch (e) { return d; }
  }
  window.VEILOS.$ = $; window.VEILOS.$$ = $$;

  var REDUCE_MOTION = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================================================
     CLOCK — the start page's exact rules.
     12h "h:mm AM/PM" by default, "veil:clock-24h" = 24h HH:MM.
     The date line is locale long-form; CSS uppercases + tracks it.
     ============================================================ */
  var clockEls = null;
  function tickClock() {
    if (!clockEls) clockEls = $$("[data-os-clock]");
    if (!clockEls.length) return;
    var d = new Date();
    var h24 = lsGet("veil:clock-24h") === "1";
    var hh = d.getHours(), mm = d.getMinutes();
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var label = h24
      ? pad(hh) + ":" + pad(mm)
      : ((hh % 12) || 12) + ":" + pad(mm) + " " + (hh < 12 ? "AM" : "PM");
    var dateStr = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    for (var i = 0; i < clockEls.length; i++) {
      var el = clockEls[i];
      if (el.hasAttribute("data-os-date")) el.textContent = dateStr;
      else el.textContent = label;
    }
  }
  function mountClock() {
    if (!$("[data-os-clock]")) return;
    tickClock();
    clockEls = null; /* re-collect after first paint */
    tickClock();
    setInterval(function () { if (!document.hidden) { clockEls = null; tickClock(); } }, 1000);
  }

  /* ============================================================
     SPLASH — 75% splash line, 1% the gold special, else tagline.
     Same inline gradient treatment the component applies.
     ============================================================ */
  var SPLASH_LINES = [
    "Your Back", "I know its the best", "happy?", "1+1=11", "woah",
    "better than the rest", "Technoblade Never dies", "battle royale",
    "If your enemy's know your next move dont move", "fire hurts- Trust me",
    "Why did I pick the name veil IDK", "WORDS", "gravity hurts", "verified by me",
  ];
  var TAGLINE = "The whole web, through the veil.";
  function mountSplash() {
    var el = $("[data-os-splash]");
    if (!el) return;
    var roll = Math.random();
    var line = TAGLINE, special = false;
    if (roll < 0.01) { line = "passwords 5rew21"; special = true; }
    else if (roll < 0.76) { line = SPLASH_LINES[Math.floor(Math.random() * SPLASH_LINES.length)]; }
    var isSplash = line !== TAGLINE;
    el.textContent = line;
    /* the h2 re-runs its rise animation when the line swaps (key change) */
    if (isSplash) {
      el.style.backgroundImage = special
        ? "linear-gradient(180deg,#fde68a 45%,#f59e0b)"
        : "linear-gradient(180deg,#f4f4f5 55%,#6ee7b7)";
      el.style.webkitBackgroundClip = "text";
      el.style.backgroundClip = "text";
      el.style.color = "transparent";
      el.style.filter = special
        ? "drop-shadow(0 2px 16px rgba(245,158,11,0.45))"
        : "drop-shadow(0 2px 16px rgba(52,211,153,0.35))";
      el.classList.remove("text-zinc-50");
      if (!REDUCE_MOTION) { el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; }
    }
  }

  /* ============================================================
     PRESENCE — "N online" pill, ONE SHARED NUMBER with the website.
     When the app's API is reachable, this copy heartbeats into the
     same room (/api/presence, CORS-open) and renders the authoritative
     total the website's pill renders — CDN visitors and website
     visitors count into the SAME number. Offline, it falls back to
     the chat-room estimate (latest.json + chat-live.json activity,
     floored at 1).
     ============================================================ */
  function mountPresence() {
    var el = $$("[data-os-presence]");
    if (!el.length) return;
    var WINDOW_MS = 4 * 60 * 1000;
    var render = function (n) {
      var label = n > 0 ? n + " online" : "connecting…";
      for (var i = 0; i < el.length; i++) el[i].textContent = label;
    };

    /* durable visitor id — cross-origin callers can't carry the app's
       httpOnly cookie, so the body carries this instead */
    var vid = lsGet("veil:visitor-id");
    if (!vid || !/^[a-zA-Z0-9-]{8,64}$/.test(vid)) {
      vid = "cdn-" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 24);
      lsSet("veil:visitor-id", vid);
    }
    /* signed-in live-room users ride the beat as an account so the two
       presence systems can dedupe by accountId */
    var liveAccount = null;
    try {
      var ident = JSON.parse(lsGet("veil:live-identity") || "null");
      if (ident && ident.username) {
        liveAccount = {
          accountId: "live:" + String(ident.username).toLowerCase(),
          username: String(ident.username).toLowerCase(),
          displayName: ident.displayName || ident.username,
          avatarColor: ident.avatarColor || "#22d3ee",
          avatarImage: null,
        };
      }
    } catch (e) { liveAccount = null; }

    var apiOk = false;
    function beat() {
      var body = { vid: vid };
      if (liveAccount) body.account = liveAccount;
      return fetch(window.VEILOS.apiUrl("/api/presence"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (j && typeof j.total === "number") {
            apiOk = true;
            render(j.total);
            return true;
          }
          return false;
        })
        .catch(function () { return false; });
    }

    var estimate = function () {
      var count = 0;
      var seen = {};
      dataOf("latest.json").then(function (d) {
        var now = Date.now();
        (d.messages || []).forEach(function (m) {
          var t = new Date(m.createdAt).getTime();
          if (isFinite(t) && now - t < WINDOW_MS && !seen[m.accountId]) {
            seen[m.accountId] = true;
            count++;
          }
        });
      }).catch(function () {}).then(function () {
        return dataOf("chat-live.json").then(function (s) {
          var now = Date.now();
          var online = {};
          for (var k in (s.users || {})) {
            var u = s.users[k];
            if (u && u.banned) continue;
            var t = u && u.lastSeen ? new Date(u.lastSeen).getTime() : 0;
            if (isFinite(t) && now - t < WINDOW_MS) online[k.toLowerCase()] = true;
          }
          (s.messages || []).forEach(function (m) {
            var t = new Date(m.createdAt).getTime();
            if (isFinite(t) && now - t < WINDOW_MS) online[String(m.username || "").toLowerCase()] = true;
          });
          var extra = 0;
          for (var kk in online) extra++;
          count = count + extra;
        }).catch(function () {});
      }).then(function () {
        /* offline estimate: you're here, so at least 1 */
        if (!apiOk) render(Math.max(count, 1));
      });
    };

    apiBaseResolve().then(function (base) {
      if (base === null) { estimate(); return; }
      beat().then(function (ok) {
        if (!ok) estimate();
      });
      setInterval(function () { if (!document.hidden) beat(); }, 15000);
    });
    setInterval(function () {
      if (!document.hidden && !apiOk) estimate();
    }, 30000);
  }

  /* ============================================================
     WEATHER — the real pill: glyph · temp · desc · greeting · pin.
     Open-Meteo direct from the browser (public, CORS on), with the
     app's exact WMO text table + lucide glyphs + C/F toggle + the
     city pin popover (Open-Meteo geocoding).
     ============================================================ */
  var WMO_TEXT = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Light freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light showers", 81: "Rain showers", 82: "Violent showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm, light hail", 99: "Thunderstorm, hail",
  };
  /* lucide stroke paths, 24x24 — the exact glyphs the app renders */
  var WX_SVGS = {
    sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path>',
    cloudsun: '<path d="M12 2v8"></path><path d="m4.93 10.93 1.41 1.41"></path><path d="M2 18h2"></path><path d="M20 18h2"></path><path d="m19.07 10.93-1.41 1.41"></path><path d="M15.947 12.651a3 3 0 0 0-2.825-4.509 4 4 0 0 0-7.29 1.357A3.5 3.5 0 0 0 6.177 18H16a2 2 0 0 0 1.066-3.852"></path>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path>',
    fog: '<path d="M10 20.75a3.2 3.2 0 0 1-.7-1.5c0-.9.6-1.4.6-2.3 0-.4-.1-.8-.2-1.1"></path><path d="M14 20.75a3.2 3.2 0 0 1-.7-1.5c0-.9.6-1.4.6-2.3 0-.4-.1-.8-.2-1.1"></path><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9"></path>',
    drizzle: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M16 14v6"></path><path d="M8 14v6"></path><path d="M12 16v6"></path>',
    rain: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M16 14v6"></path><path d="M8 14v6"></path>',
    snow: '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path><path d="M8 15h.01"></path><path d="M8 19h.01"></path><path d="M12 17h.01"></path><path d="M12 21h.01"></path><path d="M16 15h.01"></path><path d="M16 19h.01"></path>',
    lightning: '<path d="M6 16.326A7.95 7.95 0 1 1 23.68 16q-.242.83-.677 1.585"></path><path d="M14.5 19a2 2 0 1 1-4 0"></path><path d="M13 3 7 13h6l-2 8"></path>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>',
    cloudmoon: '<path d="M10.83 5.17A6 6 0 0 1 16.8 11a6.11 6.11 0 0 1-.55 2.53l-.14.28a5.55 5.55 0 0 1-5.06 3.19A6 6 0 0 1 5.09 9.9a5.55 5.55 0 0 1 3.19-5.07l.28-.14a6.11 6.11 0 0 1 2.27-.52"></path><path d="M13 3a6 6 0 0 1 9 9 6.5 6.5 0 0 1-1.7 3.4"></path>',
  };
  function wxIconName(code, isDay) {
    var night = isDay === 0 || isDay === false;
    if (code != null && code >= 0) {
      if (night && code === 0) return "moon";
      if (night && (code === 1 || code === 2)) return "cloudmoon";
      if (code === 0) return "sun";
      if (code === 1 || code === 2) return "cloudsun";
      if (code === 3) return "cloud";
      if (code === 45 || code === 48) return "fog";
      if (code >= 51 && code <= 57) return "drizzle";
      if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
      if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
      if (code >= 95) return "lightning";
    }
    return "cloud";
  }
  function wxSvg(name, cls) {
    return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="' + cls + '">' + WX_SVGS[name] + "</svg>";
  }
  function greetingFor(h) {
    return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 21 ? "Good evening" : "Good night";
  }

  function mountWeather() {
    var host = $("[data-os-weather]");
    if (!host) return;
    var pin = lsJson("veil:wx-pin", null);
    var unit = lsGet("veil:temp-unit") === "F" ? "F" : "C";

    function renderIdle() {
      host.innerHTML =
        wxSvg("sun", "hidden") +
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-clock size-3.5 shrink-0 text-zinc-500"><path d="M12 6v6l4 2"></path><circle cx="12" cy="12" r="10"></circle></svg>' +
        '<span class="shrink-0 truncate text-zinc-400" data-os-greeting>Hello</span>' +
        pinButtonHtml(!!pin);
      greetTick();
    }
    function pinButtonHtml(pinned) {
      return '<button type="button" aria-label="Set the weather location" data-os-wxpin title="' + (pinned ? "Pinned: " + esc(pin && pin.place) + " — click to change" : "Weather not right? Set your city") + '" class="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition hover:bg-white/10 ' + (pinned ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300") + '"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-map-pin size-3.5"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"></path><circle cx="12" cy="10" r="3"></circle></svg></button>';
    }
    function greetTick() {
      var g = $("[data-os-greeting]", host);
      if (g) g.textContent = greetingFor(new Date().getHours());
    }
    setInterval(greetTick, 30000);

    function renderWx(tempC, code, isDay, desc) {
      var name = wxIconName(code, isDay);
      var t = Math.round(unit === "F" ? tempC * 1.8 + 32 : tempC);
      var text = desc || WMO_TEXT[code] || "";
      host.innerHTML =
        wxSvg(name, "lucide size-3.5 shrink-0 text-emerald-300") +
        '<button type="button" data-os-wxunit title="' + (pin ? esc(pin.place) + " · refreshes every minute" : "refreshes every minute") + '" aria-label="Temperature ' + Math.round(tempC) + ' degrees Celsius. Click to switch units." class="veil-wx-fresh rounded-full px-1.5 font-medium tabular-nums text-zinc-100 transition hover:bg-white/10 hover:text-white">' + t + "°" + unit + "</button>" +
        (text ? '<span aria-hidden="true" class="size-0.5 shrink-0 rounded-full bg-zinc-500"></span><span class="truncate">' + esc(text) + "</span>" : "") +
        '<span aria-hidden="true" class="size-0.5 shrink-0 rounded-full bg-zinc-500"></span>' +
        '<span class="shrink-0 truncate text-zinc-400" data-os-greeting>' + esc(greetingFor(new Date().getHours())) + "</span>" +
        pinButtonHtml(!!pin);
      var ub = $("[data-os-wxunit]", host);
      if (ub) ub.addEventListener("click", function () {
        unit = unit === "F" ? "C" : "F";
        lsSet("veil:temp-unit", unit);
        renderWx(tempC, code, isDay, desc);
      });
      bindPin();
    }

    function queryWx() {
      var done = function (lat, lon) {
        fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current_weather=true&timezone=auto", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j || !j.current_weather) return;
            var cw = j.current_weather;
            renderWx(cw.temperature, cw.weathercode, cw.is_day, null);
          })
          .catch(function () {});
      };
      var byIp = function () {
        /* the app's own fallback chain ends at IP geolocation — the
           static copy reaches the same service (ipwho.is) directly. */
        fetch("https://ipwho.is/", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && j.success && isFinite(j.latitude)) done(j.latitude, j.longitude);
          })
          .catch(function () {});
      };
      if (pin) return done(pin.lat, pin.lon);
      if (!navigator.geolocation) return byIp();
      navigator.geolocation.getCurrentPosition(function (pos) {
        done(pos.coords.latitude, pos.coords.longitude);
      }, function () { byIp(); /* denied — fall back to IP like the app */ }, { timeout: 8000, maximumAge: 600000 });
    }

    /* the pin popover — same Radix look, plain <div> */
    function bindPin() {
      var btn = $("[data-os-wxpin]", host);
      if (!btn) return;
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var existing = $("#os-wx-pop");
        if (existing) { existing.remove(); return; }
        var pop = document.createElement("div");
        pop.id = "os-wx-pop";
        pop.className = "fixed z-[90] w-72 rounded-2xl border border-zinc-800 bg-zinc-950/95 p-3.5 backdrop-blur-xl shadow-[0_24px_48px_rgba(0,0,0,0.6)]";
        pop.style.left = "50%";
        pop.style.top = "84px";
        pop.style.transform = "translateX(-50%)";
        pop.innerHTML =
          '<p class="text-[12.5px] font-semibold text-zinc-100">Weather location</p>' +
          '<p class="mt-0.5 text-[11.5px] leading-snug text-zinc-500">' + (pin ? 'Pinned to <span class="text-emerald-300">' + esc(pin.place) + "</span>" : "Detecting your location…") + "</p>" +
          '<form class="mt-2.5 flex items-center gap-1.5"><input placeholder="City — e.g. Austin, TX" aria-label="City for the weather" spellcheck="false" class="h-8 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-[12.5px] text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-500/50"/><button type="submit" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-emerald-950 transition hover:bg-emerald-400" aria-label="Set the location"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-3.5"><path d="M20 6 9 17l-5-5"></path></svg></button></form>' +
          (pin ? '<button type="button" data-os-wxclear class="mt-2 w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200">Use auto location instead</button>' : "");
        document.body.appendChild(pop);
        var input = $("input", pop);
        input.focus();
        $("form", pop).addEventListener("submit", function (ev) {
          ev.preventDefault();
          var q = input.value.trim();
          if (!q) return;
          fetch("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(q) + "&count=1&language=en&format=json")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
              var hit = j && j.results && j.results[0];
              if (!hit) return;
              var place = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null, hit.country_code].filter(Boolean).join(", ");
              pin = { place: place, lat: hit.latitude, lon: hit.longitude };
              lsSet("veil:wx-pin", JSON.stringify(pin));
              pop.remove();
              queryWx();
            })
            .catch(function () {});
        });
        var clear = $("[data-os-wxclear]", pop);
        if (clear) clear.addEventListener("click", function () {
          pin = null;
          try { window.localStorage.removeItem("veil:wx-pin"); } catch (err) { /* ignore */ }
          pop.remove();
          queryWx();
        });
        setTimeout(function () {
          document.addEventListener("click", function closer(ev2) {
            if (pop.contains(ev2.target) || btn.contains(ev2.target)) return;
            pop.remove();
            document.removeEventListener("click", closer);
          });
        }, 50);
      });
    }

    renderIdle();
    bindPin();
    queryWx();
    setInterval(queryWx, 60000);
  }

  /* ============================================================
     COMMAND BAR — exact suggestions model + dropdown + keys.
     ============================================================ */
  var QUICK_LINKS = [
    { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page", host: "en.wikipedia.org", desc: "The free encyclopedia" },
    { name: "Hacker News", url: "https://news.ycombinator.com/", host: "news.ycombinator.com", desc: "Tech news, distilled" },
    { name: "MDN Docs", url: "https://developer.mozilla.org/en-US/", host: "developer.mozilla.org", desc: "Web documentation" },
    { name: "BBC News", url: "https://www.bbc.com/news", host: "www.bbc.com", desc: "World headlines" },
    { name: "Lite CNN", url: "https://lite.cnn.com/", host: "lite.cnn.com", desc: "Text-only edition" },
    { name: "Bing", url: "https://www.bing.com/", host: "www.bing.com", desc: "Web search" },
    { name: "FreeTube", url: "https://freetube.veil.local/", host: "freetube.veil.local", desc: "Veil's private YouTube — the program", aliases: "freetube subscriptions trending private tube" },
  ];
  var SEARCH_ENGINES = {
    brave: { label: "Brave", url: "https://search.brave.com/search?q=" },
    bing: { label: "Bing", url: "https://www.bing.com/search?q=" },
    duckduckgo: { label: "DuckDuckGo", url: "https://html.duckduckgo.com/html/?q=" },
    google: { label: "Google", url: "https://www.google.com/search?q=" },
    ecosia: { label: "Ecosia", url: "https://www.ecosia.org/search?q=" },
  };
  function engine() {
    var id = lsGet("veil:search-engine");
    return (id && SEARCH_ENGINES[id]) || SEARCH_ENGINES.brave;
  }
  function normalizeInput(raw) {
    var input = (raw || "").trim();
    if (!input) return null;
    if (/^https?:\/\//i.test(input)) return input;
    var looksLikeDomain = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(input);
    if (looksLikeDomain && !input.includes(" ")) return "https://" + input;
    return engine().url + encodeURIComponent(input);
  }
  window.VEILOS.normalizeInput = normalizeInput;
  window.VEILOS.searchEngine = engine;

  /* mirror-side history: pages opened from this copy land here and
     feed the "Recently viewed" rail exactly like the real app's. */
  function historyAll() { return lsJson("veil.mirror.history", []); }
  function pushHistory(url, title) {
    try {
      var u = new URL(url);
      var list = historyAll().filter(function (v) { return v.url !== url; });
      list.unshift({ url: url, host: u.hostname, title: title || u.hostname, at: Date.now() });
      lsSet("veil.mirror.history", JSON.stringify(list.slice(0, 24)));
    } catch (e) { /* ignore */ }
  }
  window.VEILOS.pushHistory = pushHistory;
  window.VEILOS.historyAll = historyAll;

  function timeAgo(ts) {
    var s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  function mountSearch() {
    var form = $("[data-os-search]");
    if (!form) return;
    var input = $("input", form);
    var dropdownWrap = $("[data-os-sugg]", form.parentElement) || null;
    var sel = 0, focused = false, current = [];

    function suggestions() {
      var q = input.value.trim().toLowerCase();
      var out = [];
      if (!q) return out;
      var raw = input.value.trim();
      var direct = normalizeInput(raw);
      var urlIntent = direct != null && /^https?:\/\//i.test(direct) && !raw.includes(" ") &&
        (/^https?:\/\//i.test(raw) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(raw));
      if (urlIntent) {
        try {
          var u = new URL(direct);
          out.push({ kind: "search", title: u.hostname, sub: "Open this site", url: direct, host: u.hostname });
        } catch (e) { /* ignore */ }
      }
      QUICK_LINKS.forEach(function (l) {
        if (out.length >= 6) return;
        var aliasHit = l.aliases ? l.aliases.toLowerCase().indexOf(q) > -1 : false;
        if (l.name.toLowerCase().indexOf(q) > -1 || l.host.toLowerCase().indexOf(q) > -1 || l.desc.toLowerCase().indexOf(q) > -1 || aliasHit) {
          out.push({ kind: "link", title: l.name, sub: l.desc, url: l.url, host: l.host });
        }
      });
      historyAll().forEach(function (v) {
        if (out.length >= 6) return;
        if (v.host.toLowerCase().indexOf(q) > -1 || (v.title || "").toLowerCase().indexOf(q) > -1) {
          out.push({ kind: "visit", title: (v.title || v.host).slice(0, 60), sub: v.host, url: v.url, host: v.host });
        }
      });
      out.push({
        kind: "search",
        title: "Search " + engine().label + " for “" + input.value.trim().slice(0, 40) + "”",
        sub: "", url: "", host: "",
      });
      return out;
    }

    function rowIconSvg(s) {
      if (s.kind === "link") return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>';
      if (s.kind === "visit") {
        return '<img src="https://icons.duckduckgo.com/ip3/' + esc(s.host) + '.ico" alt="" width="18" height="18" class="size-[18px] rounded-sm object-contain" />';
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="size-4"><path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle></svg>';
    }

    function renderSugg() {
      current = suggestions();
      if (!dropdownWrap) return;
      if (!focused || !current.length) { dropdownWrap.innerHTML = ""; return; }
      var html = '<div role="listbox" aria-label="Suggestions" class="absolute left-0 right-0 top-[calc(100%+8px)] z-40 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/95 p-1.5 shadow-[0_32px_64px_rgba(0,0,0,0.6)] backdrop-blur-xl veil-scroll-slim" style="max-height:18.5rem">';
      current.forEach(function (s, i) {
        html += '<button type="button" role="option" aria-selected="' + (i === sel) + '" data-os-sel="' + i + '" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ' + (i === sel ? "bg-emerald-500/10" : "hover:bg-zinc-900") + '">' +
          '<span aria-hidden="true" class="flex size-8 shrink-0 items-center justify-center rounded-lg ' +
          (s.kind === "visit" ? "bg-zinc-800 text-zinc-400" : s.kind === "link" ? "bg-emerald-500/15 text-emerald-300 [box-shadow:inset_0_0_0_1px_rgba(16,185,129,0.25)]" : "bg-zinc-800 text-amber-300") + '">' + rowIconSvg(s) + "</span>" +
          '<span class="min-w-0 flex-1"><span class="block truncate text-[13.5px] font-medium text-zinc-100">' + esc(s.title) + "</span>" +
          (s.sub ? '<span class="block truncate text-[11.5px] text-zinc-500">' + esc(s.sub) + "</span>" : "") + "</span>" +
          (i === sel ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="mr-1 size-3.5 shrink-0 text-emerald-400"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>' : "") +
          "</button>";
      });
      html += "</div>";
      dropdownWrap.innerHTML = html;
      $$("[data-os-sel]", dropdownWrap).forEach(function (b) {
        b.addEventListener("mouseenter", function () { sel = parseInt(b.getAttribute("data-os-sel"), 10); paintSel(); });
        b.addEventListener("click", function () { choose(parseInt(b.getAttribute("data-os-sel"), 10)); });
      });
    }
    function paintSel() {
      $$("[data-os-sel]", dropdownWrap || document).forEach(function (b) {
        var i = parseInt(b.getAttribute("data-os-sel"), 10);
        b.setAttribute("aria-selected", i === sel);
        b.className = b.className.replace(/(^|\s)(bg-emerald-500\/10|hover:bg-zinc-900)(\s|$)/g, "$1$3").trim() + " " + (i === sel ? "bg-emerald-500/10" : "hover:bg-zinc-900");
        var arrow = $("svg", b.parentElement && b.lastElementChild && b.lastElementChild.tagName.toLowerCase() === "svg" ? b : null);
        /* simpler: rebuild arrow visibility via class */
      });
      /* simplest correct approach: re-render on selection change is
         avoided (focus loss); instead toggle the two stateful bits */
      $$("[data-os-sel]", dropdownWrap || document).forEach(function (b) {
        var i = parseInt(b.getAttribute("data-os-sel"), 10);
        var on = i === sel;
        b.classList.toggle("bg-emerald-500/10", on);
        b.classList.toggle("hover:bg-zinc-900", !on);
        var last = b.lastElementChild;
        if (last && last.tagName.toLowerCase() === "svg" && last.getAttribute("aria-hidden") === "true" && last.getAttribute("viewBox") === "0 0 24 24") {
          last.style.display = on ? "" : "none";
        } else if (on) {
          var arr = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          arr.setAttribute("viewBox", "0 0 24 24");
          arr.setAttribute("aria-hidden", "true");
          arr.setAttribute("class", "mr-1 size-3.5 shrink-0 text-emerald-400");
          arr.innerHTML = '<path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path>';
          arr.setAttribute("fill", "none"); arr.setAttribute("stroke", "currentColor");
          arr.setAttribute("stroke-width", "2"); arr.setAttribute("stroke-linecap", "round"); arr.setAttribute("stroke-linejoin", "round");
          b.appendChild(arr);
        }
      });
    }

    function launch(url, title) {
      if (!url) return;
      input.value = "";
      focused = false;
      renderSugg();
      input.blur();
      pushHistory(url, title || "");
      window.open(url, "_blank", "noopener");
    }
    function choose(i) {
      var s = current[i];
      if (!s) return;
      if (s.url) launch(s.url, s.kind === "link" ? s.title : "");
      else submit();
    }
    function submit() {
      var target = normalizeInput(input.value);
      if (!target) return;
      launch(target, "");
    }

    form.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
    input.addEventListener("input", function () { sel = 0; renderSugg(); });
    input.addEventListener("focus", function () { focused = true; renderSugg(); });
    input.addEventListener("blur", function () {
      setTimeout(function () { focused = false; renderSugg(); }, 120);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" && current.length) { e.preventDefault(); sel = (sel + 1) % current.length; paintSel(); }
      else if (e.key === "ArrowUp" && current.length) { e.preventDefault(); sel = (sel - 1 + current.length) % current.length; paintSel(); }
      else if (e.key === "Escape") { input.blur(); }
      else if (e.key === "Enter") { /* form submit handles it */ }
    });

    /* "/" focuses the bar (when not already typing) */
    document.addEventListener("keydown", function (e) {
      var t = e.target;
      var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing) { e.preventDefault(); input.focus(); }
    });
  }

  /* ============================================================
     HIDE UI — wallpaper-only zen mode, Esc brings it back.
     ============================================================ */
  function mountHideUI() {
    var btn = $("[data-os-hideui]");
    var content = $("[data-os-content]");
    if (!btn || !content) return;
    var hidden = false;
    var EYE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-eye size-3"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    var EYEOFF = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-eye-off size-3"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"></path><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"></path><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"></path><path d="m2 2 20 20"></path></svg>';
    function apply() {
      btn.setAttribute("aria-pressed", hidden);
      btn.title = hidden ? "Show the interface (Esc)" : "Hide the interface — just the wallpaper (Esc brings it back)";
      btn.innerHTML = (hidden ? EYE : EYEOFF) + "<span>" + (hidden ? "show UI" : "hide UI") + "</span>";
      content.classList.toggle("pointer-events-none", hidden);
      content.classList.toggle("opacity-0", hidden);
    }
    btn.addEventListener("click", function () { hidden = !hidden; apply(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && hidden) { hidden = false; apply(); }
    });
  }

  /* ============================================================
     WALLPAPER — the same selection object the real app persists.
     ============================================================ */
  var THEME_GRADIENTS = {
    sulfur: "from-amber-400/70 to-orange-600/60",
    emerald: "from-emerald-400/70 to-teal-600/60",
    aurora: "from-emerald-400/60 to-indigo-500/60",
    nebula: "from-violet-400/70 to-fuchsia-600/60",
    grid: "from-fuchsia-500/60 to-cyan-400/60",
    sunset: "from-orange-400/70 to-rose-600/60",
    ocean: "from-sky-400/70 to-teal-400/60",
  };
  window.VEILOS.THEME_GRADIENTS = THEME_GRADIENTS;
  function wpAsset(src) {
    if (!src) return "";
    if (/^https?:\/\//.test(src) || src.indexOf("data:") === 0) return src;
    /* root-relative in the real app → shared site/ path (mirror folders
       keep one canonical copy of the heavy assets) */
    return SHARED + src.replace(/^\//, "");
  }
  window.VEILOS.wpAsset = wpAsset;
  function mountWallpaper() {
    var slot = $("[data-os-wallpaper]");
    if (!slot) return;
    var dim = lsGet("veil:wp-dim");
    function render() {
      var sel = lsJson("veil.wallpaper", null);
      var kind = sel && sel.kind, src = sel ? wpAsset(sel.src) : "";
      var inner = "";
      if (kind === "video" && src) {
        inner = '<video src="' + esc(src) + '" autoplay loop muted playsinline ' + (sel.thumb ? 'poster="' + esc(wpAsset(sel.thumb)) + '"' : "") + ' class="size-full object-cover"></video>';
      } else if (kind === "image" && src) {
        inner = '<img src="' + esc(src) + '" alt="" class="size-full object-cover" />';
      } else {
        var theme = (sel && sel.theme) || "emerald";
        inner = '<div class="absolute inset-0 bg-gradient-to-br ' + (THEME_GRADIENTS[theme] || THEME_GRADIENTS.emerald) + '">' +
          '<div class="absolute -top-40 left-[25%] h-[26rem] w-[40rem] rounded-full bg-white/10 blur-3xl' + (REDUCE_MOTION ? "" : " veil-orb-a") + '"></div>' +
          '<div class="absolute -bottom-32 right-[8%] h-80 w-80 rounded-full bg-black/10 blur-3xl' + (REDUCE_MOTION ? "" : " veil-orb-b") + '"></div></div>';
      }
      var dimCls = dim === "55" ? "bg-black/55" : dim === "25" ? "bg-black/25" : "";
      slot.innerHTML = inner + (dimCls ? '<div class="absolute inset-0 ' + dimCls + '"></div>' : "") +
        '<div class="veil-vignette absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-black/45 to-transparent"></div>' +
        '<div class="absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/35"></div>';
    }
    render();
    window.addEventListener("veil:wallpaper-changed", render);
    /* storage events from other tabs of the same host */
    window.addEventListener("storage", function (e) { if (e.key === "veil.wallpaper") render(); });
  }

  /* ============================================================
     LAYOUT — the start page's arrange mode. Same persisted shape
     as the real app (veil.start.layout.v1: {order, customized});
     drag widgets to reorder, "done" saves.
     ============================================================ */
  function mountLayout() {
    var btn = $("[data-os-layout]");
    var content = $("[data-os-content]");
    if (!btn || !content) return;
    var editing = false;
    var ORDER = ["clock", "weather", "presence", "brand", "search", "hints", "dock", "recent", "stats"];

    function readSaved() {
      var l = lsJson("veil.start.layout.v1", null);
      if (l && l.order && l.order.length) {
        var extra = ORDER.filter(function (w) { return l.order.indexOf(w) === -1; });
        return { order: l.order.concat(extra), customized: true };
      }
      return { order: ORDER.slice(), customized: false };
    }
    function applyOrder(order) {
      var col = content.firstElementChild;
      if (!col) return;
      order.forEach(function (id) {
        var el = $('[data-os-widget="' + id + '"]', content);
        if (el) col.appendChild(el);
      });
    }
    applyOrder(readSaved().order);

    function setEditing(on) {
      editing = on;
      btn.setAttribute("aria-pressed", on);
      btn.title = on ? "Finish arranging the layout" : "Arrange the start page — drag the apps to move them";
      var grid = $("svg", btn);
      if (grid) grid.style.color = on ? "#6ee7b7" : "";
      var span = $("span", btn);
      if (span) span.textContent = on ? "done" : "layout";
      $$("[data-os-widget]", content).forEach(function (el) {
        el.draggable = on;
        el.classList.toggle("cursor-grab", on);
        el.classList.toggle("rounded-2xl", on);
        el.classList.toggle("ring-1", on);
        el.classList.toggle("ring-emerald-400/40", on);
      });
      if (!on) {
        var order = $$("[data-os-widget]", content).map(function (el) { return el.getAttribute("data-os-widget"); });
        var hiddenIds = order.filter(function (id) { return $('[data-os-widget="' + id + '"]').hidden; });
        lsSet("veil.start.layout.v1", JSON.stringify({ order: order, customized: true }));
        var h = $('[data-os-widget="recent"]');
        if (h && hiddenIds.indexOf("recent") === -1 && !VhasVisits()) h.hidden = true;
      }
    }
    function VhasVisits() { return lsJson("veil.mirror.history", []).length > 0; }

    btn.addEventListener("click", function () { setEditing(!editing); });

    /* HTML5 drag reorder */
    var dragSrc = null;
    content.addEventListener("dragstart", function (e) {
      var w = e.target.closest && e.target.closest("[data-os-widget]");
      if (!editing || !w) { e.preventDefault(); return; }
      dragSrc = w;
      w.classList.add("opacity-50");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", w.getAttribute("data-os-widget")); } catch (err) { /* ie */ }
    });
    content.addEventListener("dragend", function () {
      if (dragSrc) dragSrc.classList.remove("opacity-50");
      dragSrc = null;
    });
    content.addEventListener("dragover", function (e) {
      if (!editing || !dragSrc) return;
      e.preventDefault();
      var w = e.target.closest && e.target.closest("[data-os-widget]");
      if (!w || w === dragSrc) return;
      var rect = w.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      w.parentNode.insertBefore(dragSrc, after ? w.nextSibling : w);
    });
  }

  /* ============================================================
     REFRESH PILL — a newer build was pushed; offer a reload.
     ============================================================ */
  function mountRefresh() {
    var pill = $("[data-os-refresh]");
    if (!pill) return;
    var latest = null;
    /* location.reload() can re-serve the 7-day-cached page — reload with
       a fresh query string instead so the CDN edge (purged on push) is hit */
    try { pill.removeAttribute("onclick"); } catch (e) { /* ignore */ }
    pill.addEventListener("click", function () {
      var v = (latest && latest.built) || String(Date.now());
      var q = location.search.replace(/^[?]/, "").split("&").filter(function (kv) { return kv && kv.indexOf("v=") !== 0; });
      q.push("v=" + encodeURIComponent(v));
      location.href = location.pathname + "?" + q.join("&") + location.hash;
    });
    function poll() {
      var stamp = document.documentElement.getAttribute("data-veil-build") || "0";
      fetchJson([
        SHARED + "version.json?t=" + Date.now(),
        "https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/site/version.json?t=" + Date.now(),
        REPO_BASE + "site/version.json?t=" + Date.now(),
      ]).then(function (v) {
        latest = v;
        if (v && v.built && v.built > stamp) pill.style.display = "inline-flex";
      }).catch(function () {});
    }
    setTimeout(poll, 4000);
    setInterval(function () { if (!document.hidden) poll(); }, 30000);
  }

  /* ============================================================
     SECTION CHROME — back button target + section clock.
     ============================================================ */
  function mountSection() {
    var root = $("[data-os-section]");
    if (!root) return;
    var back = $("[data-os-back]", root);
    if (back) {
      back.addEventListener("click", function () {
        window.location.href = window.VEILOS.page("index");
      });
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    mountClock();
    mountSplash();
    mountPresence();
    mountWeather();
    mountSearch();
    mountHideUI();
    mountWallpaper();
    mountLayout();
    mountRefresh();
    mountSection();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
