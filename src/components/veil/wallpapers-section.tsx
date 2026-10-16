"use client";

/**
 * Veil Wallpapers — the wallpaper gallery.
 *
 * Three sources behind a segmented control:
 *
 *  - "My Pack": the built-in wallpaper pack + procedural animated live
 *    wallpapers, as a masonry grid of thumbnail cards (live videos
 *    preview on hover; animated themes render as mini CSS backdrops).
 *
 *  - "Live": a live browser of motionbgs.com's public catalog (tag feeds,
 *    4K/mobile feeds, search, via /api/wallpapers/live) with a Shuffle
 *    button that applies a random wallpaper instantly. Videos stream
 *    through the veil's curl-backed disk cache.
 *
 *  - "4K Catalog": a live browser of 4kwallpapers.com's public catalog
 *    (curated + category feeds + search, via /api/wallpapers). Picking a
 *    wallpaper opens a lightbox that resolves its downloadable resolutions
 *    (/api/wallpapers/detail) and applies the best 4K file with one click.
 *
 * The parent renders this section inside a fixed inset-0 overlay, so the
 * root only needs h-full w-full with an internal scroll area.
 */

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Check,
  Dices,
  Download,
  Globe,
  Heart,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  MonitorPlay,
  Package,
  Play,
  Search,
  SearchX,
  Sparkles,
  TriangleAlert,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { routeUrl, fetchJsonSafe } from "@/lib/veil/shared";
import { OfflineDownload } from "@/components/veil/offline-download";
import {
  ANIMATED_THEMES,
  UPLOADED_PACK,
  WALLPAPER_FILTERS,
  fullPack,
  isLocalAsset,
  libraryHas,
  loadWallpaperSelection,
  previewVideoSrcFor,
  readFavoriteIds,
  removeFromLibrary,
  renderSrc,
  saveWallpaperData,
  saveWallpaperSelection,
  saveToLibrary,
  motionbgsPoster,
  toggleWallpaperFavorite,
  type VeilWallpaper,
  type WallpaperSelection,
} from "@/lib/veil/wallpapers";

/* ------------------------------------------------------------------ */
/* DTOs (server API shapes)                                            */
/* ------------------------------------------------------------------ */

interface LiveItemDTO {
  id: number;
  name: string;
  slug: string;
  thumb: string;
  video: string;
}

interface CatalogItemDTO {
  id: number;
  name: string;
  slug: string;
  category: string;
  thumb: string;
  detail: string;
}

interface LiveResponse {
  items: LiveItemDTO[];
  page: number;
  hasMore: boolean;
  category: string;
  error?: string;
}

interface CatalogResponse {
  items: CatalogItemDTO[];
  page: number;
  hasMore: boolean;
  category: string;
  error?: string;
}

interface DetailResponse {
  ok: boolean;
  name?: string;
  resolutions: { w: number; h: number; url: string }[];
  best: { w: number; h: number; url: string } | null;
  error?: string;
}

const SKELETON_COUNT = 8;

const LIVE_CATEGORIES: { id: string; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "anime", label: "Anime" },
  { id: "superhero", label: "Superhero" },
  { id: "nature", label: "Nature" },
  { id: "scifi", label: "Sci-Fi" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "space", label: "Space" },
  { id: "dark", label: "Dark" },
  { id: "city", label: "City" },
  { id: "aesthetic", label: "Aesthetic" },
  { id: "animals", label: "Animals" },
  { id: "fantasy", label: "Fantasy" },
  { id: "horror", label: "Horror" },
  { id: "minimal", label: "Minimal" },
  { id: "cars", label: "Cars" },
  { id: "neon", label: "Neon" },
  { id: "4k", label: "4K" },
  { id: "mobile", label: "Mobile" },
];

const CATALOG_CATEGORIES: { id: string; label: string }[] = [
  { id: "recent", label: "Curated" },
  { id: "nature", label: "Nature" },
  { id: "anime", label: "Anime" },
  { id: "abstract", label: "Abstract" },
  { id: "cars", label: "Cars" },
  { id: "minimal", label: "Minimal" },
  { id: "dark", label: "Dark" },
  { id: "fantasy", label: "Fantasy" },
  { id: "space", label: "Space" },
  { id: "aesthetic", label: "Aesthetic" },
  { id: "animals", label: "Animals" },
  { id: "architecture", label: "Architecture" },
  { id: "flowers", label: "Flowers" },
  { id: "movies", label: "Movies" },
  { id: "music", label: "Music" },
  { id: "cute", label: "Cute" },
];

/* ------------------------------------------------------------------ */
/* My-pack card                                                        */
/* ------------------------------------------------------------------ */

const MINI_THEMES: Record<string, string> = {
  sulfur: "from-amber-400/70 to-orange-600/60",
  emerald: "from-emerald-400/70 to-teal-600/60",
  aurora: "from-emerald-400/60 to-indigo-500/60",
  nebula: "from-violet-400/70 to-fuchsia-600/60",
  grid: "from-fuchsia-500/60 to-cyan-400/60",
  sunset: "from-orange-400/70 to-rose-600/60",
  ocean: "from-sky-400/70 to-teal-400/60",
  ash: "from-zinc-400/60 to-red-500/40",
  mono: "from-zinc-300/60 to-zinc-600/60",
};

function PackCard({
  wp,
  applied,
  favorite,
  onToggleFavorite,
  onOpen,
  index,
  onDelete,
}: {
  wp: VeilWallpaper;
  applied: boolean;
  favorite: boolean;
  onToggleFavorite: (id: string) => void;
  onOpen: (wp: VeilWallpaper) => void;
  index: number;
  /** Present for the owner's own uploads — renders the delete control. */
  onDelete?: (id: string) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  // motionbgs thumb names are inconsistent on their CDN (most carry a
  // .3840x2160.jpg suffix, some are plain .jpg) — fall back one step.
  const [posterStage, setPosterStage] = React.useState(0);
  // A second, delayed self-heal round: after both thumb names have failed,
  // remount the stage-0 poster once after 3s. Cold motionbgs thumbs fail
  // transiently (Cloudflare roulette — the server retries and commits
  // within seconds), so the delayed re-request hits the warm cache and
  // paints. Only a genuinely dead poster falls through to the video /
  // icon fallbacks.
  const [posterRound, setPosterRound] = React.useState(0);
  const healTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (healTimer.current) clearTimeout(healTimer.current);
    },
    []
  );
  const reduceMotion = useReducedMotion();
  // The hover preview always plays a PREVIEW-quality file: the 720p local
  // sibling (/wp-prev/) or the 1080p motionbgs variant (?vw=1080). It
  // NEVER falls back to the full original — a hover is not permission to
  // start a 4K download (that fallback was the landmine that filled the
  // browser's connection budget and froze the page).
  const hoverPreviewSrc =
    wp.kind === "video" ? (previewVideoSrcFor(wp.src) ?? assetSrc(wp.src)) : null;

  // Poster: a saved thumb when we have one, else the motionbgs catalog
  // image derived from the video URL. Never the extension-less video path
  // itself — that 403s at their CDN. renderSrc keeps stale absolute thumbs
  // same-origin (a direct motionbgs image fetch is bot-walled too).
  const basePoster =
    renderSrc(wp.thumb) ??
    (wp.kind === "video" ? motionbgsPoster(wp.src) : null) ??
    assetSrc(wp.src);

  // Reset the image state when the wallpaper OR its poster URL changes —
  // the injected "currently applied" entry can swap its thumb under the
  // same id (healed storage, re-apply), and a stale `failed` flag used to
  // wedge the card on the dead-icon fallback even with a healthy poster.
  React.useEffect(() => {
    if (healTimer.current) clearTimeout(healTimer.current);
    setLoaded(false);
    setFailed(false);
    setPosterStage(0);
    setPosterRound(0);
  }, [wp.id, basePoster]);

  // Pre-warm the server-side curl cache for routed videos (the injected
  // active live wallpaper) so hover previews and lightbox opens start
  // almost instantly instead of stalling on a cold download. The server
  // answers warm-up HEADs immediately (download continues in the
  // background); the abort signal is a client-side backstop so a
  // misbehaving server can never wedge a browser connection.
  React.useEffect(() => {
    if (wp.kind !== "video" || !wp.src || isLocalAsset(wp.src)) return;
    void fetch(assetSrc(wp.src), {
      method: "HEAD",
      signal: AbortSignal.timeout(4000),
    }).catch(() => {});
  }, [wp.kind, wp.src]);

  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    []
  );
  const startPreview = React.useCallback(() => {
    if (reduceMotion) return;
    // Settings › Appearance can disable hover previews outright (the
    // "Hover previews" row) — the setting is read live per hover.
    try {
      if (window.localStorage.getItem("veil:hover-previews") === "0") return;
    } catch {
      /* private mode — previews on */
    }
    // Poster-failed cards keep their metadata video as the card visual —
    // animate that one on hover too.
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPreviewing(true), 450);
    void videoRef.current?.play().catch(() => {});
  }, [reduceMotion]);

  const stopPreview = React.useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    // Unmounting aborts any in-flight fetch and frees the pipeline —
    // a fast sweep across the grid never holds a connection.
    videoRef.current?.pause();
    setPreviewing(false);
  }, []);

  const posterUrl =
    posterStage === 1 ? basePoster.replace(/\.3840x2160\.jpg$/, ".jpg") : basePoster;
  const handlePosterError = () => {
    if (posterStage === 0 && /\.3840x2160\.jpg$/.test(basePoster)) {
      setPosterStage(1); // retry the plain-jpg thumb name
      return;
    }
    if (posterRound < 1) {
      // Both names failed — but the server-side retry chain may still be
      // committing the file. One delayed round back to stage 0 (the <img>
      // key remounts it, forcing a fresh request against the warm cache).
      healTimer.current = setTimeout(() => {
        setPosterRound((r) => r + 1);
        setPosterStage(0);
      }, 3000);
      return;
    }
    setFailed(true);
  };

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-30px" }}
      transition={{ duration: 0.3, delay: Math.min((index % 24) * 0.02, 0.2) }}
      className="veil-cv"
    >
      <button
        type="button"
        onClick={() => {
          // Free the hover preview's pipeline the moment the popup opens —
          // the dialog overlay swallows mouseleave, so the video would
          // otherwise keep decoding underneath it.
          stopPreview();
          onOpen(wp);
        }}
        onMouseEnter={startPreview}
        onMouseLeave={stopPreview}
        onFocus={startPreview}
        onBlur={stopPreview}
        aria-label={`Preview ${wp.name}${wp.kind === "video" ? " (live wallpaper)" : ""}`}
        className={cn(
          "veil-hover-tilt group relative block w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900 text-left outline-none transition-all duration-200 hover:-translate-y-1 hover:border-emerald-500/60 hover:shadow-[0_18px_42px_-14px_rgba(16,185,129,0.45)] focus-visible:ring-2 focus-visible:ring-emerald-500/70",
          applied && "veil-border-dance"
        )}
      >
        <div className="relative aspect-video w-full overflow-hidden">
          {wp.kind === "animated" ? (
            <div
              aria-hidden
              className={`size-full bg-gradient-to-br ${MINI_THEMES[wp.theme ?? "emerald"] ?? MINI_THEMES.emerald} transition-transform duration-500 group-hover:scale-[1.04]`}
            >
              <div className="veil-orb-a size-full rounded-none bg-white/10 blur-2xl" />
            </div>
          ) : failed ? (
            wp.kind === "video" && wp.src ? (
              // Poster dead (CDN thumb-name roulette) — let the video itself
              // paint the card: metadata preload draws the first frame, and
              // hover still plays the live preview through the same element.
              <video
                ref={videoRef}
                src={assetSrc(wp.src)}
                preload="metadata"
                muted
                loop
                playsInline
                aria-hidden
                className="size-full object-cover"
              />
            ) : (
              <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-950 text-zinc-600">
                <ImageIcon className="size-7" aria-hidden />
              </div>
            )
          ) : (
            <>
              <img
                key={`${posterRound}-${posterStage}`}
                src={posterUrl}
                alt=""
                loading={index < 8 ? "eager" : "lazy"}
                decoding="async"
                onError={handlePosterError}
                onLoad={() => setLoaded(true)}
                className={cn(
                  "size-full object-cover transition-all duration-500 group-hover:scale-[1.04]",
                  loaded ? "opacity-100" : "opacity-0"
                )}
              />
              {wp.kind === "video" && previewing && hoverPreviewSrc && (
                <video
                  src={hoverPreviewSrc}
                  poster={posterUrl}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="auto"
                  aria-hidden
                  onError={() => {
                    // Preview-quality file unavailable → quietly keep the
                    // poster. Never retry at full quality from a hover —
                    // the lightbox (an intentional click) may do that.
                    setPreviewing(false);
                  }}
                  className={cn(
                    "absolute inset-0 size-full object-cover transition-opacity duration-300",
                    previewing ? "opacity-100" : "opacity-0"
                  )}
                />
              )}
            </>
          )}
          {/* Loading shimmer while the poster streams in. NOTE: there is
              deliberately NO gradient underlay above the <img> — a prior
              absolutely-positioned "neutral underlay" painted OVER the
              in-flow poster image (positioned elements stack above in-flow
              content), which is exactly why live wallpapers showed plain
              dark cards instead of their thumbnails. */}
          {!loaded && !failed && (
            <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800/80 to-zinc-900/60" />
          )}
          {/* ♥ favorite toggle — a span (not a nested button) so the card
              stays valid HTML; visible on hover on desktop, always on touch */}
          <span
            role="button"
            tabIndex={0}
            aria-pressed={favorite}
            aria-label={
              favorite
                ? `Remove ${wp.name} from favorites`
                : `Add ${wp.name} to favorites`
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(wp.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onToggleFavorite(wp.id);
              }
            }}
            className={cn(
              "veil-hover-bounce veil-press absolute right-2.5 top-2.5 z-20 flex size-8 items-center justify-center rounded-full border backdrop-blur-md transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/70",
              favorite
                ? "border-rose-400/50 bg-rose-500/25 text-rose-300 opacity-100"
                : "border-zinc-700/60 bg-zinc-950/60 text-zinc-300 opacity-70 hover:border-rose-400/40 hover:text-rose-300 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
            )}
          >
            <Heart
              aria-hidden
              className={cn(
                "size-4 transition-transform duration-200",
                favorite && "fill-rose-400 text-rose-400 scale-110"
              )}
            />
          </span>
          {onDelete && (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Delete ${wp.name} from My pack`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(wp.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(wp.id);
                }
              }}
              className="veil-press absolute right-2.5 top-12 z-20 flex size-8 items-center justify-center rounded-full border border-zinc-700/60 bg-zinc-950/60 text-zinc-300 backdrop-blur-md transition-all duration-200 hover:border-red-400/50 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
            >
              <Trash2 aria-hidden className="size-4" />
            </span>
          )}
        </div>

        <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
          {(wp.kind === "video" || wp.kind === "animated") && (
            <span className="flex items-center gap-1 rounded-full border border-emerald-400/30 bg-zinc-950/75 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 backdrop-blur-sm">
              <Video className="size-2.5" aria-hidden />
              Live
            </span>
          )}
          {wp.tags.includes("uploaded") && (
            <span className="flex items-center gap-1 rounded-full border border-violet-400/40 bg-zinc-950/75 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-300 backdrop-blur-sm">
              <Upload className="size-2.5" aria-hidden />
              Mine
            </span>
          )}
          {wp.tags.includes("saved") && (
            <span className="flex items-center gap-1 rounded-full border border-rose-400/40 bg-zinc-950/75 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-300 backdrop-blur-sm">
              <Heart aria-hidden className="size-2.5 fill-rose-400 text-rose-400" />
              Saved
            </span>
          )}
          {applied && (
            <span className="flex items-center gap-1 rounded-full border border-teal-400/40 bg-teal-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-200 backdrop-blur-sm">
              <Check className="size-3" aria-hidden />
              Active
            </span>
          )}
        </div>

        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950/90 via-zinc-950/30 to-transparent"
        />
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="truncate text-sm font-semibold leading-tight text-zinc-50 drop-shadow-sm">
            {wp.name}
          </p>
          <p className="mt-0.5 truncate text-[11px] leading-tight text-zinc-400">
            {wp.desc || wp.tags.slice(0, 3).join(" · ")}
          </p>
        </div>
      </button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Pack lightbox                                                       */
/* ------------------------------------------------------------------ */

function PackLightbox({
  wp,
  applied,
  onApply,
  onClose,
}: {
  wp: VeilWallpaper | null;
  applied: boolean;
  onApply: (sel: WallpaperSelection) => void;
  onClose: () => void;
}) {
  const [saved, setSaved] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  // The live video fades in only once it can actually play — until then
  // the poster (the exact thumb the grid card already cached) paints the
  // popup instantly, so it NEVER opens to a stall or a black rectangle.
  const [ready, setReady] = React.useState(false);
  // Preview-quality first (720p sibling / 1080p motionbgs variant), the
  // full-quality original as the automatic error fallback. motionbgs
  // videos (the injected active live card) preview at the 1080p variant —
  // the full 4K decode here was the OOM that froze the page on click.
  const videoSrcs = usePreviewVideoSrc(
    wp?.kind === "video" && wp.src ? assetSrc(wp.src) : "",
    wp?.kind === "video" ? previewVideoSrcFor(wp.src) : null
  );

  React.useEffect(() => {
    setSaved(false);
    setFailed(false);
    setReady(false);
    setRetry(0);
    // Pre-warm the server-side curl cache the moment the preview opens —
    // the popup paints its poster instantly either way.
    if (wp?.kind === "video" && wp.src) {
      void fetch(assetSrc(wp.src), {
        method: "HEAD",
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    }
  }, [wp?.id, wp?.kind, wp?.src]);

  const handleRetry = () => {
    setFailed(false);
    setReady(false);
    setRetry((n) => n + 1);
  };

  const handleApply = () => {
    if (!wp) return;
    setSaved(true);
    onApply({
      id: wp.id,
      src: wp.kind === "animated" ? "" : assetSrc(wp.src),
      kind: wp.kind,
      name: wp.name,
      theme: wp.theme,
      // Poster (catalog jpg for motionbgs videos) so the applied backdrop
      // paints instantly and My-pack cards have real thumbnails.
      thumb:
        renderSrc(wp.thumb) ??
        (wp.kind === "video" ? (motionbgsPoster(wp.src) ?? undefined) : undefined),
    });
  };

  const poster =
    renderSrc(wp?.thumb) ?? (wp?.kind === "video" ? motionbgsPoster(wp?.src) : null);

  return (
    <Dialog open={Boolean(wp)} onOpenChange={(o) => !o && onClose()}>
      {/* The preview panel, exactly as requested: the preview, a smaller
          Download button, an Apply button — nothing else. Poster-first so
          it paints instantly; vh (not dvh) height caps so the popup stays
          visible in every embedding (iframes included); a scrollable
          column so the buttons can never clip off-screen. */}
      <DialogContent className="flex max-h-[92vh] w-[min(94vw,720px)] max-w-[min(94vw,720px)] flex-col gap-0 overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-[min(94vw,720px)]">
        {wp && (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            <div className="flex items-center px-5 pb-3 pr-12 pt-4">
              <DialogTitle className="min-w-0 flex-1 truncate text-left text-[15px] font-semibold text-zinc-100">
                {wp.name}
              </DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              {wp.desc || "From your Veil wallpaper pack."}
            </DialogDescription>

            {/* The preview — the poster paints instantly; the live video
                fades in on top once it can play (muted loop, no native
                controls — same light pipeline as the hover preview). */}
            <div key={wp.id} className="veil-zoom-burst relative mx-5 aspect-video max-h-[52vh] w-[calc(100%-2.5rem)] shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
              {wp.kind === "animated" ? (
                <div className={`size-full bg-gradient-to-br ${MINI_THEMES[wp.theme ?? "emerald"] ?? MINI_THEMES.emerald}`}>
                  <div className="veil-orb-a size-full rounded-none bg-white/10 blur-2xl" />
                </div>
              ) : wp.kind === "video" ? (
                <>
                  {poster && <img src={poster} alt="" className="size-full object-cover" />}
                  {!failed && (
                    <video
                      key={`${wp.id}-${retry}`}
                      src={videoSrcs.src}
                      autoPlay
                      muted
                      loop
                      playsInline
                      preload="auto"
                      onCanPlay={() => setReady(true)}
                      onPlaying={() => setReady(true)}
                      onError={() => {
                        // Preview variant missing → retry at full quality;
                        // only a real failure shows the fallback bar.
                        if (!videoSrcs.handleError()) setFailed(true);
                      }}
                      className={cn(
                        "absolute inset-0 size-full object-cover transition-opacity duration-500",
                        ready ? "opacity-100" : "opacity-0"
                      )}
                    />
                  )}
                  {!failed && !ready && (
                    <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-950/80 px-2 py-0.5 text-[10px] font-medium text-zinc-300 backdrop-blur-sm">
                      <Loader2 className="size-3 animate-spin text-emerald-400" aria-hidden />
                      Loading preview…
                    </div>
                  )}
                  {failed && (
                    <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-zinc-950/85 px-3 py-2 backdrop-blur-sm">
                      <p className="min-w-0 truncate text-[11px] text-zinc-400">
                        Preview unavailable — Download &amp; Apply still work.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRetry}
                        className="veil-press h-7 shrink-0 border-zinc-700 bg-zinc-900 px-2.5 text-[12px] text-zinc-200 hover:border-emerald-500/50 hover:bg-zinc-800 hover:text-emerald-300"
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <img src={assetSrc(wp.src)} alt={wp.name} className="size-full object-cover" />
              )}
            </div>

            {/* Smaller Download + Apply buttons, directly underneath the
                preview — the two actions, nothing else. */}
            <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3">
              {wp.kind !== "animated" && wp.src && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Download ${wp.name}`}
                  onClick={() => downloadWallpaper(assetSrc(wp.src), wp.name)}
                  className="veil-press h-8 gap-1.5 rounded-full px-3 text-[13px] text-zinc-400 transition hover:bg-zinc-800/70 hover:text-emerald-300"
                >
                  <Download aria-hidden className="size-3.5" />
                  Download
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleApply}
                className="veil-hover-glow veil-press h-8 shrink-0 gap-1.5 rounded-full bg-emerald-500 px-4 text-[13px] font-medium text-zinc-950 shadow-lg shadow-emerald-500/25 hover:bg-emerald-400"
              >
                {saved || applied ? (
                  <>
                    <Check className="size-3.5" aria-hidden />
                    Applied
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" aria-hidden />
                    Apply
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* MotionBGs live-wallpaper card — video previews on hover              */
/* ------------------------------------------------------------------ */

function LiveCard({
  item,
  applied,
  onOpen,
  index,
}: {
  item: LiveItemDTO;
  applied: boolean;
  onOpen: (item: LiveItemDTO) => void;
  index: number;
}) {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewPlaying, setPreviewPlaying] = React.useState(false);
  // Cold thumbnails can fail transiently (the curl-backed server retry
  // chain rides out Cloudflare's challenge roulette and commits the file
  // within a couple of seconds). One delayed self-heal round — remount
  // the <img> after 3s so it re-requests the now-warm URL — turns a
  // dead card into a working one without any user action.
  const [thumbRound, setThumbRound] = React.useState(0);
  const healTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (healTimer.current) clearTimeout(healTimer.current);
    },
    []
  );
  const handleThumbError = () => {
    if (thumbRound < 1) {
      healTimer.current = setTimeout(() => setThumbRound((r) => r + 1), 3000);
      return;
    }
    setFailed(true);
  };
  const reduceMotion = useReducedMotion();
  // The hover preview always streams the 1080p variant (¼ the 4K decode
  // memory). It never falls back to the 4K original — a missing variant
  // is the server's job to heal (its fallback chain serves 540p bytes on
  // the same URL), and a hover must never start a full 4K download.
  const hoverPreviewSrc = previewVideoRoute(item.video);

  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    []
  );
  const startPreview = React.useCallback(() => {
    if (reduceMotion) return;
    // Settings › Appearance can disable hover previews outright —
    // read live per hover so the flip applies immediately.
    try {
      if (window.localStorage.getItem("veil:hover-previews") === "0") return;
    } catch {
      /* private mode — previews on */
    }
    // Hover INTENT: the <video> mounts (autoPlay muted) only after the
    // pointer rests ~450ms — at most one media pipeline per grid, and a
    // fast sweep across 57 cards starts zero downloads and holds zero
    // connections. (The always-mounted `preload="none"` videos of an
    // older build OOM-killed the renderer and froze the page.)
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setPreviewing(true), 450);
  }, [reduceMotion]);

  const stopPreview = React.useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    // Unmount aborts the in-flight download and frees the pipeline —
    // a fast sweep across the grid never holds a connection.
    setPreviewing(false);
    setPreviewPlaying(false);
  }, []);

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-30px" }}
      transition={{ duration: 0.3, delay: Math.min((index % 24) * 0.02, 0.2) }}
      className="veil-cv"
    >
      <button
        type="button"
        onClick={() => {
          // Free the hover preview's pipeline the moment the popup opens —
          // the dialog overlay swallows mouseleave, so the video would
          // otherwise keep decoding underneath it.
          stopPreview();
          onOpen(item);
        }}
        onMouseEnter={startPreview}
        onMouseLeave={stopPreview}
        onFocus={startPreview}
        onBlur={stopPreview}
        aria-label={`Preview ${item.name} live wallpaper`}
        className={cn(
          "veil-hover-tilt group relative block w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900 text-left outline-none transition-all duration-200 hover:-translate-y-1 hover:border-emerald-500/60 hover:shadow-[0_18px_42px_-14px_rgba(16,185,129,0.45)] focus-visible:ring-2 focus-visible:ring-emerald-500/70",
          applied && "veil-border-dance"
        )}
      >
        <div className="relative aspect-video w-full overflow-hidden">
          {failed ? (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-950 text-zinc-600">
              <Video className="size-7" aria-hidden />
            </div>
          ) : (
            <>
              <img
                key={thumbRound}
                src={routeUrl(item.thumb)}
                alt={`${item.name} preview`}
                loading={index < 8 ? "eager" : "lazy"}
                decoding="async"
                onLoad={() => setLoaded(true)}
                onError={handleThumbError}
                className={cn(
                  "size-full object-cover transition-all duration-500 group-hover:scale-[1.04]",
                  loaded ? "opacity-100" : "opacity-0"
                )}
              />
              {/* Hover video preview — mounted ONLY while previewing (after
                  hover intent) so a 57-card live grid holds zero media
                  pipelines at rest; the poster thumb underneath paints the
                  card. It streams the 1080p variant (vw hint) through the
                  veil's live-streaming cache — Apply/Download still use 4K. */}
              {previewing && !failed && (
                <video
                  src={hoverPreviewSrc}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="auto"
                  aria-hidden
                  onPlaying={() => setPreviewPlaying(true)}
                  onPause={() => setPreviewPlaying(false)}
                  onError={() => {
                    // Preview-quality stream unavailable → quietly keep the
                    // poster. Never retry the 4K original from a hover.
                    setPreviewing(false);
                    setPreviewPlaying(false);
                  }}
                  className={cn(
                    "absolute inset-0 size-full object-cover transition-opacity duration-300",
                    previewPlaying ? "opacity-100" : "opacity-0"
                  )}
                />
              )}
              {/* Preview buffering hint — a cold video can take a few
                  seconds through the veil; never let the card look dead. */}
              {previewing && !previewPlaying && loaded && !failed && (
                <div className="absolute bottom-14 left-2.5 flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-950/80 px-2 py-0.5 text-[10px] font-medium text-zinc-300 backdrop-blur-sm">
                  <Loader2 className="size-3 animate-spin text-emerald-400" aria-hidden />
                  Loading preview…
                </div>
              )}
            </>
          )}
          {!loaded && !failed && (
            <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800/80 to-zinc-900/60" />
          )}

          <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-full border border-emerald-400/30 bg-zinc-950/75 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300 backdrop-blur-sm">
              <Video className="size-2.5" aria-hidden />
              Live
            </span>
            {applied && (
              <span className="flex items-center gap-1 rounded-full border border-teal-400/40 bg-teal-500/25 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-200 backdrop-blur-sm">
                <Check className="size-3" aria-hidden />
                Active
              </span>
            )}
          </div>

          <div
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-zinc-950/0 opacity-0 transition-all duration-200 group-hover:bg-zinc-950/30 group-hover:opacity-100"
          >
            <span className="veil-hover-bounce veil-press flex size-12 items-center justify-center rounded-full bg-emerald-500 text-zinc-950 shadow-xl shadow-emerald-500/40 transition-transform duration-200 scale-75 group-hover:scale-100">
              <Play className="size-5" aria-hidden />
            </span>
          </div>

          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950/90 via-zinc-950/30 to-transparent"
          />
          <div className="absolute inset-x-0 bottom-0 p-3">
            <p className="truncate text-sm font-semibold leading-tight text-zinc-50 drop-shadow-sm">
              {item.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] leading-tight text-zinc-400">
              motionbgs.com · loops
            </p>
          </div>
        </div>
      </button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* MotionBGs lightbox — full preview + one-click apply                  */
/* ------------------------------------------------------------------ */

function LiveLightbox({
  item,
  applied,
  saved,
  onApply,
  onToggleSave,
  onClose,
}: {
  item: LiveItemDTO | null;
  applied: boolean;
  saved: boolean;
  onApply: (sel: WallpaperSelection) => void;
  onToggleSave: (sel: WallpaperSelection) => void;
  onClose: () => void;
}) {
  // "Applied!" flash on the Apply button (library save-state arrives via
  // the `saved` prop instead).
  const [justApplied, setJustApplied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [retry, setRetry] = React.useState(0);
  // The poster (the exact thumb the grid card already cached) paints the
  // popup instantly; the live video fades in on top once it can play —
  // muted loop, no native controls, same light pipeline as the hover
  // preview. The popup therefore always opens instantly and can never
  // stall on a cold video download.
  const [ready, setReady] = React.useState(false);
  // The preview always streams the 1080p variant through the veil's
  // live-streaming disk cache (a quarter of the 4K decode memory). No
  // client-side 4K retry: the server's fallback chain already serves
  // 540p/4K bytes on the SAME vw=1080 URL, so an error here is a real
  // failure — the Download & Apply actions still work at full quality.
  const previewSrc = item ? previewVideoRoute(item.video) : "";

  React.useEffect(() => {
    setJustApplied(false);
    setFailed(false);
    setReady(false);
    setRetry(0);
  }, [item?.id]);

  const handleRetry = () => {
    setFailed(false);
    setReady(false);
    setRetry((n) => n + 1);
  };

  const selection = (): WallpaperSelection => ({
    id: `mbg-${item?.id}`,
    src: routeUrl(item?.video ?? ""),
    kind: "video",
    name: item?.name ?? "",
    // Poster so the saved entry renders with a real thumbnail in My pack.
    thumb: routeUrl(item?.thumb ?? ""),
  });

  const handleApply = () => {
    if (!item) return;
    setJustApplied(true);
    onApply(selection());
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={(o) => !o && onClose()}>
      {/* The preview panel, exactly as requested: the preview, a smaller
          Download button, an Apply button — nothing else. Poster-first so
          it paints instantly; vh (not dvh) height caps so the popup stays
          visible in every embedding (iframes included); a scrollable
          column so the buttons can never clip off-screen. */}
      <DialogContent className="flex max-h-[92vh] w-[min(94vw,720px)] max-w-[min(94vw,720px)] flex-col gap-0 overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-[min(94vw,720px)]">
        {item && (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            <div className="flex items-center px-5 pb-3 pr-12 pt-4">
              <DialogTitle className="min-w-0 flex-1 truncate text-left text-[15px] font-semibold text-zinc-100">
                {item.name}
              </DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              Looping video wallpaper from motionbgs.com.
            </DialogDescription>

            <div key={item.id} className="veil-zoom-burst relative mx-5 aspect-video max-h-[52vh] w-[calc(100%-2.5rem)] shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
              {/* Poster first — the grid card already loaded this exact
                  thumb URL, so the popup paints instantly from cache. */}
              <img src={routeUrl(item.thumb)} alt="" className="size-full object-cover" />
              {!failed && (
                <video
                  key={`${item.id}-${retry}`}
                  src={previewSrc}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="auto"
                  onCanPlay={() => setReady(true)}
                  onPlaying={() => setReady(true)}
                  onError={() => {
                    // Real failure (the server already tried every variant
                    // behind this URL) → the honest fallback bar; Download
                    // & Apply still fetch the full 4K file.
                    setFailed(true);
                  }}
                  className={cn(
                    "absolute inset-0 size-full object-cover transition-opacity duration-500",
                    ready ? "opacity-100" : "opacity-0"
                  )}
                />
              )}
              {!failed && !ready && (
                <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-950/80 px-2 py-0.5 text-[10px] font-medium text-zinc-300 backdrop-blur-sm">
                  <Loader2 className="size-3 animate-spin text-emerald-400" aria-hidden />
                  Loading preview…
                </div>
              )}
              {failed && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-zinc-950/85 px-3 py-2 backdrop-blur-sm">
                  <p className="min-w-0 truncate text-[11px] text-zinc-400">
                    Preview unavailable — Download &amp; Apply still work.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRetry}
                    className="veil-press h-7 shrink-0 border-zinc-700 bg-zinc-900 px-2.5 text-[12px] text-zinc-200 hover:border-emerald-500/50 hover:bg-zinc-800 hover:text-emerald-300"
                  >
                    Try again
                  </Button>
                </div>
              )}
            </div>

            {/* Save to My pack (♥), smaller Download, Apply — the
                actions, nothing else. */}
            <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3">
              <Button
                variant="ghost"
                size="sm"
                aria-label={saved ? `Remove ${item.name} from My pack` : `Save ${item.name} to My pack`}
                onClick={() => onToggleSave(selection())}
                className={cn(
                  "veil-hover-bounce veil-press h-8 gap-1.5 rounded-full px-3 text-[13px] transition",
                  saved
                    ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                    : "text-zinc-400 hover:bg-zinc-800/70 hover:text-rose-300"
                )}
              >
                <Heart
                  aria-hidden
                  className={cn("size-3.5", saved && "fill-rose-400 text-rose-400")}
                />
                {saved ? "Saved" : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Download ${item.name}`}
                onClick={() => downloadWallpaper(routeUrl(item.video), item.name)}
                className="h-8 gap-1.5 rounded-full px-3 text-[13px] text-zinc-400 transition hover:bg-zinc-800/70 hover:text-emerald-300"
              >
                <Download aria-hidden className="size-3.5" />
                Download
              </Button>
              <Button
                size="sm"
                onClick={handleApply}
                className="veil-hover-glow veil-press h-8 shrink-0 gap-1.5 rounded-full bg-emerald-500 px-4 text-[13px] font-medium text-zinc-950 shadow-lg shadow-emerald-500/25 hover:bg-emerald-400"
              >
                {justApplied || applied ? (
                  <>
                    <Check className="size-3.5" aria-hidden />
                    Applied
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3.5" aria-hidden />
                    Apply
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* 4K catalog card + lightbox                                          */
/* ------------------------------------------------------------------ */

function CatalogCard({
  item,
  onOpen,
  index,
}: {
  item: CatalogItemDTO;
  onOpen: (item: CatalogItemDTO) => void;
  index: number;
}) {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  // 4kwallpapers thumbs occasionally fail transiently (bot wall / rate
  // limit on the proxy's upstream fetch). One delayed remount retry —
  // genuinely dead thumbs (upstream 404) then fall to the Globe card.
  const [thumbRound, setThumbRound] = React.useState(0);
  const healTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (healTimer.current) clearTimeout(healTimer.current);
    },
    []
  );
  const handleThumbError = () => {
    if (thumbRound < 1) {
      healTimer.current = setTimeout(() => setThumbRound((r) => r + 1), 2500);
      return;
    }
    setFailed(true);
  };
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-30px" }}
      transition={{ duration: 0.3, delay: Math.min((index % 24) * 0.02, 0.2) }}
      className="veil-cv"
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        aria-label={`Preview ${item.name} wallpaper`}
        className="veil-hover-tilt group relative block w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900 text-left outline-none transition-all duration-200 hover:-translate-y-1 hover:border-teal-500/60 hover:shadow-[0_18px_42px_-14px_rgba(20,184,166,0.45)] focus-visible:ring-2 focus-visible:ring-teal-500/70"
      >
        <div className="relative aspect-video w-full overflow-hidden">
          {failed ? (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-800 via-zinc-900 to-zinc-950 text-zinc-600">
              <Globe className="size-7" aria-hidden />
            </div>
          ) : (
            <img
              key={thumbRound}
              src={routeUrl(item.thumb)}
              alt={`${item.name} preview`}
              loading={index < 8 ? "eager" : "lazy"}
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={handleThumbError}
              className={cn(
                "size-full object-cover transition-all duration-500 group-hover:scale-[1.04]",
                loaded ? "opacity-100" : "opacity-0"
              )}
            />
          )}
          {!loaded && !failed && (
            <div className="absolute inset-0 animate-pulse bg-gradient-to-br from-zinc-800/80 to-zinc-900/60" />
          )}

          <span className="absolute left-2.5 top-2.5 flex items-center gap-1 rounded-full border border-teal-400/30 bg-zinc-950/75 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-300 backdrop-blur-sm">
            <ImageIcon className="size-2.5" aria-hidden />
            4K
          </span>

          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-zinc-950/90 via-zinc-950/30 to-transparent"
          />
          <div className="absolute inset-x-0 bottom-0 p-3">
            <p className="truncate text-sm font-semibold leading-tight text-zinc-50 drop-shadow-sm">
              {item.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] leading-tight text-zinc-400">
              4kwallpapers.com · {item.category}
            </p>
          </div>
        </div>
      </button>
    </motion.div>
  );
}

function CatalogLightbox({
  item,
  saved,
  onApply,
  onToggleSave,
  onClose,
}: {
  item: CatalogItemDTO | null;
  saved: boolean;
  onApply: (sel: WallpaperSelection) => void;
  onToggleSave: (sel: WallpaperSelection) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<DetailResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justApplied, setJustApplied] = React.useState(false);

  React.useEffect(() => {
    setJustApplied(false);
    if (!item) {
      setDetail(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setDetail(null);
    let cancelled = false;
    fetchJsonSafe<DetailResponse>(`/api/wallpapers/detail?url=${encodeURIComponent(item.detail)}`)
      .then((data) => {
        if (cancelled) return;
        if (!data.ok) throw new Error(data.error ?? "resolution lookup failed");
        setDetail(data);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "resolution lookup failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item?.id]);

  const handleApply = () => {
    if (!item || !detail?.best) return;
    setJustApplied(true);
    onApply({
      id: `4k-${item.id}`,
      src: routeUrl(detail.best.url),
      kind: "image",
      name: item.name,
      // Catalog preview as poster for the saved My-pack card.
      thumb: routeUrl(item.thumb),
    });
  };

  // The library selection — full-quality src when the detail resolved,
  // the thumb until then (Apply re-writes the full-quality selection).
  const buildSelection = (): WallpaperSelection | null => {
    if (!item) return null;
    return {
      id: `4k-${item.id}`,
      src: detail?.best ? routeUrl(detail.best.url) : routeUrl(item.thumb),
      kind: "image",
      name: item.name,
      thumb: routeUrl(item.thumb),
    };
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={(o) => !o && onClose()}>
      {/* The preview panel, exactly as requested: the preview, a smaller
          Download button, an Apply button — nothing else. vh (not dvh)
          height caps so the popup stays visible in every embedding
          (iframes included); a scrollable column so the buttons can never
          clip off-screen. */}
      <DialogContent className="flex max-h-[92vh] w-[min(94vw,720px)] max-w-[min(94vw,720px)] flex-col gap-0 overflow-hidden border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-[min(94vw,720px)]">
        {item && (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            <div className="flex items-center px-5 pb-3 pr-12 pt-4">
              <DialogTitle className="min-w-0 flex-1 truncate text-left text-[15px] font-semibold text-zinc-100">
                {detail?.name || item.name}
              </DialogTitle>
            </div>
            <DialogDescription className="sr-only">
              Wallpaper from 4kwallpapers.com — Apply sets it as the Veil
              background at its best resolution.
            </DialogDescription>

            <div key={item.id} className="veil-zoom-burst relative mx-5 aspect-video max-h-[52vh] w-[calc(100%-2.5rem)] shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
              {/* The card already loaded this exact thumb, so the popup
                  paints instantly from the browser cache. */}
              <img src={routeUrl(item.thumb)} alt={item.name} className="size-full object-cover" />
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60">
                  <Loader2 className="size-8 animate-spin text-teal-400" aria-hidden />
                </div>
              )}
            </div>

            {/* Resolving state — one tiny inline line, only while the
                resolutions load (the buttons enable the moment they're
                ready). */}
            {error && (
              <p className="truncate px-5 pt-2 text-[12px] text-red-300/90">
                Couldn&apos;t resolve the download — close and reopen to retry.
              </p>
            )}

            {/* Save to My pack (♥), smaller Download, Apply — the
                actions, nothing else. */}
            <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3">
              <Button
                variant="ghost"
                size="sm"
                aria-label={saved ? `Remove ${item.name} from My pack` : `Save ${item.name} to My pack`}
                onClick={() => {
                  const sel = buildSelection();
                  if (sel) onToggleSave(sel);
                }}
                className={cn(
                  "veil-hover-bounce veil-press h-8 gap-1.5 rounded-full px-3 text-[13px] transition",
                  saved
                    ? "bg-rose-500/15 text-rose-300 hover:bg-rose-500/25"
                    : "text-zinc-400 hover:bg-zinc-800/70 hover:text-rose-300"
                )}
              >
                <Heart
                  aria-hidden
                  className={cn("size-3.5", saved && "fill-rose-400 text-rose-400")}
                />
                {saved ? "Saved" : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Download ${detail?.name ?? item.name}`}
                disabled={!detail?.best || loading}
                onClick={() =>
                  item &&
                  detail?.best &&
                  downloadWallpaper(routeUrl(detail.best.url), detail.name || item.name)
                }
                className="veil-press h-8 gap-1.5 rounded-full px-3 text-[13px] text-zinc-400 transition hover:bg-zinc-800/70 hover:text-emerald-300 disabled:opacity-40"
              >
                <Download aria-hidden className="size-3.5" />
                Download
              </Button>
              <Button
                size="sm"
                onClick={handleApply}
                disabled={!detail?.best || loading}
                className="veil-hover-glow veil-press h-8 shrink-0 gap-1.5 rounded-full bg-teal-500 px-4 text-[13px] font-medium text-zinc-950 shadow-lg shadow-teal-500/25 hover:bg-teal-400 disabled:opacity-50"
              >
                {justApplied ? (
                  <>
                    <Check className="size-3.5" aria-hidden />
                    Applied
                  </>
                ) : (
                  <>
                    <MonitorPlay className="size-3.5" aria-hidden />
                    {`Apply${detail?.best ? ` ${detail.best.w}×${detail.best.h}` : ""}`}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

type Source = "pack" | "live" | "catalog" | "themes";

function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Resolve a wallpaper src for rendering/applying: local public/ assets
 *  (uploaded pack) stay same-origin; absolute URLs route through the veil. */
const assetSrc = (src: string | undefined | null): string => {
  const s = src ?? "";
  return isLocalAsset(s) ? s : routeUrl(s);
};

/** Trigger a browser download of a wallpaper file. Works for local
 *  public/ assets and routed /api/p/ URLs alike — both are same-origin,
 *  so the anchor's download attribute is honored. */
const downloadWallpaper = (url: string, name: string): void => {
  const clean = (url.split("?")[0] ?? url).split("#")[0] ?? url;
  const extMatch = /\.[a-z0-9]{2,5}$/i.exec(clean);
  const ext = extMatch ? extMatch[0] : "";
  const safe =
    name.replace(/[^\w\d-]+/g, " ").trim().replace(/\s+/g, "-").toLowerCase() ||
    "veil-wallpaper";
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}${ext}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/* ------------------------------------------------------------------ */
/* Preview-quality video sources                                       */
/* ------------------------------------------------------------------ */

/** Route a motionbgs video at preview quality (the 1080p variant through
 *  the veil's disk cache) — a quarter of the 4K decode memory. Apply and
 *  Download keep requesting the plain URL, which the server canonicalizes
 *  back to the full 4K file. Shared engine: lib/veil/wallpapers.ts. */
const previewVideoRoute = (video: string): string =>
  previewVideoSrcFor(video) ?? routeUrl(video);

/**
 * Two-stage <video> source: the preview-quality URL is tried first (1080p
 * motionbgs variant / 720p pack sibling), falling back to the full-quality
 * original on error. This is what keeps hover previews and preview popups
 * cheap enough that opening one can never tip a memory-tight renderer
 * into an OOM kill — the old "clicked a wallpaper and the page froze with
 * no popup" bug was exactly a 4K decode spike landing on an exhausted box.
 */
function usePreviewVideoSrc(full: string, preview: string | null): {
  src: string;
  handleError: () => boolean;
} {
  const [stage, setStage] = React.useState(0);
  React.useEffect(() => {
    setStage(0);
  }, [full, preview]);
  const src = stage === 0 && preview ? preview : full;
  const handleError = React.useCallback(() => {
    if (stage === 0 && preview) {
      setStage(1); // preview variant missing upstream → retry at full quality
      return true;
    }
    return false; // propagate: the caller marks the preview failed
  }, [stage, preview]);
  return { src, handleError };
}

export function WallpapersSection({ onBack }: { onBack: () => void }) {
  const [source, setSource] = React.useState<Source>("pack");
  const reduceMotion = useReducedMotion();
  const [filter, setFilter] = React.useState<string>("all");
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<VeilWallpaper | null>(null);
  const [appliedId, setAppliedId] = React.useState<string | null>(null);
  const [pack, setPack] = React.useState<VeilWallpaper[]>(UPLOADED_PACK);

  /* ---- custom uploads (owner's own images/mp4s in My pack) ---- */
  const customRef = React.useRef<VeilWallpaper[]>([]);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  // The owner password for uploads/deletes — kept for the tab session only
  // (same lifetime as the Updates unlock, never written to disk).
  const [ownerPw, setOwnerPw] = React.useState("");
  React.useEffect(() => {
    try {
      const saved = sessionStorage.getItem("veil:wp-owner-pw");
      if (saved) setOwnerPw(saved);
    } catch {
      /* private mode */
    }
  }, []);
  const [pwOpen, setPwOpen] = React.useState(false);
  const [pwDraft, setPwDraft] = React.useState("");
  const [pwErr, setPwErr] = React.useState("");
  // The file waiting for the password gate (upload) — or the upload id
  // waiting for it (delete).
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const [upload, setUpload] = React.useState<{ name: string; pct: number } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [notice, setNotice] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );
  const toast = React.useCallback((kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4500);
  }, []);

  // 4K catalog state
  const [cat, setCat] = React.useState("recent");
  const [searchQ, setSearchQ] = React.useState("");
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [items, setItems] = React.useState<CatalogItemDTO[]>([]);
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [catLoading, setCatLoading] = React.useState(true);
  const [catError, setCatError] = React.useState<string | null>(null);
  const [moreLoading, setMoreLoading] = React.useState(false);
  const [catalogPick, setCatalogPick] = React.useState<CatalogItemDTO | null>(null);

  // MotionBGs live-wallpaper state
  const [liveCat, setLiveCat] = React.useState("recent");
  const [liveSearchQ, setLiveSearchQ] = React.useState("");
  const [liveDebouncedQ, setLiveDebouncedQ] = React.useState("");
  const [liveItems, setLiveItems] = React.useState<LiveItemDTO[]>([]);
  const [livePage, setLivePage] = React.useState(1);
  const [liveHasMore, setLiveHasMore] = React.useState(false);
  const [liveLoading, setLiveLoading] = React.useState(false);
  const [liveError, setLiveError] = React.useState<string | null>(null);
  const [liveMoreLoading, setLiveMoreLoading] = React.useState(false);
  const [livePick, setLivePick] = React.useState<LiveItemDTO | null>(null);
  const [shuffling, setShuffling] = React.useState(false);

  /* ---- universal search — My pack's box fans out to the big catalogs ----
   * The default tab's box used to filter ONLY the ~17 local items, so any
   * real-world query ("batman", "goku"…) came back empty and search read
   * as broken. Now the same box ALSO queries the 4K catalog and the live
   * catalog in parallel and renders their cards below the local matches —
   * one box, the whole wallpaper universe. */
  const [packDebouncedQ, setPackDebouncedQ] = React.useState("");
  const [packRemote, setPackRemote] = React.useState<{
    loading: boolean;
    fourK: CatalogItemDTO[];
    live: LiveItemDTO[];
  }>({ loading: false, fourK: [], live: [] });

  // Applying a wallpaper closes the lightbox AND the gallery so the user
  // lands straight back on the main page with the new background live —
  // no dead-end menu after "Set as background" / "Apply to Veil".
  const exitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (exitTimer.current) clearTimeout(exitTimer.current);
    },
    []
  );
  const applyAndExit = React.useCallback(() => {
    setSelected(null);
    setCatalogPick(null);
    setLivePick(null);
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => onBack(), 450);
  }, [onBack]);

  // ♥ favorites (persisted ids; favorites float to the front of My pack).
  // For SAVED gallery cards (♥'d from the Live/4K preview panels) the heart
  // means "remove from My pack" — the library entry's only life is the
  // heart state, so unhearting removes the card entirely.
  const [favIds, setFavIds] = React.useState<Set<string>>(new Set());
  const toggleFavorite = React.useCallback((id: string) => {
    if (libraryHas(id)) {
      removeFromLibrary(id);
    } else {
      toggleWallpaperFavorite(id);
    }
    // Both branches ping their change events → the sync effect re-merges
    // [custom uploads + fullPack()] with favorites re-floated.
  }, []);

  // Load + live-track the applied background selection and the user pack
  // (library saves from the preview panels update it in real time too).
  // The grid is [custom uploads → fullPack()] with favorites floated to
  // the front — the owner's own additions always lead My pack.
  React.useEffect(() => {
    const sync = () => {
      setAppliedId(loadWallpaperSelection()?.id ?? null);
      const favs = readFavoriteIds();
      const custom = customRef.current;
      // Dedupe: fullPack() injects the APPLIED selection at its front —
      // when that's a custom upload it's already in `custom`, so drop the
      // injected twin (the custom card wins; it carries the delete button).
      const merged = [...custom, ...fullPack().filter((w) => !custom.some((c) => c.id === w.id))]
        .map((w, i) => ({ w, i }))
        .sort((a, b) => Number(favs.has(b.w.id)) - Number(favs.has(a.w.id)) || a.i - b.i)
        .map(({ w }) => w);
      setPack(merged);
      setFavIds(favs);
    };
    sync();
    window.addEventListener("veil:wallpaper-changed", sync);
    window.addEventListener("veil:wallpaper-favs-changed", sync);
    window.addEventListener("veil:wallpaper-library-changed", sync);
    return () => {
      window.removeEventListener("veil:wallpaper-changed", sync);
      window.removeEventListener("veil:wallpaper-favs-changed", sync);
      window.removeEventListener("veil:wallpaper-library-changed", sync);
    };
  }, []);

  // Fetch the owner's custom uploads (public list — site-wide wallpapers).
  // Self-heals the applied selection when its upload vanished out-of-band
  // (deleted from another device): a dead "up-" backdrop falls back to the
  // default instead of rendering a 404 card forever.
  const loadCustom = React.useCallback(() => {
    fetchJsonSafe<{ ok?: boolean; wallpapers?: VeilWallpaper[] }>("/api/wallpapers/custom", {
      cache: "no-store",
    })
      .then((data) => {
        const list = Array.isArray(data.wallpapers) ? data.wallpapers : [];
        customRef.current = list;
        const sel = loadWallpaperSelection();
        if (sel && sel.id.startsWith("up-") && !list.some((w) => w.id === sel.id)) {
          const fallback = UPLOADED_PACK.find((w) => w.id === "neon-aurora") ?? UPLOADED_PACK[0];
          saveWallpaperSelection({
            id: fallback.id,
            src: fallback.src || "",
            kind: fallback.kind,
            name: fallback.name,
            thumb: fallback.thumb ?? undefined,
          });
        } else {
          window.dispatchEvent(new Event("veil:wallpaper-changed"));
        }
      })
      .catch(() => {
        /* offline/degraded — the built-in pack still renders */
      });
  }, []);
  React.useEffect(() => {
    loadCustom();
  }, [loadCustom]);

  /* ---- custom upload engine (XHR for real progress, like chat files) ---- */

  const startUpload = React.useCallback(
    (file: File, password: string) => {
      if (file.size > 300 * 1024 * 1024) {
        toast("err", "That file is over the 300 MB limit.");
        return;
      }
      setUpload({ name: file.name, pct: 0 });
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        "/api/wallpapers/upload?password=" +
          encodeURIComponent(password) +
          "&name=" +
          encodeURIComponent(file.name.slice(0, 120)) +
          "&type=" +
          encodeURIComponent(file.type || ""),
      );
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUpload({ name: file.name, pct: Math.round((e.loaded / e.total) * 100) });
        }
      };
      xhr.onload = () => {
        setUpload(null);
        try {
          const d = JSON.parse(xhr.responseText) as { ok?: boolean; error?: string };
          if (xhr.status >= 200 && xhr.status < 300 && d.ok) {
            toast("ok", `Added "${file.name.replace(/\.[^.]+$/, "")}" to My pack.`);
            loadCustom();
          } else if (xhr.status === 403) {
            // Wrong password — drop the cached one and re-prompt.
            setOwnerPw("");
            try {
              sessionStorage.removeItem("veil:wp-owner-pw");
            } catch {
              /* ignore */
            }
            setPendingFile(file);
            setPwErr("That password didn't work — try again.");
            setPwOpen(true);
          } else {
            toast("err", d.error || "Upload failed — try again.");
          }
        } catch {
          toast("err", "Upload failed — try again.");
        }
      };
      xhr.onerror = () => {
        setUpload(null);
        toast("err", "Upload failed — network hiccup.");
      };
      xhr.send(file);
    },
    [toast, loadCustom],
  );

  /** Route a picked file through the password gate when needed. */
  const handleFilePicked = React.useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (upload) return; // one at a time
      if (ownerPw) {
        startUpload(file, ownerPw);
      } else {
        setPendingFile(file);
        setPwErr("");
        setPwOpen(true);
      }
    },
    [ownerPw, upload, startUpload],
  );

  /** Delete a custom upload (owner). */
  const deleteCustom = React.useCallback(
    async (id: string, password: string) => {
      if (!/^up-/.test(id)) return;
      setDeleting(id);
      try {
        const res = await fetch(
          `/api/wallpapers/custom?password=${encodeURIComponent(password)}&id=${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.ok && d.ok) {
          toast("ok", "Removed from My pack.");
          // If it was applied, fall back to the default so the backdrop
          // never points at deleted bytes.
          const sel = loadWallpaperSelection();
          if (sel && sel.id === id) {
            const fallback = UPLOADED_PACK.find((w) => w.id === "neon-aurora") ?? UPLOADED_PACK[0];
            saveWallpaperSelection({
              id: fallback.id,
              src: fallback.src || "",
              kind: fallback.kind,
              name: fallback.name,
              thumb: fallback.thumb ?? undefined,
            });
          }
          loadCustom();
        } else if (res.status === 403) {
          setOwnerPw("");
          try {
            sessionStorage.removeItem("veil:wp-owner-pw");
          } catch {
            /* ignore */
          }
          setPendingDelete(id);
          setPwErr("That password didn't work — try again.");
          setPwOpen(true);
        } else {
          toast("err", d.error || "Could not delete that wallpaper.");
        }
      } catch {
        toast("err", "Could not delete that wallpaper.");
      } finally {
        setDeleting(null);
      }
    },
    [toast, loadCustom],
  );

  /** Card-level delete — gate on the password when it isn't cached. */
  const handleDelete = React.useCallback(
    (id: string) => {
      if (deleting) return;
      if (ownerPw) void deleteCustom(id, ownerPw);
      else {
        setPendingDelete(id);
        setPwErr("");
        setPwOpen(true);
      }
    },
    [ownerPw, deleting, deleteCustom],
  );

  /** The password gate confirmed — run whatever was waiting behind it. */
  const confirmPw = () => {
    const pw = pwDraft;
    if (!pw) return;
    setOwnerPw(pw);
    try {
      sessionStorage.setItem("veil:wp-owner-pw", pw);
    } catch {
      /* private mode — session-only */
    }
    setPwOpen(false);
    setPwDraft("");
    setPwErr("");
    const file = pendingFile;
    const del = pendingDelete;
    setPendingFile(null);
    setPendingDelete(null);
    if (file) startUpload(file, pw);
    else if (del) void deleteCustom(del, pw);
  };

  // Debounce the catalog search box.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ.trim()), 400);
    return () => clearTimeout(t);
  }, [searchQ]);

  // Reset the catalog whenever the category or the search changes.
  React.useEffect(() => {
    setPage(1);
    setItems([]);
    setHasMore(false);
    setCatError(null);
    setCatLoading(true);
  }, [cat, debouncedQ]);

  // Fetch the first page of the current catalog slice.
  React.useEffect(() => {
    if (!catLoading) return;
    let cancelled = false;
    const params = new URLSearchParams({ cat, page: "1" });
    if (debouncedQ) params.set("q", debouncedQ);
    // Searches bypass the HTTP cache so a transient empty/upstream failure
    // can never pin itself for the cache TTL (server memory cache still
    // dedupes upstream fetches).
    fetchJsonSafe<CatalogResponse>(`/api/wallpapers?${params}`, {
      cache: debouncedQ ? "no-store" : "default",
    })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setHasMore(data.hasMore);
        setCatError(data.items.length === 0 ? "No wallpapers matched." : null);
      })
      .catch(() => {
        if (cancelled) return;
        setCatError("The 4K catalog is unreachable right now.");
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setCatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catLoading, cat, debouncedQ]);

  const loadMore = React.useCallback(() => {
    if (moreLoading || !hasMore) return;
    setMoreLoading(true);
    const next = page + 1;
    const params = new URLSearchParams({ cat, page: String(next) });
    fetchJsonSafe<CatalogResponse>(`/api/wallpapers?${params}`)
      .then((data) => {
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...data.items.filter((i) => !seen.has(i.id))];
        });
        setHasMore(data.hasMore);
        setPage(next);
      })
      .catch(() => {
        setHasMore(false);
      })
      .finally(() => setMoreLoading(false));
  }, [moreLoading, hasMore, page, cat]);

  // ----- MotionBGs live wallpapers -----

  // Debounce the live search box.
  React.useEffect(() => {
    const t = setTimeout(() => setLiveDebouncedQ(liveSearchQ.trim()), 400);
    return () => clearTimeout(t);
  }, [liveSearchQ]);

  // Fetch the first page whenever the live category/search changes (and on
  // first entry into the tab).
  React.useEffect(() => {
    if (source !== "live") return;
    let cancelled = false;
    setLiveLoading(true);
    setLiveError(null);
    const params = new URLSearchParams({ cat: liveCat, page: "1" });
    if (liveDebouncedQ) params.set("q", liveDebouncedQ);
    fetchJsonSafe<LiveResponse>(`/api/wallpapers/live?${params}`)
      .then((data) => {
        if (cancelled) return;
        setLiveItems(data.items);
        setLivePage(1);
        setLiveHasMore(data.hasMore);
        setLiveError(data.items.length === 0 ? "No live wallpapers matched." : null);
      })
      .catch(() => {
        if (cancelled) return;
        setLiveError("The live catalog is unreachable right now.");
        setLiveItems([]);
      })
      .finally(() => {
        if (!cancelled) setLiveLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, liveCat, liveDebouncedQ]);

  const liveLoadMore = React.useCallback(() => {
    if (liveMoreLoading || !liveHasMore) return;
    setLiveMoreLoading(true);
    const next = livePage + 1;
    const params = new URLSearchParams({ cat: liveCat, page: String(next) });
    fetchJsonSafe<LiveResponse>(`/api/wallpapers/live?${params}`)
      .then((data) => {
        setLiveItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...data.items.filter((i) => !seen.has(i.id))];
        });
        setLiveHasMore(data.hasMore);
        setLivePage(next);
      })
      .catch(() => {
        setLiveHasMore(false);
      })
      .finally(() => setLiveMoreLoading(false));
  }, [liveMoreLoading, liveHasMore, livePage, liveCat]);

  // Pre-warm the server's motionbgs disk cache with the first few videos of
  // a freshly loaded grid (staggered HEAD requests — the veil downloads and
  // caches each mp4 on the server, so hover previews start almost instantly
  // instead of waiting for a first-play download).
  const warmedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (source !== "live" || liveLoading || liveItems.length === 0) return;
    const warmKey = `${liveCat}#${liveDebouncedQ}`;
    if (warmedFor.current === warmKey) return;
    warmedFor.current = warmKey;
    liveItems.slice(0, 6).forEach((it, i) => {
      setTimeout(() => {
        void fetch(routeUrl(it.video), {
          method: "HEAD",
          signal: AbortSignal.timeout(4000),
        }).catch(() => {});
      }, 350 + i * 450);
    });
  }, [source, liveLoading, liveItems, liveCat, liveDebouncedQ]);

  // Shuffle: draw a random live wallpaper (from a random category feed for
  // real variety, falling back to the loaded grid) and apply it instantly.
  const shuffleLive = React.useCallback(() => {
    if (shuffling) return;
    setShuffling(true);
    const finish = (pool: LiveItemDTO[]) => {
      const it = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
      setShuffling(false);
      if (!it) return;
      saveWallpaperData({
        id: `mbg-${it.id}`,
        src: routeUrl(it.video),
        kind: "video",
        name: it.name,
        thumb: routeUrl(it.thumb),
      });
      setAppliedId(`mbg-${it.id}`);
      applyAndExit();
    };
    const cats = LIVE_CATEGORIES.map((c) => c.id);
    const randomCat = cats[Math.floor(Math.random() * cats.length)];
    fetchJsonSafe<LiveResponse>(`/api/wallpapers/live?cat=${encodeURIComponent(randomCat)}`, {
      signal: AbortSignal.timeout(8000),
    })
      .then((data) => {
        finish(data.items.length > 0 ? data.items : liveItems);
      })
      .catch(() => finish(liveItems));
  }, [shuffling, liveItems, applyAndExit]);

  const shown = React.useMemo(() => {
    const query = q.trim().toLowerCase();
    return pack.filter((w) => {
      const inFilter =
        filter === "all" ||
        filter === "favorites" ||
        w.tags.includes(filter);
      if (!inFilter) return false;
      if (filter === "favorites" && !favIds.has(w.id)) return false;
      if (!query) return true;
      return (
        w.name.toLowerCase().includes(query) ||
        w.tags.some((t) => t.includes(query))
      );
    });
  }, [pack, filter, q, favIds]);

  /* Debounce the universal box, then fan out to both catalogs (aborted
   * when the query changes again — no stale results, no wasted fetches). */
  React.useEffect(() => {
    const t = setTimeout(() => setPackDebouncedQ(q.trim()), 450);
    return () => clearTimeout(t);
  }, [q]);
  React.useEffect(() => {
    if (source !== "pack") return;
    const query = packDebouncedQ;
    if (!query) {
      setPackRemote({ loading: false, fourK: [], live: [] });
      return;
    }
    const ac = new AbortController();
    setPackRemote((prev) => ({ ...prev, loading: true }));
    const params4k = new URLSearchParams({ cat: "recent", page: "1", q: query });
    const paramsLive = new URLSearchParams({ cat: "recent", page: "1", q: query });
    Promise.all([
      fetchJsonSafe<CatalogResponse>(`/api/wallpapers?${params4k}`, {
        cache: "no-store",
        signal: ac.signal,
      }).catch(() => null),
      fetchJsonSafe<LiveResponse>(`/api/wallpapers/live?${paramsLive}`, {
        cache: "no-store",
        signal: ac.signal,
      }).catch(() => null),
    ]).then(([fourK, live]) => {
      if (ac.signal.aborted) return;
      setPackRemote({
        loading: false,
        fourK: (fourK?.items ?? []).slice(0, 24),
        live: (live?.items ?? []).slice(0, 12),
      });
    });
    return () => ac.abort();
  }, [source, packDebouncedQ]);

  const liveCount = pack.filter((w) => w.kind === "video" || w.kind === "animated").length;

  return (
    /* Transparent root — the page overlay scrim (zinc-950/72 + blur) lets
       the applied wallpaper show behind the gallery. */
    <div className="relative flex h-full w-full flex-col overflow-hidden text-zinc-100">
      {/* ambient orbs (clipped) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="veil-orb-a absolute -top-40 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="veil-orb-b absolute -bottom-32 right-[-6rem] h-80 w-80 rounded-full bg-teal-500/10 blur-3xl" />
      </div>

      {/* top bar */}
      <header className="relative z-10 shrink-0 border-b border-zinc-800/70 bg-zinc-950/70 backdrop-blur-xl">
        <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to the start page"
            className="veil-hover-bounce size-9 shrink-0 text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-zinc-950 shadow-lg shadow-emerald-500/20 ring-1 ring-emerald-300/30">
              <ImageIcon className="size-5" aria-hidden />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="veil-text-shine truncate text-base font-semibold tracking-tight text-zinc-50 sm:text-lg">
                Veil Wallpapers
              </h1>
              <Badge
                variant="outline"
                className="hidden shrink-0 border-emerald-500/30 bg-emerald-500/10 text-emerald-300 sm:inline-flex"
              >
                Gallery
              </Badge>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {source === "pack" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={!!upload}
                className="veil-press h-9 gap-1.5 rounded-full border-violet-500/40 bg-violet-500/10 text-[12.5px] font-medium text-violet-200 transition hover:border-violet-400/70 hover:bg-violet-500/20 hover:text-violet-100 disabled:opacity-50"
              >
                <Upload className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">Add yours</span>
                <span className="sm:hidden">Add</span>
              </Button>
            )}
            <OfflineDownload />
            <div className="hidden rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1 text-xs tabular-nums text-zinc-400 sm:block">
              {source === "pack"
                ? `${pack.length} uploads · ${liveCount} live`
                : source === "themes"
                  ? `${ANIMATED_THEMES.length} themes`
                  : source === "live"
                    ? `${liveItems.length} loaded${liveHasMore ? "+" : ""} · motionbgs`
                    : `${items.length} loaded${hasMore ? "+" : ""} · 4K catalog`}
            </div>
          </div>
        </div>

        {/* Source segmented control */}
        <div className="flex items-center gap-1 px-3 pb-2.5 sm:px-4">
          <div
            role="tablist"
            aria-label="Wallpaper source"
            className="flex w-full max-w-md items-center gap-1 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={source === "pack"}
              onClick={() => setSource("pack")}
              className={cn(
                "veil-press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                source === "pack"
                  ? "bg-emerald-500/15 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)] ring-1 ring-emerald-500/40"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              )}
            >
              <Package className="size-3.5" aria-hidden />
              My pack
              <span className="hidden rounded-full bg-zinc-800 px-1.5 text-[10px] tabular-nums text-zinc-400 sm:inline">
                {pack.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={source === "live"}
              onClick={() => setSource("live")}
              className={cn(
                "veil-press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                source === "live"
                  ? "bg-emerald-500/15 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)] ring-1 ring-emerald-500/40"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              )}
            >
              <Video className="size-3.5" aria-hidden />
              Live
              <span className="hidden rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400 sm:inline">
                motionbgs
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={source === "themes"}
              onClick={() => setSource("themes")}
              className={cn(
                "veil-press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                source === "themes"
                  ? "bg-emerald-500/15 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)] ring-1 ring-emerald-500/40"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              )}
            >
              <Sparkles className="size-3.5" aria-hidden />
              Themes
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={source === "catalog"}
              onClick={() => setSource("catalog")}
              className={cn(
                "veil-press flex h-8 flex-1 items-center justify-center gap-1.5 rounded-xl px-3 text-[12.5px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                source === "catalog"
                  ? "bg-emerald-500/15 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)] ring-1 ring-emerald-500/40"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
              )}
            >
              <Globe className="size-3.5" aria-hidden />
              4K
            </button>
          </div>
        </div>
      </header>

      {/* content area */}
      {source === "pack" ? (
        <>
          {/* pack: filter rail + search */}
          <div className="relative z-10 shrink-0 space-y-3 px-3 py-3 sm:px-4">
            <div
              role="tablist"
              aria-label="Filter wallpapers"
              className="veil-scroll-slim -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              {WALLPAPER_FILTERS.map((f) => {
                const active = filter === f.id;
                return (
                  <button
                    key={f.id}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => setFilter(f.id)}
                    className={cn(
                      "veil-press veil-hover-glow h-8 shrink-0 rounded-full border px-4 text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                      active
                        ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)]"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    )}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500"
                aria-hidden
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search wallpapers — your pack, the 4K catalog, live walls…"
                aria-label="Search wallpapers"
                inputMode="search"
                className="veil-focus-bloom h-11 rounded-2xl border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25"
              />
              {q && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQ("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          </div>

          {/* pack grid */}
          <div
            className="veil-scroll-slim relative z-10 min-h-0 flex-1 overflow-y-auto px-3 pb-10 sm:px-4"
            onDragOver={(e) => {
              if (source !== "pack") return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOver(false);
            }}
            onDrop={(e) => {
              if (source !== "pack") return;
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFilePicked(f);
            }}
          >
            {/* upload progress + notices (float above the grid) */}
            {(upload || notice) && (
              <div className="pointer-events-none absolute inset-x-3 top-2 z-30 flex flex-col items-center gap-2 sm:inset-x-4">
                {upload && (
                  <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl border border-violet-500/40 bg-zinc-950/90 px-4 py-2.5 shadow-lg shadow-violet-500/10 backdrop-blur-xl">
                    <Loader2 className="size-4 shrink-0 animate-spin text-violet-300" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium text-zinc-200">
                        Uploading {upload.name}…
                      </p>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-all duration-200"
                          style={{ width: `${upload.pct}%` }}
                        />
                      </div>
                    </div>
                    <span className="shrink-0 text-[12px] font-semibold tabular-nums text-violet-300">
                      {upload.pct}%
                    </span>
                  </div>
                )}
                {notice && (
                  <div
                    className={cn(
                      "veil-slide-up-pop pointer-events-auto flex w-full max-w-md items-center gap-2.5 rounded-2xl border px-4 py-2.5 shadow-lg backdrop-blur-xl",
                      notice.kind === "ok"
                        ? "border-emerald-500/40 bg-zinc-950/90 shadow-emerald-500/10"
                        : "border-red-500/40 bg-zinc-950/90 shadow-red-500/10",
                    )}
                  >
                    {notice.kind === "ok" ? (
                      <Check className="size-4 shrink-0 text-emerald-300" aria-hidden />
                    ) : (
                      <TriangleAlert className="size-4 shrink-0 text-red-300" aria-hidden />
                    )}
                    <p className="min-w-0 flex-1 text-[12.5px] text-zinc-200">{notice.text}</p>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => setNotice(null)}
                      className="shrink-0 rounded-md p-0.5 text-zinc-500 transition hover:text-zinc-200"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            )}
            {dragOver && (
              <div className="veil-ants pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-violet-400/70 bg-violet-500/10 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-2 text-violet-200">
                  <Upload className="size-8" aria-hidden />
                  <p className="text-sm font-semibold">Drop it — it lands in My pack</p>
                  <p className="text-[12px] text-violet-300/80">images &amp; mp4/webm, up to 300 MB</p>
                </div>
              </div>
            )}
            {shown.length > 0 || !upload ? (
              <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {/* Add-yours tile — always the first cell of My pack */}
                <motion.button
                  type="button"
                  initial={reduceMotion ? false : { opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-30px" }}
                  transition={{ duration: 0.3 }}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!upload}
                  aria-label="Upload your own wallpaper (image or mp4)"
                  className="group relative flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-zinc-700/80 bg-zinc-900/40 text-zinc-400 outline-none transition-all duration-200 hover:-translate-y-1 hover:border-violet-400/60 hover:bg-violet-500/10 hover:text-violet-200 focus-visible:ring-2 focus-visible:ring-violet-400/70 disabled:opacity-50"
                >
                  {upload ? (
                    <Loader2 className="size-7 animate-spin text-violet-300" aria-hidden />
                  ) : (
                    <Upload className="size-7 transition-transform duration-200 group-hover:scale-110" aria-hidden />
                  )}
                  <span className="text-[13px] font-semibold">Add yours</span>
                  <span className="px-4 text-center text-[11px] leading-snug text-zinc-500 group-hover:text-violet-300/80">
                    images &amp; mp4/webm · up to 300 MB
                  </span>
                </motion.button>
                {shown.map((wp, i) => (
                  <PackCard
                    key={wp.id}
                    wp={wp}
                    index={i}
                    applied={appliedId === wp.id}
                    favorite={favIds.has(wp.id)}
                    onToggleFavorite={toggleFavorite}
                    onOpen={setSelected}
                    onDelete={wp.id.startsWith("up-") ? handleDelete : undefined}
                  />
                ))}
              </div>
            ) : (
              <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                <div className="aspect-video animate-pulse rounded-2xl border border-zinc-800/70 bg-gradient-to-br from-zinc-800/70 to-zinc-900/50" />
              </div>
            )}
            {shown.length === 0 && !upload && !q.trim() && (
              <div className="flex h-48 flex-col items-center justify-center gap-2 text-zinc-500">
                <Package className="size-8" aria-hidden />
                <p className="text-sm">
                  {filter === "favorites"
                    ? "Nothing favorited yet — tap the ♥ on a card."
                    : "No uploads match this filter."}
                </p>
              </div>
            )}
            {q.trim() && (
              <div className="mt-2 space-y-8">
                {packRemote.loading && (
                  <div className="flex items-center justify-center gap-2.5 py-8 text-zinc-500">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    <p className="text-[13px]">searching the 4K + live catalogs…</p>
                  </div>
                )}
                {!packRemote.loading &&
                  shown.length === 0 &&
                  packRemote.fourK.length === 0 &&
                  packRemote.live.length === 0 && (
                    <div className="flex h-48 flex-col items-center justify-center gap-2 text-zinc-500">
                      <SearchX className="size-8" aria-hidden />
                      <p className="text-sm">Nothing matched anywhere — try a shorter query.</p>
                    </div>
                  )}
                {packRemote.fourK.length > 0 && (
                  <section aria-label="4K catalog results">
                    <div className="mb-3 flex items-center gap-2.5">
                      <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                        From the 4K catalog
                      </h3>
                      <span className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                        {packRemote.fourK.length}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-zinc-800/70" />
                    </div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                      {packRemote.fourK.map((it, i) => (
                        <CatalogCard key={it.id} item={it} index={i} onOpen={setCatalogPick} />
                      ))}
                    </div>
                  </section>
                )}
                {packRemote.live.length > 0 && (
                  <section aria-label="Live wallpaper results">
                    <div className="mb-3 flex items-center gap-2.5">
                      <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                        Live wallpapers
                      </h3>
                      <span className="rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                        {packRemote.live.length}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-zinc-800/70" />
                    </div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                      {packRemote.live.map((it, i) => (
                        <LiveCard
                          key={it.id}
                          item={it}
                          index={i}
                          applied={appliedId === `mbg-${it.id}`}
                          onOpen={setLivePick}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </>
      ) : source === "themes" ? (
        <>
          {/* themes: intro + procedural CSS backdrop grid */}
          <div className="relative z-10 shrink-0 space-y-3 px-3 py-3 sm:px-4">
            <div className="flex items-center gap-2.5 rounded-2xl border border-zinc-800/70 bg-zinc-900/40 px-3.5 py-2.5">
              <Sparkles className="size-4 shrink-0 text-emerald-400" aria-hidden />
              <p className="text-[12.5px] leading-snug text-zinc-400">
                Procedural animated themes — pure CSS, zero bandwidth, infinitely smooth.
                Apply one like any wallpaper.
              </p>
            </div>
          </div>
          <div className="veil-scroll-slim relative z-10 min-h-0 flex-1 overflow-y-auto px-3 pb-10 sm:px-4">
            <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {ANIMATED_THEMES.map((wp, i) => (
                <PackCard
                  key={wp.id}
                  wp={wp}
                  index={i}
                  applied={appliedId === wp.id}
                  favorite={favIds.has(wp.id)}
                  onToggleFavorite={toggleFavorite}
                  onOpen={setSelected}
                />
              ))}
            </div>
          </div>
        </>
      ) : source === "live" ? (
        <>
          {/* live: category rail + search + shuffle */}
          <div className="relative z-10 shrink-0 space-y-3 px-3 py-3 sm:px-4">
            <div
              role="tablist"
              aria-label="Live wallpaper categories"
              className="veil-scroll-slim -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              {LIVE_CATEGORIES.map((c) => {
                const active = liveCat === c.id && !liveDebouncedQ;
                return (
                  <button
                    key={c.id}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => {
                      setLiveSearchQ("");
                      setLiveCat(c.id);
                    }}
                    className={cn(
                      "veil-press veil-hover-glow h-8 shrink-0 rounded-full border px-4 text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                      active
                        ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-300 shadow-[0_0_16px_-6px_rgba(16,185,129,0.8)]"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500"
                  aria-hidden
                />
                <Input
                  value={liveSearchQ}
                  onChange={(e) => setLiveSearchQ(e.target.value)}
                  placeholder="Search motionbgs — try “spider-man”, “rainy”, “sunset”…"
                  aria-label="Search live wallpapers"
                  inputMode="search"
                  className="veil-focus-bloom h-11 rounded-2xl border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25"
                />
                {liveSearchQ && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setLiveSearchQ("")}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={shuffleLive}
                disabled={shuffling || liveItems.length === 0}
                title="Apply a random live wallpaper from a random category"
                aria-label="Shuffle a random live wallpaper"
                className="veil-hover-glow veil-press h-11 shrink-0 gap-2 rounded-2xl border-zinc-800 bg-zinc-900/70 px-4 text-[13px] font-medium text-zinc-300 transition hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-60"
              >
                {shuffling ? (
                  <Loader2 className="size-4 animate-spin text-emerald-400" aria-hidden />
                ) : (
                  <Dices className="size-4 text-emerald-400/90" aria-hidden />
                )}
                <span className="hidden sm:inline">Shuffle</span>
              </Button>
            </div>
          </div>

          {/* live grid */}
          <div className="veil-scroll-slim relative z-10 min-h-0 flex-1 overflow-y-auto px-3 pb-10 sm:px-4">
            {liveLoading ? (
              <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-video animate-pulse rounded-2xl border border-zinc-800/70 bg-gradient-to-br from-zinc-800/70 to-zinc-900/50"
                  />
                ))}
              </div>
            ) : liveItems.length > 0 ? (
              <>
                <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                  {liveItems.map((item, i) => (
                    <LiveCard
                      key={item.id}
                      item={item}
                      index={i}
                      applied={appliedId === `mbg-${item.id}`}
                      onOpen={setLivePick}
                    />
                  ))}
                </div>
                {liveHasMore && (
                  <div className="mx-auto mt-6 flex max-w-6xl justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={liveLoadMore}
                      disabled={liveMoreLoading}
                      className="veil-press h-10 rounded-full border-zinc-700 bg-zinc-900/70 px-6 text-[13px] text-zinc-300 transition hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300"
                    >
                      {liveMoreLoading ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                          Loading…
                        </>
                      ) : (
                        "Load more live wallpapers"
                      )}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-zinc-500">
                <TriangleAlert className="size-8" aria-hidden />
                <p className="text-sm">{liveError ?? "No live wallpapers found."}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLiveSearchQ("");
                    setLiveCat("recent");
                    setLiveDebouncedQ("");
                  }}
                  className="veil-press mt-1 h-8 border-zinc-700 text-zinc-300 hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300"
                >
                  Try again
                </Button>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* catalog: category rail + search */}
          <div className="relative z-10 shrink-0 space-y-3 px-3 py-3 sm:px-4">
            <div
              role="tablist"
              aria-label="4K wallpaper categories"
              className="veil-scroll-slim -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            >
              {CATALOG_CATEGORIES.map((c) => {
                const active = cat === c.id && !debouncedQ;
                return (
                  <button
                    key={c.id}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => {
                      setSearchQ("");
                      setCat(c.id);
                    }}
                    className={cn(
                      "veil-press veil-hover-glow h-8 shrink-0 rounded-full border px-4 text-[13px] font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70",
                      active
                        ? "border-teal-500/60 bg-teal-500/15 text-teal-300 shadow-[0_0_16px_-6px_rgba(20,184,166,0.8)]"
                        : "border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500"
                aria-hidden
              />
              <Input
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="Search 4K wallpapers — try “spider-man”, “goku”, “batman”…"
                aria-label="Search the 4K catalog"
                inputMode="search"
                className="veil-focus-bloom h-11 rounded-2xl border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-teal-500/60 focus-visible:ring-teal-500/25"
              />
              {searchQ && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearchQ("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
          </div>

          {/* catalog grid */}
          <div className="veil-scroll-slim relative z-10 min-h-0 flex-1 overflow-y-auto px-3 pb-10 sm:px-4">
            {catLoading ? (
              <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
                  <div
                    key={i}
                    className="aspect-video animate-pulse rounded-2xl border border-zinc-800/70 bg-gradient-to-br from-zinc-800/70 to-zinc-900/50"
                  />
                ))}
              </div>
            ) : items.length > 0 ? (
              <>
                <div className="mx-auto grid max-w-6xl grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                  {items.map((item, i) => (
                    <CatalogCard key={item.id} item={item} index={i} onOpen={setCatalogPick} />
                  ))}
                </div>
                {hasMore && (
                  <div className="mx-auto mt-6 flex max-w-6xl justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadMore}
                      disabled={moreLoading}
                      className="veil-press h-10 rounded-full border-zinc-700 bg-zinc-900/70 px-6 text-[13px] text-zinc-300 transition hover:border-teal-500/50 hover:bg-teal-500/10 hover:text-teal-300"
                    >
                      {moreLoading ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                          Loading…
                        </>
                      ) : (
                        "Load more wallpapers"
                      )}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-zinc-500">
                <Globe className="size-8" aria-hidden />
                <p className="text-sm">{catError ?? "No wallpapers found."}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearchQ("");
                    setCat("recent");
                    setDebouncedQ("");
                  }}
                  className="veil-press mt-1 h-8 border-zinc-700 text-zinc-300 hover:border-teal-500/50 hover:bg-teal-500/10 hover:text-teal-300"
                >
                  Try again
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {/* lightboxes */}
      <PackLightbox
        wp={selected}
        applied={selected ? appliedId === selected.id : false}
        onApply={(sel) => {
          saveWallpaperSelection(sel);
          setAppliedId(sel.id);
          applyAndExit();
        }}
        onClose={() => setSelected(null)}
      />
      <LiveLightbox
        item={livePick}
        applied={livePick ? appliedId === `mbg-${livePick.id}` : false}
        saved={livePick ? libraryHas(`mbg-${livePick.id}`) : false}
        onApply={(sel) => {
          saveWallpaperData(sel);
          setAppliedId(sel.id);
          applyAndExit();
        }}
        onToggleSave={(sel) => {
          if (libraryHas(sel.id)) removeFromLibrary(sel.id);
          else saveToLibrary(sel);
        }}
        onClose={() => setLivePick(null)}
      />
      <CatalogLightbox
        item={catalogPick}
        saved={catalogPick ? libraryHas(`4k-${catalogPick.id}`) : false}
        onApply={(sel) => {
          saveWallpaperData(sel);
          setAppliedId(sel.id);
          applyAndExit();
        }}
        onToggleSave={(sel) => {
          if (libraryHas(sel.id)) removeFromLibrary(sel.id);
          else saveToLibrary(sel);
        }}
        onClose={() => setCatalogPick(null)}
      />

      {/* hidden helper: download icon used by catalog cards on some clients */}
      <span className="hidden">
        <Download aria-hidden className="size-0" />
      </span>

      {/* hidden file input — the Add-yours tile and header button both
          route through it; picking a file runs the password gate first. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm,video/quicktime,video/x-matroska,.png,.jpg,.jpeg,.webp,.gif,.avif,.mp4,.m4v,.webm,.mov,.mkv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (f) handleFilePicked(f);
        }}
      />

      {/* owner password gate — uploads & deletes wait behind it */}
      <Dialog open={pwOpen} onOpenChange={(o) => !o && setPwOpen(false)}>
        <DialogContent className="w-[min(92vw,400px)] max-w-[min(92vw,400px)] border-zinc-800 bg-zinc-950 p-0 text-zinc-100">
          <div className="flex items-start gap-3 px-5 pb-2 pr-10 pt-5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-fuchsia-600 text-zinc-950 shadow-lg shadow-violet-500/20 ring-1 ring-violet-300/30">
              <KeyRound className="size-4.5" aria-hidden />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-left text-[15px] font-semibold text-zinc-100">
                Owner password
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-left text-[12.5px] leading-snug text-zinc-400">
                Uploading into My pack is the owner's move — the pack is shared
                site-wide.
              </DialogDescription>
            </div>
          </div>
          <div className="space-y-3 px-5 pb-5">
            <Input
              type="password"
              value={pwDraft}
              autoFocus
              onChange={(e) => {
                setPwDraft(e.target.value);
                setPwErr("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmPw();
                }
              }}
              placeholder="The owner password"
              aria-label="Owner password"
              className="veil-focus-bloom h-11 rounded-xl border-zinc-800 bg-zinc-900/70 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-violet-500/60 focus-visible:ring-violet-500/25"
            />
            {pwErr && (
              <p className="text-[12px] font-medium text-red-400" role="alert">
                {pwErr}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPwOpen(false)}
                className="veil-press h-9 rounded-full px-4 text-[13px] text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={confirmPw}
                disabled={!pwDraft}
                className="veil-hover-glow veil-press h-9 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 text-[13px] font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-50"
              >
                Unlock &amp; upload
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-zinc-500">
              Kept for this tab only — same password as Owner Mode.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
