"use client";

/**
 * Veil Roblox — the Arcade's Roblox tab. This IS Roblox, not a lookalike:
 * live charts straight from roblox.com's own home sorts, real search, real
 * game pages with real banners/creators/counts — all rendered natively in
 * React (zero iframes). Pressing Play fires the same roblox-player://
 * deep link roblox.com uses, launching the real Roblox app on the device,
 * with the real game page as the browser-tab fallback.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  RotateCw,
  Search,
  Smartphone,
  ThumbsDown,
  ThumbsUp,
  WifiOff,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CLOUD_GAMES,
  cloudMatchFor,
  fetchRobloxDetail,
  fetchRobloxHome,
  fetchRobloxSearch,
  fmtCount,
  fmtDate,
  fmtVisits,
  isEmbeddedContext,
  launchRobloxApp,
  loadRecent,
  maturityLabel,
  openExternalTab,
  openRobloxGamePageTab,
  ratingPct,
  recordRecentGame,
  robloxGamePageUrl,
  type CloudGame,
  type RecentGame,
  type RobloxDetailResponse,
  type RobloxGameCard,
  type RobloxHomeResponse,
} from "@/components/veil/roblox/shared";

/* ------------------------------------------------------------------ */
/* Palette — roblox.com dark                                           */
/* ------------------------------------------------------------------ */

const R = {
  page: "#191b1d",
  panel: "#232527",
  panelHover: "#2e3133",
  line: "#2e3133",
  text: "#ffffff",
  sub: "#bdbebe",
  dim: "#7b7d7d",
  green: "#00b06f",
  greenHover: "#00c67d",
  red: "#ff4747",
  /* now.gg's own brand pink — the cloud accent. */
  cloud: "#ff42a5",
  cloudHover: "#ff5cb1",
};

/** execCommand copy fallback for embeds where the async clipboard API is
 * permission-blocked (returns success so the UI can still confirm). */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Small parts                                                         */
/* ------------------------------------------------------------------ */

/** The tilted-square Roblox mark, drawn in CSS. */
function RobloxMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-6 rotate-[14deg] rounded-[4px] bg-white shadow-[0_2px_10px_rgba(0,0,0,0.4)]",
        className
      )}
    >
      <span className="absolute inset-[32%] rounded-[2px] bg-[#191b1d]" />
    </span>
  );
}

function GameImage({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex items-center justify-center bg-gradient-to-br from-[#2e3133] to-[#232527] text-xl font-black text-[#5c5f60]",
          className
        )}
      >
        {alt.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

function PlayingCount({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1 text-[11.5px] font-medium", className)}>
      <span aria-hidden className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full" style={{ background: R.green }} />
      </span>
      <span className="truncate tabular-nums" style={{ color: R.sub }}>
        {fmtCount(n)}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Game card                                                           */
/* ------------------------------------------------------------------ */

function GameCard({
  game,
  index,
  onOpen,
  onPlay,
  subtitle,
}: {
  game: RobloxGameCard;
  index: number;
  onOpen: (g: RobloxGameCard) => void;
  onPlay: (g: RobloxGameCard) => void;
  /** Overrides the live count line (used by the Continue row). */
  subtitle?: string;
}) {
  const pct = ratingPct(game.upVotes, game.downVotes);
  const cloud = cloudMatchFor(game.name);
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration: 0.3, delay: (index % 8) * 0.03 }}
      className="group relative w-[132px] shrink-0 sm:w-[148px]"
    >
      <button
        type="button"
        onClick={() => onOpen(game)}
        aria-label={`Open ${game.name}`}
        className="block w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
      >
        <span
          className="relative block aspect-square overflow-hidden rounded-lg transition-transform duration-200 group-hover:scale-[1.03]"
          style={{ background: R.panel }}
        >
          <GameImage src={game.icon} alt={game.name} className="absolute inset-0 size-full object-cover" />
          {game.sponsored && (
            <span
              className="absolute left-1 top-1 rounded px-1 py-px text-[8px] font-bold uppercase tracking-wider text-black"
              style={{ background: "#e8bd43" }}
            >
              Ad
            </span>
          )}
          {cloud && (
            <span
              className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded px-1 py-px text-[8px] font-bold uppercase tracking-wider text-white"
              style={{ background: R.cloud }}
              title="Also playable in your browser via now.gg's cloud — no install"
            >
              <Cloud aria-hidden className="size-2" />
              Cloud
            </span>
          )}
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100"
          >
            <span
              className="flex size-10 scale-75 items-center justify-center rounded-full text-white shadow-lg transition-transform duration-200 group-hover:scale-100"
              style={{ background: R.green }}
            >
              <Play aria-hidden className="size-4 translate-x-px fill-white" />
            </span>
          </span>
        </span>
        <span className="mt-1.5 block truncate text-[13px] font-semibold leading-tight text-white">
          {game.name}
        </span>
        {subtitle ? (
          <span className="block truncate text-[11.5px]" style={{ color: R.dim }}>
            {subtitle}
          </span>
        ) : (
          <span className="mt-0.5 flex items-center justify-between gap-1.5">
            <PlayingCount n={game.playing} />
            {pct > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-[10.5px] tabular-nums"
                style={{ color: R.dim }}
                title={`${pct}% positive — ${fmtVisits(game.upVotes)} likes`}
              >
                <ThumbsUp aria-hidden className="size-2.5" />
                {pct}%
              </span>
            )}
          </span>
        )}
      </button>
      {/* quick-play — hover corner button, plays without opening the page */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPlay(game);
        }}
        aria-label={`Play ${game.name} now`}
        title="Play now — launches the Roblox app"
        className={cn(
          "absolute right-1.5 top-1.5 z-10 flex size-8 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100 focus-visible:opacity-100",
          "hover:border-emerald-400/60 hover:bg-black/70 active:scale-90"
        )}
      >
        <Play aria-hidden className="size-3.5 translate-x-px fill-white" />
      </button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Horizontal row with arrows (roblox.com home rows)                   */
/* ------------------------------------------------------------------ */

function GameRow({
  title,
  hint,
  games,
  subtitle,
  onOpen,
  onPlay,
}: {
  title: string;
  hint?: string;
  games: RobloxGameCard[];
  /** Per-card footer override (the Continue row shows "played recently"
   *  instead of a stale live count). */
  subtitle?: string;
  onOpen: (g: RobloxGameCard) => void;
  onPlay: (g: RobloxGameCard) => void;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 8,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8,
    });
  }, []);

  React.useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure, games.length]);

  const nudge = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  if (games.length === 0) return null;

  return (
    <section aria-label={title} className="group/row relative mb-7">
      <div className="mb-2.5 flex items-center gap-2.5">
        <h2 className="text-[16px] font-bold text-white">{title}</h2>
        {hint && (
          <span className="truncate text-[11.5px]" style={{ color: R.dim }}>
            {hint}
          </span>
        )}
      </div>
      <div className="relative">
        <div
          ref={scroller}
          className="veil-scroll-slim flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {games.map((g, i) => (
            <GameCard
              key={`${g.universeId}-${i}`}
              game={g}
              index={i}
              onOpen={onOpen}
              onPlay={onPlay}
              subtitle={subtitle}
            />
          ))}
        </div>
        {edges.left && (
          <button
            type="button"
            onClick={() => nudge(-1)}
            aria-label={`Scroll ${title} left`}
            className="absolute -left-1 top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white opacity-0 backdrop-blur-md transition group-hover/row:opacity-100 focus-visible:opacity-100 md:flex"
          >
            <ChevronLeft aria-hidden className="size-5" />
          </button>
        )}
        {edges.right && (
          <button
            type="button"
            onClick={() => nudge(1)}
            aria-label={`Scroll ${title} right`}
            className="absolute -right-1 top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white opacity-0 backdrop-blur-md transition group-hover/row:opacity-100 focus-visible:opacity-100 md:flex"
          >
            <ChevronRight aria-hidden className="size-5" />
          </button>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Cloud play row — now.gg streams these right in the browser          */
/* ------------------------------------------------------------------ */

function CloudCard({
  game,
  index,
  onPlayCloud,
}: {
  game: CloudGame;
  index: number;
  onPlayCloud: (cg: CloudGame) => void;
}) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -40px 0px" }}
      transition={{ duration: 0.3, delay: (index % 8) * 0.03 }}
      onClick={() => onPlayCloud(game)}
      aria-label={`Play ${game.name} in the cloud`}
      className="group relative w-[196px] shrink-0 overflow-hidden rounded-xl border border-white/10 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-400/60 sm:w-[212px]"
      style={{ background: R.panel }}
    >
      <span className="relative block aspect-video overflow-hidden">
        <img
          src={game.tile}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
          className="absolute inset-0 size-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
        />
        <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />
        <span
          className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-white"
          style={{ background: R.cloud }}
        >
          <Cloud aria-hidden className="size-2.5" />
          Cloud
        </span>
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100"
        >
          <span
            className="flex size-11 scale-75 items-center justify-center rounded-full text-white shadow-lg transition-transform duration-200 group-hover:scale-100"
            style={{ background: R.cloud }}
          >
            <Play aria-hidden className="size-4 translate-x-px fill-white" />
          </span>
        </span>
      </span>
      <span className="block px-2.5 pb-2.5 pt-2">
        <span className="block truncate text-[13px] font-semibold leading-tight text-white">
          {game.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-[10.5px] font-medium" style={{ color: R.cloudHover }}>
          <Cloud aria-hidden className="size-2.5" />
          plays in your browser
        </span>
      </span>
    </motion.button>
  );
}

function CloudRow({ onPlayCloud }: { onPlayCloud: (cg: CloudGame) => void }) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 8,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8,
    });
  }, []);

  React.useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);

  const nudge = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section aria-label="Cloud play" className="group/row relative mb-7">
      <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
        <h2 className="flex items-center gap-1.5 text-[16px] font-bold text-white">
          <Cloud aria-hidden className="size-4" style={{ color: R.cloud }} />
          Cloud play
        </h2>
        <span className="truncate text-[11.5px]" style={{ color: R.dim }}>
          no download — the real game, streamed to your browser by now.gg
        </span>
      </div>
      <div className="relative">
        <div
          ref={scroller}
          className="veil-scroll-slim flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {CLOUD_GAMES.map((cg, i) => (
            <CloudCard key={cg.key} game={cg} index={i} onPlayCloud={onPlayCloud} />
          ))}
        </div>
        {edges.left && (
          <button
            type="button"
            onClick={() => nudge(-1)}
            aria-label="Scroll cloud play left"
            className="absolute -left-1 top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white opacity-0 backdrop-blur-md transition group-hover/row:opacity-100 focus-visible:opacity-100 md:flex"
          >
            <ChevronLeft aria-hidden className="size-5" />
          </button>
        )}
        {edges.right && (
          <button
            type="button"
            onClick={() => nudge(1)}
            aria-label="Scroll cloud play right"
            className="absolute -right-1 top-1/2 z-10 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-white opacity-0 backdrop-blur-md transition group-hover/row:opacity-100 focus-visible:opacity-100 md:flex"
          >
            <ChevronRight aria-hidden className="size-5" />
          </button>
        )}
      </div>
    </section>
  );
}

function SkeletonCards({ count = 8, wide = false }: { count?: number; wide?: boolean }) {
  return (
    <div className={cn("flex gap-3 overflow-hidden", wide && "flex-wrap")}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={cn("shrink-0", wide && "w-[148px]")}>
          <div
            className={cn("aspect-square w-[132px] animate-pulse rounded-lg sm:w-[148px]", wide && "w-full sm:w-full")}
            style={{ background: R.panel }}
          />
          <div className="mt-2 h-3 w-3/4 animate-pulse rounded" style={{ background: R.panel }} />
          <div className="mt-1.5 h-2.5 w-1/2 animate-pulse rounded" style={{ background: R.panel }} />
        </div>
      ))}
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl px-6 py-14 text-center"
      style={{ background: R.panel }}
    >
      <WifiOff aria-hidden className="size-7" style={{ color: R.dim }} />
      <p className="max-w-sm text-[13.5px]" style={{ color: R.sub }}>
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="flex h-9 items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold text-white transition active:scale-95"
        style={{ background: R.green }}
      >
        <RotateCw aria-hidden className="size-3.5" />
        Try again
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

type View =
  | { kind: "home" }
  | { kind: "search" }
  | { kind: "detail"; universeId: number; seed: RobloxGameCard | null };

function recentToCard(g: RecentGame): RobloxGameCard {
  return {
    universeId: g.universeId,
    placeId: g.placeId,
    name: g.name,
    icon: g.icon,
    playing: 0,
    upVotes: 0,
    downVotes: 0,
  };
}

function HomeView({
  home,
  loading,
  error,
  recent,
  retry,
  onOpen,
  onPlay,
  onPlayCloud,
}: {
  home: RobloxHomeResponse | null;
  loading: boolean;
  error: string;
  recent: RecentGame[];
  retry: () => void;
  onOpen: (g: RobloxGameCard) => void;
  onPlay: (g: RobloxGameCard) => void;
  onPlayCloud: (cg: CloudGame) => void;
}) {
  if (error && !home) return <ErrorCard message={error} onRetry={retry} />;

  return (
    <>
      <CloudRow onPlayCloud={onPlayCloud} />
      {recent.length > 0 && (
        <GameRow
          title="Continue"
          games={recent.map(recentToCard)}
          subtitle="played recently"
          onOpen={onOpen}
          onPlay={onPlay}
        />
      )}
      {loading && !home ? (
        Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mb-7">
            <div className="mb-2.5 h-4 w-40 animate-pulse rounded" style={{ background: R.panel }} />
            <SkeletonCards />
          </div>
        ))
      ) : (
        home?.rows.map((row) => (
          <GameRow
            key={row.id}
            title={row.title}
            games={row.games}
            onOpen={onOpen}
            onPlay={onPlay}
          />
        ))
      )}
      <p className="pt-1 text-center text-[11px]" style={{ color: R.dim }}>
        live from roblox.com — Play launches the Roblox app · ☁ cloud games play right in your browser
      </p>
    </>
  );
}

function SearchView({
  query,
  results,
  searching,
  error,
  retry,
  onOpen,
  onPlay,
}: {
  query: string;
  results: RobloxGameCard[] | null;
  searching: boolean;
  error: string;
  retry: () => void;
  onOpen: (g: RobloxGameCard) => void;
  onPlay: (g: RobloxGameCard) => void;
}) {
  if (error) return <ErrorCard message={error} onRetry={retry} />;

  if (searching && !results) {
    return (
      <div className="flex flex-wrap gap-3">
        <SkeletonCards count={10} wide />
      </div>
    );
  }

  if (results && results.length === 0) {
    return (
      <p className="py-16 text-center text-[14px]" style={{ color: R.sub }}>
        No experiences found for “{query}”.
      </p>
    );
  }

  return (
    <>
      <p className="mb-4 text-[13px]" style={{ color: R.sub }}>
        {results?.length ?? 0} result{results?.length === 1 ? "" : "s"} for{" "}
        <span className="font-semibold text-white">“{query}”</span>
      </p>
      <div className="flex flex-wrap gap-3">
        {results?.map((g, i) => (
          <GameCard key={g.universeId} game={g} index={i} onOpen={onOpen} onPlay={onPlay} />
        ))}
      </div>
    </>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-3 py-2.5" style={{ background: R.panel }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: R.dim }}>
        {label}
      </p>
      <p className="mt-0.5 truncate text-[14px] font-semibold tabular-nums text-white" title={value}>
        {value}
      </p>
    </div>
  );
}

function DetailView({
  detail,
  loading,
  error,
  retry,
  onBack,
  onOpen,
  onPlay,
  onPlayCloud,
}: {
  detail: RobloxDetailResponse | null;
  loading: boolean;
  error: string;
  retry: () => void;
  onBack: () => void;
  onOpen: (g: RobloxGameCard) => void;
  onPlay: (g: RobloxGameCard) => void;
  onPlayCloud: (cg: CloudGame) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);

  if (error && !detail) return <ErrorCard message={error} onRetry={retry} />;
  if (loading && !detail) {
    return (
      <div>
        <div className="aspect-[16/6] w-full animate-pulse rounded-xl" style={{ background: R.panel }} />
        <div className="mt-4 flex items-center gap-4">
          <div className="size-24 animate-pulse rounded-xl" style={{ background: R.panel }} />
          <div className="flex-1">
            <div className="h-5 w-2/3 animate-pulse rounded" style={{ background: R.panel }} />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded" style={{ background: R.panel }} />
          </div>
        </div>
      </div>
    );
  }
  if (!detail) return null;

  const g = detail.game;
  const pct = ratingPct(g.upVotes, g.downVotes);
  const maturity = maturityLabel(g.maturity);
  const desc = g.description.trim();
  const cloud = cloudMatchFor(g.name);

  return (
    <div>
      {/* hero banner */}
      <div className="relative overflow-hidden rounded-xl" style={{ background: R.panel }}>
        {g.thumb ? (
          <img
            src={g.thumb}
            alt={`${g.name} banner`}
            referrerPolicy="no-referrer"
            className="aspect-[16/6] max-h-[32vh] w-full object-cover"
          />
        ) : (
          <div className="aspect-[16/6] max-h-[32vh] w-full bg-gradient-to-br from-[#2e3133] to-[#232527]" />
        )}
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
      </div>

      {/* identity */}
      <div className="relative flex flex-wrap items-end gap-4 px-1 pt-3 sm:px-2">
        <div
          className="-mt-14 size-24 shrink-0 overflow-hidden rounded-xl border-4 shadow-xl sm:size-28"
          style={{ borderColor: R.page, background: R.panel }}
        >
          <GameImage src={g.icon} alt={g.name} className="size-full object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-[22px] font-bold leading-tight text-white sm:text-[26px]">
            <span className="break-words">{g.name}</span>
            {g.creator.verified && (
              <BadgeCheck aria-label="Verified creator" className="size-5 shrink-0" style={{ color: R.green }} />
            )}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]" style={{ color: R.sub }}>
            <span className="flex items-center gap-1.5">
              By
              <span className="flex items-center gap-1 font-semibold text-white">
                {g.creator.avatarUrl && (
                  <img
                    src={g.creator.avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="size-5 rounded-full object-cover"
                  />
                )}
                {g.creator.name}
              </span>
              {g.creator.type === "Group" && (
                <span
                  className="rounded px-1 py-px text-[9px] font-bold uppercase tracking-wider"
                  style={{ background: R.panelHover, color: R.dim }}
                >
                  Group
                </span>
              )}
            </span>
            <PlayingCount n={g.playing} />
            {maturity && (
              <span
                className="rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: R.panelHover, color: R.sub }}
                title="Roblox content maturity"
              >
                {maturity}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            onPlay({
              universeId: g.universeId,
              placeId: g.placeId,
              name: g.name,
              icon: g.icon,
              playing: g.playing,
              upVotes: g.upVotes,
              downVotes: g.downVotes,
            })
          }
          className="flex h-12 min-w-[160px] shrink-0 items-center justify-center gap-2 rounded-lg px-8 text-[16px] font-bold uppercase tracking-wide text-white shadow-[0_6px_20px_rgba(0,176,111,0.35)] transition hover:brightness-110 active:scale-95"
          style={{ background: R.green }}
        >
          <Play aria-hidden className="size-5 fill-white" />
          Play
        </button>
      </div>

      {/* cloud banner — this exact game is playable in a browser tab */}
      {cloud && (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
          style={{ borderColor: `${R.cloud}55`, background: `${R.cloud}14` }}
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-white"
            style={{ background: R.cloud }}
          >
            <Cloud className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-bold text-white">
              Play this in your browser — no download
            </p>
            <p className="text-[11.5px] leading-snug" style={{ color: R.sub }}>
              now.gg streams the real game from their cloud to any browser tab.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onPlayCloud(cloud)}
            className="flex h-10 shrink-0 items-center gap-2 rounded-lg px-5 text-[13.5px] font-bold uppercase tracking-wide text-white shadow-[0_6px_20px_rgba(255,66,165,0.35)] transition hover:brightness-110 active:scale-95"
            style={{ background: R.cloud }}
          >
            <Cloud aria-hidden className="size-4" />
            Cloud play
          </button>
        </div>
      )}

      {/* stats */}
      <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatCell label="Active" value={fmtCount(g.playing)} />
        <StatCell label="Favorites" value={fmtVisits(g.favorites)} />
        <StatCell label="Visits" value={fmtVisits(g.visits)} />
        <StatCell label="Server Size" value={String(g.maxPlayers || "—")} />
        <StatCell label="Created" value={fmtDate(g.created)} />
        <StatCell label="Updated" value={fmtDate(g.updated)} />
        <StatCell label="Genre" value={g.genre || "All"} />
        <StatCell label="Max Players" value={String(g.maxPlayers || "—")} />
      </div>

      {/* votes */}
      <div className="mt-4 rounded-lg px-3.5 py-3" style={{ background: R.panel }}>
        <div className="mb-2 flex items-center justify-between text-[12.5px]" style={{ color: R.sub }}>
          <span className="flex items-center gap-1.5">
            <ThumbsUp aria-hidden className="size-3.5" style={{ color: R.green }} />
            <span className="font-semibold tabular-nums text-white">{fmtVisits(g.upVotes)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-semibold tabular-nums text-white">{fmtVisits(g.downVotes)}</span>
            <ThumbsDown aria-hidden className="size-3.5" style={{ color: R.red }} />
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: R.red }}>
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: R.green }}
          />
        </div>
        <p className="mt-1.5 text-center text-[11px]" style={{ color: R.dim }}>
          {pct}% positive
        </p>
      </div>

      {/* about */}
      {desc && (
        <section className="mt-5">
          <h2 className="mb-2 text-[16px] font-bold text-white">About</h2>
          <p
            className={cn(
              "whitespace-pre-line break-words text-[13.5px] leading-relaxed",
              !expanded && "line-clamp-5"
            )}
            style={{ color: R.sub }}
          >
            {desc}
          </p>
          {desc.length > 280 && (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              className="mt-1.5 text-[12.5px] font-semibold transition hover:brightness-125"
              style={{ color: R.green }}
            >
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </section>
      )}

      {/* recommended */}
      {detail.recommended.length > 0 && (
        <div className="mt-7">
          <GameRow
            title="Recommended"
            games={detail.recommended}
            onOpen={onOpen}
            onPlay={onPlay}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The tab                                                             */
/* ------------------------------------------------------------------ */

export function RobloxTab({
  active,
  onLaunch,
}: {
  active: boolean;
  /**
   * Opens a URL in Veil's own browser tab (the Quasar engine) — the
   * always-works path when the preview sandbox blocks both the
   * roblox-player:// deep link and external popups.
   */
  onLaunch?: (url: string, name: string) => void;
}) {
  const [view, setView] = React.useState<View>({ kind: "home" });
  const [query, setQuery] = React.useState("");

  // Embedded (preview panel) — computed once, client-side. Custom
  // protocols and popups are restricted there, so Play offers explicit
  // fallbacks instead of a silent no-op.
  const [embedded] = React.useState(
    () => typeof window !== "undefined" && isEmbeddedContext()
  );

  const [home, setHome] = React.useState<RobloxHomeResponse | null>(null);
  const [homeLoading, setHomeLoading] = React.useState(true);
  const [homeError, setHomeError] = React.useState("");

  const [results, setResults] = React.useState<RobloxGameCard[] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState("");

  const [detail, setDetail] = React.useState<RobloxDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState("");

  const [recent, setRecent] = React.useState<RecentGame[]>([]);
  const [playTarget, setPlayTarget] = React.useState<RobloxGameCard | null>(null);
  const [launching, setLaunching] = React.useState(false);
  const [cloudTarget, setCloudTarget] = React.useState<CloudGame | null>(null);
  const [cloudBlocked, setCloudBlocked] = React.useState(false);
  const [cloudCopied, setCloudCopied] = React.useState(false);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const detailCache = React.useRef(new Map<number, RobloxDetailResponse>());

  /* ----- home data + live poll ----- */
  const loadHome = React.useCallback(async (silent: boolean) => {
    if (!silent) setHomeLoading(true);
    try {
      const data = await fetchRobloxHome();
      setHome(data);
      setHomeError("");
    } catch (e) {
      if (!silent) setHomeError(e instanceof Error ? e.message : "Roblox is unreachable.");
    } finally {
      if (!silent) setHomeLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadHome(false);
    const iv = setInterval(() => {
      if (active && !document.hidden) void loadHome(true);
    }, 90_000);
    return () => clearInterval(iv);
  }, [active, loadHome]);

  React.useEffect(() => {
    setRecent(loadRecent());
  }, []);

  /* ----- search (debounced) ----- */
  React.useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      setSearchError("");
      setView((v) => (v.kind === "search" ? { kind: "home" } : v));
      return;
    }
    setView({ kind: "search" });
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const data = await fetchRobloxSearch(q);
        if (cancelled) return;
        setResults(data.results);
        setSearchError("");
      } catch (e) {
        if (!cancelled) setSearchError(e instanceof Error ? e.message : "Search failed.");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 420);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  /* ----- detail ----- */
  const openGame = React.useCallback(
    (card: RobloxGameCard) => {
      setView({ kind: "detail", universeId: card.universeId, seed: card });
      setDetailError("");
      const cachedRes = detailCache.current.get(card.universeId);
      if (cachedRes) {
        setDetail(cachedRes);
        setDetailLoading(false);
        return;
      }
      setDetail(null);
      setDetailLoading(true);
      void (async () => {
        try {
          const data = await fetchRobloxDetail(card.universeId);
          detailCache.current.set(card.universeId, data);
          setDetail(data);
        } catch (e) {
          setDetailError(e instanceof Error ? e.message : "Could not load the game page.");
        } finally {
          setDetailLoading(false);
        }
      })();
    },
    []
  );

  const goBack = React.useCallback(() => {
    setDetail(null);
    setDetailError("");
    setView(query.trim().length >= 2 ? { kind: "search" } : { kind: "home" });
  }, [query]);

  /* scroll to top on view change */
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view]);

  /* ----- play ----- */
  const play = React.useCallback(
    (card: RobloxGameCard) => {
      if (card.placeId <= 0) return;
      recordRecentGame({
        universeId: card.universeId,
        placeId: card.placeId,
        name: card.name,
        icon: card.icon,
      });
      setRecent(loadRecent());
      // Fires the deep link (top-level) or hands it to the host page's
      // top frame (embedded previews). No spinner in embedded mode —
      // subframe protocol launches are usually blocked, so the dialog
      // opens straight into its honest fallback panel.
      launchRobloxApp(card.placeId);
      setPlayTarget(card);
      if (!embedded) {
        setLaunching(true);
        setTimeout(() => setLaunching(false), 1600);
      }
    },
    [embedded]
  );

  /* Retry the app handoff from the dialog. */
  const retryLaunch = React.useCallback(() => {
    if (!playTarget) return;
    launchRobloxApp(playTarget.placeId);
    if (!embedded) {
      setLaunching(true);
      setTimeout(() => setLaunching(false), 1600);
    }
  }, [playTarget, embedded]);

  /* Open the real game page — real new tab when allowed, otherwise the
   * in-app browser. Returns true when something actually opened. */
  const openGamePage = React.useCallback(() => {
    if (!playTarget) return false;
    if (openRobloxGamePageTab(playTarget.placeId)) return true;
    if (onLaunch) {
      onLaunch(robloxGamePageUrl(playTarget.placeId), playTarget.name);
      return true;
    }
    return false;
  }, [playTarget, onLaunch]);

  /* Copy the game page URL — clipboard API with a textarea fallback for
   * restricted embeds (the preview iframe's permissions policy can deny
   * navigator.clipboard; execCommand still works from a user gesture). */
  const [copied, setCopied] = React.useState(false);
  const copyLink = React.useCallback(() => {
    if (!playTarget) return;
    const url = robloxGamePageUrl(playTarget.placeId);
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () => {
        if (legacyCopy(url)) done();
      });
    } else if (legacyCopy(url)) {
      done();
    }
  }, [playTarget]);

  /* ----- cloud play (now.gg) ----- */
  const openCloud = React.useCallback((cg: CloudGame) => {
    setCloudTarget(cg);
    setCloudBlocked(false);
    setPlayTarget(null);
  }, []);

  const launchCloud = React.useCallback(() => {
    if (!cloudTarget) return;
    if (openExternalTab(cloudTarget.url)) {
      setCloudTarget(null);
      return;
    }
    setCloudBlocked(true);
  }, [cloudTarget]);

  const copyCloudLink = React.useCallback(() => {
    if (!cloudTarget) return;
    const url = cloudTarget.url;
    const done = () => {
      setCloudCopied(true);
      window.setTimeout(() => setCloudCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () => {
        if (legacyCopy(url)) done();
      });
    } else if (legacyCopy(url)) {
      done();
    }
  }, [cloudTarget]);

  /* ----- Esc: cloud dialog → play dialog → back ----- */
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (cloudTarget) {
        setCloudTarget(null);
        return;
      }
      if (playTarget) {
        setPlayTarget(null);
        return;
      }
      if (view.kind === "detail") goBack();
      else if (query.trim()) setQuery("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, cloudTarget, playTarget, view, query, goBack]);

  const inSearch = view.kind === "search";

  return (
    <div
      role="region"
      aria-label="Roblox"
      className="relative h-full overflow-hidden rounded-2xl border border-black/50 shadow-2xl shadow-black/50"
      style={{ background: R.page }}
    >
      <div ref={scrollRef} className="veil-scroll-slim h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-4 sm:px-6">
          {/* toolbar */}
          <div
            className="sticky top-0 z-20 -mx-4 mb-5 flex items-center gap-3 border-b px-4 pb-3.5 pt-1 backdrop-blur-md sm:-mx-6 sm:px-6"
            style={{ background: `${R.page}e6`, borderColor: R.line }}
          >
            {view.kind !== "home" && (
              <button
                type="button"
                onClick={goBack}
                aria-label="Back to games"
                className="flex size-9 shrink-0 items-center justify-center rounded-full transition hover:brightness-125 active:scale-90"
                style={{ background: R.panel, color: R.sub }}
              >
                <ArrowLeft aria-hidden className="size-4" />
              </button>
            )}
            <RobloxMark />
            <form
              role="search"
              className="relative min-w-0 flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                searchInput.current?.blur();
              }}
            >
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2"
                style={{ color: R.dim }}
              />
              <input
                ref={searchInput}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Roblox experiences…"
                aria-label="Search Roblox experiences"
                spellCheck={false}
                autoComplete="off"
                className="h-10 w-full rounded-full border pl-10 pr-9 text-[13.5px] text-white outline-none transition placeholder:text-[#7b7d7d] focus:border-emerald-400/50"
                style={{ background: R.panel, borderColor: R.line }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    searchInput.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full transition hover:brightness-125"
                  style={{ color: R.dim }}
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              )}
            </form>
            <span
              className="hidden shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider sm:flex"
              style={{ background: R.panel, color: R.dim }}
              title="Charts, search and game pages stream live from roblox.com"
            >
              <span
                aria-hidden
                className="relative flex size-1.5"
              >
                <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative size-1.5 rounded-full" style={{ background: R.green }} />
              </span>
              live
            </span>
          </div>

          {view.kind === "home" && (
            <HomeView
              home={home}
              loading={homeLoading}
              error={homeError}
              recent={recent}
              retry={() => void loadHome(false)}
              onOpen={openGame}
              onPlay={play}
              onPlayCloud={openCloud}
            />
          )}
          {inSearch && (
            <SearchView
              query={query.trim()}
              results={results}
              searching={searching}
              error={searchError}
              retry={() => {
                const q = query;
                setQuery("");
                setTimeout(() => setQuery(q), 30);
              }}
              onOpen={openGame}
              onPlay={play}
            />
          )}
          {view.kind === "detail" && (
            <DetailView
              detail={detail}
              loading={detailLoading}
              error={detailError}
              retry={() => openGame({ ...(view.seed ?? { name: "", icon: null, playing: 0, upVotes: 0, downVotes: 0, placeId: 0 }), universeId: view.universeId })}
              onBack={goBack}
              onOpen={openGame}
              onPlay={play}
              onPlayCloud={openCloud}
            />
          )}
        </div>
      </div>

      {/* play dialog */}
      <AnimatePresence>
        {playTarget && (
          <motion.div
            key="roblox-play"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={() => setPlayTarget(null)}
            role="dialog"
            aria-modal="true"
            aria-label={`Play ${playTarget.name}`}
          >
            <motion.div
              initial={{ scale: 0.92, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="w-full max-w-sm rounded-2xl p-5 shadow-2xl"
              style={{ background: R.panel }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <div
                  className="size-16 shrink-0 overflow-hidden rounded-xl"
                  style={{ background: R.panelHover }}
                >
                  <GameImage src={playTarget.icon} alt={playTarget.name} className="size-full object-cover" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[16px] font-bold text-white">{playTarget.name}</h3>
                  <p className="mt-0.5 text-[12px]" style={{ color: R.dim }}>
                    {embedded ? "choose how to play" : "launching in the Roblox app"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPlayTarget(null)}
                  aria-label="Close"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full transition hover:brightness-125"
                  style={{ color: R.dim }}
                >
                  <X aria-hidden className="size-4" />
                </button>
              </div>

              <div className="mt-4 flex flex-col items-center gap-2.5 rounded-xl px-4 py-5" style={{ background: R.page }}>
                {launching ? (
                  <>
                    <Loader2 aria-hidden className="size-6 animate-spin" style={{ color: R.green }} />
                    <p className="text-[13.5px] font-semibold text-white">Opening Roblox…</p>
                    <p className="text-[11.5px]" style={{ color: R.dim }}>
                      your browser may ask permission first
                    </p>
                  </>
                ) : embedded ? (
                  <>
                    {/* QR hero — the one path that goes from the preview
                     * straight INTO the game: scan with a phone that has the
                     * Roblox app, tap Play there. */}
                    <p className="text-center text-[12.5px] leading-snug" style={{ color: R.sub }}>
                      Browsers can&apos;t run Roblox games — not even roblox.com.
                      The game runs in the Roblox app on your device:
                    </p>
                    <div className="my-1 flex items-center gap-4 self-stretch rounded-xl p-3" style={{ background: R.panel }}>
                      <div className="rounded-lg bg-white p-2 shadow-inner">
                        <QRCodeSVG
                          value={robloxGamePageUrl(playTarget.placeId)}
                          size={116}
                          level="M"
                          bgColor="#ffffff"
                          fgColor="#191b1d"
                          aria-label={`QR code linking to ${playTarget.name} on roblox.com`}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 text-[13px] font-bold text-white">
                          <Smartphone aria-hidden className="size-3.5" style={{ color: R.green }} />
                          Scan to play
                        </p>
                        <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: R.dim }}>
                          Opens this game on your phone — tap the green Play
                          there and the Roblox app joins it.
                        </p>
                        <button
                          type="button"
                          onClick={copyLink}
                          className="mt-2 flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-semibold transition hover:brightness-125 active:scale-95"
                          style={{ background: copied ? R.green : R.panelHover, color: copied ? "#fff" : R.sub }}
                        >
                          {copied ? (
                            <Check aria-hidden className="size-3.5" />
                          ) : (
                            <Copy aria-hidden className="size-3.5" />
                          )}
                          {copied ? "Copied!" : "Copy link"}
                        </button>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (openGamePage()) setPlayTarget(null);
                      }}
                      className="flex h-10 w-full items-center justify-center gap-2 rounded-lg text-[14px] font-bold uppercase tracking-wide text-white transition hover:brightness-110 active:scale-95"
                      style={{ background: R.green }}
                    >
                      <ExternalLink aria-hidden className="size-4" />
                      Open game page
                    </button>
                    {onLaunch && (
                      <button
                        type="button"
                        onClick={() => {
                          onLaunch(robloxGamePageUrl(playTarget.placeId), playTarget.name);
                          setPlayTarget(null);
                        }}
                        className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition hover:brightness-125 active:scale-95"
                        style={{ background: R.panelHover, color: R.sub }}
                      >
                        <Globe aria-hidden className="size-3.5" />
                        Open in the Veil browser
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={retryLaunch}
                      className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-semibold underline-offset-2 transition hover:brightness-125 hover:underline active:scale-95"
                      style={{ color: R.dim }}
                    >
                      <Play aria-hidden className="size-3" />
                      Try launching the app on this device
                    </button>
                    <p className="mt-1 max-w-[30ch] text-center text-[10.5px] leading-relaxed" style={{ color: R.dim }}>
                      This device: open Veil in its own tab (↗ above the
                      preview) and Play launches the Roblox app directly.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-center text-[13px]" style={{ color: R.sub }}>
                      Roblox didn&apos;t open? Launch it again — or take the game
                      to your phone.
                    </p>
                    <button
                      type="button"
                      onClick={retryLaunch}
                      className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-lg text-[14px] font-bold uppercase tracking-wide text-white transition hover:brightness-110 active:scale-95"
                      style={{ background: R.green }}
                    >
                      <Play aria-hidden className="size-4 fill-white" />
                      Launch Roblox
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (openGamePage()) setPlayTarget(null);
                      }}
                      className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[13px] font-semibold transition hover:brightness-125 active:scale-95"
                      style={{ background: R.panelHover, color: R.sub }}
                    >
                      <ExternalLink aria-hidden className="size-3.5" />
                      Game page on roblox.com
                    </button>
                    <div className="mt-1 flex items-center gap-3 self-stretch rounded-xl p-2.5" style={{ background: R.panel }}>
                      <div className="rounded-lg bg-white p-1.5">
                        <QRCodeSVG
                          value={robloxGamePageUrl(playTarget.placeId)}
                          size={72}
                          level="M"
                          bgColor="#ffffff"
                          fgColor="#191b1d"
                          aria-label={`QR code linking to ${playTarget.name} on roblox.com`}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-semibold text-white">Play on your phone instead</p>
                        <p className="text-[10.5px] leading-relaxed" style={{ color: R.dim }}>
                          Scan → tap Play → the app joins the game.
                        </p>
                        <button
                          type="button"
                          onClick={copyLink}
                          className="mt-1.5 flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold transition hover:brightness-125 active:scale-95"
                          style={{ background: copied ? R.green : R.panelHover, color: copied ? "#fff" : R.sub }}
                        >
                          {copied ? (
                            <Check aria-hidden className="size-3" />
                          ) : (
                            <Copy aria-hidden className="size-3" />
                          )}
                          {copied ? "Copied!" : "Copy link"}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
