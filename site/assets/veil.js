/* ============================================================
   Veil — shared runtime for the static jsDelivr mirror.
   - Resolves CDN-absolute URLs against whichever jsDelivr host
     the page itself was loaded from (cdn/fastly/gcore/testingcf).
   - Renders the live #general chat from backups/chat/latest.json
     (auto-refreshed by the 30s backup loop + CDN purge).
   - Polls version.json and shows a refresh pill when the site
     has been updated on GitHub since the page was loaded.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- CDN base resolution ---------- */
  // Page lives at .../site/<page>.html  →  site root is one dir up.
  var HERE = window.location.href.split("#")[0].split("?")[0];
  var SITE_BASE = HERE.replace(/[^/]*$/, "");          // .../site/
  var REPO_BASE = SITE_BASE.replace(/[^/]*\/$/, "");   // .../veil-os@main/

  window.VEIL = {
    base: SITE_BASE,
    asset: function (p) { return SITE_BASE + p; },
    repoFile: function (p) { return REPO_BASE + p; },
    latestJson: function () { return REPO_BASE + "backups/chat/latest.json"; },
    versionJson: function () { return REPO_BASE + "site/version.json"; },
  };

  /* ---------- clock ---------- */
  function tickClock() {
    var el = document.querySelectorAll("[data-veil-clock]");
    var d = new Date();
    var hh = d.getHours(), mm = d.getMinutes(), ss = d.getSeconds();
    var ampm = hh >= 12 ? "PM" : "AM";
    var h12 = hh % 12 === 0 ? 12 : hh % 12;
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var t = h12 + ":" + pad(mm) + ":" + pad(ss) + " " + ampm;
    var days = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    var months = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    var ds = days[d.getDay()] + ", " + months[d.getMonth()] + " " + d.getDate();
    el.forEach(function (n) {
      if (n.hasAttribute("data-date")) n.textContent = ds;
      else if (n.hasAttribute("data-seconds")) n.textContent = t;
      else n.textContent = h12 + ":" + pad(mm) + " " + ampm;
    });
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ---------- helpers ---------- */
  function initials(name) {
    return (name || "?").trim().split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
  }
  function relTime(iso) {
    var then = new Date(iso).getTime();
    if (!then) return "";
    var s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    var d = new Date(iso);
    return (d.getMonth() + 1) + "/" + d.getDate() + "/" + d.getFullYear();
  }
  function clockTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var hh = d.getHours(), mm = String(d.getMinutes()).padStart(2, "0");
    var ampm = hh >= 12 ? "PM" : "AM";
    var h12 = hh % 12 === 0 ? 12 : hh % 12;
    return h12 + ":" + mm + " " + ampm;
  }
  function dateLabel(iso) {
    var d = new Date(iso);
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- message content renderer ---------- */
  var GIF_RE = /^https?:\/\/(?:media\d*\.giphy\.com|media\.giphy\.com|i\.giphy\.com|media\.tenor\.com)\/\S+\.(?:gif|png|webp|mp4)(?:\?\S*)?$/i;

  function renderContent(text) {
    var out = "";
    String(text || "").split(/(\s+)/).forEach(function (tok) {
      if (/^https?:\/\/\S+$/i.test(tok)) {
        var url = tok.replace(/[.,!?]+$/, "");
        if (GIF_RE.test(url)) {
          out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"><img class="gif" src="' + esc(url) + '" alt="GIF shared in chat" loading="lazy"></a>';
        } else {
          out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>";
        }
      } else {
        out += esc(tok);
      }
    });
    return out;
  }
  window.VEIL.renderContent = renderContent;

  /* ---------- chat renderer (site/chat.html) ---------- */
  var chatState = { rendered: 0, lastSig: null };

  function renderChat(data) {
    var list = document.getElementById("chat-messages");
    var count = document.getElementById("chat-count");
    if (!list) return;

    var accounts = {};
    (data.accounts || []).forEach(function (a) { accounts[a.id] = a; });
    var byId = {};
    (data.messages || []).forEach(function (m) { byId[m.id] = m; });

    var msgs = (data.messages || [])
      .filter(function (m) { return !m.channelId || m.channelId === "main" || m.channelId === "general"; })
      .sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });

    if (count) count.textContent = msgs.length;

    var html = "";
    var prevAuthor = null, prevDay = null;
    msgs.forEach(function (m) {
      var a = accounts[m.accountId] || { username: "unknown", displayName: "unknown", avatarColor: "#2c3e50", role: "member" };
      var name = a.displayName || a.username;
      var day = dateLabel(m.createdAt);
      var first = m.accountId !== prevAuthor || day !== prevDay;

      if (day !== prevDay) {
        html += '<div class="group-label" style="text-align:center;padding:14px 0 4px">' + esc(day) + "</div>";
      }

      html += '<div class="msg' + (first ? " first" : "") + '">';
      if (first) {
        html += '<div class="ava" style="background:' + esc(a.avatarColor || "#2c3e50") + '">' + esc(initials(name)) + "</div>";
        html += '<div class="mbody"><div class="mhead">';
        html += '<span class="mauthor">' + esc(name) + "</span>";
        if (a.role === "admin" || a.role === "owner") html += '<span class="mtag">ADMIN</span>';
        html += '<span class="mtime" title="' + esc(m.createdAt) + '">' + esc(clockTime(m.createdAt)) + "</span>";
        html += "</div>";
      } else {
        html += '<div class="ava" style="visibility:hidden;background:#000">' + esc(initials(name)) + "</div>";
        html += '<div class="mbody"><div class="mhead"><span class="mtime" style="opacity:0">.</span></div>';
      }
      var reply = "";
      if (m.replyTo && byId[m.replyTo]) {
        var ra = accounts[byId[m.replyTo].accountId] || { displayName: "unknown" };
        reply = '<div class="pill" style="display:inline-block;margin-bottom:4px">↩ ' + esc(ra.displayName || "?") + ": " + esc(String(byId[m.replyTo].content || "").slice(0, 60)) + "</div><br>";
      }
      html += '<div class="mtext">' + reply + renderContent(m.content) + "</div></div></div>";

      prevAuthor = m.accountId; prevDay = day;
    });

    if (!msgs.length) {
      html = '<div style="text-align:center;padding:60px 20px;color:var(--text-2)"><div style="font-size:44px;margin-bottom:10px">💬</div>No messages yet — the live site has them first.</div>';
    }
    list.innerHTML = html;
    chatState.rendered = msgs.length;
  }

  function renderPlayers(data) {
    var box = document.getElementById("players-list");
    if (!box) return;
    var html = '<div class="group-label">Members — ' + (data.accounts || []).length + "</div>";
    var sorted = (data.accounts || []).slice().sort(function (a, b) {
      var rank = function (x) { return x.role === "admin" || x.role === "owner" ? 0 : 1; };
      return rank(a) - rank(b) || a.username.localeCompare(b.username);
    });
    sorted.forEach(function (a) {
      var name = a.displayName || a.username;
      html += '<div class="prow">';
      html += '<div class="pava" style="background:' + esc(a.avatarColor || "#2c3e50") + '">' + esc(initials(name)) + '<span class="dot' + (a.legacy ? "" : " on") + '"></span></div>';
      html += '<div><div class="pname">' + esc(name);
      if (a.role === "admin" || a.role === "owner") html += ' <span class="pbadge">ADMIN</span>';
      html += "</div>";
      html += '<div style="font-size:11px;color:var(--text-2)">@' + esc(a.username) + (a.legacy ? " · legacy" : "") + ")</div></div></div>";
    });
    box.innerHTML = html;

    var stamp = document.getElementById("backup-age");
    if (stamp && data.exportedAt) stamp.textContent = "snapshot " + relTime(data.exportedAt);
  }

  function loadChat() {
    fetch(window.VEIL.latestJson(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        renderChat(data);
        renderPlayers(data);
        var err = document.getElementById("chat-error");
        if (err) err.style.display = "none";
      })
      .catch(function () {
        var err = document.getElementById("chat-error");
        if (err) err.style.display = "block";
      });
  }

  if (document.getElementById("chat-messages")) {
    loadChat();
    setInterval(loadChat, 30000); // mirror of the 30s backup loop
  }

  /* ---------- version pill: "site updated — refresh" ---------- */
  function pollVersion() {
    fetch(window.VEIL.versionJson() + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (!v || !v.built) return;
        var pageStamp = document.documentElement.getAttribute("data-veil-build") || "0";
        if (v.built > pageStamp) {
          var pill = document.getElementById("refresh-pill");
          if (pill) pill.style.display = "inline-flex";
        }
      })
      .catch(function () {});
  }
  if (document.getElementById("refresh-pill")) {
    setTimeout(pollVersion, 4000);
    setInterval(pollVersion, 30000);
  }

  /* ---------- copy buttons (links page) ---------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (!b) return;
    e.preventDefault();
    var txt = b.getAttribute("data-copy");
    function done() {
      b.classList.add("done");
      b.textContent = "copied ✓";
      setTimeout(function () { b.classList.remove("done"); b.textContent = "copy"; }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (x) {}
      document.body.removeChild(ta);
    }
  });
})();
