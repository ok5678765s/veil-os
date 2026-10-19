"use client";

/**
 * Veil Arcade — the "My Builds" tab.
 *
 * The home of everything the AI Coder ever wrote for you: builds live in
 * localStorage (see lib/veil/cloud-games), replay and delete from here,
 * and the "Build with AI Coder" CTA hops to the AI section with Coder
 * mode armed. Builds run in an EMBEDDED player inside this tab — never a
 * browser tab, never a new window.
 *
 * (This tab replaced the old Roblox tab — owner ask 2026-10-19: "remove
 * roblox from arcade". The made-builds player and cross-section handoff
 * moved here unchanged; the live roblox.com charts/search/deep-links are
 * gone from the Arcade entirely.)
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  FileCode2,
  Loader2,
  Maximize,
  Minimize,
  Play,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  bumpMadeGamePlays,
  deleteMadeGame,
  findMadeGame,
  loadMadeGames,
  MADE_GAMES_CHANGED_EVENT,
  PLAY_MADE_GAME_EVENT,
  requestAiGames,
  takePendingMadeGame,
  type MadeGame,
} from "@/lib/veil/cloud-games";

/* ------------------------------------------------------------------ */
/* Palette — the AI Coder violet identity                              */
/* ------------------------------------------------------------------ */

const B = {
  page: "#12101a",
  panel: "#1b1830",
  panelHover: "#252044",
  line: "#2e2854",
  text: "#ffffff",
  sub: "#b8b2d8",
  dim: "#7872a3",
  violet: "#8b5cf6",
  violetHover: "#9d74f8",
  red: "#ff4747",
};

type PlayingGame = { mg: MadeGame; key: number };

/* ------------------------------------------------------------------ */
/* Build card                                                          */
/* ------------------------------------------------------------------ */

function BuildCard({
  game,
  index,
  onPlay,
  onDelete,
}: {
  game: MadeGame;
  index: number;
  onPlay: (g: MadeGame) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -30px 0px" }}
      transition={{ duration: 0.32, delay: (index % 12) * 0.04 }}
      className="group relative overflow-hidden rounded-2xl border border-white/10 shadow-lg shadow-black/40 transition-colors hover:border-violet-400/40"
      style={{ background: B.panel }}
    >
      <button
        type="button"
        onClick={() => onPlay(game)}
        aria-label={`Play ${game.name} — your own AI Coder build`}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
      >
        <span
          className="relative block aspect-video overflow-hidden"
          style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.25), rgba(18,16,26,1))" }}
        >
          {/* grid texture — the coder terminal feel */}
          <span
            aria-hidden
            className="absolute inset-0 opacity-[0.14]"
            style={{
              backgroundImage:
                "linear-gradient(rgba(139,92,246,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(139,92,246,0.5) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
            }}
          />
          <span aria-hidden className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-violet-500/20 ring-1 ring-violet-400/40 transition-transform duration-200 group-hover:scale-110">
              <FileCode2 aria-hidden className="size-7 text-violet-300" />
            </span>
          </span>
          <span
            aria-hidden
            className="absolute left-2 top-2 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white"
            style={{ background: B.violet }}
          >
            <Sparkles aria-hidden className="size-2.5" />
            AI Built
          </span>
          <span
            aria-hidden
            className="absolute right-2 top-2 rounded-md px-1.5 py-0.5 text-[9px] font-semibold tabular-nums"
            style={{ background: "rgba(0,0,0,0.55)", color: B.sub }}
          >
            {(game.html.length / 1024).toFixed(0)} KB
          </span>
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition group-hover:opacity-100"
          >
            <span className="flex size-12 scale-75 items-center justify-center rounded-full bg-violet-500 text-white shadow-xl shadow-violet-500/40 transition-transform duration-200 group-hover:scale-100">
              <Play aria-hidden className="size-5 translate-x-px fill-white" />
            </span>
          </span>
        </span>
        <span className="block px-3.5 pb-3.5 pt-3">
          <span className="block truncate text-[14px] font-semibold leading-tight text-white">
            {game.name}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-[11px] font-medium text-violet-300">
            <FileCode2 aria-hidden className="size-3" />
            {game.plays === 0 ? "ready to run" : `played ${game.plays}×`}
            <span aria-hidden className="text-white/20">
              ·
            </span>
            <span className="text-white/40">{fmtBuilt(game.savedAt)}</span>
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(game.id);
        }}
        aria-label={`Delete ${game.name}`}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-full bg-black/70 text-white opacity-0 backdrop-blur-sm transition hover:bg-red-500/80 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 aria-hidden className="size-3.5" />
      </button>
    </motion.div>
  );
}

/** "2h ago" style relative time for a build's savedAt (epoch ms). */
function fmtBuilt(ts: number | undefined): string {
  if (!ts) return "saved";
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just built";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ */
/* The tab                                                             */
/* ------------------------------------------------------------------ */

export function BuildsTab({ active }: { active: boolean }) {
  const [madeGames, setMadeGames] = React.useState<MadeGame[]>([]);
  const [playing, setPlaying] = React.useState<PlayingGame | null>(null);

  /* ----- my AI builds (AI Coder) — localStorage-backed ----- */
  React.useEffect(() => {
    const sync = () => setMadeGames(loadMadeGames());
    sync();
    window.addEventListener(MADE_GAMES_CHANGED_EVENT, sync);
    return () => window.removeEventListener(MADE_GAMES_CHANGED_EVENT, sync);
  }, []);

  /* Cross-section handoff: "Play in the Arcade" from the AI section
   * lands here (event when this tab is already mounted, pending slot
   * when it wasn't — first-ever arcade open). The pending slot is
   * ALWAYS drained — on the event too — so a Fast Refresh remount can
   * never replay a consumed launch. */
  React.useEffect(() => {
    const start = (id: string) => {
      const g = findMadeGame(id);
      if (g) {
        setPlaying({ mg: g, key: Date.now() });
        bumpMadeGamePlays(id);
      }
    };
    const onEvt = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      /* Drain the pending slot — the live listener makes it redundant. */
      takePendingMadeGame();
      if (typeof id === "string") start(id);
    };
    window.addEventListener(PLAY_MADE_GAME_EVENT, onEvt);
    const pendingId = takePendingMadeGame();
    if (pendingId) start(pendingId);
    return () => window.removeEventListener(PLAY_MADE_GAME_EVENT, onEvt);
  }, []);

  /* ----- made play — embedded, never a browser tab ----- */
  const playMade = React.useCallback((mg: MadeGame) => {
    setPlaying({ mg, key: Date.now() });
    bumpMadeGamePlays(mg.id);
  }, []);

  const removeMade = React.useCallback((id: string) => {
    deleteMadeGame(id);
  }, []);

  /* "Build with AI Coder" — hop to the AI section's Coder mode
   * (requestAiGames bridges the first-ever-open race via a pending
   * slot, exactly like the made-build play handoff). */
  const makeGame = React.useCallback(() => {
    requestAiGames();
  }, []);

  /* ----- Esc: embedded player → back ----- */
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && playing) setPlaying(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, playing]);

  const totalPlays = madeGames.reduce((n, g) => n + g.plays, 0);
  const totalKb = Math.round(madeGames.reduce((n, g) => n + g.html.length, 0) / 1024);

  return (
    <div
      role="region"
      aria-label="My builds"
      className="relative h-full overflow-hidden rounded-2xl border border-black/50 shadow-2xl shadow-black/50"
      style={{ background: B.page }}
    >
      <div className="veil-scroll-slim h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-5 sm:px-6">
          {/* header */}
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[22px] font-bold text-white">
                <span
                  aria-hidden
                  className="flex size-9 items-center justify-center rounded-xl"
                  style={{ background: `${B.violet}26`, boxShadow: `inset 0 0 0 1px ${B.violet}55` }}
                >
                  <Sparkles aria-hidden className="size-4 text-violet-300" />
                </span>
                My Builds
              </h2>
              <p className="mt-1.5 text-[13px]" style={{ color: B.dim }}>
                games &amp; apps the AI Coder wrote for you — they run right here, never a browser tab
              </p>
            </div>
            {madeGames.length > 0 && (
              <div
                className="flex items-center gap-3 rounded-xl px-3.5 py-2 text-[11.5px] font-semibold"
                style={{ background: B.panel, color: B.sub }}
              >
                <span>
                  <span className="tabular-nums text-white">{madeGames.length}</span>{" "}
                  {madeGames.length === 1 ? "build" : "builds"}
                </span>
                <span aria-hidden style={{ color: B.line }}>
                  ·
                </span>
                <span>
                  <span className="tabular-nums text-white">{totalPlays}</span> plays
                </span>
                <span aria-hidden style={{ color: B.line }}>
                  ·
                </span>
                <span>
                  <span className="tabular-nums text-white">{totalKb}</span> KB of code
                </span>
              </div>
            )}
          </div>

          {/* the grid */}
          {madeGames.length === 0 ? (
            <div
              className="flex flex-col items-center gap-4 rounded-2xl px-6 py-20 text-center"
              style={{ background: B.panel }}
            >
              <span
                aria-hidden
                className="flex size-16 items-center justify-center rounded-2xl"
                style={{ background: `${B.violet}1f`, boxShadow: `inset 0 0 0 1px ${B.violet}44` }}
              >
                <FileCode2 aria-hidden className="size-8 text-violet-300" />
              </span>
              <div>
                <p className="text-[16px] font-bold text-white">Nothing built yet</p>
                <p className="mx-auto mt-1.5 max-w-[44ch] text-[13px] leading-relaxed" style={{ color: B.dim }}>
                  Describe any game, tool or web app — the AI Coder writes the complete code and it
                  lands here, ready to replay forever.
                </p>
              </div>
              <button
                type="button"
                onClick={makeGame}
                className="mt-1 flex h-11 items-center gap-2 rounded-xl px-6 text-[14px] font-bold text-white transition hover:brightness-110 active:scale-95"
                style={{ background: B.violet }}
              >
                <Sparkles aria-hidden className="size-4" />
                Build with AI Coder
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {madeGames.map((g, i) => (
                <BuildCard key={g.id} game={g} index={i} onPlay={playMade} onDelete={removeMade} />
              ))}
              {/* the maker CTA — always the last cell */}
              <button
                type="button"
                onClick={makeGame}
                className="flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed border-violet-400/40 bg-violet-500/[0.05] p-4 text-center transition hover:border-violet-300/70 hover:bg-violet-500/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
              >
                <span
                  aria-hidden
                  className="flex size-11 items-center justify-center rounded-full bg-violet-500/15 ring-1 ring-violet-400/30 transition-transform duration-200 hover:scale-110"
                >
                  <Sparkles aria-hidden className="size-5 text-violet-300" />
                </span>
                <span className="text-[13.5px] font-semibold text-white">Build with AI Coder</span>
                <span className="text-[10.5px] leading-snug" style={{ color: B.dim }}>
                  describe it — Veil AI writes the code, it runs here
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* embedded player — AI Coder builds play INSIDE this tab,
          never a browser tab or new window. Made builds run as
          self-contained srcDoc pages. */}
      <AnimatePresence>
        {playing && <EmbeddedPlayer playing={playing} onBack={() => setPlaying(null)} />}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Embedded player — the in-tab game viewport                          */
/* ------------------------------------------------------------------ */

function EmbeddedPlayer({
  playing,
  onBack,
}: {
  playing: PlayingGame;
  onBack: () => void;
}) {
  const [reloads, setReloads] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);
  const [full, setFull] = React.useState(false);
  const viewport = React.useRef<HTMLDivElement>(null);

  const name = playing.mg.name;
  const accent = B.violet;

  React.useEffect(() => {
    setLoaded(false);
  }, [playing.key, reloads]);

  React.useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === viewport.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFull = () => {
    const el = viewport.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void el.requestFullscreen();
    } catch {
      /* denied — the tab-sized player still works */
    }
  };

  return (
    <motion.div
      key="builds-embedded-player"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      role="region"
      aria-label={`Now playing: ${name}`}
      className="absolute inset-0 z-50 flex flex-col"
      style={{ background: B.page }}
    >
      {/* status bar */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2 sm:px-4"
        style={{ borderColor: B.line, background: B.panel }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to your builds"
          className="flex size-8 shrink-0 items-center justify-center rounded-full transition hover:brightness-125 active:scale-90"
          style={{ background: B.panelHover, color: B.sub }}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </button>
        <span aria-hidden className="relative flex size-2.5 shrink-0 items-center justify-center">
          <span
            className="absolute size-full animate-ping rounded-full opacity-60"
            style={{ background: accent }}
          />
          <span className="relative size-2 rounded-full" style={{ background: accent }} />
        </span>
        <span className="max-w-[30vw] truncate text-[13px] font-semibold text-white sm:max-w-[260px]">
          {name}
        </span>
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-white"
          style={{ background: accent }}
        >
          <Sparkles aria-hidden className="mr-0.5 inline size-2.5 align-[-1px]" />
          AI
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setReloads((r) => r + 1)}
            aria-label={`Reload ${name}`}
            title="Reload"
            className="flex size-8 items-center justify-center rounded-lg transition hover:brightness-125 active:scale-90"
            style={{ background: B.panelHover, color: B.sub }}
          >
            <RotateCw aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleFull}
            aria-label={full ? "Exit fullscreen" : "Fullscreen"}
            title="Fullscreen"
            className="flex size-8 items-center justify-center rounded-lg transition hover:brightness-125 active:scale-90"
            style={{ background: B.panelHover, color: B.sub }}
          >
            {full ? <Minimize aria-hidden className="size-3.5" /> : <Maximize aria-hidden className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onBack}
            aria-label={`Stop ${name}`}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-semibold transition hover:brightness-125 active:scale-95"
            style={{ borderColor: "#ff474740", background: "#ff47471a", color: "#ff8a8a" }}
          >
            <X aria-hidden className="size-3.5" />
            <span className="hidden sm:inline">Stop</span>
          </button>
        </div>
      </div>

      {/* game viewport — the OS-fullscreen target */}
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {!loaded && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
            <Loader2 aria-hidden className="size-7 animate-spin" style={{ color: accent }} />
            <p className="text-[13.5px] font-semibold text-white">Starting your build…</p>
            <p className="max-w-[36ch] text-center text-[11px]" style={{ color: B.dim }}>
              written by AI Coder — it runs right here, never a browser tab
            </p>
          </div>
        )}
        <iframe
          key={`${playing.key}-${reloads}`}
          srcDoc={playing.mg.html}
          title={name}
          className="absolute inset-0 size-full border-0 bg-black"
          sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-downloads"
          allow="fullscreen; autoplay; gamepad"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </motion.div>
  );
}
