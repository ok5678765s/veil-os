"use client";

/**
 * Veil Arcade — the Game Library. Titles play INSIDE the overlay,
 * directly under a persistent arcade-selection top bar (header +
 * tabs + search) that never unmounts while something is running.
 *
 * Architecture:
 * - The top bar is always mounted. Launching a title renders a player
 *   layer (status bar + iframe) in the content region BELOW the top bar,
 *   so the arcade-selection UI stays reachable at all times.
 * - "Back to arcade" (or clicking any tab) tucks the player away with
 *   display:none — the iframe and its state survive (the game effectively
 *   pauses) and a floating pill offers to resume it. "Stop" unmounts it.
 * - The GN-Math tab is the xylora-style study grid, sourced from
 *   gn-math.dev (the catalog Xylora itself uses — 800+ ad-free html5
 *   games). Titles play through the veil proxy, whose ad-block 204s any
 *   ad/analytics network a game file references.
 * - The Math tab is the number rush — sprint / survival / zen modes
 *   with streaks, difficulty tiers and per-mode bests, fully local
 *   React, no third-party servers. Replaced the Blooks quiz
 *   platform at the owner's request (Bloxd before that).
 * - The Builds tab ("My Builds") is the home of the owner's AI Coder
 *   builds — every game/app Veil AI wrote lives in localStorage and
 *   plays in an embedded in-tab player (owner ask 2026-10-19: "remove
 *   roblox from arcade" — the old live roblox.com tab is gone).
 * - Swapping titles or reloading bumps a key so only the iframe remounts.
 * - Title URLs and thumbnails are routed through the veil (routeUrl).
 * - Title iframes register themselves in the arcade-frame
 *   registry (setArcadeFrame / registerArcadeFrame) so their postMessages
 *   never drive the browser tab state.
 * - Esc is handled in the CAPTURE phase on window: 1st Esc tucks the
 *   running app away, 2nd Esc closes the arcade. F toggles OS fullscreen
 *   on the running app.
 */

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  ArrowLeft,
  Calculator,
  ExternalLink,
  Flame,
  Joystick,
  LayoutGrid,
  Maximize,
  Minimize,
  Play,
  RotateCw,
  Search,
  Sparkles,
  Square,
  Star,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyboardHelp } from "@/components/veil/keyboard-help";
import { BackdropVideo } from "@/components/veil/backdrop-video";
import { MathGame } from "@/components/veil/math-game";
import { BuildsTab } from "@/components/veil/arcade/builds-tab";
import { routeUrl, setArcadeFrame } from "@/lib/veil/shared";
import { takePendingRobloxJump } from "@/lib/veil/cloud-games";
import {
  THEME_GRADIENTS,
  loadWallpaperSelection,
  type WallpaperSelection,
} from "@/lib/veil/wallpapers";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

interface TitleItem {
  id: string;
  name: string;
  key: string;
  image: string;
  category: string;
  play: string;
  /** Off-site titles (the discord promo card) open in the browser view. */
  external?: boolean;
}

interface ArcadeResponse {
  items?: TitleItem[];
  total?: number;
  page?: number;
  hasMore?: boolean;
  error?: string;
  /** The full `special` tag list (port / flash / emulator / fnf …) —
   *  powers the tag filter dropdown exactly like the website. */
  tags?: string[];
}

interface RunningTitle {
  url: string;
  name: string;
  /** Bumped when swapping titles so the iframe remounts. */
  key: number;
  /** Bumped on "Reload" — remounts the iframe with the same src. */
  reloads: number;
}

type TabId = "gnmath" | "math" | "stash" | "builds";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "gnmath", label: "GN-Math", icon: Joystick },
  { id: "math", label: "Math", icon: Calculator },
  { id: "stash", label: "The Stash", icon: Archive },
  { id: "builds", label: "My Builds", icon: Sparkles },
];

const SEARCH_PLACEHOLDER = "search the arcade…";

/** Catalog image URL -> veil-routed URL (absolute or gn-math-relative). */
function titleImageSrc(url: string): string {
  if (/^https?:\/\//i.test(url)) return routeUrl(url);
  if (url.startsWith("/")) return routeUrl(`https://gn-math.dev${url}`);
  return "";
}

/* ------------------------------------------------------------------ */
/* Favorites & recently played (localStorage)                          */
/* ------------------------------------------------------------------ */

const FAV_KEY = "veil:arcade-favs:v1";
const RECENT_KEY = "veil:arcade-recent:v1";
const RECENT_MAX = 10;

/** Favorite/recent records — a trimmed TitleItem (no derived fields). */
interface StoredTitle {
  id: string;
  name: string;
  key: string;
  image: string;
  category: string;
  play: string;
}

function isTitleItem(g: unknown): g is StoredTitle {
  return (
    !!g &&
    typeof g === "object" &&
    typeof (g as TitleItem).id === "string" &&
    typeof (g as TitleItem).name === "string" &&
    typeof (g as TitleItem).play === "string"
  );
}

function loadFavs(): Record<string, StoredTitle> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, StoredTitle> = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, g] of Object.entries(parsed)) {
        if (isTitleItem(g)) out[id] = { id: g.id, name: g.name, key: g.key ?? "", image: g.image ?? "", category: g.category ?? "", play: g.play };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveFavs(favs: Record<string, StoredTitle>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  } catch {
    /* storage unavailable — favorites stay in-memory for this session */
  }
}

function loadRecent(): StoredTitle[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTitleItem).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecent(list: StoredTitle[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Backdrop — the applied wallpaper shows while BROWSING the catalogs  */
/* (xylora-style: wallpaper + dark overlay); it fades out the moment a */
/* title is playing (opaque player layer).                             */
/* ------------------------------------------------------------------ */

function ArcadeBackdropLayer({ visible }: { visible: boolean }) {
  const [wp, setWp] = React.useState<WallpaperSelection | null>(null);
  React.useEffect(() => {
    const sync = () => setWp(loadWallpaperSelection());
    sync();
    window.addEventListener("veil:wallpaper-changed", sync);
    return () => window.removeEventListener("veil:wallpaper-changed", sync);
  }, []);

  const kind = wp?.kind ?? "animated";
  const theme = wp?.theme ?? "emerald";
  const src = wp?.src ?? "";
  const thumb = wp?.thumb ?? undefined;

  return (
    <div
      aria-hidden
      className={cn(
        "absolute inset-0 overflow-hidden transition-opacity duration-700 ease-out",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      {kind === "video" && src ? (
        <BackdropVideo src={src} poster={thumb} />
      ) : kind === "image" && src ? (
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        <div className={`absolute inset-0 bg-gradient-to-br ${THEME_GRADIENTS[theme] ?? THEME_GRADIENTS.emerald}`}>
          <div className="veil-orb-a absolute -top-40 left-[25%] h-[26rem] w-[40rem] rounded-full bg-white/10 blur-3xl" />
          <div className="veil-orb-b absolute -bottom-32 right-[8%] h-80 w-80 rounded-full bg-black/10 blur-3xl" />
        </div>
      )}
      {/* xylora-style dark overlay so the cards read on any wallpaper */}
      <div className="absolute inset-0 bg-black/60" />
      <div className="absolute inset-0 bg-emerald-950/25" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/50 to-transparent" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Catalog cards                                                       */
/* ------------------------------------------------------------------ */

/* xylora study card, Veil twist: 16:9 cover that zooms on hover with a */
/* centered play glyph, a corner flame on hot titles, and a slim       */
/* lowercase-only footer. The favorite star lives on the cover corner  */
/* (invisible until hover) so the footer stays as clean as xylora's.    */

function TitleCard({
  title,
  index,
  onLaunch,
  className,
  favorite,
  hot,
  onToggleFavorite,
}: {
  title: TitleItem;
  index: number;
  onLaunch: (title: TitleItem) => void;
  className?: string;
  favorite?: boolean;
  hot?: boolean;
  onToggleFavorite?: (title: TitleItem) => void;
}) {
  const [failed, setFailed] = React.useState(false);
  const src = titleImageSrc(title.image);

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -48px 0px" }}
      transition={{ duration: 0.35, delay: (index % 6) * 0.04 }}
      onClick={() => onLaunch(title)}
      aria-label={`Play ${title.name}`}
      className={cn(
        "group block overflow-hidden rounded-[14px] border border-[#1a2822] bg-[#121f1a] text-left shadow-sm shadow-black/40 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-[#3f7f63] hover:shadow-[0_10px_28px_rgba(63,127,99,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5fae87]/50",
        favorite && "border-[#6b5c2e]/60 hover:border-[#3f7f63]",
        className
      )}
    >
      <span className="veil-hover-tilt relative block aspect-video w-full overflow-hidden bg-[#0a100d]">
        {src && !failed ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#1c3327] via-[#0d1612] to-[#15251d]"
          >
            <span className="text-2xl font-black text-[#5fae87]/80">
              {title.name.charAt(0).toUpperCase()}
            </span>
          </span>
        )}

        {/* Veil twist: play glyph fades in over the zooming cover */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 backdrop-blur-[0px] transition-opacity duration-200 group-hover:opacity-100 group-hover:bg-black/40"
        >
          <span className="veil-press veil-hover-glow flex size-11 scale-75 items-center justify-center rounded-full bg-[#3f7f63] shadow-[0_8px_24px_rgba(0,0,0,0.55)] ring-1 ring-white/25 transition-transform duration-200 group-hover:scale-100">
            <Play aria-hidden className="size-4 translate-x-[1px] fill-white text-white" />
          </span>
        </span>

        {/* Veil twist: tiny flame on the corner of hot titles */}
        {hot && (
          <span
            aria-hidden
            title="Hot right now"
            className="veil-bounce-soft pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full border border-orange-400/25 bg-black/55 px-1.5 py-[3px] text-[9px] font-bold uppercase tracking-wider text-orange-300 backdrop-blur-md"
          >
            <Flame aria-hidden className="size-2.5 fill-orange-400/60" />
            hot
          </span>
        )}

        {/* subtle top scrim so the star reads on any thumbnail */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-black/50 to-transparent"
        />
        {onToggleFavorite && (
          <span
            role="button"
            tabIndex={0}
            aria-pressed={!!favorite}
            aria-label={favorite ? `Remove ${title.name} from favorites` : `Add ${title.name} to favorites`}
            title={favorite ? "Remove from favorites" : "Add to favorites"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(title);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onToggleFavorite(title);
              }
            }}
            className={cn(
              "veil-press absolute right-1.5 top-1.5 z-10 flex size-7 items-center justify-center rounded-full border backdrop-blur-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70",
              favorite
                ? "border-amber-400/50 bg-amber-500/25 text-amber-300 opacity-100"
                : "border-white/15 bg-black/45 text-zinc-300 opacity-0 hover:border-amber-400/40 hover:text-amber-300 group-hover:opacity-100 group-focus-within:opacity-100"
            )}
          >
            <Star
              aria-hidden
              className={cn("size-3.5 transition-transform", favorite && "fill-amber-400 text-amber-400 scale-110")}
            />
          </span>
        )}
      </span>
      <span className="flex items-center gap-1.5 border-t border-[#1a2822] bg-[#121f1a] px-2.5 py-2 pt-[9px]">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold lowercase text-[#e8f2ee] transition group-hover:text-[#5fae87]">
          {title.name}
        </span>
      </span>
    </motion.button>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-[14px] border border-[#1a2822] bg-[#121f1a]/80">
      <div className="aspect-video w-full animate-pulse bg-[#183024]/50" />
      <div className="border-t border-[#1a2822] px-2.5 py-2">
        <div className="h-2.5 w-3/4 animate-pulse rounded-full bg-[#183024]/50" />
      </div>
    </div>
  );
}

function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

function CatalogGrid({
  titles,
  onLaunch,
  favoriteIds,
  hotIds,
  onToggleFavorite,
}: {
  titles: TitleItem[];
  onLaunch: (title: TitleItem) => void;
  favoriteIds?: Set<string>;
  hotIds?: Set<string>;
  onToggleFavorite?: (title: TitleItem) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {titles.map((g, i) => (
        <TitleCard
          key={g.id}
          title={g}
          index={i}
          onLaunch={onLaunch}
          favorite={favoriteIds?.has(g.id)}
          hot={hotIds?.has(g.id)}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
}

function CatalogErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="veil-pop-in rounded-2xl border border-amber-500/25 bg-amber-500/10 p-8 text-center sm:p-10">
      <WifiOff aria-hidden className="mx-auto h-6 w-6 text-amber-400" />
      <p className="mt-3 text-[13.5px] font-medium text-amber-200">Couldn't reach the arcade catalog.</p>
      <p className="mt-1 text-[12.5px] text-amber-200/70">
        The upstream arcade source may be down — try again in a moment.
      </p>
      <Button
        variant="outline"
        onClick={onRetry}
        className="veil-press mt-4 h-9 gap-1.5 rounded-xl border-amber-500/30 bg-zinc-900/60 px-4 text-[13px] text-amber-200 hover:border-amber-400/50 hover:bg-zinc-900"
      >
        <RotateCw aria-hidden className="h-3.5 w-3.5" />
        Try again
      </Button>
    </div>
  );
}

function SearchView({
  query,
  results,
  loading,
  stashLoading,
  onLaunch,
  favoriteIds,
  hotIds,
  onToggleFavorite,
}: {
  query: string;
  results: TitleItem[];
  loading: boolean;
  /** true while The Stash catalog is still being searched */
  stashLoading?: boolean;
  onLaunch: (title: TitleItem) => void;
  favoriteIds?: Set<string>;
  hotIds?: Set<string>;
  onToggleFavorite?: (title: TitleItem) => void;
}) {
  const stashCount = results.filter((g) => g.category === "The Stash").length;
  const arcadeCount = results.length - stashCount;
  return (
    <div>
      {/* xylora-style meta line — counts in the accent green */}
      <p className="mb-4 text-[11px] tracking-[0.04em] text-[#526a60]">
        {loading || stashLoading ? (
          "searching both catalogs…"
        ) : results.length > 0 ? (
          <>
            <span className="font-semibold text-[#5fae87]">{results.length}</span>{" "}
            {results.length === 1 ? "title" : "titles"} for “{query}”
            {stashCount > 0 && (
              <>
                {" · "}
                <span className="font-semibold text-[#5fae87]">{stashCount}</span> from the stash
              </>
            )}
            {" — press Enter to play the top match"}
          </>
        ) : (
          <>nothing matched “{query}” — try a shorter word</>
        )}
      </p>
      {results.length > 0 ? (
        <CatalogGrid
          titles={results}
          onLaunch={onLaunch}
          favoriteIds={favoriteIds}
          hotIds={hotIds}
          onToggleFavorite={onToggleFavorite}
        />
      ) : loading || stashLoading ? (
        <SkeletonGrid count={8} />
      ) : (
        /* xylora-style empty state — one muted glyph, one line */
        <div className="py-16 text-center">
          <Search aria-hidden className="mx-auto block size-6 opacity-30 text-[#526a60]" />
          <p className="mt-3 text-[13px] text-[#526a60]">No titles match “{query}”.</p>
          <p className="mt-1 text-[12px] text-[#526a60]/70">
            Both the arcade and The Stash came up empty — try a shorter word, or check the Stash
            tab for the full A–Z list.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The Stash tab                                                       */
/* ------------------------------------------------------------------ */

function StashTab() {
  // The user's uploaded Stash single-file build — served locally from the
  // public bundle with a custom Veil layout. Its title list + titles stream
  // from the UGS CDN inside this iframe; everything stays inside the arcade
  // layer.
  //
  // Fill mode: when a title's fullscreen request is denied (embedded preview
  // panels), the stash player posts a "veil:ugs-fill" message and the stash
  // expands to cover the whole arcade — the title gets the entire screen.
  const [fill, setFill] = React.useState(false);

  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fill?: boolean } | null;
      if (d && typeof d === "object" && d.type === "veil:ugs-fill") {
        setFill(Boolean(d.fill));
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col",
        fill
          ? "fixed inset-0 z-40 h-full w-full bg-zinc-950"
          : "h-full w-full px-4 pb-4 pt-2 sm:px-6"
      )}
    >
      <div
        className={cn(
          "relative w-full min-h-0 flex-1 overflow-hidden",
          fill
            ? "h-full rounded-none border-0"
            : "rounded-[14px] border border-[#1a2822] bg-[#0d1612] shadow-2xl shadow-black/50"
        )}
      >
        <iframe
          src="/arcade/ugs.html"
          title="The Stash — the single-file collection"
          className="absolute inset-0 size-full border-0 bg-zinc-950"
          // sandbox without allow-top-navigation: UGS title buttons try to
          // navigate window.top (taking over the whole Veil page) — blocked,
          // titles load inside this frame instead.
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
          allow="autoplay; fullscreen; encrypted-media; clipboard-write; gamepad"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ArcadeSection                                                      */
/* ------------------------------------------------------------------ */

export function ArcadeSection({
  onBack,
  onLaunch,
}: {
  /** Close the arcade → back to the start page. */
  onBack: () => void;
  /** Escape hatch: open the title in a full browser tab. */
  onLaunch: (url: string, name: string) => void;
}) {
  // ----- running title (stays MOUNTED while tucked away) -----
  const [title, setTitle] = React.useState<RunningTitle | null>(null);
  const [arcadeVisible, setArcadeVisible] = React.useState(false);
  const [isArcadeFullscreen, setIsArcadeFullscreen] = React.useState(false);
  const arcadeAreaRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // ----- top bar -----
  const [tab, setTab] = React.useState<TabId>("gnmath");
  const [query, setQuery] = React.useState("");

  // ----- favorites & recently played (localStorage-backed) -----
  const [favs, setFavs] = React.useState<Record<string, StoredTitle>>({});
  const [recent, setRecent] = React.useState<StoredTitle[]>([]);

  // Load persisted picks once on mount (client-only values).
  React.useEffect(() => {
    setFavs(loadFavs());
    setRecent(loadRecent());
  }, []);

  const favIds = React.useMemo(() => new Set(Object.keys(favs)), [favs]);
  const favList = React.useMemo(() => Object.values(favs), [favs]);

  const toggleFavorite = React.useCallback((g: TitleItem) => {
    setFavs((prev) => {
      const next = { ...prev };
      if (next[g.id]) delete next[g.id];
      else next[g.id] = g;
      saveFavs(next);
      return next;
    });
  }, []);

  const recordRecent = React.useCallback((g: TitleItem) => {
    setRecent((prev) => {
      const next = [g, ...prev.filter((p) => p.id !== g.id)].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
  }, []);

  // ----- GN-Math catalog -----
  const [hot, setHot] = React.useState<TitleItem[]>([]);
  const hotIds = React.useMemo(() => new Set(hot.map((g) => g.id)), [hot]);
  const [titles, setTitles] = React.useState<TitleItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [initialLoading, setInitialLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [catalogError, setCatalogError] = React.useState(false);
  const [remoteResults, setRemoteResults] = React.useState<TitleItem[]>([]);
  const [remoteLoading, setRemoteLoading] = React.useState(false);

  // The website's own catalog controls, mirrored: sort (ID (Date) /
  // Name) + the `special` tag filter (contains-match).
  const [sort, setSort] = React.useState<"id" | "name">("id");
  const [tag, setTag] = React.useState("");
  const [tagList, setTagList] = React.useState<string[]>([]);

  // ----- Stash catalog (the UGS single-file titles, searched server-side) -----
  const [stashResults, setStashResults] = React.useState<TitleItem[]>([]);
  const [stashLoading, setStashLoading] = React.useState(false);

  // Frame registry: the arcade iframe's postMessages must not drive the
  // browser tab state. Register/unregister via a callback ref.
  const arcadeFrameRef = React.useCallback((el: HTMLIFrameElement | null) => {
    setArcadeFrame(el ? el.contentWindow : null);
  }, []);

  // ----- catalog fetch (page 1 + featured row; one shared upstream cache) -----
  // ATOMIC: both responses are fully parsed BEFORE any state flips — an
  // await between setHasMore(true) and setInitialLoading(false) could split
  // the mount into two commits and leave the sentinel rendered but never
  // observed (the dead-observer race that froze the catalog at page 1).
  const loadInitial = React.useCallback(async () => {
    setInitialLoading(true);
    setCatalogError(false);
    const params = new URLSearchParams();
    if (sort === "name") params.set("sort", "name");
    if (tag) params.set("tag", tag);
    const qs = params.toString();
    const [mainRes, hotRes] = await Promise.allSettled([
      fetch(`/api/arcade?page=1${qs ? `&${qs}` : ""}`, { cache: "no-store" }),
      fetch(`/api/arcade?hot=1${qs ? `&${qs}` : ""}`, { cache: "no-store" }),
    ]);
    let mainData: ArcadeResponse | null = null;
    let hotData: ArcadeResponse | null = null;
    if (mainRes.status === "fulfilled") {
      try {
        mainData = (await mainRes.value.json()) as ArcadeResponse;
      } catch {
        mainData = null;
      }
    }
    if (hotRes.status === "fulfilled") {
      try {
        hotData = (await hotRes.value.json()) as ArcadeResponse;
      } catch {
        hotData = null;
      }
    }
    /* ——— everything below runs in one synchronous block ——— */
    if (mainData && mainRes.status === "fulfilled" && mainRes.value.ok && Array.isArray(mainData.items)) {
      setTitles(mainData.items);
      setTotal(mainData.total ?? 0);
      setHasMore(Boolean(mainData.hasMore));
      setPage(1);
      if (Array.isArray(mainData.tags)) setTagList(mainData.tags);
    } else {
      setCatalogError(true);
    }
    if (hotData && hotRes.status === "fulfilled" && hotRes.value.ok && Array.isArray(hotData.items)) {
      setHot(hotData.items);
    }
    setInitialLoading(false);
  }, [sort, tag]);

  React.useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const loadMore = React.useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const params = new URLSearchParams({ page: String(next) });
      if (sort === "name") params.set("sort", "name");
      if (tag) params.set("tag", tag);
      const res = await fetch(`/api/arcade?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json()) as ArcadeResponse;
      if (res.ok && Array.isArray(data.items)) {
        setTitles((prev) => {
          const seen = new Set(prev.map((g) => g.id));
          const merged = [...prev];
          for (const g of data.items ?? []) {
            if (!seen.has(g.id)) {
              seen.add(g.id);
              merged.push(g);
            }
          }
          return merged;
        });
        setPage(next);
        setHasMore(Boolean(data.hasMore));
      }
    } catch {
      /* keep the current page loaded */
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, page, sort, tag]);

  /* ----- Veil twist: the catalog feeds itself — a CALLBACK-REF      */
  /* ----- IntersectionObserver watches the sentinel under the grid    */
  /* ----- and pulls the next page in as you scroll. A callback ref    */
  /* ----- (not useRef + effect) observes the node exactly when it     */
  /* ----- mounts and whenever loadMore changes — immune to the        */
  /* ----- render-split race that used to leave the catalog stuck      */
  /* ----- after page 1.                                              */
  const sentinelIoRef = React.useRef<IntersectionObserver | null>(null);
  const attachSentinel = React.useCallback(
    (el: HTMLDivElement | null) => {
      sentinelIoRef.current?.disconnect();
      sentinelIoRef.current = null;
      if (!el || typeof IntersectionObserver === "undefined") return;
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) void loadMore();
        },
        { rootMargin: "700px 0px" }
      );
      io.observe(el);
      sentinelIoRef.current = io;
    },
    [loadMore]
  );

  // ----- server-side search (debounced), alongside the client filter -----
  // Both catalogs are queried in parallel: GN-Math and The Stash (the UGS
  // single-file list) — so stash-only titles (e.g. "cluster rush") are
  // findable right from this search bar.
  React.useEffect(() => {
    const q = query.trim();
    if (!q) {
      setRemoteResults([]);
      setRemoteLoading(false);
      setStashResults([]);
      setStashLoading(false);
      return;
    }
    let cancelled = false;
    setRemoteLoading(true);
    setStashLoading(true);
    const t = setTimeout(async () => {
      const enc = encodeURIComponent(q);
      const [main, stash] = await Promise.allSettled([
        fetch(`/api/arcade?q=${enc}`, { cache: "no-store" }).then(async (res) => {
          const data = (await res.json()) as ArcadeResponse;
          if (res.ok && Array.isArray(data.items)) return data.items;
          throw new Error("bad response");
        }),
        fetch(`/api/arcade/stash?q=${enc}`, { cache: "no-store" }).then(async (res) => {
          const data = (await res.json()) as ArcadeResponse;
          if (res.ok && Array.isArray(data.items)) return data.items;
          throw new Error("bad response");
        }),
      ]);
      if (cancelled) return;
      if (main.status === "fulfilled") setRemoteResults(main.value);
      if (stash.status === "fulfilled") setStashResults(stash.value);
      // Errors keep whatever we had — the client-side filter still covers
      // the loaded GN-Math pages.
      setRemoteLoading(false);
      setStashLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const clientFiltered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const pool = [...hot, ...titles];
    const seen = new Set<string>();
    return pool.filter((g) => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      const hay = `${g.name} ${g.key} ${g.category}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [query, hot, titles]);

  const searchResults = React.useMemo(() => {
    const seen = new Set<string>();
    const out: TitleItem[] = [];
    // GN-Math matches first (catalog + hot + loaded pages), then The Stash
    // (single-file titles launch straight from the CDN through the veil).
    for (const g of [...remoteResults, ...clientFiltered, ...stashResults]) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(g);
    }
    return out;
  }, [remoteResults, clientFiltered, stashResults]);


  // ----- title controls -----
  const launch = React.useCallback((url: string, name: string) => {
    setTitle((prev) =>
      prev ? { url, name, key: prev.key + 1, reloads: 0 } : { url, name, key: 0, reloads: 0 }
    );
    setArcadeVisible(true);
  }, []);

  const launchTitle = React.useCallback(
    (g: TitleItem) => {
      if (g.external) {
        // Off-site links (the discord “SUGGEST GAMES” card) open in the
        // browser view — Veil’s equivalent of the website’s new tab.
        onLaunch(g.play, g.name);
        return;
      }
      recordRecent(g);
      launch(g.play, g.name);
    },
    [launch, recordRecent, onLaunch]
  );

  const stopTitle = React.useCallback(() => {
    setTitle(null);
    setArcadeVisible(false);
  }, []);

  const reloadTitle = React.useCallback(() => {
    setTitle((g) => (g ? { ...g, reloads: g.reloads + 1 } : g));
  }, []);

  const toggleArcadeFullscreen = React.useCallback(async () => {
    const el = arcadeAreaRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch {
      /* sandboxed previews may deny — the full-viewport layout still applies */
    }
  }, []);

  React.useEffect(() => {
    const onChange = () => setIsArcadeFullscreen(document.fullscreenElement === arcadeAreaRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Clicking ANY tab (including the active one) tucks the running title
  // away, and shows that catalog. Plain buttons (not Radix) so the active
  // tab's click fires too — onValueChange would only fire on change.
  const selectTab = React.useCallback((id: TabId) => {
    setTab(id);
    setArcadeVisible(false);
  }, []);

  // Cross-section jump: the legacy "open the apps tab" signal lands on
  // the Builds tab (the AI Coder home — the old Apps/Roblox tab is gone).
  React.useEffect(() => {
    const onJump = () => selectTab("builds");
    window.addEventListener("veil:open-arcade-apps", onJump);
    return () => window.removeEventListener("veil:open-arcade-apps", onJump);
  }, [selectTab]);

  // "Play in the Arcade" from the AI section's AI Coder: the
  // made build starts in the Builds tab's embedded player (BuildsTab
  // listens for the same event / consumes the pending slot itself).
  // The jump slot covers the post-reload first-open race — the event
  // fired before this section ever mounted.
  React.useEffect(() => {
    const onPlay = () => selectTab("builds");
    window.addEventListener("veil:play-made-game", onPlay);
    if (takePendingRobloxJump()) selectTab("builds");
    return () => window.removeEventListener("veil:play-made-game", onPlay);
  }, [selectTab]);

  // Search + Enter launches the first matching title straight into the player.
  const submitSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (!q) return;
    let top = searchResults[0];
    if (!top) {
      // No match yet — search BOTH full catalogs immediately (skips the
      // debounce), then launch the best hit.
      const enc = encodeURIComponent(q);
      const [main, stash] = await Promise.allSettled([
        fetch(`/api/arcade?q=${enc}`, { cache: "no-store" }).then(async (res) => {
          const data = (await res.json()) as ArcadeResponse;
          if (res.ok && Array.isArray(data.items)) return data.items;
          return [];
        }),
        fetch(`/api/arcade/stash?q=${enc}`, { cache: "no-store" }).then(async (res) => {
          const data = (await res.json()) as ArcadeResponse;
          if (res.ok && Array.isArray(data.items)) return data.items;
          return [];
        }),
      ]);
      const mainItems = main.status === "fulfilled" ? main.value : [];
      const stashItems = stash.status === "fulfilled" ? stash.value : [];
      if (mainItems.length > 0) setRemoteResults(mainItems);
      if (stashItems.length > 0) setStashResults(stashItems);
      top = mainItems[0] ?? stashItems[0];
    }
    if (top) {
      launchTitle(top);
      searchRef.current?.blur();
    }
  };

  // ----- keyboard: "/" focuses the search bar (xylora-style quick search) -----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ----- keyboard: CAPTURE-phase so the arcade's Esc beats app-level -----
  React.useEffect(() => {
    if (!title) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

      if (e.key === "Escape") {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        if (typing) {
          // Esc while typing in search just clears/blurs the input.
          if (el === searchRef.current) {
            setQuery("");
            searchRef.current?.blur();
          }
          return;
        }
        // While OS-fullscreen, let the browser's Esc exit fullscreen first.
        if (document.fullscreenElement) return;
        // 1st Esc tucks the running title away; 2nd Esc closes the arcade.
        if (arcadeVisible) setArcadeVisible(false);
        else onBack();
        return;
      }

      if ((e.key === "f" || e.key === "F") && !typing && arcadeVisible) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        void toggleArcadeFullscreen();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [title, arcadeVisible, onBack, toggleArcadeFullscreen]);

  // Wallpaper backdrop rule: visible while BROWSING the selecting menus
  // (catalog + math + stash), hidden the moment a title is actually
  // running (the player layer is opaque anyway — this fades the header wash
  // too).
  const playing = Boolean(title) && arcadeVisible;
  const showBackdrop = !playing;

  return (
    <div
      role="region"
      aria-label="Veil Arcade"
      className="relative flex h-full w-full flex-col overflow-hidden text-zinc-100"
    >
      {/* Backdrop — a deep green static base, with the applied Veil wallpaper
          (+ xylora-style dark overlay) layered on top while browsing catalogs.
          Clipped by overflow-hidden so it can never extend the scroll height.
          The base uses an inline style: multi-layer gradient arbitrary values
          are unreliable in Tailwind's class extractor. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(70rem 40rem at 18% -10%, rgba(63,127,99,0.16), transparent 60%), radial-gradient(50rem 30rem at 96% 8%, rgba(31,79,60,0.14), transparent 60%), radial-gradient(70rem 44rem at 50% 118%, rgba(95,174,135,0.08), transparent 60%), #070c0a",
          }}
        />
        <ArcadeBackdropLayer visible={showBackdrop} />
      </div>

      {/* ---------------- persistent top bar (never unmounts) ---------------- */}
      {/* xylora study format: transparent header straight over the wallpaper */}
      {/* + dark overlay — centered lowercase logo, tabs+search bar, meta.   */}
      <header className="relative z-20 shrink-0">
        {/* Row 1: identity — xylora-style centered logo + sub */}
        <div className="relative px-4 pb-1 pt-5 sm:pt-6">
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            aria-label="Close the arcade"
            className="veil-hover-bounce absolute left-4 top-5 h-8 gap-1.5 rounded-xl border-[#253830]/80 bg-[#0d1612]/70 px-2.5 text-[#88a49a] backdrop-blur-md hover:border-[#3f7f63] hover:bg-[#12231b] hover:text-[#5fae87] sm:px-3"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <div className="select-none text-center">
            <h1 className="veil-text-rainbow text-[30px] font-bold lowercase leading-none tracking-[-1px] text-[#e8f2ee] [text-shadow:0_2px_24px_rgba(0,0,0,0.6)] sm:text-[38px]">
              veil <em className="not-italic text-[#5fae87]">arcade</em>
            </h1>
            <p className="mt-2 text-[11px] lowercase tracking-[0.1em] text-[#88a49a] [text-shadow:0_1px_10px_rgba(0,0,0,0.6)]">
              the game library — titles, math, the stash &amp; your builds, play instantly
            </p>
          </div>
          <div className="absolute right-4 top-5">
            <KeyboardHelp
              trigger={
                <button
                  type="button"
                  aria-label="Keyboard shortcuts"
                  className="veil-press flex h-8 w-8 items-center justify-center rounded-xl border border-[#253830]/80 bg-[#0d1612]/70 text-[13px] font-semibold text-[#88a49a] backdrop-blur-md transition hover:border-[#3f7f63] hover:text-[#5fae87] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5fae87]/50"
                >
                  ?
                </button>
              }
            />
          </div>
        </div>

        {/* Row 2: the study bar — section tabs + search in one line
            (xylora-style: tabs left, search fills the rest; stacks on mobile) */}
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-2.5 px-4 pt-4 sm:flex-row sm:items-center sm:gap-2.5 sm:px-6">
          <div
            role="tablist"
            aria-label="Arcade sections"
            className="flex flex-wrap items-center gap-1.5"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`arcade-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`arcade-panel-${t.id}`}
                onClick={() => selectTab(t.id)}
                className={cn(
                  "veil-press flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-semibold lowercase transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5fae87]/50 active:scale-[0.97] sm:px-[22px] sm:py-3",
                  tab === t.id
                    ? "border-[#3f7f63] bg-[#3f7f63] text-white shadow-[0_4px_20px_rgba(63,127,99,0.35)]"
                    : "border-[#253830] bg-[#0d1612]/90 text-[#88a49a] hover:border-[#3f7f63] hover:bg-[#3f7f63]/[0.08] hover:text-[#5fae87]"
                )}
              >
                <t.icon aria-hidden className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>
          <form role="search" onSubmit={(e) => void submitSearch(e)} className="min-w-0 flex-1">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#526a60]"
              />
              <Input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={SEARCH_PLACEHOLDER}
                aria-label="Search titles — Enter plays the top match"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                className="veil-focus-bloom h-[46px] rounded-xl border-[#253830] bg-[#0d1612]/90 pl-11 pr-10 text-[14px] lowercase text-zinc-100 shadow-xl shadow-black/30 placeholder:text-[#526a60] focus-visible:border-[#3f7f63] focus-visible:ring-[3px] focus-visible:ring-[rgba(63,127,99,0.18)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-lg text-[#526a60] transition hover:bg-[#1a2822] hover:text-zinc-200"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Row 3: meta — the count line beneath the bar (xylora-style) */}
        <div className="mx-auto w-full max-w-[1200px] px-4 pb-3.5 pt-3.5 sm:px-6">
          <p className="text-[11px] tracking-[0.04em] text-[#526a60]">
            {tab === "gnmath" ? (
              initialLoading ? (
                "loading the catalog…"
              ) : catalogError ? (
                "the catalog is unreachable — scroll down to retry"
              ) : (
                <>
                  <span className="font-semibold text-[#5fae87]">{total.toLocaleString()}</span>{" "}
                  titles available
                  {hot.length > 0 && (
                    <>
                      {" · "}
                      <span className="font-semibold text-[#5fae87]">{hot.length}</span> featured
                    </>
                  )}
                  {favList.length > 0 && (
                    <>
                      {" · "}
                      <span className="font-semibold text-[#5fae87]">{favList.length}</span>{" "}
                      favorites
                    </>
                  )}
                </>
              )
            ) : tab === "math" ? (
              <>
                veil math — the number rush · sprint / survival / zen ·{" "}
                <span className="font-semibold text-[#5fae87]">streaks, levels, bests</span>
              </>
            ) : tab === "builds" ? (
              <>
                <span className="font-semibold text-[#5fae87]">my builds</span> — games &amp; apps
                the AI Coder wrote · replay any time, right here
              </>
            ) : (
              "the collection — 2,000+ single-file titles, plays in-frame"
            )}
          </p>
        </div>
      </header>

      {/* ---------------- content region: catalogs + title player ---------------- */}
      <div className="relative z-10 min-h-0 flex-1">
        {/* GN-Math catalog (kept mounted; hidden when inactive) */}
        <div
          role="tabpanel"
          id="arcade-panel-gnmath"
          aria-labelledby="arcade-tab-gnmath"
          className={cn(
            "veil-scroll-slim absolute inset-0 overflow-y-auto px-4 pb-20 pt-4 sm:px-6",
            tab === "gnmath" ? "block" : "hidden"
          )}
        >
          {/* xylora study content: max-width column, grid, nothing else */}
          <div className="mx-auto w-full max-w-[1200px]">
            {query.trim() ? (
              <SearchView
                query={query.trim()}
                results={searchResults}
                loading={remoteLoading}
                stashLoading={stashLoading}
                onLaunch={launchTitle}
                favoriteIds={favIds}
                hotIds={hotIds}
                onToggleFavorite={toggleFavorite}
              />
            ) : initialLoading ? (
              <SkeletonGrid count={24} />
            ) : catalogError ? (
              <CatalogErrorCard onRetry={() => void loadInitial()} />
            ) : (
              <>
                {/* The website's own catalog controls, mirrored: sort
                    (ID (Date) / Name) + the `special` tag filter. */}
                <div className="mb-6 flex flex-wrap items-center gap-2.5">
                  <label
                    htmlFor="arcade-sort"
                    className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#526a60]"
                  >
                    sort
                  </label>
                  <select
                    id="arcade-sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value === "name" ? "name" : "id")}
                    className="veil-press h-9 cursor-pointer rounded-xl border border-[#253830] bg-[#0d1612]/90 px-3 text-[12.5px] font-medium text-[#88a49a] shadow-sm shadow-black/30 outline-none backdrop-blur-md transition hover:border-[#3f7f63] hover:text-[#5fae87] focus-visible:border-[#3f7f63]"
                  >
                    <option value="id">ID (Date)</option>
                    <option value="name">Name</option>
                  </select>
                  <span aria-hidden className="h-4 w-px bg-[#1a2822]" />
                  <label
                    htmlFor="arcade-tag"
                    className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#526a60]"
                  >
                    tag
                  </label>
                  <select
                    id="arcade-tag"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    className="veil-press h-9 cursor-pointer rounded-xl border border-[#253830] bg-[#0d1612]/90 px-3 text-[12.5px] font-medium text-[#88a49a] shadow-sm shadow-black/30 outline-none backdrop-blur-md transition hover:border-[#3f7f63] hover:text-[#5fae87] focus-visible:border-[#3f7f63]"
                  >
                    <option value="">all</option>
                    {tagList.map((t) => (
                      <option key={t} value={t}>
                        {t
                          .split(" ")
                          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                          .join(" ")}
                      </option>
                    ))}
                  </select>
                  {(tag || sort !== "id") && (
                    <button
                      type="button"
                      onClick={() => {
                        setTag("");
                        setSort("id");
                      }}
                      className="veil-press flex h-9 items-center gap-1.5 rounded-xl border border-[#253830] bg-[#0d1612]/90 px-3 text-[12px] font-medium text-[#88a49a] shadow-sm shadow-black/30 backdrop-blur-md transition hover:border-[#3f7f63] hover:text-[#5fae87]"
                    >
                      <RotateCw aria-hidden className="h-3 w-3" />
                      reset
                    </button>
                  )}
                </div>

                {/* Featured Zones — the website's first block (featured
                    flag + the pinned discord card), hidden while a tag
                    filter is active exactly like the site collapsing the
                    section. */}
                {!tag && hot.length > 0 && (
                  <section aria-label="Featured zones" className="mb-8">
                    <div className="mb-4 flex items-center gap-3">
                      <h2 className="shrink-0 text-[15px] font-bold lowercase tracking-tight text-[#e8f2ee]">
                        featured zones{" "}
                        <span className="font-semibold text-[#526a60]">({hot.length})</span>
                      </h2>
                      <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-[#1a2822] to-transparent" />
                    </div>
                    {/* No per-card flame badges here — every card in this
                        section is featured by definition (the website shows
                        no badges on its featured row either). */}
                    <CatalogGrid
                      titles={hot}
                      onLaunch={launchTitle}
                      favoriteIds={favIds}
                      onToggleFavorite={toggleFavorite}
                    />
                  </section>
                )}

                {/* All Zones — the website's second block: every title in
                    the catalog, infinite-scroll fed. */}
                <section aria-label="All zones">
                  <div className="mb-4 flex items-center gap-3">
                    <h2 className="shrink-0 text-[15px] font-bold lowercase tracking-tight text-[#e8f2ee]">
                      all zones <span className="font-semibold text-[#526a60]">({total})</span>
                    </h2>
                    <span aria-hidden className="h-px flex-1 bg-gradient-to-r from-[#1a2822] to-transparent" />
                  </div>
                  <CatalogGrid
                    titles={titles}
                    onLaunch={launchTitle}
                    favoriteIds={favIds}
                    hotIds={hotIds}
                    onToggleFavorite={toggleFavorite}
                  />
                  {/* Veil twist on xylora's endless grid: the next page loads
                      itself as you approach the bottom — no button, just cards. */}
                  {hasMore && (
                    <>
                      <div ref={attachSentinel} aria-hidden className="h-2" />
                      {loadingMore && (
                        <div className="mt-3">
                          <SkeletonGrid count={6} />
                        </div>
                      )}
                    </>
                  )}
                  {!hasMore && titles.length > 24 && (
                    <p className="mt-10 text-center text-[11px] tracking-[0.04em] text-[#526a60]">
                      — that’s the whole catalog · {total.toLocaleString()} titles —
                    </p>
                  )}
                </section>
              </>
            )}
          </div>
        </div>

        {/* Veil Math — the built-in number rush (native React, no
            iframe): sprint, survival and zen modes with streaks,
            difficulty tiers and per-mode bests. Always mounted, hidden
            when inactive — a run in progress survives tab switches. */}
        <div
          role="tabpanel"
          id="arcade-panel-math"
          aria-labelledby="arcade-tab-math"
          className={cn(
            "veil-scroll-slim absolute inset-0 overflow-y-auto px-4 pb-20 pt-4 sm:px-6",
            tab === "math" ? "block" : "hidden",
          )}
        >
          <MathGame active={tab === "math"} />
        </div>

        {/* The Stash — fills the remaining panel height so the title player
            (and its bottom-right fullscreen button) are always on-screen */}
        <div
          role="tabpanel"
          id="arcade-panel-stash"
          aria-labelledby="arcade-tab-stash"
          className={cn("absolute inset-0 overflow-hidden", tab === "stash" ? "block" : "hidden")}
        >
          <StashTab />
        </div>

        {/* My Builds — the AI Coder home: every build Veil AI ever wrote
            for this browser, replayable in the embedded in-tab player. */}
        <div
          role="tabpanel"
          id="arcade-panel-builds"
          aria-labelledby="arcade-tab-builds"
          className={cn("absolute inset-0 p-3 sm:p-4", tab === "builds" ? "block" : "hidden")}
        >
          <BuildsTab active={tab === "builds"} />
        </div>

        {/* ---------------- title player layer (below the top bar) ---------------- */}
        <AnimatePresence>
          {title && (
            <motion.div
              key="arcade-player"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              role="region"
              aria-label={`Now playing: ${title.name}`}
              className={cn(
                "absolute inset-0 z-30 flex-col bg-zinc-950",
                arcadeVisible ? "flex" : "hidden"
              )}
            >
              {/* Status bar */}
              <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-zinc-800/80 bg-zinc-950/90 px-3 py-2 backdrop-blur-xl sm:px-4">
                <span aria-hidden className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                  <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                <span className="max-w-[28vw] truncate text-[13px] font-semibold text-zinc-100 sm:max-w-[240px]">
                  {title.name}
                </span>
                <Badge className="veil-text-breathe shrink-0 rounded-full border-emerald-500/30 bg-emerald-500/15 px-2 text-[10.5px] font-medium uppercase tracking-wider text-emerald-300">
                  Playing
                </Badge>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => setArcadeVisible(false)}
                    aria-label="Back to arcade — the title keeps running"
                    className="veil-press h-8 gap-1.5 rounded-lg border-zinc-800 bg-zinc-900/70 px-2.5 text-[12px] font-medium text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:text-emerald-200 sm:px-3"
                  >
                    <LayoutGrid aria-hidden className="h-3.5 w-3.5" />
                    Back to arcade
                  </Button>
                  <Button
                    size="sm"
                    onClick={reloadTitle}
                    aria-label={`Reload ${title.name}`}
                    className="veil-press h-8 gap-1.5 rounded-lg border-zinc-800 bg-zinc-900/70 px-2.5 text-[12px] font-medium text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:text-emerald-200 sm:px-3"
                  >
                    <RotateCw aria-hidden className="h-3.5 w-3.5" />
                    Reload
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void toggleArcadeFullscreen()}
                    aria-label={
                      isArcadeFullscreen ? "Exit fullscreen for the title" : "Fullscreen for the title"
                    }
                    className="veil-press h-8 gap-1.5 rounded-lg border-zinc-800 bg-zinc-900/70 px-2.5 text-[12px] font-medium text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:text-emerald-200 sm:px-3"
                  >
                    {isArcadeFullscreen ? (
                      <Minimize aria-hidden className="h-3.5 w-3.5" />
                    ) : (
                      <Maximize aria-hidden className="h-3.5 w-3.5" />
                    )}
                    Fullscreen
                  </Button>
                  {/* Browser-tab escape hatch for the running title. */}
                  <Button
                    size="sm"
                    onClick={() => onLaunch(title.url, title.name)}
                    aria-label="Open in a full browser tab"
                    className="veil-press h-8 gap-1.5 rounded-lg border-zinc-800 bg-zinc-900/70 px-2.5 text-[12px] font-medium text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:text-emerald-200 sm:px-3"
                  >
                    <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">Open in a full browser tab</span>
                    <span className="md:hidden">Browser tab</span>
                  </Button>
                  <Button
                    size="sm"
                    onClick={stopTitle}
                    aria-label={`Stop ${title.name}`}
                    className="veil-press h-8 gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 text-[12px] font-medium text-red-300 hover:border-red-400/40 hover:bg-red-500/20 hover:text-red-200 sm:px-3"
                  >
                    <Square aria-hidden className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                </div>
              </div>

              {/* Title viewport — the wrapper is the OS-fullscreen target (F key). */}
              <div ref={arcadeAreaRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
                <iframe
                  key={`${title.key}-${title.reloads}`}
                  ref={arcadeFrameRef}
                  src={routeUrl(title.url)}
                  title={title.name}
                  className="absolute inset-0 h-full w-full border-0 bg-black"
                  allow="fullscreen; autoplay; clipboard-read; clipboard-write; gamepad"
                  referrerPolicy="no-referrer"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ---------------- resume pill (title tucked away but still running) ---------------- */}
      <AnimatePresence>
        {title && !arcadeVisible && (
          <motion.div
            key="resume-pill"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 18 }}
            transition={{ duration: 0.25 }}
            className="absolute bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-zinc-900/90 p-1.5 pl-4 shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            <button
              type="button"
              onClick={() => setArcadeVisible(true)}
              aria-label={`Resume ${title.name} — still running`}
              className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
            >
              <span
                aria-hidden
                className="relative flex h-2 w-2 shrink-0 items-center justify-center"
              >
                <span className="absolute h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              <span className="truncate text-[13px] text-zinc-300">
                Resume <span className="font-semibold text-emerald-300">{title.name}</span> — still
                running
              </span>
            </button>
            <button
              type="button"
              onClick={stopTitle}
              aria-label={`Stop ${title.name}`}
              className="veil-press flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-red-500/15 hover:text-red-300"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
