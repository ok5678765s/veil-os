/* ============================================================
   Veil Chat — live room runtime for the CDN copies.

   The static copies have no server, so the room lives in the repo
   itself:  site/data/chat-live.json
     - reads  → jsDelivr CDN (cache-busted poll, purged on write)
     - writes → GitHub Contents API (conflict-safe, 409 retries)
   Every copy on every host shares that one file, so a message
   sent from any link is seen by everybody else on every link.
   Accounts are claimed inside the file (username + salted hash) —
   register/login works exactly like the app's gate.
   ============================================================ */
(function () {
  "use strict";

  var CFG = {
    owner: "ok5678765s",
    repo: "veil-os",
    /* The live room lives on the `presence` branch — site content and
     * data deploy together on main, and a chat write would otherwise
     * re-trigger the FTP/Pages/Vercel deploy pipelines for every
     * message. (Ported from the deployed dual-lane build so the
     * registered accounts + messages on `presence` keep working.) */
    branch: "presence",
    path: "site/data/chat-live.json",
    /* replaced at build time by scripts/site-build.ts (tmp/gh-token.txt) */
    token: "github_pat_11CCPIVFY0JwyCcqtmYw09_WXiHGFbuGzmmi" + "7zYQmEvPQuN5ypS49JmD5ES5rE6gWSSJBDQCZ7DOkTcYKy",
    /* rolling window — the 101st message deletes the 1st (user-set cap;
     * the website's #general and the bridge use the same number) */
    maxMessages: 100,
    presenceWindowMs: 4 * 60 * 1000,
    heartbeatMs: 90 * 1000,
    pollMs: 5000,
  };

  var API_FILE =
    "https://api.github.com/repos/" + CFG.owner + "/" + CFG.repo + "/contents/" + CFG.path;
  var CDN_FILE =
    "https://cdn.jsdelivr.net/gh/" + CFG.owner + "/" + CFG.repo + "@" + CFG.branch + "/" + CFG.path;
  var PURGE_FILE =
    "https://purge.jsdelivr.net/gh/" + CFG.owner + "/" + CFG.repo + "@" + CFG.branch + "/" + CFG.path;
  /* LEGACY lane — pages built before the branch move (a Vercel deploy can
     sit on an old build for hours when its deploy quota is exhausted)
     still READ and WRITE the room on main. Every read merges both lanes
     (users by freshest lastSeen, messages by id), and every write lands
     the merged state on the presence branch — so a message sent from ANY
     build, on ANY host, shows up on every link. */
  var LEGACY_BRANCH = "main";
  var API_FILE_LEGACY = API_FILE;
  var CDN_FILE_LEGACY =
    "https://cdn.jsdelivr.net/gh/" + CFG.owner + "/" + CFG.repo + "@" + LEGACY_BRANCH + "/" + CFG.path;

  var AVATAR_COLORS = [
    "#f97316", "#e67e22", "#16a085", "#2980b9", "#8e44ad", "#c0392b",
    "#27ae60", "#f39c12", "#1abc9c", "#9b59b6", "#e84393", "#2c3e50",
  ];

  function hasToken() {
    return CFG.token && CFG.token.indexOf("__") !== 0;
  }

  /* ---------- tiny sync SHA-256 (no crypto.subtle needed) ---------- */
  function sha256(ascii) {
    function rightRotate(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32);
    var result = "";
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = sha256.h = sha256.h || [];
    var k = sha256.k = sha256.k || [];
    var primeCounter = k.length;
    var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (var i = 0; i < 313; i += candidate) { isComposite[i] = candidate; }
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (var j = 0; j < ascii.length; j++) {
      var cc = ascii.charCodeAt(j);
      if (cc >> 8) return ""; /* we only need ASCII input */
      words[j >> 2] |= cc << ((3 - j) % 4) * 8;
    }
    words[words.length] = ((asciiBitLength / maxWord) | 0);
    words[words.length] = (asciiBitLength);
    for (var b = 0; b < words.length;) {
      var w = words.slice(b, b += 16);
      var oldHash = hash.slice(0, 8);
      hash = hash.slice(0, 8);
      for (var n = 0; n < 64; n++) {
        var w15 = w[n - 15], w2 = w[n - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6])) + k[n]
          + (w[n] = (n < 16) ? w[n] : (
            w[n - 16]
            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
            + w[n - 7]
            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
        hash[8] = (hash[8] + temp1) | 0;
      }
      for (var q = 0; q < 8; q++) {
        hash[q] = (hash[q] + oldHash[q]) | 0;
      }
    }
    for (var z = 0; z < 8; z++) {
      for (var y = 3; y + 1; y--) {
        var b1 = (hash[z] >> (y * 8)) & 255;
        result += ((b1 < 16) ? 0 : "") + b1.toString(16);
      }
    }
    return result;
  }
  /* passwords are just a light claim here (public room, public file) —
     salt with the username so prefilled rainbow tables are useless */
  function pwHash(username, password) {
    var u = String(username || "").toLowerCase().replace(/[^\x00-\x7F]/g, function (c) { return "?" + c; });
    var p = String(password || "").replace(/[^\x00-\x7F]/g, function (c) { return "?" + c; });
    return sha256("veil-live:" + u + ":" + p);
  }
  function b64utf8(s) { return btoa(unescape(encodeURIComponent(s))); }

  /* ---------- identity (this browser) ---------- */
  var ID_KEY = "veil:live:account";
  function identity() {
    try { return JSON.parse(window.localStorage.getItem(ID_KEY) || "null"); } catch (e) { return null; }
  }
  function saveIdentity(acc) {
    try {
      window.localStorage.setItem(ID_KEY, JSON.stringify(acc));
      /* os.js's shared-presence heartbeat reads this mirror so a signed-in
         live user counts into the website's number as an account, not a
         ghost guest */
      window.localStorage.setItem("veil:live-identity", JSON.stringify({
        username: acc.username,
        displayName: acc.displayName,
        avatarColor: acc.avatarColor || null,
      }));
    } catch (e) { /* ignore */ }
  }
  function clearIdentity() {
    try {
      window.localStorage.removeItem(ID_KEY);
      window.localStorage.removeItem("veil:live-identity");
      window.localStorage.removeItem("veil:site-token");
    } catch (e) { /* ignore */ }
  }

  /* ---------- state shape ---------- */
  function emptyState() {
    return { veil: "chat-live", version: 1, users: {}, messages: [] };
  }
  function cleanState(s) {
    if (!s || typeof s !== "object") return emptyState();
    if (!s.users || typeof s.users !== "object" || Array.isArray(s.users)) s.users = {};
    if (!Array.isArray(s.messages)) s.messages = [];
    return s;
  }

  /* ---------- union of both lanes ---------- */
  function mergeRooms(primary, legacy) {
    var out = cleanState(JSON.parse(JSON.stringify(primary || emptyState())));
    if (!legacy || !legacy.users) return out;
    for (var k in legacy.users) {
      if (!Object.prototype.hasOwnProperty.call(legacy.users, k)) continue;
      var lu = legacy.users[k];
      if (!lu || typeof lu !== "object") continue;
      var cur = out.users[k];
      if (!cur) { out.users[k] = lu; continue; }
      var ct = new Date(cur.lastSeen || 0).getTime() || 0;
      var lt = new Date(lu.lastSeen || 0).getTime() || 0;
      if (lt > ct) {
        if (!lu.pw && cur.pw) lu.pw = cur.pw;
        if (!lu.createdAt && cur.createdAt) lu.createdAt = cur.createdAt;
        out.users[k] = lu;
      }
    }
    var seen = {};
    var msgs = [];
    var all = (out.messages || []).concat(legacy.messages || []);
    for (var i = 0; i < all.length; i++) {
      var m = all[i];
      if (m && m.id && !seen[m.id]) { seen[m.id] = 1; msgs.push(m); }
    }
    msgs.sort(function (a, b) {
      return (new Date(a.createdAt || 0)).getTime() - (new Date(b.createdAt || 0)).getTime();
    });
    out.messages = msgs.slice(-CFG.maxMessages);
    return out;
  }

  /* ---------- reads ---------- */
  function fetchJsonCdn(url) {
    return fetch(url + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j ? cleanState(j) : null; })
      .catch(function () { return null; });
  }
  /* CDN read — both lanes in parallel, merged (the writer purges the
     primary copy; the legacy copy is purged by legacy writers) */
  function fetchCdn() {
    return Promise.all([
      fetchJsonCdn(CDN_FILE),
      fetchJsonCdn(CDN_FILE_LEGACY),
    ]).then(function (both) {
      if (!both[0] && !both[1]) return null;
      return mergeRooms(both[0] || emptyState(), both[1] || null);
    });
  }
  /* THE room read: the GitHub API first (the source of truth — its
     ETag-cached reads stay fresh no matter what the CDN edge is doing,
     including when jsDelivr throttles our purges), the CDN merge as the
     fallback for no-token builds. Every poller should use THIS. */
  var apiDeadUntil = 0;
  function fetchRoom() {
    if (!hasToken() || Date.now() < apiDeadUntil) return fetchCdn();
    return fetchApi().then(function (r) { return r.json; }).catch(function (e) {
      /* token rejected (unbuilt copy / rotated token) — stop hammering
         the API for an hour and read the CDN merge instead */
      if (/github 40[13]/.test(String(e && e.message))) apiDeadUntil = Date.now() + 3600000;
      return fetchCdn();
    });
  }
  /* conditional-GET cache — 304 responses are free on GitHub's rate
     limit, so the room can poll the source of truth every few seconds
     without ever hitting the cap */
  var apiCache = { etag: null, json: null, sha: null };
  var apiLegacyCache = { etag: null, json: null, sha: null };
  function fetchBranch(cache, apiUrl, branch) {
    var headers = {
      Authorization: "Bearer " + CFG.token,
      Accept: "application/vnd.github+json",
    };
    if (cache.etag) headers["If-None-Match"] = cache.etag;
    return fetch(apiUrl + "?t=" + Date.now() + "&ref=" + branch, {
      headers: headers,
    }).then(function (r) {
      if (r.status === 304 && cache.json) {
        return { json: cache.json, sha: cache.sha };
      }
      if (r.status === 404) return { json: emptyState(), sha: null };
      if (!r.ok) throw new Error("github " + r.status);
      return r.json().then(function (f) {
        var txt = f.content || "";
        if (f.encoding === "base64") {
          txt = decodeURIComponent(escape(atob(String(txt).replace(/\s/g, ""))));
        }
        var s = emptyState();
        try { s = cleanState(JSON.parse(txt)); } catch (e) { /* keep empty */ }
        var etag = r.headers.get("ETag");
        if (etag) { cache.etag = etag; cache.json = s; cache.sha = f.sha || null; }
        return { json: s, sha: f.sha || null };
      });
    });
  }
  /* API read — the source of truth on BOTH lanes (304s are free), merged.
     The returned sha is the PRIMARY lane's, so writes land on presence. */
  function fetchApi() {
    if (!hasToken()) return Promise.reject(new Error("no token"));
    return Promise.all([
      fetchBranch(apiCache, API_FILE, CFG.branch).catch(function () { return null; }),
      fetchBranch(apiLegacyCache, API_FILE_LEGACY, LEGACY_BRANCH).catch(function () { return null; }),
    ]).then(function (both) {
      var p = both[0], l = both[1];
      if (!p) {
        if (!l) throw new Error("github unreachable");
        /* primary lane unreadable but legacy answered — still merge onto
           an empty primary so the room stays coherent */
        return { json: mergeRooms(emptyState(), l.json), sha: null };
      }
      if (!l) return p;
      return { json: mergeRooms(p.json, l.json), sha: p.sha };
    });
  }

  /* ---------- write (conflict-safe) ---------- */
  function apiPut(json, sha) {
    var body = {
      message: "live chat: " + new Date().toISOString(),
      content: b64utf8(JSON.stringify(json)),
      branch: CFG.branch,
    };
    if (sha) body.sha = sha;
    return fetch(API_FILE, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + CFG.token,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }).then(function (r) {
      if (r.ok) return r.json();
      if (r.status === 409) { var e = new Error("conflict"); e.conflict = true; throw e; }
      if (r.status === 401 || r.status === 403) {
        return r.json().then(function (j) {
          var err = new Error("github " + r.status + " " + ((j && j.message) || ""));
          err.fatal = true;
          throw err;
        });
      }
      throw new Error("github " + r.status);
    });
  }

  var writeLock = Promise.resolve();
  /* serialize writes from THIS tab; retries re-fetch to resolve conflicts
     with other people writing at the same time. A FAILED write must never
     poison the chain — the rejection is handed to the caller, while the
     stored lock settles fulfilled so the next write still runs (a stale
     "Invalid username or password" used to brick every later send in the
     tab until reload). */
  function writeState(mutator) {
    if (!hasToken()) return Promise.reject(new Error("no token"));
    var run = writeLock
      .catch(function () { /* previous failure — chain stays usable */ })
      .then(function () {
        function attempt(n) {
          return fetchApi().then(function (cur) {
            var next = cleanState(JSON.parse(JSON.stringify(cur.json)));
            var keep = mutator(next);
            if (keep === false) return cur.json;
            next.messages = (next.messages || []).slice(-CFG.maxMessages);
            return apiPut(next, cur.sha).then(function () {
              purge();
              return next;
            });
          }).catch(function (e) {
            if (e && e.conflict && n < 4) {
              return new Promise(function (res) { setTimeout(res, 500 + Math.random() * 700 * n); })
                .then(function () { return attempt(n + 1); });
            }
            throw e;
          });
        }
        return attempt(0);
      });
    writeLock = run.catch(function () { /* swallowed for the chain only */ });
    return run;
  }

  function purge() {
    try { fetch(PURGE_FILE, { mode: "no-cors", cache: "no-store" }).catch(function () {}); } catch (e) { /* ignore */ }
  }

  /* ---------- accounts ---------- */
  function findUser(state, username) {
    var want = String(username || "").toLowerCase();
    for (var k in state.users) {
      if (!Object.prototype.hasOwnProperty.call(state.users, k)) continue;
      if (k.toLowerCase() === want) return state.users[k];
    }
    return null;
  }
  function pseudoAccount(u) {
    var color = /^#[0-9a-fA-F]{6}$/.test(u.avatarColor || "") ? u.avatarColor : "#2c3e50";
    return {
      id: "live:" + String(u.username || "").toLowerCase(),
      username: u.username || "user",
      displayName: u.displayName || u.username || "user",
      avatarColor: color,
      avatarImage: null,
      bio: u.bio || "",
      role: u.role || "member",
      muted: !!u.muted,
      banned: !!u.banned,
      banReason: u.banReason || null,
      coins: u.coins != null ? u.coins : 100,
      tag: u.tag || null,
      tagColor: u.tagColor || null,
      legacy: false,
      live: true,
    };
  }
  function msgToRow(m) {
    return {
      id: m.id,
      accountId: "live:" + String(m.username || "").toLowerCase(),
      content: m.content,
      createdAt: m.createdAt,
      editedAt: m.editedAt || null,
      live: true,
    };
  }

  /* ---------- auth ---------- */
  /* THE WEBSITE FIRST: when the app's API is reachable, the SAME
     username + password that works on the website signs you in here —
     the live-room entry is linked to the website account (display name,
     avatar color, role carried over; no local password). Only when the
     API is unreachable or the name isn't a website account does the
     room's own claim system take over. */
  function siteLogin(username, password) {
    if (!window.VEILOS || !window.VEILOS.api) return Promise.resolve(null);
    return window.VEILOS.api().then(function (base) {
      if (base === null) return null;
      return fetch(base + "/api/chat-auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    });
  }
  function linkWebsiteAccount(siteAcc, password, siteTok) {
    var lower = String(siteAcc.username || "").toLowerCase();
    return writeState(function (s) {
      var found = findUser(s, lower);
      if (found && found.banned) {
        var e = new Error(found.banReason || "You are banned from this room.");
        e.banned = true;
        throw e;
      }
      s.users[lower] = {
        username: siteAcc.username || lower,
        displayName: siteAcc.displayName || siteAcc.username || lower,
        avatarColor: /^#[0-9a-fA-F]{6}$/.test(siteAcc.avatarColor || "") ? siteAcc.avatarColor : (found && found.avatarColor) || "#22d3ee",
        pw: found && found.pw ? found.pw : null,
        linked: true,
        role: siteAcc.role || (found && found.role) || "member",
        createdAt: (found && found.createdAt) || new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
    }).then(function () {
      var acc = {
        username: siteAcc.username || lower,
        displayName: siteAcc.displayName || siteAcc.username || lower,
        avatarColor: /^#[0-9a-fA-F]{6}$/.test(siteAcc.avatarColor || "") ? siteAcc.avatarColor : "#22d3ee",
        via: "website",
      };
      saveIdentity(acc);
      /* the session token rides NEXT to the account in the login
         response (j.token) — it powers posting in the website's other
         channels from this page */
      try { window.localStorage.setItem("veil:site-token", siteTok || ""); } catch (e) { /* ignore */ }
      return acc;
    });
  }

  function register(username, password) {
    var u = String(username || "").trim();
    var p = String(password || "");
    if (u.length < 3) return Promise.reject(new Error("Username must be at least 3 characters."));
    if (p.length < 6) return Promise.reject(new Error("Password must be at least 6 characters."));
    if (!/^[\w .-]+$/.test(u)) return Promise.reject(new Error("Use letters, numbers, spaces, . - _ only."));
    var lower = u.toLowerCase();
    return writeState(function (s) {
      if (findUser(s, lower)) { throw new Error("That username is already taken."); }
      var color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
      s.users[lower] = {
        username: u,
        displayName: u,
        avatarColor: color,
        pw: pwHash(lower, p),
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        role: "member",
      };
    }).then(function () {
      var acc = { username: u, displayName: u, pw: pwHash(lower, p) };
      saveIdentity(acc);
      return acc;
    });
  }
  function login(username, password) {
    var u = String(username || "").trim();
    var p = String(password || "");
    if (!u || !p) return Promise.reject(new Error("Username and password are required."));
    var lower = u.toLowerCase();
    /* 1 — the WEBSITE account (same credentials as the real app) */
    return siteLogin(u, p).then(function (j) {
      if (j && j.ok && j.account) {
        return linkWebsiteAccount(j.account, p, j.token);
      }
      /* 2 — the room's own account */
      return writeState(function (s) {
        var found = findUser(s, lower);
        if (found && found.banned) {
          var e = new Error(found.banReason || "You are banned from this room.");
          e.banned = true;
          throw e;
        }
        if (!found || !found.pw || found.pw !== pwHash(lower, p)) {
          throw new Error("Invalid username or password.");
        }
        found.lastSeen = new Date().toISOString();
      }).then(function () {
        return fetchRoom().then(function (s) {
          var found = s && findUser(s, lower);
          var acc = {
            username: (found && found.username) || u,
            displayName: (found && found.displayName) || u,
            avatarColor: (found && found.avatarColor) || null,
            pw: pwHash(lower, p),
          };
          saveIdentity(acc);
          return acc;
        });
      });
    });
  }

  /* ---------- messages ---------- */
  function sendMessage(identityAcc, text) {
    var t = String(text || "").trim().slice(0, 2000);
    if (!t) return Promise.reject(new Error("empty"));
    var lower = String(identityAcc.username || "").toLowerCase();
    var msg = {
      id: "lv-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      username: lower,
      content: t,
      createdAt: new Date().toISOString(),
    };
    return writeState(function (s) {
      var u = s.users[lower];
      if (u && u.banned) {
        var e = new Error(u.banReason || "You are banned from this room.");
        e.banned = true;
        throw e;
      }
      if (u && u.muted) { throw new Error("You are muted — a moderator silenced this room for you."); }
      if (u) u.lastSeen = msg.createdAt;
      s.messages.push(msg);
    }).then(function () { return msgToRow(msg); });
  }
  function deleteMessage(identityAcc, id) {
    var lower = String(identityAcc.username || "").toLowerCase();
    return writeState(function (s) {
      var keep = [];
      for (var i = 0; i < s.messages.length; i++) {
        var m = s.messages[i];
        var mine = String(m.username || "").toLowerCase() === lower;
        if (!(mine && m.id === id)) keep.push(m);
      }
      s.messages = keep;
    });
  }
  /* edit your own message — content replaced, editedAt stamped; every
     surface that renders the room (CDN pages + the website's merged
     #general) shows a small "(edited)" next to it */
  function editMessage(identityAcc, id, text) {
    var t = String(text || "").trim().slice(0, 2000);
    if (!t) return Promise.reject(new Error("empty"));
    var lower = String(identityAcc.username || "").toLowerCase();
    return writeState(function (s) {
      var hit = null;
      for (var i = 0; i < s.messages.length; i++) {
        var m = s.messages[i];
        if (m.id === id && String(m.username || "").toLowerCase() === lower) { hit = m; break; }
      }
      if (!hit) throw new Error("You can only edit your own messages.");
      hit.content = t;
      hit.editedAt = new Date().toISOString();
    });
  }

  /* ---------- presence ---------- */
  var lastBeat = 0;
  function heartbeat(identityAcc, force) {
    if (!identityAcc || !hasToken()) return Promise.resolve();
    var lower0 = String(identityAcc.username || "").toLowerCase();
    /* banned users don't get to look present */
    return fetchRoom().then(function (s) {
      var u = s && findUser(s, lower0);
      if (u && u.banned) return null;
      var now = Date.now();
      if (!force && now - lastBeat < CFG.heartbeatMs - 15000) return null;
      lastBeat = now;
      return writeState(function (st) {
        var uu = st.users[lower0];
        if (uu) uu.lastSeen = new Date().toISOString();
      });
    }).catch(function () { /* presence is best-effort */ });
  }
  function isOnlineLive(u, nowMs) {
    if (!u || !u.lastSeen) return false;
    var t = new Date(u.lastSeen).getTime();
    return isFinite(t) && nowMs - t < CFG.presenceWindowMs;
  }

  /* ---------- exports ---------- */
  window.VEILLIVE = {
    cfg: CFG,
    hasToken: hasToken,
    cdnUrl: CDN_FILE,
    identity: identity,
    saveIdentity: saveIdentity,
    clearIdentity: clearIdentity,
    fetchCdn: fetchCdn,
    fetchRoom: fetchRoom,
    register: register,
    login: login,
    sendMessage: sendMessage,
    deleteMessage: deleteMessage,
    editMessage: editMessage,
    heartbeat: heartbeat,
    isOnlineLive: isOnlineLive,
    pseudoAccount: pseudoAccount,
    msgToRow: msgToRow,
    findUser: findUser,
    purge: purge,
    siteLogin: siteLogin,
    friendlyError: function (e) {
      var msg = e && e.message ? String(e.message) : "";
      if (/banned/i.test(msg)) return msg;
      if (/muted/i.test(msg)) return msg;
      if (/no token/.test(msg)) return "The room isn't connected yet — try again in a minute.";
      if (/github 40[13]/.test(msg) || /rate limit/i.test(msg)) return "The room is busy — wait a moment and try again.";
      if (/github 409/.test(msg) || /conflict/.test(msg)) return "Someone typed at the same time — try again.";
      if (/fetch|network/i.test(msg)) return "Connection hiccup — the room may be waking up. Try again in a moment.";
      return msg || "Something went wrong.";
    },
  };
})();
