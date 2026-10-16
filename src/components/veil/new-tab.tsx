"use client";

/**
 * Veil — new-tab start page (v2 overhaul).
 *
 * Shown inside the browsing overlay when the active tab has no target yet.
 * Now a proper "OS new tab": the applied wallpaper (video / image / the
 * default emerald live theme from first boot) paints the whole surface,
 * with a live clock + greeting, a glass command bar, glass quick links
 * and recent history — all on translucent cards over the backdrop.
 */

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  Clock,
  History as HistoryIcon,
  LogOut,
  Maximize2,
  Search,
} from "lucide-react";
import { BackdropVideo } from "@/components/veil/backdrop-video";
import { FANCY_GLIDE_EASE, useFancyMotion } from "@/lib/veil/motion";
import {
  loadWallpaperSelection,
  THEME_GRADIENTS,
  type WallpaperSelection,
} from "@/lib/veil/wallpapers";
import {
  faviconUrls,
  normalizeInput,
  QUICK_LINKS,
  timeAgo,
  type HistoryResponse,
} from "@/lib/veil/shared";

function FaviconImg({ host, name, className }: { host: string; name: string; className?: string }) {
  const urls = React.useMemo(() => faviconUrls(host), [host]);
  const [idx, setIdx] = React.useState(0);
  const failed = idx >= urls.length;
  if (failed) {
    return (
      <div
        aria-hidden
        className={`flex items-center justify-center rounded-lg bg-emerald-400/20 font-semibold text-emerald-100 ring-1 ring-white/20 ${className ?? "h-8 w-8"}`}
        style={{ fontSize: 13 }}
      >
        {name.replace(/^www\./, "").charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={urls[idx]}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      onError={() => setIdx((i) => i + 1)}
      className={`rounded-lg bg-zinc-900 object-contain p-0.5 ring-1 ring-white/15 ${className ?? "h-8 w-8"}`}
    />
  );
}

/* ── live clock ─────────────────────────────────────────────────────── */

function useNow() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Up late, veiling the night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/* Mega-motion ambient stars for the procedural wallpaper — tiny twinkling
   dots with staggered rhythm (only animate under data-veil-fancy="on"). */
const TWINKLE_STARS: { pos: string; delay: string; dur: string }[] = [
  { pos: "left-[16%] top-[24%]", delay: "0.5s", dur: "3.6s" },
  { pos: "left-[70%] top-[18%]", delay: "1.4s", dur: "4.0s" },
  { pos: "left-[58%] top-[70%]", delay: "2.2s", dur: "3.2s" },
  { pos: "left-[28%] top-[68%]", delay: "0.9s", dur: "4.4s" },
];

/* ── the page ───────────────────────────────────────────────────────── */

export function NewTab({
  onNavigate,
  history,
  onHome,
}: {
  onNavigate: (url: string) => void;
  history: HistoryResponse | null;
  onHome: () => void;
}) {
  const [input, setInput] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();
  const fancy = useFancyMotion();
  const now = useNow();

  /* ── the applied wallpaper — live-tracked, defaults to the emerald
   *    live theme (the green look from first boot) ── */
  const [wallpaper, setWallpaper] = React.useState<WallpaperSelection | null>(null);
  React.useEffect(() => {
    const sync = () => setWallpaper(loadWallpaperSelection());
    sync();
    window.addEventListener("veil:wallpaper-changed", sync);
    return () => window.removeEventListener("veil:wallpaper-changed", sync);
  }, []);

  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const target = normalizeInput(input.trim());
    if (target) onNavigate(target);
  };

  const stats = history?.stats;

  const clock = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dateLine = now.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  /* Wallpaper lanes — same three-way logic as the start page. */
  const wpKind = wallpaper?.kind ?? "animated";
  const wpTheme = wallpaper?.theme ?? "emerald";
  const wpSrc = wallpaper?.src ?? "";
  const wpThumb = wallpaper?.thumb ?? undefined;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-zinc-950 text-zinc-100 veil-scroll-slim">
      {/* ── wallpaper backdrop (applied wallpaper, or the emerald live
          theme you get when you first join) ── */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        {wpKind === "video" && wpSrc ? (
          <BackdropVideo src={wpSrc} poster={wpThumb} />
        ) : wpKind === "image" && wpSrc ? (
          <img src={wpSrc} alt="" className="size-full object-cover" />
        ) : (
          <div className={`absolute inset-0 bg-gradient-to-br ${THEME_GRADIENTS[wpTheme] ?? THEME_GRADIENTS.emerald}`}>
            <div className={`absolute -top-40 left-[25%] h-[26rem] w-[40rem] rounded-full bg-white/10 blur-3xl ${reduceMotion ? "" : "veil-orb-a"}`} />
            <div className={`absolute -bottom-32 right-[8%] h-80 w-80 rounded-full bg-black/10 blur-3xl ${reduceMotion ? "" : "veil-orb-b"}`} />
            {/* mega-motion: an aurora haze + twinkling stars over the live theme */}
            <div className="veil-aurora absolute -inset-32" />
            {TWINKLE_STARS.map((s, si) => (
              <span
                key={si}
                className={`veil-twinkle absolute size-1 rounded-full bg-white/70 ${s.pos}`}
                style={{ "--twinkle-delay": s.delay, "--twinkle-dur": s.dur } as React.CSSProperties}
              />
            ))}
          </div>
        )}
        {/* readability scrim + vignette over any wallpaper */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/30 to-black/50" />
        <div className="veil-vignette absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-black/45 to-transparent" />
      </div>

      {/* ── content ── */}
      <motion.div
        initial={
          fancy
            ? { opacity: 0, y: 26, scale: 0.985, filter: "blur(10px)" }
            : { opacity: 0, y: 14 }
        }
        animate={
          fancy
            ? { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
            : { opacity: 1, y: 0 }
        }
        transition={fancy ? { duration: 0.6, ease: FANCY_GLIDE_EASE } : { duration: 0.45, ease: "easeOut" }}
        className="relative mx-auto w-full max-w-3xl px-4 pb-24 pt-28 sm:px-6 sm:pt-32"
      >
        {/* ── live clock + greeting ── */}
        <motion.div
          initial={
            fancy
              ? { opacity: 0, y: 14, scale: 0.94, filter: "blur(6px)" }
              : { opacity: 0, y: 10 }
          }
          animate={
            fancy
              ? { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }
              : { opacity: 1, y: 0 }
          }
          transition={
            fancy
              ? { type: "spring", stiffness: 210, damping: 24, delay: 0.05 }
              : { duration: 0.5, delay: 0.05 }
          }
          className="text-center"
        >
          <p className="text-6xl font-extralight tracking-tight text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.45)] sm:text-7xl">
            <span className="tabular-nums">{clock}</span>
          </p>
          <p className="veil-text-shine mt-2.5 text-[14.5px] font-medium text-white/75 drop-shadow sm:text-[15.5px]">
            {dateLine} · {greetingFor(now)}
          </p>
        </motion.div>

        {/* ── command bar (glass) ── */}
        <motion.form
          initial={
            fancy
              ? { opacity: 0, y: 18, scale: 0.98 }
              : { opacity: 0, y: 14 }
          }
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={
            fancy
              ? { type: "spring", stiffness: 260, damping: 26, delay: 0.12 }
              : { duration: 0.45, delay: 0.12 }
          }
          onSubmit={submit}
          className="mx-auto mt-9 flex w-full max-w-2xl items-center gap-2.5"
          role="search"
        >
          <div className="veil-border-dance group relative flex-1 rounded-2xl">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-4 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-white/50 transition group-focus-within:text-emerald-300"
            />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search the web…"
              aria-label="Search or enter a web address"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              className="veil-focus-bloom h-13 w-full rounded-2xl border border-white/15 bg-zinc-950/55 pl-11 pr-4 text-[15px] text-white shadow-2xl shadow-black/50 outline-none backdrop-blur-xl transition placeholder:text-white/40 hover:border-white/25 focus:border-emerald-300/60 focus:bg-zinc-950/70 focus:shadow-[0_0_0_4px_rgba(52,211,153,0.18)]"
            />
          </div>
          <motion.button
            whileHover={fancy ? { scale: 1.04, boxShadow: "0 18px 44px rgba(52,211,153,0.35)" } : { scale: 1.03 }}
            whileTap={{ scale: 0.96 }}
            transition={{ type: "spring", stiffness: 460, damping: 24 }}
            type="submit"
            className="flex h-13 shrink-0 items-center gap-1.5 rounded-2xl bg-emerald-400 px-5 text-[15px] font-semibold text-emerald-950 shadow-xl shadow-emerald-500/25 transition hover:bg-emerald-300"
          >
            <Maximize2 aria-hidden className="veil-hover-bounce h-4 w-4" />
            <span className="hidden sm:inline">Browse</span>
          </motion.button>
        </motion.form>

        {/* ── quick links (glass cards) ── */}
        <div className="mt-11">
          <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/55">
            <Clock aria-hidden className="h-3.5 w-3.5" />
            Launch pads
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {QUICK_LINKS.map((s, i) => (
              <motion.button
                key={s.url}
                initial={
                  fancy
                    ? { opacity: 0, y: 16, scale: 0.96 }
                    : { opacity: 0, y: 12 }
                }
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={
                  fancy
                    ? { type: "spring", stiffness: 320, damping: 24, delay: 0.16 + i * 0.055 }
                    : { duration: 0.35, delay: 0.16 + i * 0.05 }
                }
                whileHover={fancy ? { y: -4, scale: 1.02 } : { y: -3 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onNavigate(s.url)}
                className="group flex items-center gap-3 rounded-2xl border border-white/12 bg-zinc-950/45 p-3 text-left shadow-lg shadow-black/25 backdrop-blur-md transition-colors hover:border-emerald-300/40 hover:bg-zinc-950/65"
              >
                <FaviconImg host={s.host} name={s.name} className={`veil-pop-in veil-stagger-${(i % 8) + 1} h-9 w-9 shrink-0`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-white">{s.name}</span>
                  <span className="block truncate text-[11px] text-white/55">{s.desc}</span>
                </span>
                <ArrowRight
                  aria-hidden
                  className="h-3.5 w-3.5 shrink-0 text-white/35 transition group-hover:translate-x-0.5 group-hover:text-emerald-300"
                />
              </motion.button>
            ))}
          </div>
        </div>

        {/* ── recent history (glass rows) ── */}
        {history && history.visits.length > 0 && (
          <div className="mt-9">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/55">
              <HistoryIcon aria-hidden className="h-3.5 w-3.5" />
              Recently viewed
            </div>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {history.visits.slice(0, 6).map((v, i) => {
                const title = v.title || v.url.replace(/^https?:\/\//, "");
                return (
                  <li key={v.id}>
                    <motion.button
                      initial={
                        fancy
                          ? { opacity: 0, x: -12 }
                          : { opacity: 0, y: 8 }
                      }
                      animate={fancy ? { opacity: 1, x: 0 } : { opacity: 1, y: 0 }}
                      transition={
                        fancy
                          ? { type: "spring", stiffness: 340, damping: 26, delay: 0.24 + i * 0.045 }
                          : { duration: 0.3, delay: 0.24 + i * 0.04 }
                      }
                      whileHover={fancy ? { x: 4 } : undefined}
                      onClick={() => onNavigate(v.url)}
                      className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/35 p-2.5 text-left backdrop-blur-md transition hover:border-emerald-300/35 hover:bg-zinc-950/60"
                    >
                      <FaviconImg host={v.host} name={v.host} className="veil-hover-bounce h-8 w-8 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-white/90">{title}</span>
                        <span className="block truncate text-[11px] text-white/50">
                          {v.host} · {timeAgo(v.updatedAt)}
                          {v.visitCount > 1 && <span className="text-emerald-300/80"> · {v.visitCount}×</span>}
                        </span>
                      </span>
                    </motion.button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* ── footer: stats + exit ── */}
        <motion.div
          initial={fancy ? { opacity: 0, y: 10 } : { opacity: 0 }}
          animate={fancy ? { opacity: 1, y: 0 } : { opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.35 }}
          className="mt-11 flex flex-col items-center gap-4"
        >
          {stats && (
            <p className="text-center text-[12px] text-white/45">
              {stats.sites.toLocaleString()} sites visited · {stats.pageVisits.toLocaleString()} page loads · all server-side
            </p>
          )}
          <motion.button
            whileHover={fancy ? { scale: 1.04 } : undefined}
            whileTap={fancy ? { scale: 0.95 } : undefined}
            transition={{ type: "spring", stiffness: 460, damping: 24 }}
            onClick={onHome}
            className="flex items-center gap-2 rounded-full border border-white/15 bg-zinc-950/45 px-5 py-2.5 text-[12.5px] font-medium text-white/70 shadow-lg shadow-black/25 backdrop-blur-md transition hover:border-white/30 hover:bg-zinc-950/65 hover:text-white"
          >
            <LogOut aria-hidden className="veil-hover-wobble h-3.5 w-3.5" />
            Close all tabs and return to the start page
          </motion.button>
        </motion.div>
      </motion.div>
    </div>
  );
}
