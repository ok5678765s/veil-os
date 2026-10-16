"use client";

/**
 * Veil — full-screen browsing overlay with multi-tab support.
 *
 * Takes over the entire viewport (fixed inset-0) with an auto-hiding glass
 * control bar. The remote page renders edge-to-edge underneath it. When the
 * active tab has no target yet, a compact start page is shown instead.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Home,
  Lock,
  Maximize,
  Minimize,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Sparkles,
  Volume2,
  VolumeX,
  Search,
} from "lucide-react";
import { KeyboardHelp } from "@/components/veil/keyboard-help";
import { NewTab } from "@/components/veil/new-tab";
import { FindBar } from "@/components/veil/quasar-find-bar";
import { QuasarDebugPanel } from "@/components/veil/quasar-debug-panel";
import {
  QuasarTabStrip,
  type TabMenuAction,
} from "@/components/veil/quasar-tab-strip";
import {
  DEFAULT_TAB_CTX,
  encodeQuasarPath,
  engineFrameSrc,
  faviconUrls,
  isVeilAppUrl,
  normalizeInput,
  proxyEngineId,
  quasarCtxActive,
  veilAppFrameSrc,
  type HistoryResponse,
  type QuasarTabCtx,
  type TabEgress,
} from "@/lib/veil/shared";
import { FANCY_GLIDE_EASE, useFancyMotion } from "@/lib/veil/motion";

export interface Tab {
  id: string;
  stack: string[];
  idx: number;
  reloadKey: number;
  title: string;
  /* ── Quasar v2.1.0 per-tab context ── baked into every encoded blob
   * for this tab: cookie container, egress route, UA override. Plus the
   * chrome-level pin / mute flags. */
  container: string;
  egress: TabEgress;
  ua: string;
  pinned: boolean;
  muted: boolean;
}

export type { TabEgress, TabMenuAction };

const BAR_IDLE_MS = 2600;

/** Veil's local programs (freetube.veil.local) load from the same-origin
 *  /ft mount instead of the WISP route — their favicon is a play glyph. */
function TabFavicon({ target, title }: { target: string; title: string }) {
  const [failed, setFailed] = React.useState(false);
  const host = React.useMemo(() => {
    if (!target) return "";
    try {
      return new URL(target).hostname;
    } catch {
      return "";
    }
  }, [target]);
  const isFt = isVeilAppUrl(target);
  const urls = React.useMemo(() => (host && !isFt ? faviconUrls(host) : []), [host, isFt]);
  const [idx, setIdx] = React.useState(0);

  React.useEffect(() => {
    setFailed(false);
    setIdx(0);
  }, [host, isFt]);

  if (!target) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500">
        <Sparkles aria-hidden className="h-3 w-3" />
      </span>
    );
  }
  if (isFt) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-emerald-500/20 text-emerald-300">
        <Play aria-hidden className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (failed || idx >= urls.length) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-emerald-500/20 text-[9px] font-semibold text-emerald-300">
        {(title || host || "?").charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={urls[idx]}
      alt=""
      width={16}
      height={16}
      onError={() => setIdx((i) => i + 1)}
      className="h-4 w-4 shrink-0 rounded-sm bg-zinc-800 object-contain p-px"
    />
  );
}

export function BrowserView({
  tabs,
  activeId,
  target,
  title,
  loading,
  canBack,
  canForward,
  reloadKey,
  history,
  onBack,
  onForward,
  onReload,
  onHome,
  onNavigate,
  onUrlChange,
  onNewTab,
  onCloseTab,
  onSwitchTab,
  onOpenInNewTab,
  onTabAction,
  onReorder,
  onReopen,
  canReopen,
}: {
  tabs: Tab[];
  activeId: string;
  target: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  reloadKey: number;
  history: HistoryResponse | null;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onHome: () => void;
  onNavigate: (url: string) => void;
  onUrlChange: (url: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  onSwitchTab: (id: string) => void;
  /** Open a URL as a NEW tab (target=_blank / middle-click inside engine pages). */
  onOpenInNewTab: (url: string) => void;
  /** Quasar v2.1.0 — context-menu action on a tab (pin/mute/container/…). */
  onTabAction: (tabId: string, action: TabMenuAction) => void;
  /** Quasar v2.1.0 — drag reorder. */
  onReorder: (dragId: string, targetId: string, place: "before" | "after") => void;
  /** Quasar v2.1.0 — reopen the last closed tab. */
  onReopen: () => void;
  canReopen: boolean;
}) {
  const [barVisible, setBarVisible] = React.useState(true);
  /* Manually hidden via the corner-arrow/chevron — while true, the usual
     mouse-near-top reveal stays silent: the corner arrow is the ONLY way
     back (mirrors the offline file's veilHideBar → veilCorner pairing). */
  const [barManual, setBarManualState] = React.useState(false);
  const barManualRef = React.useRef(false);
  /* Settings › Appearance — "More animations": the full motion language
     (page glides, light sweeps, breathing buttons). Respects the OS
     reduced-motion preference automatically. */
  const fancy = useFancyMotion();
  const setBarManual = React.useCallback((v: boolean) => {
    barManualRef.current = v;
    setBarManualState(v);
  }, []);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [editValue, setEditValue] = React.useState(target);
  const [editing, setEditing] = React.useState(false);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = React.useRef<HTMLIFrameElement>(null);

  /* ── Quasar v2.1.0 state: find-in-page + engine debug panel ── */
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState("");
  const [findResult, setFindResult] = React.useState<{ count: number; index: number; found: boolean }>({
    count: 0,
    index: 0,
    found: false,
  });
  const findIndexRef = React.useRef(0);
  const [debugOpen, setDebugOpen] = React.useState(false);

  React.useEffect(() => {
    if (!editing) setEditValue(target);
  }, [target, editing]);

  React.useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const revealBar = React.useCallback(() => {
    // Manually hidden: stay hidden — the corner arrow (or a key like
    // Ctrl+L that needs the input) is the way back, never a stray
    // mouse-leave/mouse-move near the top edge.
    if (barManualRef.current) return;
    setBarVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // Keep the bar parked while the active tab is a start page (no target).
    if (target === "") return;
    hideTimer.current = setTimeout(() => {
      if (document.activeElement !== urlInputRef.current) setBarVisible(false);
    }, BAR_IDLE_MS);
  }, [target]);

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (barManualRef.current) return; // manually hidden — corner arrow owns the reveal
      if (e.clientY <= 96) revealBar();
    };
    const onVeilMouse = (e: MessageEvent) => {
      const d = e.data as { __veil?: 1; type?: string; d?: { y?: number } } | undefined;
      if (!d || d.__veil !== 1) return;
      if (d.type === "mouse" && typeof d.d?.y === "number" && d.d.y <= 120) {
        revealBar();
      }
      // Escape pressed inside the veiled page surfaces the control bar —
      // runtime.ts's original intent. The page keeps the keystroke for its
      // own menus/dialogs; the shell NEVER treats a relayed Esc as a
      // "go home" (that was the reset-to-start-page bug).
      if (d.type === "esc") {
        revealBar();
      }
    };
    const onKey = () => revealBar();
    window.addEventListener("mousemove", onMove);
    window.addEventListener("message", onVeilMouse);
    window.addEventListener("keydown", onKey);
    revealBar();
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("message", onVeilMouse);
      window.removeEventListener("keydown", onKey);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [revealBar]);

  const toggleFullscreen = React.useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      /* sandboxed preview may deny — full-viewport layout still applies */
    }
  }, []);

  React.useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.key === "f" || e.key === "F") {
        if (!typing && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          void toggleFullscreen();
        }
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        onBack();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        onForward();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        // Keyboard access to the URL bar always un-hides the controls
        // (even from manual-hide mode).
        setBarManual(false);
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
        setEditing(true);
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "t" || e.key === "T")) {
        // (Ctrl+Shift+T reopen is handled globally in page.tsx — it works
        // from the start page too, not just while the chrome is mounted.)
        e.preventDefault();
        onNewTab();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        if (activeId) onCloseTab(activeId);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        // Quasar v2.1.0 — find in page (chrome-level; the frame forwards its
        // own Ctrl+F as a find-open message).
        e.preventDefault();
        setBarVisible(true);
        setFindOpen(true);
      } else if (e.ctrlKey && e.key === "Tab") {
        // Cycle tabs
        e.preventDefault();
        if (tabs.length < 2) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        const next = e.shiftKey
          ? tabs[(idx - 1 + tabs.length) % tabs.length]
          : tabs[(idx + 1) % tabs.length];
        onSwitchTab(next.id);
      } else if (e.key === "?") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("veil:open-shortcuts"));
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [onBack, onForward, onHome, toggleFullscreen, onNewTab, onCloseTab, onSwitchTab, activeId, tabs]);

  const submitUrl = (e?: React.FormEvent) => {
    e?.preventDefault();
    const next = normalizeInput(editValue);
    if (next) {
      setEditing(false);
      urlInputRef.current?.blur();
      onNavigate(next);
    } else {
      setEditValue(target);
      setEditing(false);
    }
  };

  /* The corner-arrow pair (ported from the offline file's veilCorner /
   * veilHideBar): chev-up in the bar's right cluster parks the controls
   * away; the chev-down corner button pinned top-LEFT brings them back
   * (user pick: top-left corner, not top-right). */
  const hideBarManually = React.useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setBarManual(true);
    setBarVisible(false);
  }, [setBarManual]);
  const showBarFromCorner = React.useCallback(() => {
    setBarManual(false);
    revealBar();
  }, [revealBar, setBarManual]);

  const host = React.useMemo(() => {
    try {
      return new URL(target).hostname;
    } catch {
      return target;
    }
  }, [target]);

  // Veil-local programs load from the same-origin /ft mount; everything
  // else goes through whichever proxy engine is selected (Settings ›
  // Browsing › Proxy engine) — engineFrameSrc decides the lane.
  const isFt = isVeilAppUrl(target);
  const activeTabCtx: QuasarTabCtx = React.useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t
      ? { container: t.container, egress: t.egress, ua: t.ua }
      : DEFAULT_TAB_CTX;
  }, [tabs, activeId]);
  const ctxEngaged = !isFt && proxyEngineId() === "quasar" && quasarCtxActive(activeTabCtx);

  /* ── Quasar v2.1.0 — when the active tab carries a context (container /
   * egress / UA), the proxied path must be encoded server-side so the ctx
   * rides inside the encrypted blob. Default tabs keep the instant
   * legacy blob (zero regression, no extra round-trip).
   *
   * The resolved blob is keyed by target+ctx and cached — switching back
   * to a visited ctx tab is instant, and a stale blob from the previous
   * tab can NEVER flash into the frame (frameSrc is null until the right
   * one arrives, which shows the brief "spinning up" panel instead of a
   * wrong page or a double load). */
  const [ctxState, setCtxState] = React.useState<{ key: string; src: string } | null>(null);
  const ctxCache = React.useRef(new Map<string, string>());
  const ctxKey = React.useMemo(
    () => `${activeTabCtx.container}|${activeTabCtx.egress}|${activeTabCtx.ua}::${target}`,
    [activeTabCtx, target]
  );
  React.useEffect(() => {
    if (!ctxEngaged || !target) {
      setCtxState(null);
      return;
    }
    let alive = true;
    const hit = ctxCache.current.get(ctxKey);
    if (hit) {
      setCtxState({ key: ctxKey, src: hit });
      return;
    }
    setCtxState(null);
    void encodeQuasarPath(target, activeTabCtx).then((p) => {
      if (!alive) return;
      if (ctxCache.current.size > 80) ctxCache.current.clear();
      ctxCache.current.set(ctxKey, p);
      setCtxState({ key: ctxKey, src: p });
    });
    return () => {
      alive = false;
    };
  }, [ctxEngaged, target, activeTabCtx, reloadKey, ctxKey]);

  const frameSrc = isFt
    ? veilAppFrameSrc(target)
    : ctxEngaged
      ? ctxState && ctxState.key === ctxKey
        ? ctxState.src
        : null /* ctx blob still encoding — spin-up panel shows */
      : engineFrameSrc(target);

  /* ── Quasar v2.1.0 find-in-page protocol (with the injected hooks) ──
   *
   * chrome → frame:  { __quasar: 'quasar-find', q, dir }
   * frame → chrome:  { __quasar: 'find-open' }   (Ctrl+F pressed inside)
   * frame → chrome:  { __quasar: 'find-result', count, found } */
  const postFind = React.useCallback((q: string, dir: "next" | "prev") => {
    frameRef.current?.contentWindow?.postMessage({ __quasar: "quasar-find", q, dir }, "*");
  }, []);

  const onFindQueryChange = React.useCallback(
    (q: string) => {
      setFindQuery(q);
      setFindResult((prev) => ({ ...prev, count: 0, index: 0, found: false }));
      findIndexRef.current = 0;
      postFind(q, "next");
    },
    [postFind]
  );

  const findNext = React.useCallback(() => {
    setFindResult((prev) => {
      const idx = prev.count > 0 ? (prev.index % prev.count) + 1 : 1;
      findIndexRef.current = idx;
      return { ...prev, index: idx };
    });
    postFind(findQuery, "next");
  }, [findQuery, postFind]);

  const findPrev = React.useCallback(() => {
    setFindResult((prev) => {
      const idx = prev.count > 0 ? ((prev.index - 2 + prev.count) % prev.count) + 1 : 1;
      findIndexRef.current = idx;
      return { ...prev, index: idx };
    });
    postFind(findQuery, "prev");
  }, [findQuery, postFind]);

  const closeFind = React.useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindResult({ count: 0, index: 0, found: false });
    findIndexRef.current = 0;
  }, []);

  // Frame → chrome find messages (find-open request + find-result counts).
  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __quasar?: string; count?: number; found?: boolean } | undefined;
      if (!d || typeof d !== "object" || typeof d.__quasar !== "string") return;
      if (d.__quasar === "find-open") {
        setFindOpen(true);
      } else if (d.__quasar === "find-result") {
        setFindResult((prev) => ({
          count: typeof d.count === "number" ? d.count : prev.count,
          index: prev.index || 1,
          found: d.found !== false,
        }));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  /* Mute relay — the engine hooks mute every <audio>/<video> element in
   * the frame (and auto-mute new ones while the flag is up). */
  const activeTabMuted = React.useMemo(
    () => tabs.find((x) => x.id === activeId)?.muted ?? false,
    [tabs, activeId]
  );
  React.useEffect(() => {
    if (!target || isFt) return;
    frameRef.current?.contentWindow?.postMessage({ __quasar: "quasar-mute", muted: activeTabMuted }, "*");
  }, [activeTabMuted, target, isFt, reloadKey, frameSrc]);

  return (
    <motion.div
      initial={fancy ? { opacity: 0, scale: 0.992, filter: "blur(10px)" } : { opacity: 0 }}
      animate={fancy ? { opacity: 1, scale: 1, filter: "blur(0px)" } : { opacity: 1 }}
      exit={fancy ? { opacity: 0, scale: 0.994, filter: "blur(8px)" } : { opacity: 0 }}
      transition={fancy ? { duration: 0.45, ease: FANCY_GLIDE_EASE } : { duration: 0.25 }}
      className="fixed inset-0 z-[100] bg-white"
      role="region"
      aria-label="Full-screen browsing"
    >
      {/* ------- Remote page OR start page (edge-to-edge) ------- */}
      {target ? (
        frameSrc ? (
          /* The glide wrapper carries the identity key — every tab switch
             or reload remounts it, so the fresh page fades/glides in over
             white instead of hard-cutting. In-tab navigations (src swap)
             get the light-sweep below. */
          <motion.div
            key={`${activeId}:${reloadKey}`}
            initial={fancy ? { opacity: 0, scale: 0.996, y: 12 } : false}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={fancy ? { duration: 0.5, ease: FANCY_GLIDE_EASE } : { duration: 0 }}
            className="absolute inset-0 bg-white"
          >
            <iframe
              id="veil-frame"
              ref={frameRef}
              src={frameSrc}
              title={title || target}
              className="h-full w-full border-0 bg-white"
              allow="fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-read; clipboard-write"
              /* The FreeTube program is same-origin and needs its API calls to
               * carry the page's Referer — the service reads it to bake
               * *reachable* absolute media URLs (the visitor's real origin, not
               * localhost:3031). Remote/proxied lanes keep no-referrer. */
              referrerPolicy={isFt ? "same-origin" : "no-referrer"}
              onLoad={() => onUrlChange(target)}
            />
          </motion.div>
        ) : (
          /* ctx lane still encoding — a beat of glass, never a wrong page */
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
            <div className="flex flex-col items-center gap-3">
              <span className="relative flex size-10 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/20" />
                <span className="veil-pulse-glow size-4 rounded-full bg-emerald-400/80 shadow-[0_0_18px_rgba(52,211,153,0.7)]" />
              </span>
              <p className="text-[12.5px] font-medium text-zinc-400">
                Spinning up the container lane…
              </p>
            </div>
          </div>
        )
      ) : (
        <NewTab onNavigate={onNavigate} history={history} onHome={onHome} />
      )}

      {/* ------- Navigation light-sweep (More animations) -------
          A soft emerald breeze crosses the viewport on every navigation —
          tab switches, reloads AND in-tab link clicks (the sweep key
          includes the target, the frame key does not). */}
      {fancy && target && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
          <motion.div
            key={`${activeId}:${reloadKey}:${target}`}
            initial={{ x: "-115%", opacity: 0.85 }}
            animate={{ x: "115%", opacity: 0 }}
            transition={{ duration: 1.05, ease: [0.3, 0.6, 0.4, 1] }}
            className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-emerald-400/10 to-transparent"
          />
        </div>
      )}

      {/* ------- Find-in-page bar (Quasar v2.1.0) ------- */}
      {findOpen && target && !isFt && (
        <FindBar
          query={findQuery}
          count={findResult.count}
          index={findResult.index}
          found={findResult.found}
          onQueryChange={onFindQueryChange}
          onNext={findNext}
          onPrev={findPrev}
          onClose={closeFind}
        />
      )}

      {/* ------- Quasar engine debug panel (v2.1.0) ------- */}
      <QuasarDebugPanel open={debugOpen} onClose={() => setDebugOpen(false)} />

      {/* ------- Loading progress ------- */}
      <AnimatePresence>
        {loading && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="pointer-events-none absolute left-0 right-0 top-0 z-20 h-[3px] overflow-hidden bg-emerald-500/10"
          >
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: "0%" }}
              transition={{ duration: fancy ? 0.85 : 1.1, repeat: Infinity, ease: "easeInOut" }}
              className={
                fancy
                  ? "h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-emerald-400 to-transparent"
                  : "h-full w-1/2 bg-gradient-to-r from-transparent via-emerald-500 to-transparent"
              }
              style={fancy ? { boxShadow: "0 0 14px 2px rgba(52,211,153,0.55)" } : undefined}
            />
            {fancy && (
              <motion.div
                initial={{ x: "-160%" }}
                animate={{ x: "-15%" }}
                transition={{ duration: 0.85, repeat: Infinity, ease: "easeInOut", delay: 0.12 }}
                className="veil-stripes-drift absolute inset-y-0 w-1/6 rounded-full bg-emerald-300/60 blur-[2px]"
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ------- Auto-hiding control bar (with tab strip when >1 tab) ------- */}
      <motion.header
        animate={{ y: barVisible ? 0 : "-105%" }}
        transition={{ type: "spring", stiffness: fancy ? 330 : 380, damping: fancy ? 26 : 34 }}
        className="absolute left-0 right-0 top-0 z-30"
        onMouseEnter={() => {
          if (hideTimer.current) clearTimeout(hideTimer.current);
        }}
        onMouseLeave={revealBar}
      >
        <div className="relative bg-zinc-950/92 shadow-2xl shadow-black/30 backdrop-blur-xl">
          {/* More animations — a living emerald hairline under the bar,
              quietly drifting like light on water. */}
          {fancy && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
              <motion.div
                animate={{ x: ["-30%", "130%"] }}
                transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut", repeatDelay: 1.2 }}
                className="h-px w-1/3 bg-gradient-to-r from-transparent via-emerald-400/60 to-transparent"
              />
            </div>
          )}
          {/* Tab strip (Quasar v2.1.0: drag reorder, pin, mute, per-tab
              container / egress / UA context menu) — always visible once
              there is at least one tab, so the + button and right-click
              menu are reachable even with a single tab. */}
          {tabs.length > 0 && (
            <QuasarTabStrip
              tabs={tabs}
              activeId={activeId}
              loading={loading}
              onSelect={onSwitchTab}
              onClose={onCloseTab}
              onNewTab={onNewTab}
              onReorder={onReorder}
              onAction={onTabAction}
              onReopen={onReopen}
              canReopen={canReopen}
              renderFavicon={(tTarget, tTitle) => <TabFavicon target={tTarget} title={tTitle} />}
            />
          )}

          {/* Main control row */}
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-1.5 px-2.5 sm:gap-2 sm:px-4">
            {/* Left cluster */}
            <div className="flex items-center gap-0.5">
              <IconBtn label="Back (Alt+←)" onClick={onBack} disabled={!canBack}>
                <ArrowLeft aria-hidden className="veil-hover-bounce veil-press" />
              </IconBtn>
              <IconBtn label="Forward (Alt+→)" onClick={onForward} disabled={!canForward}>
                <ArrowRight aria-hidden className="veil-hover-bounce veil-press" />
              </IconBtn>
              <IconBtn label="Reload" onClick={onReload} disabled={!target}>
                <RotateCw aria-hidden className={loading ? "animate-spin" : "veil-hover-spin"} />
              </IconBtn>
            </div>

            {/* URL pill */}
            <form onSubmit={submitUrl} className="mx-1 min-w-0 flex-1 sm:mx-2">
              <div className="group flex h-10 items-center gap-2.5 rounded-xl border border-zinc-700/80 bg-zinc-800/60 px-3 transition focus-within:border-emerald-500/60 focus-within:bg-zinc-800 focus-within:shadow-[0_0_0_3px_rgba(16,185,129,0.18)]">
                {isFt ? (
                  <>
                    <Play aria-hidden className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="hidden shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-400 sm:inline-flex">
                      private tube
                    </span>
                  </>
                ) : (
                  <>
                    <ShieldCheck aria-hidden className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="hidden shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-emerald-400 sm:inline-flex">
                      <Lock aria-hidden className="h-3 w-3" />
                      veiled
                    </span>
                  </>
                )}
                <input
                  ref={urlInputRef}
                  value={editValue}
                  onChange={(e) => {
                    setEditing(true);
                    setEditValue(e.target.value);
                  }}
                  onFocus={(e) => {
                    setEditing(true);
                    revealBar();
                    requestAnimationFrame(() => e.target.select());
                  }}
                  onBlur={() => {
                    setEditing(false);
                    setEditValue(target);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setEditing(false);
                      setEditValue(target);
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Enter a URL to keep browsing…"
                  aria-label="Current page URL"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  className="veil-focus-bloom h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
                />
                <span className="hidden max-w-[180px] shrink-0 truncate text-[11px] text-zinc-500 lg:block">
                  {host}
                </span>
              </div>
            </form>

            {/* Right cluster */}
            <div className="flex items-center gap-0.5">
              <IconBtn label="New tab (Ctrl+T)" onClick={onNewTab}>
                <Plus aria-hidden className="veil-hover-bounce" />
              </IconBtn>
              <IconBtn
                label={activeTabMuted ? "Unmute tab" : "Mute tab"}
                onClick={() => activeId && onTabAction(activeId, { type: "toggle-mute" })}
              >
                {activeTabMuted ? <VolumeX aria-hidden className="veil-hover-bounce text-amber-300" /> : <Volume2 aria-hidden className="veil-hover-bounce" />}
              </IconBtn>
              <IconBtn
                label="Find in page (Ctrl+F)"
                onClick={() => {
                  setBarVisible(true);
                  setFindOpen(true);
                }}
                disabled={!target || isFt}
              >
                <Search aria-hidden className="veil-hover-bounce" />
              </IconBtn>
              <IconBtn
                label="Quasar engine debug"
                onClick={() => setDebugOpen((v) => !v)}
              >
                <Bug aria-hidden className="veil-hover-bounce" />
              </IconBtn>
              <KeyboardHelp
                trigger={
                  <button
                    type="button"
                    aria-label="Keyboard shortcuts (?)"
                    title="Keyboard shortcuts (?)"
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                  >
                    ?
                  </button>
                }
              />
              <IconBtn
                label={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
                onClick={() => void toggleFullscreen()}
              >
                {isFullscreen ? <Minimize aria-hidden className="veil-hover-bounce" /> : <Maximize aria-hidden className="veil-hover-bounce" />}
              </IconBtn>
              <IconBtn
                label="Open this page in a new tab"
                onClick={() => target && window.open(frameSrc, "_blank", "noopener")}
                disabled={!target}
              >
                <ExternalLink aria-hidden className="veil-hover-bounce" />
              </IconBtn>
              <div className="mx-1 hidden h-6 w-px bg-zinc-700 sm:block" aria-hidden />
              {/* Exit veil — the one filled accent in the chrome; with More
                  animations it swells on hover and glows on press. */}
              <motion.button
                type="button"
                onClick={onHome}
                whileHover={fancy ? { scale: 1.05 } : undefined}
                whileTap={fancy ? { scale: 0.93 } : undefined}
                transition={{ type: "spring", stiffness: 480, damping: 24 }}
                className="flex h-9 items-center rounded-lg bg-emerald-500/15 px-3 text-[13px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30 transition hover:bg-emerald-500/25"
              >
                <Home aria-hidden className="veil-hover-bounce veil-press sm:hidden" />
                <span className="veil-hover-bounce hidden sm:inline">Exit veil</span>
              </motion.button>
              {/* Hide the controls — the chev-down corner button (top-left)
                  brings them back. Ports the offline file's veilHideBar. */}
              <IconBtn
                label="Hide controls — the arrow in the top-left corner brings them back"
                onClick={hideBarManually}
              >
                <ChevronUp aria-hidden className="veil-hover-bounce" />
              </IconBtn>
            </div>
          </div>
        </div>
      </motion.header>

      {/* Corner arrow pinned top-LEFT while the bar is hidden — click to
          bring the controls back. Replaces the old slim center handle; in
          manual mode this is the only reveal (mouse-near-top stays silent).
          Ports the offline file's veilCorner, moved to the top-left corner
          (user pick). With More animations it also breathes — a gentle
          idle bob so it reads as alive, never as a stuck artifact. */}
      <AnimatePresence>
        {!barVisible && (
          <motion.button
            initial={{ opacity: 0, y: -6, scale: 0.9 }}
            animate={
              fancy
                ? { opacity: 1, y: [0, -3, 0], scale: 1 }
                : { opacity: 1, y: 0, scale: 1 }
            }
            exit={{ opacity: 0, y: -6, scale: 0.9 }}
            transition={
              fancy
                ? {
                    y: { duration: 2.2, repeat: Infinity, ease: "easeInOut", delay: 0.6 },
                    default: { duration: 0.22 },
                  }
                : { duration: 0.22 }
            }
            type="button"
            aria-label="Show the control bar"
            title="Show the control bar"
            onClick={showBarFromCorner}
            onMouseEnter={barManual ? undefined : revealBar}
            className="absolute left-3 top-3 z-40 flex size-9 items-center justify-center rounded-full border border-zinc-700/80 bg-zinc-950/85 text-zinc-300 shadow-xl shadow-black/30 backdrop-blur-md transition hover:border-emerald-500/60 hover:bg-zinc-900 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50"
          >
            <ChevronDown aria-hidden className="size-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ------- Fullscreen nudge (only when not OS-fullscreen) ------- */}
      <AnimatePresence>
        {!isFullscreen && target && (
          <motion.button
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={
              fancy
                ? { opacity: 1, y: 0, scale: [1, 1.03, 1] }
                : { opacity: 1, y: 0, scale: 1 }
            }
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            transition={
              fancy
                ? {
                    scale: { duration: 2.6, repeat: Infinity, ease: "easeInOut", delay: 1.4 },
                    default: { delay: 0.8, duration: 0.35 },
                  }
                : { delay: 0.8, duration: 0.35 }
            }
            onClick={() => void toggleFullscreen()}
            className="absolute bottom-5 right-5 z-30 flex items-center gap-2 rounded-full border border-zinc-700/70 bg-zinc-950/85 px-4 py-2.5 text-[12.5px] font-medium text-zinc-300 shadow-xl shadow-black/30 backdrop-blur-md transition hover:border-emerald-500/50 hover:text-emerald-300"
          >
            <Maximize aria-hidden className="h-3.5 w-3.5" />
            Go true fullscreen <span className="font-mono text-[10.5px] text-zinc-500">F</span>
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  /* More animations — every chrome button breathes: hover swell, tap
     squeeze, spring-settled. Calm mode keeps the plain fade. */
  const fancy = useFancyMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      whileHover={fancy ? { scale: 1.14 } : undefined}
      whileTap={fancy ? { scale: 0.86 } : undefined}
      transition={{ type: "spring", stiffness: 520, damping: 22 }}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </motion.button>
  );
}
