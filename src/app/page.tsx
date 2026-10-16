"use client";

/**
 * Veil — a full-screen web viewer with multi-tab browsing.
 *
 * Start mode: the start page (wallpaper backdrop, clock, weather, command
 * bar, dock) with full-viewport section overlays — Veil AI, Arcade,
 * Wallpapers, Music, Links, History, Settings. Sections mount on first
 * open and STAY MOUNTED (hidden) so arcade games and docked music keep
 * running while you browse.
 * Browse mode: one or more tabs, each with its own navigation stack. The
 * active tab's remote page takes over the whole viewport with an
 * auto-hiding control bar. The remote page reports navigation events back
 * here via postMessage so the URL bar and history stay in sync.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { StartPage, type SectionId } from "@/components/veil/start-page";
import { BrowserView, type Tab } from "@/components/veil/browser";
import type { TabMenuAction } from "@/components/veil/quasar-tab-strip";
import { AiSection } from "@/components/veil/ai-section";
import { ArcadeSection } from "@/components/veil/arcade-section";
import { StreamSection } from "@/components/veil/stream-section";
import { ChatSection } from "@/components/veil/chat-section";
import { MusicSection } from "@/components/veil/music-section";
import { WallpapersSection } from "@/components/veil/wallpapers-section";
import { SettingsSection } from "@/components/veil/settings-section";
import { CoderSection } from "@/components/veil/coder-section";
import { LinksSection, HistorySection } from "@/components/veil/start-sections";
import { VeilMusicPlayer } from "@/components/veil/veil-player";
import { PresenceHeartbeat } from "@/components/veil/presence-heartbeat";
import { usePanicKeys } from "@/lib/veil/panic";
import { useTabCloak } from "@/lib/veil/tab-cloak";
import {
  isArcadeSource,
  isVeilAppUrl,
  uid,
  viewerHeaders,
  type HistoryResponse,
} from "@/lib/veil/shared";

import { purgeFatCookiesOnBoot } from "@/lib/veil/cookie-hygiene";
import { useFancyMotion } from "@/lib/veil/motion";

/* 431 firewall — sweep fat cookies (the legacy session mirror carried the
 * whole account incl. the base64 PFP; proxied pages used to drop their
 * cookies on this origin too) BEFORE the first section fetch goes out.
 * Node rejects requests with headers over 16KB, so one fat cookie was
 * enough to break every API call in the app. No-op on the server and
 * when the jar is already lean. */
purgeFatCookiesOnBoot();

interface VeilMessage {
  __veil: 1;
  type: "nav" | "title" | "error" | "home-request" | "mouse" | "esc" | "search-request" | "open-tab";
  url: string;
  d?: { title?: string; message?: string; q?: string };
}

const STORAGE_KEY = "veil:tabs:v1";

function makeTab(url?: string): Tab {
  return {
    id: uid(),
    stack: url ? [url] : [],
    idx: url ? 0 : -1,
    reloadKey: 0,
    title: "",
    /* Quasar v2.1.0 per-tab context */
    container: "default",
    egress: "auto",
    ua: "",
    pinned: false,
    muted: false,
  };
}

/** Normalize a restored/persisted tab — fills the v2.1.0 context fields
 *  so pre-upgrade sessions keep loading without undefined access. */
function normTab(t: Tab): Tab {
  return {
    ...t,
    container: typeof t.container === "string" ? t.container : "default",
    egress: t.egress === "direct" || t.egress === "upstream" ? t.egress : "auto",
    ua: typeof t.ua === "string" ? t.ua : "",
    pinned: t.pinned === true,
    muted: t.muted === true,
  };
}

function activeTarget(tab: Tab | null): string {
  if (!tab || tab.idx < 0) return "";
  return tab.stack[tab.idx] ?? "";
}

const SECTIONS: SectionId[] = ["ai", "arcade", "stream", "chat", "wallpapers", "music", "links", "history", "coder", "settings"];

export default function Home() {
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [history, setHistory] = React.useState<HistoryResponse | null>(null);
  const [hydrated, setHydrated] = React.useState(false);
  // Query a veiled page (bot-wall “search this site”) asked the start page
  // to run on its next mount — consumed once by StartPage.
  const [pendingSearch, setPendingSearch] = React.useState("");

  /* Settings › Appearance — "More animations" (default On): amplified
     motion across the WHOLE site — start page, overlays, browser. */
  const fancy = useFancyMotion();

  // Hydration handshake — pairs with the inline watchdog in layout.tsx:
  // mark the window hydrated as soon as React takes over, and clear the
  // watchdog's one-shot retry flag so the NEXT stall can still self-heal.
  React.useEffect(() => {
    (window as unknown as { __veilHydrated?: boolean }).__veilHydrated = true;
    try {
      sessionStorage.removeItem("veil:hydra-retry");
    } catch {
      /* private mode */
    }
  }, []);

  // ----- panic key + about:blank cloak (capture-phase, every mode) -----
  usePanicKeys();

  // ----- tab disguise (Settings › Security — title + favicon) -----
  useTabCloak();

  // ----- section overlays (lazy-mount on first open, then stay alive) -----
  // A reload mid-conversation (dev-server restore, Fast Refresh on a cold
  // route compile) used to land back on the start page — killing the Veil
  // AI chat and any in-flight build. The "ai" section reopens from
  // sessionStorage; the conversation itself is restored inside
  // ai-section.tsx from the same store. The reopen happens in an effect
  // (not a state initializer): this page is server-rendered, and
  // sessionStorage does not exist during SSR.
  const [section, setSection] = React.useState<SectionId | null>(null);
  const [opened, setOpened] = React.useState<Set<SectionId>>(() => new Set());
  React.useEffect(() => {
    try {
      // EVERY section reopens after ANY reload — a restart must never
      // dump the user back on the start page mid-game, mid-chat or
      // mid-stream. The hint lives in BOTH sessionStorage (same-tab
      // reloads) and localStorage (new tabs / reopened previews — the
      // "still resets to the home page" fix: sessionStorage alone dies
      // with the tab, so a dev-server restart that took the preview down
      // landed the user home on the next open). (The chat account lives
      // in localStorage, so reopening lands inside the chat, logged in.)
      const saved =
        sessionStorage.getItem("veil:section") ??
        localStorage.getItem("veil:section");
      if (saved && (SECTIONS as string[]).includes(saved)) {
        setOpened((prev) => (prev.has(saved) ? prev : new Set([...prev, saved])));
        setSection(saved);
      }
    } catch {
      /* private mode */
    }
  }, []);
  const openSection = React.useCallback((id: SectionId) => {
    setOpened((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
    setSection(id);
  }, []);
  const closeSection = React.useCallback(() => setSection(null), []);

  // Keep the reopen hint in sync — removed the moment the section closes.
  // The first run is skipped: on a reload-restore the mount pass still
  // sees section=null, and a remove there would race the restore effect
  // that just read the key (both run in the same commit).
  const sectionInit = React.useRef(true);
  React.useEffect(() => {
    if (sectionInit.current) {
      sectionInit.current = false;
      return;
    }
    try {
      if (section) {
        sessionStorage.setItem("veil:section", section);
        localStorage.setItem("veil:section", section);
      } else {
        sessionStorage.removeItem("veil:section");
        localStorage.removeItem("veil:section");
      }
    } catch {
      /* private mode — best effort */
    }
  }, [section]);

  const activeTab = React.useMemo(
    () => tabs.find((t) => t.id === activeId) ?? null,
    [tabs, activeId]
  );
  const target = activeTarget(activeTab);
  const mode = tabs.length === 0 ? "home" : "browse";

  // Refs to avoid stale closures in the postMessage listener and openUrl.
  const activeIdRef = React.useRef<string | null>(activeId);
  React.useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const activeTargetRef = React.useRef(target);
  React.useEffect(() => {
    activeTargetRef.current = target;
  }, [target]);
  const wasHomeRef = React.useRef(true);
  React.useEffect(() => {
    wasHomeRef.current = mode === "home";
  }, [mode]);

  // ----- restore session on mount -----
  // Two layers, deliberately different:
  //   1. SAME-TAB reload recovery (sessionStorage "veil:crash-tabs") —
  //      when the dev server restarts or the user hits F5 mid-browse, the
  //      page reloads and this puts them back on the page they were on.
  //      sessionStorage dies with the tab, so REOPENING the veil later
  //      still lands on the start page (the privacy directive holds for
  //      new visits).
  //   2. Cross-session restore (localStorage) — stays opt-in via
  //      Settings › Browsing, exactly as before.
  React.useEffect(() => {
    try {
      const crashRaw = sessionStorage.getItem("veil:crash-tabs");
      if (crashRaw) {
        const parsed = JSON.parse(crashRaw) as { tabs: Tab[]; activeId: string | null };
        const valid = Array.isArray(parsed.tabs)
          ? parsed.tabs.filter(
              (t) => t && typeof t.id === "string" && Array.isArray(t.stack)
            )
          : [];
        if (valid.length) {
          setTabs(valid.slice(0, 8).map(normTab));
          const a =
            parsed.activeId && valid.some((t) => t.id === parsed.activeId)
              ? parsed.activeId
              : valid[0].id;
          setActiveId(a);
        }
        return; // same-tab recovery wins — skip the cross-session path
      }
      // Default flipped (owner request 2026-10-17): tabs ALWAYS come back
      // unless the user explicitly opted into the reset (Settings ›
      // Browsing › "Start page" writes veil:keep-session=0). Being dumped
      // on the start page after a restart was the standing complaint.
      const keep = (() => {
        try {
          return window.localStorage.getItem("veil:keep-session") !== "0";
        } catch {
          return true;
        }
      })();
      if (!keep) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { tabs: Tab[]; activeId: string | null };
          if (Array.isArray(parsed.tabs) && parsed.tabs.length) {
            const valid = parsed.tabs.filter(
              (t) => t && typeof t.id === "string" && Array.isArray(t.stack)
            );
            if (valid.length) {
              setTabs(valid.slice(0, 8).map(normTab));
              const a =
                parsed.activeId && valid.some((t) => t.id === parsed.activeId)
                  ? parsed.activeId
                  : valid[0].id;
              setActiveId(a);
            }
          }
        }
      }
    } catch {
      /* ignore corrupt storage */
    } finally {
      setHydrated(true);
    }
  }, []);

  // ----- persist session -----
  React.useEffect(() => {
    if (!hydrated) return;
    try {
      if (tabs.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId }));
        // Same-tab reload recovery mirror — see the restore effect above.
        sessionStorage.setItem("veil:crash-tabs", JSON.stringify({ tabs, activeId }));
      } else {
        localStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem("veil:crash-tabs");
      }
    } catch {
      /* storage may be unavailable */
    }
  }, [tabs, activeId, hydrated]);

  // ----- history persistence (viewer-scoped via headers/cookie) -----
  const refreshHistory = React.useCallback(async () => {
    try {
      const res = await fetch("/api/history", { cache: "no-store", headers: viewerHeaders() });
      if (res.ok) setHistory((await res.json()) as HistoryResponse);
    } catch {
      /* keep whatever we had */
    }
  }, []);

  const recordVisit = React.useCallback(
    (url: string, visitTitle: string) => {
      fetch("/api/history", {
        method: "POST",
        headers: { "content-type": "application/json", ...viewerHeaders() },
        body: JSON.stringify({ url, title: visitTitle || undefined }),
      })
        .then(() => refreshHistory())
        .catch(() => {
          /* non-fatal */
        });
    },
    [refreshHistory]
  );

  React.useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // ----- loading safety valve -----
  // The loading bar clears on the iframe's load event — but an interrupted
  // navigation or a page that dies mid-handshake can leave it sweeping
  // forever (reads as "frozen"). After 45s, give up gracefully: the page
  // is either there or it isn't.
  React.useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 45_000);
    return () => clearTimeout(t);
  }, [loading]);

  // ----- navigation helpers -----
  const openUrl = React.useCallback((url: string, opts?: { newTab?: boolean }) => {
    // Veil-local programs (freetube.veil.local) load from the same-origin
    // /ft mount — the browser renders the pseudo-URL while the iframe
    // loads the program. Everything else — youtube.com included — goes
    // through the selected proxy engine, exactly like any other site.
    // One funnel, every entry point covered: command bar, URL pill,
    // quick links, sections, history rows.
    // opts.newTab: chat links and in-page popups (window.open / ads)
    // always spawn a FRESH tab with the correct URL instead of pushing
    // onto the active tab's stack.
    const seedTitle = isVeilAppUrl(url) ? "FreeTube" : "";
    const needsNewTab = !activeIdRef.current || !!opts?.newTab;
    const enteringBrowse = wasHomeRef.current;
    const id = needsNewTab ? uid() : activeIdRef.current!;
    setTabs((ts) => {
      if (needsNewTab) return [...ts, normTab({ id, stack: [url], idx: 0, reloadKey: 0, title: seedTitle })];
      return ts.map((t) => {
        if (t.id !== id) return t;
        if (t.idx === -1) return { ...t, stack: [url], idx: 0, title: seedTitle };
        const stack = [...t.stack.slice(0, t.idx + 1), url];
        return { ...t, stack, idx: stack.length - 1, title: seedTitle };
      });
    });
    if (needsNewTab) setActiveId(id);
    setLoading(true);
    // Opening a site closes any open section overlay.
    setSection(null);
    // Attempt OS-level fullscreen when we are leaving the start page via a
    // real user gesture (click/Enter). Silently no-ops in sandboxed previews.
    if (enteringBrowse && typeof document !== "undefined" && !document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  // Links tapped anywhere inside a section overlay (Veil Chat messages,
  // AI answers, shop items…) ask the OS to open them as real browser
  // tabs through the active engine lane. The chat fires a cancelable
  // "veil:open-url" CustomEvent: calling preventDefault here tells the
  // sender "the OS took it" (dispatchEvent returns false), so a
  // standalone chat build without this listener falls back to opening
  // the real URL directly instead of a broken proxy path.
  React.useEffect(() => {
    const onOpenUrl = (e: Event) => {
      const detail = (e as CustomEvent).detail as { url?: unknown; newTab?: boolean } | undefined;
      const url = detail?.url;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        e.preventDefault();
        openUrl(url, { newTab: !!detail?.newTab });
      }
    };
    window.addEventListener("veil:open-url", onOpenUrl);
    return () => window.removeEventListener("veil:open-url", onOpenUrl);
  }, [openUrl]);

  const back = React.useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    setTabs((ts) => ts.map((t) => (t.id === id && t.idx > 0 ? { ...t, idx: t.idx - 1 } : t)));
    setLoading(true);
  }, []);

  const forward = React.useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    setTabs((ts) =>
      ts.map((t) => (t.id === id && t.idx < t.stack.length - 1 ? { ...t, idx: t.idx + 1 } : t))
    );
    setLoading(true);
  }, []);

  const reload = React.useCallback(() => {
    const id = activeIdRef.current;
    if (!id) return;
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, reloadKey: t.reloadKey + 1 } : t)));
    setLoading(true);
  }, []);

  const newTab = React.useCallback(() => {
    const t = makeTab();
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    setLoading(false);
  }, []);

  /* target=_blank / middle-click inside an engine page — cherrion-style
   * in-app tabs: the link opens as a brand-new tab with its URL. */
  const openInNewTab = React.useCallback((url: string) => {
    const clean = url.trim();
    if (!clean || !/^https?:\/\//i.test(clean)) return;
    const id = uid();
    setTabs((ts) => [...ts, normTab({ id, stack: [clean], idx: 0, reloadKey: 0, title: "" })]);
    setActiveId(id);
    setLoading(true);
  }, []);

  /* ── Quasar v2.1.0: closed-tab stack (Ctrl+Shift+T reopen) ──
   * (declared before closeTab — closeTab pushes onto this stack) */
  const closedTabsRef = React.useRef<Tab[]>([]);
  const [canReopen, setCanReopen] = React.useState(false);
  const pushClosed = React.useCallback((t: Tab) => {
    closedTabsRef.current = [...closedTabsRef.current.slice(-9), t];
    setCanReopen(true);
  }, []);
  const reopenTab = React.useCallback(() => {
    const last = closedTabsRef.current.pop();
    closedTabsRef.current = closedTabsRef.current.slice();
    setCanReopen(closedTabsRef.current.length > 0);
    if (!last) return;
    const id = uid();
    setTabs((ts) => [...ts, { ...last, id, reloadKey: last.reloadKey + 1 }]);
    setActiveId(id);
    setLoading(true);
  }, []);

  const closeTab = React.useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const next = tabs.filter((t) => t.id !== id);
      pushClosed(tabs[idx]);
      setTabs(next);
      if (next.length === 0) {
        setActiveId(null);
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        void refreshHistory();
      } else if (id === activeId) {
        const neighbor = next[Math.min(idx, next.length - 1)];
        setActiveId(neighbor.id);
        setLoading(true);
      }
    },
    [tabs, activeId, refreshHistory, pushClosed]
  );

  const switchTab = React.useCallback((id: string) => {
    setActiveId(id);
    setLoading(true);
  }, []);

  /* ── Quasar v2.1.0: tab context-menu actions ── */
  const onTabAction = React.useCallback(
    (tabId: string, action: TabMenuAction) => {
      if (action.type === "toggle-pin" || action.type === "toggle-mute") {
        setTabs((ts) =>
          ts.map((t) =>
            t.id === tabId
              ? { ...t, pinned: action.type === "toggle-pin" ? !t.pinned : t.pinned, muted: action.type === "toggle-mute" ? !t.muted : t.muted }
              : t
          )
        );
        // Changing the ctx levers re-encodes the blob → reload the tab.
        if (action.type === "toggle-mute") return; // mute is live-relayed, no reload needed
        return;
      }
      if (action.type === "duplicate") {
        setTabs((ts) => {
          const src = ts.find((t) => t.id === tabId);
          if (!src) return ts;
          const copy: Tab = { ...src, id: uid(), reloadKey: 0 };
          const at = ts.findIndex((t) => t.id === tabId);
          const next = [...ts.slice(0, at + 1), copy, ...ts.slice(at + 1)];
          return next;
        });
        return;
      }
      if (action.type === "close") {
        closeTab(tabId);
        return;
      }
      if (action.type === "close-others") {
        setTabs((ts) => {
          const keep = ts.filter((t) => t.id === tabId || t.pinned);
          for (const t of ts) {
            if (!keep.some((k) => k.id === t.id)) pushClosed(t);
          }
          return keep;
        });
        return;
      }
      if (action.type === "container" || action.type === "egress" || action.type === "ua") {
        setTabs((ts) =>
          ts.map((t) => {
            if (t.id !== tabId) return t;
            if (action.type === "container") return { ...t, container: action.container, reloadKey: t.reloadKey + 1 };
            if (action.type === "egress") return { ...t, egress: action.egress, reloadKey: t.reloadKey + 1 };
            return { ...t, ua: action.ua, reloadKey: t.reloadKey + 1 };
          })
        );
        setLoading(true);
        return;
      }
      if (action.type === "drop-container") {
        // Wipe the container's cookie jars server-side, then reset the tab.
        void fetch("/api/container", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "drop", container: action.container }),
        }).catch(() => {
          /* best effort */
        });
        setTabs((ts) =>
          ts.map((t) =>
            t.id === tabId || t.container === action.container
              ? { ...t, container: "default", reloadKey: t.reloadKey + 1 }
              : t
          )
        );
        setLoading(true);
        return;
      }
    },
    [closeTab, pushClosed]
  );

  /* ── Quasar v2.1.0: drag reorder ── */
  const reorderTab = React.useCallback((dragId: string, targetId: string, place: "before" | "after") => {
    if (dragId === targetId) return;
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === dragId);
      if (from === -1) return ts;
      const [moved] = ts.splice(from, 1);
      let to = ts.findIndex((t) => t.id === targetId);
      if (to === -1) return [...ts, moved];
      if (place === "after") to += 1;
      ts.splice(to, 0, moved);
      return [...ts];
    });
  }, []);

  const home = React.useCallback(() => {
    setTabs([]);
    setActiveId(null);
    setLoading(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    void refreshHistory();
  }, [refreshHistory]);

  // ----- messages from the remote page -----
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as VeilMessage | undefined;
      if (!d || typeof d !== "object" || d.__veil !== 1) return;
      // Arcade title iframes run the same control script as veiled pages —
      // their messages must never drive the browser tab state.
      if (isArcadeSource(e.source)) return;

      if (d.type === "home-request") {
        // The veiled page's shell button (or an explicit home ask). NOTE:
        // the old "esc" relay used to live here — one Escape pressed
        // inside a veiled page (closing a YouTube menu, a search dropdown,
        // any custom modal) nuked EVERY tab and dumped the user on the
        // start page. That was the "it constantly reloads / brings me
        // back to the main screen" bug. Escape inside a page now belongs
        // 100% to the page — browser.tsx only uses the relay to surface
        // the control bar (runtime.ts's original intent).
        home();
        return;
      }
      if (d.type === "search-request") {
        // The bot-wall page's “search this site's content” button: go home
        // and run a web search for the query the page handed over.
        const q = typeof d.d?.q === "string" ? d.d.q.trim().slice(0, 120) : "";
        home();
        if (q) setPendingSearch(q);
        return;
      }
      if (d.type === "open-tab") {
        // A proxied page asked for a popup/new window (window.open,
        // target=_blank links, ad redirects): open it as a real Veil tab
        // through the engine lane instead of escaping to the host browser.
        // The engine sends either a REAL https:// url or — for AES-encrypted
        // proxied paths it cannot decode client-side — a /p/<blob>/... path,
        // which is resolved to the real URL server-side via /api/codec.
        const url = d.url;
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          openUrl(url, { newTab: true });
        } else if (typeof url === "string" && url.startsWith("/p/")) {
          fetch("/api/codec", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "decode", paths: [url.split("#")[0]] }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { urls?: unknown } | null) => {
              const real = Array.isArray(data?.urls) ? (data?.urls as unknown[])[0] : null;
              if (typeof real === "string" && /^https?:\/\//i.test(real)) {
                openUrl(real, { newTab: true });
              }
            })
            .catch(() => {
              /* undecodable popup — better dropped than escaped */
            });
        }
        return;
      }
      if (d.type === "error") {
        setLoading(false);
        return;
      }
      if (d.type === "nav") {
        setLoading(false);
        const url = d.url;
        const t = d.d?.title ?? "";
        const id = activeIdRef.current;
        if (!id) return;
        setTabs((ts) =>
          ts.map((tab) => {
            if (tab.id !== id) return tab;
            const updated = { ...tab, title: t };
            // If the page navigated somewhere new (link click inside the frame),
            // adopt it into this tab's stack so back/forward still work.
            if (url && url !== activeTargetRef.current) {
              const stack = [...updated.stack.slice(0, updated.idx + 1), url];
              return { ...updated, stack, idx: stack.length - 1 };
            }
            return updated;
          })
        );
        recordVisit(url, t);
        return;
      }
      if (d.type === "title") {
        const id = activeIdRef.current;
        if (!id) return;
        setTabs((ts) => ts.map((tab) => (tab.id === id ? { ...tab, title: d.d?.title ?? "" } : tab)));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [home, recordVisit]);

  // ----- global keyboard -----
  // Home: "/" focuses the command bar (handled inside StartPage), "?" opens
  // the shortcuts overlay. Esc: close a section overlay ONLY — never the
  // browse session (stray Escapes inside pages must stay harmless).
  // Browse: browser.tsx owns F / Alt+arrows / Ctrl+L / Ctrl+T / Ctrl+Tab.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      // Quasar v2.1.0 — reopen closed tab works from BOTH modes (the
      // browser-chrome handler only lives while a tab is open).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        reopenTab();
        return;
      }
      if (e.key === "Escape") {
        // A page/video inside the veil exiting fullscreen owns this
        // Escape — never the session. (Race guard alongside the engine's
        // own filter in rewrite.ts.)
        if (document.fullscreenElement) return;
        if (section) {
          // A section handles its own Esc first (arcade tuck, dialogs) —
          // only the un-handled remainder bubbles here, closing the overlay.
          if (section === "arcade") return; // arcade manages its own Esc flow
          e.preventDefault();
          closeSection();
          return;
        }
        // Browse mode: Escape is DELIBERATELY a no-op now. Pages use Esc
        // for their own menus/dialogs constantly (YouTube dropdowns, custom
        // modals) — a stray Esc wiping every open tab was the "kicked back
        // to the main screen" bug. The chrome's Home button remains the
        // explicit exit.
        return;
      }
      if (mode !== "home" || section) return;
      if (e.key === "?" && !typing) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("veil:open-shortcuts"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, section, closeSection, home, reopenTab]);

  // ----- privacy reset on tab switch -----
  // Settings › Browsing: by default, switching to another browser tab
  // resets Veil to the innocent start page; "keep the page" opts out.
  const privacySweep = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    const cancelSweep = () => {
      if (privacySweep.current) {
        clearTimeout(privacySweep.current);
        privacySweep.current = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState !== "hidden") return;
      let keep = true;
      try {
        // Default flipped to KEEP (owner request 2026-10-13): switching away
        // and coming back must never dump the user on the start page. Only
        // an explicit "0" (Settings › Browsing › "Start page") resets.
        keep = window.localStorage.getItem("veil:keep-session") !== "0";
      } catch {
        /* private mode — default keep */
      }
      if (!keep) {
        if (section) closeSection();
        if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        home();
        // The storage sweep must NOT run when this hide is part of an
        // unload: browsers fire visibilitychange(hidden) right before
        // pagehide on every reload/navigation, and clearing there would
        // kill the conversation-survival restore the reload is counting
        // on (observed live: the AI section never came back). pagehide
        // cancels the sweep — only a real tab-switch (page stays hidden,
        // no pagehide) lets it through.
        cancelSweep();
        privacySweep.current = setTimeout(() => {
          privacySweep.current = null;
          try {
            sessionStorage.removeItem("veil:section");
            sessionStorage.removeItem("veil:ai-chat-v1");
            localStorage.removeItem("veil:section");
          } catch {
            /* best effort */
          }
        }, 1000);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", cancelSweep);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", cancelSweep);
      cancelSweep();
    };
  }, [section, closeSection, home]);

  // ----- proxy engine switches -----
  // Changing the engine in Settings reloads every open tab so each iframe
  // re-derives its frame source through the new engine's lane.
  React.useEffect(() => {
    const onEngine = () => {
      setTabs((ts) => {
        if (ts.length === 0) return ts;
        return ts.map((t) => ({ ...t, reloadKey: t.reloadKey + 1 }));
      });
      setLoading(true);
    };
    window.addEventListener("veil:proxy-engine", onEngine);
    return () => window.removeEventListener("veil:proxy-engine", onEngine);
  }, []);

  // ----- section renderer -----
  const renderSection = (id: SectionId) => {
    /* sections stay mounted once opened (hidden when closed) — pass the
     * live open state down so sections like Music can dock/undock their
     * persistent chrome on close/reopen instead of only on first mount */
    const sectionOpen = section === id && mode === "home";
    switch (id) {
      case "ai":
        return <AiSection onBack={closeSection} onOpenUrl={openUrl} />;
      case "arcade":
        return <ArcadeSection onBack={closeSection} onLaunch={(url) => openUrl(url)} />;
      case "stream":
        return <StreamSection onBack={closeSection} />;
      case "chat":
        return <ChatSection onBack={closeSection} />;
      case "wallpapers":
        return <WallpapersSection onBack={closeSection} />;
      case "music":
        return <MusicSection onBack={closeSection} open={sectionOpen} />;
      case "links":
        return (
          <LinksSection onBack={closeSection} onNavigate={openUrl} />
        );
      case "history":
        return (
          <HistorySection
            onBack={closeSection}
            onNavigate={openUrl}
            history={history}
            onHistoryChanged={() => void refreshHistory()}
          />
        );
      case "coder":
        return <CoderSection onBack={closeSection} />;
      case "settings":
        return <SettingsSection onBack={closeSection} />;
    }
  };

  return (
    <>
      <AnimatePresence mode="wait">
        {mode === "home" ? (
          <StartPage
            key="start"
            onNavigate={openUrl}
            history={history}
            onHistoryChanged={() => void refreshHistory()}
            section={section}
            onOpenSection={openSection}
            autoSearch={pendingSearch}
            onAutoSearchConsumed={() => setPendingSearch("")}
          />
        ) : (
          <BrowserView
            key="browser"
            tabs={tabs}
            activeId={activeId!}
            target={target}
            title={activeTab?.title ?? ""}
            loading={loading}
            canBack={(activeTab?.idx ?? -1) > 0}
            canForward={activeTab ? activeTab.idx < activeTab.stack.length - 1 : false}
            reloadKey={activeTab?.reloadKey ?? 0}
            history={history}
            onBack={back}
            onForward={forward}
            onReload={reload}
            onHome={home}
            onNavigate={openUrl}
            onUrlChange={() => setLoading(false)}
            onNewTab={newTab}
            onCloseTab={closeTab}
            onSwitchTab={switchTab}
            onOpenInNewTab={openInNewTab}
            onTabAction={onTabAction}
            onReorder={reorderTab}
            onReopen={reopenTab}
            canReopen={canReopen}
          />
        )}
      </AnimatePresence>

      {/* Section overlays — mounted on first open, kept alive (hidden) so
          arcade games and the music player survive closing the section.
          With More animations, an animated backdrop layer breathes in
          behind whichever section is open (a per-open fade + drift, kept
          SEPARATE from the wrappers so the sections themselves never
          remount and lose state). */}
      <AnimatePresence>
        {fancy && section && mode === "home" && section !== "chat" && (
          <motion.div
            key="veil-section-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="pointer-events-none fixed inset-0 z-40 bg-zinc-950/80 backdrop-blur-sm"
            aria-hidden
          />
        )}
      </AnimatePresence>
      {SECTIONS.filter((id) => opened.has(id)).map((id) => {
        const open = section === id && mode === "home";
        return (
          <div
            key={id}
            className={
              open
                ? // Chat paints its own frosted-wallpaper backdrop — no
                  // extra dim/blur on the wrapper (would double the GPU cost).
                  // (Fancy mode adds the animated backdrop above instead.)
                  id === "chat"
                  ? "fixed inset-0 z-50"
                  : fancy
                    ? "fixed inset-0 z-50"
                    : "fixed inset-0 z-50 bg-zinc-950/80 backdrop-blur-sm"
                : "hidden"
            }
            aria-hidden={!open}
          >
            {renderSection(id)}
          </div>
        );
      })}

      {/* Global docked music player (listens for veil:music-play) */}
      <VeilMusicPlayer />

      {/* Site-wide presence heartbeat — mounted once, survives the
          start-page ↔ browsing switch so “who's online” never goes dark. */}
      <PresenceHeartbeat />
    </>
  );
}
