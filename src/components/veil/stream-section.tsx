"use client";

/**
 * Veil Stream — Veil's own way to watch YouTube.
 *
 * Search, trending and playback where the browser talks ONLY to this
 * origin: metadata comes from /api/yt/* and every media byte (HLS
 * manifests, video segments, thumbnails, avatars) flows through the
 * /api/yt/s byte proxy. No YouTube script, embed or iframe — the
 * network sees plain traffic to Veil.
 *
 * Player: custom controls over a bare <video> — hls.js (dynamically
 * imported) for adaptive manifests, native playback for progressive
 * files, a quality menu (hls levels + available formats), seek + volume,
 * fullscreen, picture-in-picture, and keyboard shortcuts.
 *
 * Relay: when YouTube's rotating bot-gate slams the veil's exit shut
 * (datacenter IP flagged — every extractor gated at once), playback
 * falls back to RELAY mode: a chrome-less YouTube iframe driven by our
 * own control bar over the postMessage API. The stream rides the
 * viewer's own connection (residential, un-flagged) while search,
 * thumbnails and metadata keep flowing through the veil. Background
 * probing continues the whole time; the next video goes native again
 * the moment the gate rotates back open.
 */

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  BadgeCheck,
  Ban,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Clapperboard,
  Clock,
  Download,
  Flame,
  History as HistoryIcon,
  ListPlus,
  ListVideo,
  Loader2,
  Maximize,
  MessageSquare,
  MessagesSquare,
  Heart,
  HelpCircle,
  Minimize,
  MonitorPlay,
  MoreVertical,
  Pencil,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Repeat,
  RotateCcw,
  Rss,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Subtitles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
  Users,
  Upload,
  Volume2,
  VolumeX,
  X,
  Youtube,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { OfflineDownload } from "@/components/veil/offline-download";
import { fetchJsonSafe } from "@/lib/veil/shared";
import { rankFeed, type RankCard, type RankNotInterested, type RankResult } from "@/lib/veil/rank";
// Full-device backup engine — circular with this module by design:
// backup.ts reuses this file's merge-by-id stream importer, this file's
// data popover offers the backup UI. Both sides only call each other
// inside function bodies (never during module evaluation), so the cycle
// is safe under webpack/ESM.
import { describeRestore, exportVeilBackup, importVeilBackup } from "@/lib/veil/backup";
import {
  historyClear,
  historyCount,
  historyDelete,
  historyImportTakeout,
  historyMergeBackup,
  historyReady,
  historySerialize,
  historySettled,
  historySnapshot,
  historyTouch,
} from "@/lib/veil/history-store";
import {
  SUBS_FILE_RE,
  type TakeoutHistoryRow,
} from "@/lib/veil/takeout-parse";
import {
  runArchiveExtraction,
  type YouTubeImportProgress,
} from "@/lib/veil/takeout-spawn";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Types (mirror src/lib/veil/yt.ts)                                    */
/* ------------------------------------------------------------------ */

interface YtCard {
  id: string;
  title: string;
  author: string;
  authorId: string;
  verified: boolean;
  durationSec: number;
  views: number;
  published: string;
  /** absolute publish time (unix seconds) — powers channel sorting */
  publishedAt?: number;
  live: boolean;
  short?: boolean;
  /** real channel avatar/logo (same-origin proxy URL) — present when the
   * producing wire knew it; otherwise backfilled from the avatar store. */
  avatar?: string;
  /** why this card is in the feed (personalized items only) */
  why?: string;
  thumb: string;
}
interface YtFormat {
  kind: "hls" | "progressive" | "adaptive";
  label: string;
  mime: string;
  url: string;
  /** adaptive (video-only) tracks — powers the quality menu + picks. */
  height?: number;
  fps?: number;
  bitrate?: number;
}
interface YtVideo {
  card: YtCard;
  description: string;
  likes: number;
  /** dislike count — upstream usually hides it (0). */
  dislikes: number;
  authorAvatar: string;
  formats: YtFormat[];
  /** audio-only tracks, best bitrate first — the pairing half of the
   * adaptive (1080p+) combo. */
  audio: YtFormat[];
  /** closed-caption tracks (WebVTT through the byte proxy). */
  captions: { label: string; code: string; url: string }[];
  related: YtCard[];
}
interface YtGate {
  gated: true;
  message: string;
}
interface YtCommentItem {
  author: string;
  authorId: string;
  avatar: string;
  content: string;
  published: string;
  likes: number;
  replies: number;
  replyToken: string | null;
  pinned: boolean;
  verified: boolean;
}
interface YtCommentsAnswer {
  count: number;
  comments: YtCommentItem[];
  next: string | null;
  /** false = the newest-first ask couldn't be honored upstream right now. */
  sortApplied?: boolean;
}
type VideoAnswer = YtVideo | YtGate;
interface YtChannel {
  id: string;
  name: string;
  verified: boolean;
  avatar: string;
  subs: number;
  description: string;
  videos: YtCard[];
  shorts: YtCard[];
  /** continuation tokens — "Load more" pages either shelf deeper. */
  videosNext: string | null;
  shortsNext: string | null;
}

/** A community post from the channel's Posts tab (mirror of the server's
 * YtPost — same-origin proxied avatar/images). */
interface YtPost {
  id: string;
  author: string;
  avatar: string;
  published: string;
  likes: number;
  comments: number;
  text: string;
  images: string[];
  poll?: { question: string; options: { text: string; pct: number }[] };
}

/* ------------------------------------------------------------------ */
/* Browse pages — For You (main) + Shorts / Popular / History on the
/* right rail (folding into sticky pills on mobile)                    */
/* ------------------------------------------------------------------ */

type PageKey = "foryou" | "shorts" | "popular" | "subs" | "playlists" | "history";

/** For You filter chips — the YouTube-home row of slices over the
 * personalized feed (client-side, driven by subs / likes / history). */
type FyFilter = "all" | "subs" | "new" | "live" | "liked" | "watched";
const FY_CHIPS: { key: FyFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "subs", label: "From your subs" },
  { key: "new", label: "Recently uploaded" },
  { key: "live", label: "Live" },
  { key: "liked", label: "Liked" },
  { key: "watched", label: "Watched" },
];

const PAGE_NAV: { key: PageKey; label: string; icon: LucideIcon }[] = [
  { key: "foryou", label: "For You", icon: Sparkles },
  { key: "shorts", label: "Shorts", icon: Zap },
  { key: "popular", label: "Popular", icon: Flame },
  { key: "subs", label: "Subscriptions", icon: Rss },
  { key: "playlists", label: "Playlists", icon: ListVideo },
  { key: "history", label: "History", icon: HistoryIcon },
];

const PAGE_TONE: Record<PageKey, { chip: string; active: string; icon: string }> = {
  foryou: {
    chip: "bg-rose-500/20 text-rose-300 ring-rose-500/30",
    active: "bg-rose-500/15 ring-1 ring-rose-500/30 text-rose-100",
    icon: "text-rose-400",
  },
  shorts: {
    chip: "bg-fuchsia-500/20 text-fuchsia-300 ring-fuchsia-500/30",
    active: "bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30 text-fuchsia-100",
    icon: "text-fuchsia-400",
  },
  popular: {
    chip: "bg-amber-500/20 text-amber-300 ring-amber-500/30",
    active: "bg-amber-500/15 ring-1 ring-amber-500/30 text-amber-100",
    icon: "text-amber-400",
  },
  subs: {
    chip: "bg-cyan-500/20 text-cyan-300 ring-cyan-500/30",
    active: "bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-100",
    icon: "text-cyan-400",
  },
  playlists: {
    chip: "bg-violet-500/20 text-violet-300 ring-violet-500/30",
    active: "bg-violet-500/15 ring-1 ring-violet-500/30 text-violet-100",
    icon: "text-violet-400",
  },
  history: {
    chip: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/30",
    active: "bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-100",
    icon: "text-emerald-400",
  },
};

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                   */
/* ------------------------------------------------------------------ */

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function fmtSubs(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M subscribers`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K subscribers`;
  return `${n.toLocaleString("en-US")} subscribers`;
}

function ageLabel(published: string): string {
  if (!published) return "";
  if (!/T\d{2}:\d{2}/.test(published)) return published; // already "3 days ago"-ish
  const t = Date.parse(published);
  if (!Number.isFinite(t)) return published;
  const days = (Date.now() - t) / 86_400_000;
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${Math.floor(days)} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${days < 14 ? "" : "s"} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${days < 60 ? "" : "s"} ago`;
  const y = Math.floor(days / 365);
  return `${y} year${y < 2 ? "" : "s"} ago`;
}

/** Relative time for history timestamps — "just now" → "3 days ago".
 * Powers the Watch-again rail and the history captions. */
function relTime(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 45) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} min ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)} hour${h < 2 ? "" : "s"} ago`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)} day${d < 2 ? "" : "s"} ago`;
  if (d < 30) return `${Math.floor(d / 7)} week${d < 14 ? "" : "s"} ago`;
  if (d < 365) return `${Math.floor(d / 30)} month${d < 60 ? "" : "s"} ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y < 2 ? "" : "s"} ago`;
}

/* ------------------------------------------------------------------ */
/* Watch history — per device (IndexedDB, never leaves the browser)    */
/* ------------------------------------------------------------------ */

interface HistoryEntry {
  card: YtCard;
  at: number;
}
const HISTORY_KEY = "veil.stream.history.v1";
/* The store lives in IndexedDB (see lib/veil/history-store.ts) — the
 * same "veil.stream.history.v1" NAME survives in backups/exports, but
 * a million rows now actually persist instead of dying on
 * localStorage's ~5MB quota. The row cap (HISTORY_CAP, 1,000,000)
 * lives in the store — parse, persist and UI all agree on it. */
const HISTORY_PAUSED_KEY = "veil.stream.history.paused.v1";

/** Paused watch history (YouTube's "pause watch history"): while on,
 * watching videos records nothing — so nothing gets hidden from the For
 * You feed either (the watched filter rides the same store). Existing
 * history is kept untouched; imports still merge when run explicitly. */
function historyPaused(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HISTORY_PAUSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setHistoryPaused(paused: boolean): void {
  try {
    window.localStorage.setItem(HISTORY_PAUSED_KEY, paused ? "1" : "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event("veil-stream-history-paused"));
}

function readHistory(): HistoryEntry[] {
  /* the IndexedDB store's in-memory mirror — newest-first, deduped by
   * video id, primed by historyReady() at startup (and by the module's
   * auto-kick). READ-ONLY: callers sort/slice into copies. */
  return historySnapshot<YtCard>() as HistoryEntry[];
}

/** The channels this device watches most (by watch count) — sent up with
 * the For You request so the server can blend their newest uploads into
 * the feed. Nothing is tracked server-side; the list lives only in this
 * browser's localStorage. */
function topWatchedChannels(n: number): string[] {
  const score = new Map<string, number>();
  for (const h of readHistory()) {
    const a = h.card?.authorId;
    if (a) score.set(a, (score.get(a) ?? 0) + 1);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

/** The videos this device watched most recently (newest first — history
 * is deduped by id) — sent up with the For You request so the server can
 * weave in YouTube's own "up next" recommendations for them. */
function topWatchedVideos(n: number): string[] {
  return readHistory()
    .map((h) => h.card?.id)
    .filter((id): id is string => Boolean(id))
    .slice(0, n);
}

/** Watched-id cache — one shared parse per history change, not one per
 * card render. Invalidated by the history store's event (every mirror
 * mutation) and by the local mutation helpers. */
let _watchedIds: Set<string> | null = null;
function watchedIdsSnapshot(): Set<string> {
  if (!_watchedIds) {
    _watchedIds = new Set(
      readHistory()
        .map((h) => h.card?.id)
        .filter((id): id is string => Boolean(id)),
    );
  }
  return _watchedIds;
}

/** Re-render hook: bumps whenever the watch history changes anywhere
 * (a watch, a clear, an import). */
function useHistoryVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    const bump = () => {
      _watchedIds = null;
      setV((x) => x + 1);
    };
    window.addEventListener("veil-stream-history", bump);
    return () => window.removeEventListener("veil-stream-history", bump);
  }, []);
  return v;
}

/** Reactive copy of the pause-history flag — the History page toggle, the
 * For You rail caption and pushHistory all stay in lock-step. */
function useHistoryPaused(): boolean {
  const [paused, setPaused] = React.useState(false);
  React.useEffect(() => {
    const read = () => setPaused(historyPaused());
    read();
    window.addEventListener("veil-stream-history-paused", read);
    return () => window.removeEventListener("veil-stream-history-paused", read);
  }, []);
  return paused;
}

/* ------------------------------------------------------------------ */
/* Player preferences + like/dislike state (per device, localStorage)   */
/* ------------------------------------------------------------------ */

/** Everything the player settings menu controls. `maxHeight` caps the
 * adaptive-combo pick (quality preference), `speed` is the playback rate,
 * `loop` replays, `relayQuality` is the YouTube-embed quality preference
 * for the relay lane ("auto" lets YouTube decide). Saved values apply to
 * every NEW video/short; speed applies live to the playing one too. */
interface StreamPrefs {
  maxHeight: number;
  speed: number;
  loop: boolean;
  relayQuality: string;
}
const PREFS_KEY = "veil.stream.prefs.v1";
const DEFAULT_PREFS: StreamPrefs = { maxHeight: 1080, speed: 1, loop: false, relayQuality: "auto" };
const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** The relay lane's quality ladder — YouTube's own quality ids (driven over
 * the iframe API's setPlaybackQuality). "auto" is YouTube's decision. */
const RELAY_QUALITIES: { v: string; label: string }[] = [
  { v: "auto", label: "Auto" },
  { v: "tiny", label: "144p" },
  { v: "small", label: "240p" },
  { v: "medium", label: "360p" },
  { v: "large", label: "480p" },
  { v: "hd720", label: "720p" },
  { v: "hd1080", label: "1080p" },
  { v: "hd1440", label: "1440p" },
  { v: "hd2160", label: "4K" },
];
const RELAY_QUALITY_VALUES = new Set(RELAY_QUALITIES.map((q) => q.v));
/** Pixel viewports for the relay quality ladder. YouTube's embed picks its
 * rung from the iframe's LAYOUT size (setPlaybackQuality is a deprecated
 * no-op in modern embeds), so a picked quality renders the frame at that
 * rung's pixel size and CSS-scales it to fit the shell — the mechanism the
 * quality chooser actually steers with. */
const RELAY_Q_SIZES: Record<string, [number, number]> = {
  tiny: [256, 144],
  small: [426, 240],
  medium: [640, 360],
  large: [854, 480],
  hd720: [1280, 720],
  hd1080: [1920, 1080],
  hd1440: [2560, 1440],
  hd2160: [3840, 2160],
};
/** YouTube quality id → display label ("hd1080" → "1080p"). */
function relayQualityLabel(v: string): string {
  if (!v) return "";
  return RELAY_QUALITIES.find((q) => q.v === v)?.label ?? v;
}

function readPrefs(): StreamPrefs {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<StreamPrefs>;
    return {
      maxHeight: typeof p.maxHeight === "number" && p.maxHeight > 0 ? p.maxHeight : DEFAULT_PREFS.maxHeight,
      speed: typeof p.speed === "number" && p.speed > 0 && p.speed <= 4 ? p.speed : 1,
      loop: Boolean(p.loop),
      relayQuality:
        typeof p.relayQuality === "string" && RELAY_QUALITY_VALUES.has(p.relayQuality)
          ? p.relayQuality
          : "auto",
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Write a patch + tell every mounted player (a window event keeps
 * module state simple across the three player surfaces). */
function savePrefs(patch: Partial<StreamPrefs>): void {
  try {
    const next = { ...readPrefs(), ...patch };
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("veil-stream-prefs"));
  } catch {
    /* storage unavailable — prefs stay for this view only */
  }
}

/** Re-render hook: bumps whenever prefs change anywhere. */
function usePrefsVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener("veil-stream-prefs", bump);
    return () => window.removeEventListener("veil-stream-prefs", bump);
  }, []);
  return v;
}

/** The user's like/dislike per video — local only (nothing leaves the
 * browser; YouTube's real counts stay authoritative on the count text). */
type Rating = "like" | "dislike";
const RATINGS_KEY = "veil.stream.ratings.v1";

function readAllRatings(): Record<string, Rating> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RATINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Rating>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readRating(id: string): Rating | null {
  return readAllRatings()[id] ?? null;
}

/** Which channel a liked video belongs to — recorded at like time so the
 * feed can boost "channels you liked" even after history rotates. Older
 * likes (recorded before this map existed) backfill off history. */
interface LikedMetaEntry {
  authorId?: string;
  author?: string;
}
const LIKED_META_KEY = "veil.stream.likedMeta.v1";

function readLikedMeta(): Record<string, LikedMetaEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LIKED_META_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, LikedMetaEntry>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRating(id: string, r: Rating | null, chan?: LikedMetaEntry): void {
  try {
    const all = readAllRatings();
    if (r) all[id] = r;
    else delete all[id];
    window.localStorage.setItem(RATINGS_KEY, JSON.stringify(all));
    /* remember (or forget) the channel behind the like — the feed's
     * "channels you liked" boost rides on this */
    const meta = readLikedMeta();
    if (r === "like") meta[id] = { authorId: chan?.authorId, author: chan?.author };
    else delete meta[id];
    window.localStorage.setItem(LIKED_META_KEY, JSON.stringify(meta));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event("veil-stream-ratings"));
}

/** The channels behind this device's LIKED videos — the strongest signal
 * the For You / Shorts blends get (together with subscriptions). Older
 * likes backfill off history when the meta map doesn't know them; the
 * backfill map is built lazily so a million-row history is only walked
 * when a liked video actually needs it. */
function likedChannelIds(): string[] {
  const ratings = readAllRatings();
  const meta = readLikedMeta();
  const ids = new Set<string>();
  let byVideo: Map<string, string> | null = null;
  for (const [vid, r] of Object.entries(ratings)) {
    if (r !== "like") continue;
    const m = meta[vid]?.authorId;
    if (m) {
      ids.add(m);
      continue;
    }
    if (byVideo === null) {
      byVideo = new Map();
      for (const h of readHistory()) {
        const v = h.card?.id;
        const a = h.card?.authorId;
        if (v && a) byVideo.set(v, a);
      }
    }
    const a = byVideo.get(vid);
    if (a) ids.add(a);
  }
  return [...ids];
}

/* ------------------------------------------------------------------ */
/* Subscriptions (per device — the server never stores the follow list) */
/* ------------------------------------------------------------------ */

interface SubEntry {
  name: string;
  avatar?: string;
  at: number;
}
const SUBS_KEY = "veil.stream.subs.v1";

function readSubs(): Record<string, SubEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SUBS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, SubEntry>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSubs(map: Record<string, SubEntry>): void {
  try {
    window.localStorage.setItem(SUBS_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event("veil-stream-subs"));
}

/** Toggle a follow. Returns the NEW state (true = subscribed). */
function toggleSub(id: string, entry: SubEntry): boolean {
  if (!id) return false;
  const all = readSubs();
  if (all[id]) delete all[id];
  else all[id] = entry;
  writeSubs(all);
  return Boolean(all[id]);
}

/** Re-render hook: bumps whenever the follow list changes anywhere. */
function useSubsVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener("veil-stream-subs", bump);
    return () => window.removeEventListener("veil-stream-subs", bump);
  }, []);
  return v;
}

/** The channels this device wants MORE of — its subscriptions plus the
 * channels behind its liked videos. Sent with the For You + Shorts
 * requests; the server widens exactly those channels' rails (the user's
 * standing order: see more from channels you liked / subscribed to). */
function boostChannelIds(cap = 8): string[] {
  return [...new Set([...Object.keys(readSubs()), ...likedChannelIds()])].slice(0, cap);
}

/* ------------------------------------------------------------------ */
/* "Not interested" / "Don't recommend channel" — YouTube's negative    */
/* feedback loop (veil.stream.notinterested.v1, rides the Takeout)      */
/* ------------------------------------------------------------------ */

interface NotInterestedEntry {
  title?: string;
  authorId?: string;
  at: number;
}

interface NotInterestedStore {
  /** video id → entry — "Not interested": video hidden + topic/channel
   * penalties feed rank.ts's satisfaction objective. */
  videos: Record<string, NotInterestedEntry>;
  /** authorId → entry — "Don't recommend channel": channel removed from
   * the recommendation surfaces entirely. */
  channels: Record<string, NotInterestedEntry>;
}

const NOTINTERESTED_KEY = "veil.stream.notinterested.v1";
const NI_EVENT = "veil-stream-notinterested";

function readNotInterested(): NotInterestedStore {
  if (typeof window === "undefined") return { videos: {}, channels: {} };
  try {
    const raw = window.localStorage.getItem(NOTINTERESTED_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<NotInterestedStore>) : {};
    const s: NotInterestedStore = {
      videos: parsed.videos && typeof parsed.videos === "object" ? (parsed.videos as NotInterestedStore["videos"]) : {},
      channels:
        parsed.channels && typeof parsed.channels === "object"
          ? (parsed.channels as NotInterestedStore["channels"])
          : {},
    };
    /* prune disinterest older than 30 days — "not interested" fades,
     * the same way YouTube gradually forgets old feedback */
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const [id, e] of Object.entries(s.videos)) if (!e || e.at < cutoff) delete s.videos[id];
    for (const [id, e] of Object.entries(s.channels)) if (!e || e.at < cutoff) delete s.channels[id];
    return s;
  } catch {
    return { videos: {}, channels: {} };
  }
}

function writeNotInterested(s: NotInterestedStore): void {
  try {
    window.localStorage.setItem(NOTINTERESTED_KEY, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event(NI_EVENT));
}

function markNotInterested(card: YtCard): void {
  const s = readNotInterested();
  s.videos[card.id] = { title: card.title, authorId: card.authorId || undefined, at: Date.now() };
  writeNotInterested(s);
}

function unmarkNotInterested(card: YtCard): void {
  const s = readNotInterested();
  delete s.videos[card.id];
  writeNotInterested(s);
}

function blockChannel(card: YtCard): void {
  if (!card.authorId) return;
  const s = readNotInterested();
  s.channels[card.authorId] = { title: card.author, authorId: card.authorId, at: Date.now() };
  writeNotInterested(s);
}

function unblockChannel(card: YtCard): void {
  if (!card.authorId) return;
  const s = readNotInterested();
  delete s.channels[card.authorId];
  writeNotInterested(s);
}

/** rank.ts signal builders — the raw store mapped into the ranker's
 * negative-feedback shapes. */
function niSignal(): { notInterested: RankNotInterested[]; blockedChannels: string[] } {
  const s = readNotInterested();
  return {
    notInterested: Object.entries(s.videos).map(([id, e]) => ({
      id,
      title: e.title,
      authorId: e.authorId,
      at: e.at,
    })),
    blockedChannels: Object.keys(s.channels),
  };
}

/** Hard filter for the non-ranked surfaces (shorts rails, search,
 * popular, up-next): drop hidden videos + blocked channels. */
function filterFeedback<T extends { id: string; authorId?: string }>(cards: T[]): T[] {
  const s = niSnapshot();
  if (Object.keys(s.videos).length === 0 && Object.keys(s.channels).length === 0) return cards;
  return cards.filter((c) => !s.videos[c.id] && !(c.authorId && s.channels[c.authorId]));
}

/** Cached store snapshot (refreshed by the version bump) so the filter
 * above stays cheap on big lists. */
let _niSnapshot: NotInterestedStore | null = null;
function niSnapshot(): NotInterestedStore {
  if (!_niSnapshot) _niSnapshot = readNotInterested();
  return _niSnapshot;
}

/** Re-render + cache-invalidate hook: bumps whenever negative feedback
 * is added/removed/undone anywhere in the app. Mount forces one fresh
 * read (another surface — e.g. Settings' import — may have written the
 * store while Stream was unmounted). */
function useNotInterestedVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    _niSnapshot = null; // fresh read on every mount
    const bump = () => {
      _niSnapshot = null;
      setV((x) => x + 1);
    };
    window.addEventListener(NI_EVENT, bump);
    return () => {
      _niSnapshot = null;
      window.removeEventListener(NI_EVENT, bump);
    };
  }, []);
  return v;
}

/* The card feedback actions, provided by StreamSection so every card
 * surface (For You grid, shorts rails, search, up-next) gets the
 * ⋮ menu without prop drilling through ten call sites. */
interface CardFeedbackActions {
  notInterested: (card: YtCard) => void;
  blockChannel: (card: YtCard) => void;
}
const CardFeedbackCtx = React.createContext<CardFeedbackActions | null>(null);

/** The ⋮ menu itself — YouTube's card overflow: shows on hover/focus,
 * offers "Not interested" + "Don't recommend channel". */
/** Fresh-deal sampler for the For You wire (module-level helper).
 *
 * The complaint this answers: "the same videos every time, just in a
 * different order". The wire itself is deterministic (trending + rails
 * blend), so order-only jitter was never enough. Every fresh load keeps
 * the blend's curated HEAD (its best picks still always surface) and
 * then a seeded-random slice of the tail — two reloads deal two visibly
 * different SETS, while a single session's pagination stays append-only
 * and stable. The dropped slots are refilled by the immediate deep river
 * round in loadFeed, so the page is never left short. */
function dealFreshHand(cards: YtCard[]): YtCard[] {
  if (cards.length <= 12) return cards;
  const HEAD = 10; /* the curated top of the blend — always kept */
  const KEEP_TAIL = 0.55; /* seeded-random slice of the rest */
  let seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  const rand = () => {
    /* mulberry32 — deterministic within a deal, fresh every deal */
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const head = cards.slice(0, HEAD);
  const tail = cards.slice(HEAD).filter(() => rand() < KEEP_TAIL);
  return [...head, ...tail];
}

function CardFeedbackMenu({ card }: { card: YtCard }) {
  const feedback = React.useContext(CardFeedbackCtx);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        /* swallow Esc here — the open menu owns it; without this the
         * keypress ALSO reaches the start page's window listener and
         * closes the whole Stream section (annoying, and confusing). */
        e.stopPropagation();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  if (!feedback) return null;

  return (
    <div ref={wrapRef} className="absolute right-1.5 top-1.5 z-10">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Feedback for ${card.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`grid size-7 place-items-center rounded-full bg-black/80 text-zinc-200 shadow-lg shadow-black/50 ring-1 ring-white/10 backdrop-blur-sm transition-opacity duration-200 hover:bg-black hover:text-white focus-visible:opacity-100 ${
          open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
        }`}
      >
        <MoreVertical aria-hidden className="size-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Card feedback"
            initial={{ opacity: 0, scale: 0.92, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: -4 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 top-9 w-56 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl shadow-black/70 backdrop-blur-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                feedback.notInterested(card);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-zinc-200 transition hover:bg-white/5"
            >
              <ThumbsDown aria-hidden className="size-4 shrink-0 text-zinc-400" />
              <span className="min-w-0">
                Not interested
                <span className="block text-[10.5px] leading-tight text-zinc-500">
                  fewer videos like this
                </span>
              </span>
            </button>
            {card.authorId && (
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  feedback.blockChannel(card);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium text-zinc-200 transition hover:bg-white/5"
              >
                <Ban aria-hidden className="size-4 shrink-0 text-zinc-400" />
                <span className="min-w-0">
                  Don&apos;t recommend channel
                  <span className="block truncate text-[10.5px] leading-tight text-zinc-500">
                    {card.author}
                  </span>
                </span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The YouTube-style feedback snackbar: "Video removed · UNDO". */
function FeedbackSnackbar({
  note,
  onDismiss,
}: {
  note: { text: string; sub: string; undo: () => void } | null;
  onDismiss: () => void;
}) {
  React.useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(t);
  }, [note, onDismiss]);

  return (
    <AnimatePresence>
      {note && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.96 }}
          transition={{ duration: 0.2 }}
          className="pointer-events-auto fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-zinc-700/80 bg-zinc-900/95 px-4 py-3 shadow-2xl shadow-black/70 backdrop-blur-md"
        >
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-zinc-100">{note.text}</p>
            <p className="text-[11px] leading-tight text-zinc-500">{note.sub}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              note.undo();
              onDismiss();
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-sky-300 transition hover:bg-sky-400/10"
          >
            <Undo2 aria-hidden className="size-3.5" /> Undo
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
          >
            <X aria-hidden className="size-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Re-render hook: bumps whenever a like/dislike changes anywhere. */
function useRatingsVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener("veil-stream-ratings", bump);
    return () => window.removeEventListener("veil-stream-ratings", bump);
  }, []);
  return v;
}

/* ------------------------------------------------------------------ */
/* Channel avatars (per device) — the REAL channel logos                */
/*                                                                     */
/* Cards carry `avatar` whenever the wire that produced them knew it   */
/* (channel rails, subs, popular). Anything missing is backfilled in   */
/* one batched /api/yt/avatars round-trip per view, cached forever in  */
/* localStorage under the versioned veil.stream.* key convention       */
/* (so it rides the export/import Takeout like every other key).       */
/* ------------------------------------------------------------------ */

const AVATARS_KEY = "veil.stream.avatars.v1";
const AVATARS_CAP = 600;

function readAvatarMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(AVATARS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** In-memory avatar store — a Map + a version counter subscribers
 * re-render on. Cards re-render with their real logo the moment a
 * backfill lands, without any prop drilling. */
const avatarStore = {
  map: new Map<string, string>(Object.entries(readAvatarMap())),
  version: 0,
  subs: new Set<() => void>(),
  get(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return avatarStore.map.get(id);
  },
  put(entries: Record<string, string>): void {
    let added = false;
    for (const [id, url] of Object.entries(entries)) {
      if (!id || typeof url !== "string" || !url) continue;
      if (avatarStore.map.get(id) === url) continue;
      avatarStore.map.set(id, url);
      added = true;
    }
    if (!added) return;
    /* persist (LRU-ish: newest entries win, cap the on-disk size) */
    try {
      const all = Object.fromEntries(avatarStore.map.entries());
      const keys = Object.keys(all);
      if (keys.length > AVATARS_CAP) {
        for (const k of keys.slice(0, keys.length - AVATARS_CAP)) delete all[k];
      }
      window.localStorage.setItem(AVATARS_KEY, JSON.stringify(all));
    } catch {
      /* best-effort */
    }
    avatarStore.version++;
    avatarStore.subs.forEach((fn) => fn());
  },
};

/** Re-render hook: bumps whenever the avatar store gains entries. */
function useAvatarVersion(): number {
  const [v, setV] = React.useState(avatarStore.version);
  React.useEffect(() => {
    const bump = () => setV(avatarStore.version);
    avatarStore.subs.add(bump);
    return () => {
      avatarStore.subs.delete(bump);
    };
  }, []);
  return v;
}

/** Batched avatar backfill — pass the cards currently on screen; the
 * distinct channel ids missing from the store (and missing on the cards
 * themselves) go out in ONE /api/yt/avatars request, up to 30 ids. The
 * store bumps + persists when the answer lands, and every mounted card
 * re-renders with its real logo. Runs at most once per input change. */
function useAvatarBackfill(cards: YtCard[]): void {
  React.useEffect(() => {
    if (typeof window === "undefined" || cards.length === 0) return;
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const c of cards) {
      const id = c?.authorId;
      if (!id || seen.has(id) || c.avatar || avatarStore.map.has(id)) continue;
      seen.add(id);
      missing.push(id);
    }
    if (missing.length === 0) return;
    const ids = missing.slice(0, 30).join(",");
    let alive = true;
    fetchJsonSafe<{ avatars?: Record<string, string> }>(`/api/yt/avatars?ids=${encodeURIComponent(ids)}`)
      .then((body) => {
        if (!alive) return;
        if (body?.avatars && typeof body.avatars === "object") avatarStore.put(body.avatars);
      })
      .catch(() => {
        /* avatars are progressive enhancement — a failed backfill just
         * keeps the gradient initials */
      });
    return () => {
      alive = false;
    };
  }, [cards]);
}

/* ------------------------------------------------------------------ */
/* Playlists (per device) — Watch Later + named lists, marathon-capable  */
/* ------------------------------------------------------------------ */

interface Playlist {
  id: string;
  name: string;
  at: number;
  items: YtCard[];
}
const PLAYLISTS_KEY = "veil.stream.playlists.v1";
const WATCH_LATER_ID = "watchlater";
const WATCH_LATER_NAME = "Watch Later";

function readPlaylists(): Playlist[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PLAYLISTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Playlist[]) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => p && p.id && Array.isArray(p.items)) : [];
  } catch {
    return [];
  }
}

function writePlaylists(list: Playlist[]): void {
  try {
    window.localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event("veil-stream-playlists"));
}

/** The Watch Later list, lazily created at the head of the array. */
function watchLaterOf(list: Playlist[]): Playlist {
  const hit = list.find((p) => p.id === WATCH_LATER_ID);
  if (hit) return hit;
  const fresh: Playlist = { id: WATCH_LATER_ID, name: WATCH_LATER_NAME, at: 0, items: [] };
  list.unshift(fresh);
  return fresh;
}

function createPlaylist(name: string): Playlist | null {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const list = readPlaylists();
  const existing = list.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const pl: Playlist = {
    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: clean,
    at: Date.now(),
    items: [],
  };
  writePlaylists([...list, pl]);
  return pl;
}

function renamePlaylist(id: string, name: string): void {
  const clean = name.trim().slice(0, 60);
  if (!clean || id === WATCH_LATER_ID) return;
  writePlaylists(readPlaylists().map((p) => (p.id === id ? { ...p, name: clean } : p)));
}

function deletePlaylist(id: string): void {
  if (id === WATCH_LATER_ID) return;
  writePlaylists(readPlaylists().filter((p) => p.id !== id));
}

/** Toggle a video's membership. Returns true when it's IN after. */
function togglePlaylistVideo(plId: string, card: YtCard): boolean {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === plId) ?? (plId === WATCH_LATER_ID ? watchLaterOf(list) : undefined);
  if (!pl) return false;
  const have = pl.items.some((i) => i.id === card.id);
  pl.items = have ? pl.items.filter((i) => i.id !== card.id) : [card, ...pl.items];
  writePlaylists(list);
  return !have;
}

function removeFromPlaylist(plId: string, videoId: string): void {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === plId);
  if (!pl) return;
  pl.items = pl.items.filter((i) => i.id !== videoId);
  writePlaylists(list);
}

/** Move an item one slot (dir = -1 up / +1 down). */
function movePlaylistVideo(plId: string, videoId: string, dir: -1 | 1): void {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === plId);
  if (!pl) return;
  const i = pl.items.findIndex((x) => x.id === videoId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pl.items.length) return;
  const items = [...pl.items];
  [items[i], items[j]] = [items[j], items[i]];
  pl.items = items;
  writePlaylists(list);
}

/** Re-render hook: bumps whenever playlists change anywhere. */
function usePlaylistsVersion(): number {
  const [v, setV] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener("veil-stream-playlists", bump);
    return () => window.removeEventListener("veil-stream-playlists", bump);
  }, []);
  return v;
}

/* ------------------------------------------------------------------ */
/* Data portability — export / import the veil.stream.* keys            */
/* (Takeout-style: one JSON file, every value the raw on-disk string)    */
/* ------------------------------------------------------------------ */

const STREAM_DATA_PREFIX = "veil.stream.";

/** A one-glance count of everything Stream keeps on this device — shown
 * in Settings → Data next to the Takeout export/import card. */
export function streamDataStats(): {
  history: number;
  subs: number;
  playlists: number;
  liked: number;
  avatars: number;
  hidden: number;
} {
  const ratings = readAllRatings();
  const ni = readNotInterested();
  return {
    history: historyCount(),
    subs: Object.keys(readSubs()).length,
    playlists: readPlaylists().length,
    liked: Object.values(ratings).filter((r) => r === "like").length,
    avatars: Object.keys(readAvatarMap()).length,
    hidden: Object.keys(ni.videos).length + Object.keys(ni.channels).length,
  };
}

/** Collect every veil.stream.* localStorage entry as { key: rawString } —
 * the exact on-disk format, importable on any device/browser. The watch
 * history now lives in IndexedDB, so its legacy key is re-injected from
 * the mirror — exports keep the exact same shape they always had. */
export function exportStreamDataMap(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === "undefined") return out;
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(STREAM_DATA_PREFIX)) out[k] = window.localStorage.getItem(k) ?? "";
  }
  const hist = historySerialize();
  if (hist !== "[]") out[HISTORY_KEY] = hist;
  return out;
}

interface StreamImportSummary {
  history: number;
  subs: number;
  playlists: number;
  liked: number;
  prefs: boolean;
  notInterested?: number;
}

/** Merge a Veil data export into this device. Accepts the flat
 * { "veil.stream.x": "…json…" } map (values may also be pre-parsed
 * objects/arrays). Collections merge by id — nothing is overwritten or
 * deleted; for history the newest `at` wins, playlists union their
 * items, subscriptions only ADD channels, prefs replace when present. */
export function importStreamDataMap(raw: string): StreamImportSummary {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("not a Veil data export — expected a JSON object of veil.stream.* keys");
  }
  const root = parsed as Record<string, unknown>;
  const readKey = <T,>(key: string): T | undefined => {
    if (!(key in root)) return undefined;
    const v = root[key];
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as T;
      } catch {
        return undefined;
      }
    }
    return v as T;
  };

  const summary: StreamImportSummary = { history: 0, subs: 0, playlists: 0, liked: 0, prefs: false };

  /* history — merge by video id, newest `at` wins, cap applied (the
   * IndexedDB store merges synchronously into its mirror and persists
   * in chunked background transactions) */
  const inHist = readKey<HistoryEntry[]>(HISTORY_KEY);
  if (Array.isArray(inHist)) {
    _watchedIds = null;
    summary.history = historyMergeBackup(inHist);
  }

  /* subscriptions — merge; an import never unsubscribes anything */
  const inSubs = readKey<Record<string, SubEntry>>(SUBS_KEY);
  if (inSubs && typeof inSubs === "object" && !Array.isArray(inSubs)) {
    const cur = readSubs();
    for (const [id, e] of Object.entries(inSubs)) {
      if (!id || !e || typeof e !== "object" || cur[id]) continue;
      const entry = e as SubEntry;
      cur[id] = {
        name: String(entry.name ?? id).slice(0, 80),
        avatar: typeof entry.avatar === "string" ? entry.avatar : undefined,
        at: typeof entry.at === "number" ? entry.at : Date.now(),
      };
    }
    writeSubs(cur);
    summary.subs = Object.keys(cur).length;
  }

  /* playlists — merge by playlist id, items unioned (existing order first) */
  const inPls = readKey<Playlist[]>(PLAYLISTS_KEY);
  if (Array.isArray(inPls)) {
    const cur = readPlaylists();
    for (const pl of inPls) {
      if (!pl || typeof pl !== "object" || !pl.id || !Array.isArray(pl.items)) continue;
      const hit = cur.find((p) => p.id === pl.id);
      if (!hit) {
        cur.push({
          id: String(pl.id).slice(0, 60),
          name: String(pl.name ?? "Playlist").slice(0, 60),
          at: typeof pl.at === "number" ? pl.at : Date.now(),
          items: pl.items.filter((c) => c && typeof c === "object" && c.id).slice(0, 500),
        });
        continue;
      }
      const have = new Set(hit.items.map((c) => c.id));
      for (const c of pl.items) {
        if (c && typeof c === "object" && c.id && !have.has(c.id)) hit.items.push(c);
      }
      if (!hit.name && pl.name) hit.name = String(pl.name).slice(0, 60);
    }
    /* keep Watch Later at the head, then oldest-first like YouTube */
    cur.sort((a, b) => (a.id === WATCH_LATER_ID ? -1 : b.id === WATCH_LATER_ID ? 1 : (a.at ?? 0) - (b.at ?? 0)));
    writePlaylists(cur);
    summary.playlists = cur.length;
  }

  /* ratings + liked meta — merge; a rating only fills a blank */
  const inRatings = readKey<Record<string, Rating>>(RATINGS_KEY);
  if (inRatings && typeof inRatings === "object" && !Array.isArray(inRatings)) {
    const cur = readAllRatings();
    for (const [id, r] of Object.entries(inRatings)) {
      if ((r === "like" || r === "dislike") && !cur[id]) cur[id] = r;
    }
    try {
      window.localStorage.setItem(RATINGS_KEY, JSON.stringify(cur));
    } catch {
      /* best-effort */
    }
    summary.liked = Object.values(cur).filter((r) => r === "like").length;
  }
  const inMeta = readKey<Record<string, LikedMetaEntry>>(LIKED_META_KEY);
  if (inMeta && typeof inMeta === "object" && !Array.isArray(inMeta)) {
    const cur = readLikedMeta();
    for (const [id, m] of Object.entries(inMeta)) {
      if (id && m && typeof m === "object" && !cur[id]) cur[id] = m;
    }
    try {
      window.localStorage.setItem(LIKED_META_KEY, JSON.stringify(cur));
    } catch {
      /* best-effort */
    }
  }
  if (inRatings || inMeta) window.dispatchEvent(new Event("veil-stream-ratings"));

  /* channel avatars — merge the map (union; newer URLs win), capped */
  const inAvatars = readKey<Record<string, string>>(AVATARS_KEY);
  if (inAvatars && typeof inAvatars === "object" && !Array.isArray(inAvatars)) {
    const merged = { ...readAvatarMap() };
    let n = 0;
    for (const [id, url] of Object.entries(inAvatars)) {
      if (!id || typeof url !== "string" || !url) continue;
      if (!merged[id] || merged[id] !== url) {
        merged[id] = url;
        n++;
      }
    }
    if (n > 0) {
      try {
        const keys = Object.keys(merged);
        if (keys.length > AVATARS_CAP) {
          for (const k of keys.slice(0, keys.length - AVATARS_CAP)) delete merged[k];
        }
        window.localStorage.setItem(AVATARS_KEY, JSON.stringify(merged));
        avatarStore.put(merged);
      } catch {
        /* best-effort */
      }
    }
  }

  /* prefs — replace wholesale when present */
  const inPrefs = readKey<StreamPrefs>(PREFS_KEY);
  if (inPrefs && typeof inPrefs === "object") {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(inPrefs));
      summary.prefs = true;
    } catch {
      /* best-effort */
    }
  }

  /* negative feedback — union merge (newest entry per video/channel
   * wins); an import never silently forgets disinterest */
  const inNi = readKey<NotInterestedStore>(NOTINTERESTED_KEY);
  if (inNi && typeof inNi === "object") {
    const cur = readNotInterested();
    let merged = 0;
    for (const [id, e] of Object.entries(inNi.videos ?? {})) {
      if (!e || typeof e !== "object") continue;
      if (!cur.videos[id] || (e.at ?? 0) > cur.videos[id].at) {
        cur.videos[id] = { title: e.title, authorId: e.authorId, at: e.at ?? Date.now() };
        merged++;
      }
    }
    for (const [id, e] of Object.entries(inNi.channels ?? {})) {
      if (!e || typeof e !== "object") continue;
      if (!cur.channels[id] || (e.at ?? 0) > cur.channels[id].at) {
        cur.channels[id] = { title: e.title, authorId: e.authorId, at: e.at ?? Date.now() };
        merged++;
      }
    }
    if (merged > 0) {
      writeNotInterested(cur);
      summary.notInterested = Object.keys(cur.videos).length + Object.keys(cur.channels).length;
    }
  }

  /* any other veil.stream.* keys — copy verbatim (future-proof) */
  const known = [HISTORY_KEY, SUBS_KEY, PLAYLISTS_KEY, RATINGS_KEY, LIKED_META_KEY, PREFS_KEY, AVATARS_KEY, NOTINTERESTED_KEY];
  for (const [k, v] of Object.entries(root)) {
    if (!k.startsWith(STREAM_DATA_PREFIX) || known.includes(k) || typeof v !== "string") continue;
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* best-effort */
    }
  }

  return summary;
}

/** The like/dislike pill pair for the watch views. Counts come from the
 * video answer (0 = hidden); the pressed state is this device's own. */
function LikeBar({
  videoId,
  likes,
  dislikes,
  chan,
}: {
  videoId: string;
  likes: number;
  dislikes: number;
  chan?: LikedMetaEntry;
}) {
  const [mine, setMine] = React.useState<Rating | null>(() => readRating(videoId));
  React.useEffect(() => setMine(readRating(videoId)), [videoId]);
  const toggle = (r: Rating) => {
    const next = mine === r ? null : r;
    writeRating(videoId, next, chan);
    setMine(next);
  };
  return (
    <div className="flex items-stretch overflow-hidden rounded-full border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => toggle("like")}
        aria-pressed={mine === "like"}
        aria-label={mine === "like" ? "Remove like" : "Like this video"}
        className={cn(
          "flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-semibold tabular-nums transition",
          mine === "like" ? "bg-rose-500/15 text-rose-300" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
        )}
      >
        <ThumbsUp aria-hidden className={cn("size-3.5", mine === "like" && "fill-current")} />
        {fmtCount(likes + (mine === "like" ? 1 : 0))}
      </button>
      <span aria-hidden className="w-px bg-zinc-800" />
      <button
        type="button"
        onClick={() => toggle("dislike")}
        aria-pressed={mine === "dislike"}
        aria-label={mine === "dislike" ? "Remove dislike" : "Dislike this video"}
        className={cn(
          "flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-semibold tabular-nums transition",
          mine === "dislike" ? "bg-rose-500/15 text-rose-300" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
        )}
      >
        <ThumbsDown aria-hidden className={cn("size-3.5", mine === "dislike" && "fill-current")} />
        {dislikes > 0 ? fmtCount(dislikes + (mine === "dislike" ? 1 : 0)) : <span className="sr-only">dislike count hidden</span>}
      </button>
    </div>
  );
}

/** The vertical like/dislike pair for a shorts slide — TikTok-style rail
 * buttons with the like count under the thumb. */
function ShortLikeButtons({
  videoId,
  likes,
  chan,
}: {
  videoId: string;
  likes: number;
  chan?: LikedMetaEntry;
}) {
  const [mine, setMine] = React.useState<Rating | null>(() => readRating(videoId));
  React.useEffect(() => setMine(readRating(videoId)), [videoId]);
  const toggle = (r: Rating) => {
    const next = mine === r ? null : r;
    writeRating(videoId, next, chan);
    setMine(next);
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => toggle("like")}
        aria-pressed={mine === "like"}
        aria-label={mine === "like" ? "Remove like" : "Like this short"}
        className={cn(
          "flex size-10 items-center justify-center rounded-full ring-1 backdrop-blur-sm transition",
          mine === "like"
            ? "bg-fuchsia-500 text-white ring-fuchsia-300/50"
            : "bg-white/10 text-zinc-100 ring-white/15 hover:bg-white/20",
        )}
      >
        <ThumbsUp aria-hidden className={cn("size-4.5", mine === "like" && "fill-current")} />
      </button>
      <span className="select-none text-[10.5px] font-semibold tabular-nums text-zinc-300">
        {fmtCount(likes + (mine === "like" ? 1 : 0))}
      </span>
      <button
        type="button"
        onClick={() => toggle("dislike")}
        aria-pressed={mine === "dislike"}
        aria-label={mine === "dislike" ? "Remove dislike" : "Dislike this short"}
        className={cn(
          "flex size-10 items-center justify-center rounded-full ring-1 backdrop-blur-sm transition",
          mine === "dislike"
            ? "bg-fuchsia-500 text-white ring-fuchsia-300/50"
            : "bg-white/10 text-zinc-100 ring-white/15 hover:bg-white/20",
        )}
      >
        <ThumbsDown aria-hidden className={cn("size-4.5", mine === "dislike" && "fill-current")} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Subscribe / save — per-device follows + playlists                    */
/* ------------------------------------------------------------------ */

/** The follow pill — channel pages and both watch views. */
function SubscribeButton({
  channelId,
  name,
  avatar,
  tone = "rose",
}: {
  channelId: string;
  name: string;
  avatar?: string;
  /** rose = native watch, amber = relay watch, zinc = channel header. */
  tone?: "rose" | "amber" | "zinc";
}) {
  const subsV = useSubsVersion();
  void subsV; /* re-render on any follow-list change */
  const on = Boolean(channelId && readSubs()[channelId]);
  if (!channelId) return null;
  const accent =
    tone === "rose"
      ? on
        ? "bg-rose-500/15 text-rose-300 ring-rose-500/40"
        : "bg-rose-500 text-rose-950 hover:bg-rose-400"
      : tone === "amber"
        ? on
          ? "bg-amber-400/15 text-amber-200 ring-amber-400/40"
          : "bg-amber-400 text-amber-950 hover:bg-amber-300"
        : on
          ? "bg-zinc-100/10 text-zinc-200 ring-1 ring-zinc-600"
          : "bg-zinc-100 text-zinc-900 hover:bg-white";
  return (
    <button
      type="button"
      onClick={() => toggleSub(channelId, { name: name || "", avatar, at: Date.now() })}
      aria-pressed={on}
      aria-label={on ? `Unsubscribe from ${name || "this channel"}` : `Subscribe to ${name || "this channel"}`}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40",
        accent,
      )}
    >
      {on ? <Bell aria-hidden className="size-3.5" /> : <BellOff aria-hidden className="size-3.5" />}
      <span>{on ? "Subscribed" : "Subscribe"}</span>
    </button>
  );
}

/** The save-to-playlist control — a compact "Save" button opening a
 * dropdown of the playlists (Watch Later first) + an inline creator. */
function SaveToPlaylist({ card }: { card: YtCard }) {
  const [open, setOpen] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const plsV = usePlaylistsVersion();
  void plsV; /* re-render on any playlist change */
  const lists = React.useMemo(() => {
    const l = readPlaylists();
    watchLaterOf(l); /* lazily ensure Watch Later exists for the menu */
    return l;
  }, [plsV]);
  const inList = (plId: string) => lists.find((p) => p.id === plId)?.items.some((i) => i.id === card.id) ?? false;
  const anySaved = lists.some((p) => inList(p.id));
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={anySaved ? "Saved — manage playlists" : "Save to a playlist"}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition active:scale-[0.97]",
          anySaved
            ? "border-violet-500/40 bg-violet-500/15 text-violet-300"
            : "border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-violet-500/40 hover:text-violet-300",
        )}
      >
        {anySaved ? <Check aria-hidden className="size-3.5" /> : <ListPlus aria-hidden className="size-3.5" />}
        <span className="hidden sm:inline">{anySaved ? "Saved" : "Save"}</span>
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close playlist menu" className="fixed inset-0 z-20 cursor-default" onClick={() => setOpen(false)} />
          <div className="veil-scroll-slim absolute right-0 top-10 z-30 max-h-72 w-60 overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900/95 py-1.5 shadow-2xl backdrop-blur-md">
            <p className="px-3 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Save to</p>
            {lists.map((pl) => {
              const inPl = inList(pl.id);
              return (
                <button
                  key={pl.id}
                  type="button"
                  onClick={() => togglePlaylistVideo(pl.id, card)}
                  aria-pressed={inPl}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-zinc-300 transition hover:bg-white/5 hover:text-white"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border transition",
                      inPl ? "border-violet-400 bg-violet-500 text-white" : "border-zinc-600",
                    )}
                  >
                    {inPl && <Check aria-hidden className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{pl.name}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-600">{pl.items.length}</span>
                </button>
              );
            })}
            <form
              className="mt-1 flex items-center gap-1.5 border-t border-zinc-800 px-2.5 py-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (createPlaylist(newName)) setNewName("");
              }}
            >
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New playlist…"
                aria-label="New playlist name"
                spellCheck={false}
                maxLength={60}
                className="h-7 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-violet-500/50"
              />
              <button
                type="submit"
                disabled={!newName.trim()}
                aria-label="Create the playlist"
                className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500 text-white transition hover:bg-violet-400 disabled:opacity-40"
              >
                <Plus aria-hidden className="size-3.5" />
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Comments — read-only YouTube threads (replies included)              */
/* ------------------------------------------------------------------ */

/** One comment row: avatar, author, time, content, likes, replies. */
function CommentRow({
  c,
  onOpenReplies,
  repliesOpen,
}: {
  c: YtCommentItem;
  onOpenReplies?: () => void;
  repliesOpen?: boolean;
}) {
  return (
    <div className="flex gap-3">
      {c.avatar ? (
        <Thumb src={c.avatar} alt="" className="size-8 shrink-0 rounded-full" />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-400">
          {c.author.replace(/^@/, "").slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
          <span className="truncate font-semibold text-zinc-100">{c.author}</span>
          {c.verified && <ShieldCheck aria-label="verified" className="inline size-3 shrink-0 align-[-1px] text-zinc-500" />}
          {c.pinned && (
            <span className="shrink-0 rounded-full bg-zinc-800 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-zinc-400">pinned</span>
          )}
          {c.published && <span className="shrink-0 text-zinc-500">{c.published}</span>}
        </p>
        <p className="mt-1 whitespace-pre-line break-words text-[13px] leading-relaxed text-zinc-300">{c.content}</p>
        <p className="mt-1.5 flex items-center gap-3 text-[11.5px] text-zinc-500">
          {c.likes > 0 && (
            <span className="flex items-center gap-1 tabular-nums">
              <ThumbsUp aria-hidden className="size-3" /> {fmtCount(c.likes)}
            </span>
          )}
          {c.replies > 0 && onOpenReplies && (
            <button
              type="button"
              onClick={onOpenReplies}
              aria-expanded={repliesOpen}
              className="font-semibold text-rose-300/90 transition hover:text-rose-200"
            >
              {repliesOpen ? "Hide" : "Show"} {c.replies} {c.replies === 1 ? "reply" : "replies"}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/** The comment thread panel — lazily fetched on first expand, pages
 * deeper via the continuation token, replies load per comment. */
function CommentsPanel({ videoId, sheet = false }: { videoId: string; /** sheet variant — renders open inside the shorts viewer's side panel (no toggle header, fills the height) */ sheet?: boolean }) {
  const [open, setOpen] = React.useState(sheet);
  const [list, setList] = React.useState<YtCommentItem[] | null>(null);
  const [count, setCount] = React.useState(0);
  const [next, setNext] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [more, setMore] = React.useState(false);
  /** comment sort — "top" (likes-ranked, YouTube default) | "new" (newest
   * first). Switching resets the list; the effect refetches page one. */
  const [sort, setSort] = React.useState<"top" | "new">("top");
  /** honest-degrade note: set when a newest-first ask came back unsorted
   * (YouTube hides the sort menu for some videos/buckets). */
  const [sortNotice, setSortNotice] = React.useState<string | null>(null);
  /** reply threads, keyed by parent index: items + paging state. */
  const [threads, setThreads] = React.useState<Record<string, { items: YtCommentItem[]; next: string | null; open: boolean; busy: boolean }>>({});

  /* fetch the first page when the panel first expands (or the sort flips) */
  React.useEffect(() => {
    if (!open || list !== null || loading) return;
    setLoading(true);
    setErr(null);
    fetchJsonSafe<YtCommentsAnswer | YtGate>(
      `/api/yt/comments/${encodeURIComponent(videoId)}${sort === "new" ? "?sort=new" : ""}`,
    )
      .then((body) => {
        if (body && "gated" in body) {
          setList([]);
          setErr(body.message);
        } else {
          setList(body.comments);
          setCount(body.count);
          setNext(body.next);
          setSortNotice(
            sort === "new" && body.sortApplied === false
              ? "newest-first isn't available for this video right now — YouTube's default order shown"
              : null,
          );
        }
      })
      .catch((e: Error) => {
        setList([]);
        setErr(e.message || "the comments didn't load");
      })
      .finally(() => setLoading(false));
  }, [open, videoId, list, loading, sort]);

  /* flip the sort: wipe the panel state — the effect above refetches
   * page one in the new order (deeper pages inherit it via their tokens). */
  const switchSort = (s: "top" | "new") => {
    if (s === sort || loading) return;
    setSort(s);
    setList(null);
    setNext(null);
    setCount(0);
    setThreads({});
    setErr(null);
    setSortNotice(null);
  };

  const loadMore = () => {
    if (!next || more) return;
    setMore(true);
    fetchJsonSafe<YtCommentsAnswer | YtGate>(
      `/api/yt/comments/${encodeURIComponent(videoId)}?continuation=${encodeURIComponent(next)}`,
    )
      .then((body) => {
        if (body && !("gated" in body)) {
          setList((prev) => {
            const have = new Set((prev ?? []).map((c) => `${c.author}|${c.content.slice(0, 40)}`));
            return [...(prev ?? []), ...body.comments.filter((c) => !have.has(`${c.author}|${c.content.slice(0, 40)}`))];
          });
          setNext(body.next);
        }
      })
      .catch(() => {
        /* a failed page just stops the list — retry via the button */
      })
      .finally(() => setMore(false));
  };

  const loadReplies = (key: string, token: string, pageMore = false) => {
    const cur = threads[key];
    if (cur?.busy) return;
    /* toggle: an open cached thread closes; a closed cached one reopens */
    if (!pageMore && cur && cur.items.length > 0) {
      setThreads((prev) => ({ ...prev, [key]: { ...cur, open: !cur.open } }));
      return;
    }
    setThreads((prev) => ({
      ...prev,
      [key]: { items: prev[key]?.items ?? [], next: prev[key]?.next ?? null, open: true, busy: true },
    }));
    const useToken = pageMore ? (cur?.next ?? null) : (cur?.next ?? token);
    if (!useToken) {
      setThreads((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { items: [], next: null, open: true }), busy: false } }));
      return;
    }
    fetchJsonSafe<YtCommentsAnswer | YtGate>(
      `/api/yt/comments/${encodeURIComponent(videoId)}?continuation=${encodeURIComponent(useToken)}`,
    )
      .then((body) => {
        if (body && !("gated" in body)) {
          setThreads((prev) => ({
            ...prev,
            [key]: { items: [...(prev[key]?.items ?? []), ...body.comments], next: body.next, open: true, busy: false },
          }));
        } else {
          setThreads((prev) => ({ ...prev, [key]: { items: prev[key]?.items ?? [], next: null, open: true, busy: false } }));
        }
      })
      .catch(() => {
        setThreads((prev) => ({ ...prev, [key]: { items: prev[key]?.items ?? [], next: prev[key]?.next ?? null, open: true, busy: false } }));
      });
  };

  return (
    <section aria-label="Comments" className={sheet ? "flex h-full min-h-0 flex-col" : "mt-8"}>
      {!sheet && (
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 px-4 py-3 text-left transition hover:border-zinc-700"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/25">
          <MessageSquare aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold text-zinc-100">Comments</span>
          <span className="block text-[11.5px] text-zinc-500">
            {count > 0 ? `${fmtCount(count)} on YouTube — read only` : "read-only"}
          </span>
        </span>
        {loading && <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-zinc-500" />}
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-zinc-500 transition-transform", open && "rotate-180")} />
      </button>
      )}
      {open && (
        <>
        {/* sort — Top (likes) / Newest; count rides along */}
        <div className={cn(
          "flex flex-wrap items-center gap-2.5",
          sheet ? "px-4 pt-3" : "mt-3",
        )}>
          <div
            role="group"
            aria-label="Sort comments"
            className="inline-flex rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-0.5 backdrop-blur-md"
          >
            {(
              [
                { id: "top", label: "Top", icon: Flame },
                { id: "new", label: "Newest", icon: Clock },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => switchSort(o.id)}
                aria-pressed={sort === o.id}
                disabled={loading && list === null}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1 text-[12px] font-medium transition",
                  sort === o.id
                    ? "bg-rose-500/15 text-rose-200 shadow-sm ring-1 ring-rose-500/30"
                    : "text-zinc-500 hover:text-zinc-200 disabled:opacity-50",
                )}
              >
                <o.icon aria-hidden className={cn("size-3.5", sort === o.id ? "text-rose-300" : "text-zinc-500")} />
                {o.label}
              </button>
            ))}
          </div>
          {count > 0 && !loading && (
            <span className="text-[11.5px] tabular-nums text-zinc-500">
              {fmtCount(count)} on YouTube
            </span>
          )}
          {loading && list === null && (
            <span className="text-[11.5px] text-zinc-500">
              {sort === "new" ? "sorting newest first…" : "sorting top first…"}
            </span>
          )}
          {sortNotice && (
            <span
              role="note"
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-[11.5px] text-amber-300/90 ring-1 ring-amber-500/25"
            >
              <ShieldAlert aria-hidden className="size-3 shrink-0 text-amber-400" />
              {sortNotice}
            </span>
          )}
        </div>
        <div className={cn(
          "veil-scroll-slim space-y-5",
          sheet
            ? "min-h-0 flex-1 overflow-y-auto px-4 py-4"
            : "mt-3 max-h-[32rem] overflow-y-auto rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-4",
        )}>
          {loading && list === null ? (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <div className="size-8 shrink-0 animate-pulse rounded-full bg-zinc-800/70" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-24 animate-pulse rounded bg-zinc-800/70" />
                    <div className="h-3 w-full animate-pulse rounded bg-zinc-800/50" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-800/40" />
                  </div>
                </div>
              ))}
            </div>
          ) : err && (list ?? []).length === 0 ? (
            <p className="py-4 text-center text-[12.5px] text-zinc-500">{err}</p>
          ) : (list ?? []).length === 0 ? (
            <p className="py-4 text-center text-[12.5px] text-zinc-500">no comments came back for this video</p>
          ) : (
            <>
              {(list ?? []).map((c, i) => {
                const key = String(i);
                const t = threads[key];
                return (
                  <div key={`${c.author}-${i}`}>
                    <CommentRow
                      c={c}
                      repliesOpen={Boolean(t?.open)}
                      onOpenReplies={c.replies > 0 && c.replyToken ? () => loadReplies(key, c.replyToken!) : undefined}
                    />
                    {t?.open && (
                      <div className="mt-3 space-y-3.5 border-l-2 border-zinc-800 pl-4">
                        {t.busy && t.items.length === 0 && <Loader2 aria-hidden className="size-4 animate-spin text-zinc-500" />}
                        {t.items.map((r, j) => (
                          <CommentRow key={`${r.author}-${j}`} c={r} />
                        ))}
                        {t.next && (
                          <button
                            type="button"
                            onClick={() => loadReplies(key, "", true)}
                            className="flex items-center gap-1 text-[11.5px] font-semibold text-rose-300/90 transition hover:text-rose-200"
                          >
                            <ChevronDown aria-hidden className="size-3" /> More replies
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {next ? (
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadMore}
                    disabled={more}
                    className="h-8 gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:border-rose-500/40 hover:text-rose-300"
                  >
                    {more ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <ChevronDown aria-hidden className="size-3.5" />}
                    {more ? "loading…" : "More comments"}
                  </Button>
                </div>
              ) : (
                (list ?? []).length > 0 && (
                  <p className="pt-1 text-center text-[11px] text-zinc-600">that's the thread the veil could see</p>
                )
              )}
            </>
          )}
        </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Channel avatar — deterministic gradient + initial (YouTube-style)     */
/* ------------------------------------------------------------------ */

/** Deterministic hue from a channel id/name — every channel keeps its
 * own avatar color across the app without a network fetch. */
function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** YouTube-style round channel avatar — the channel's REAL logo when
 * known (card-carried, or the device avatar store), with the
 * deterministic gradient+initial as the instant fallback (and the
 * underneath layer while the logo loads / if it ever fails). Clickable
 * when a channel handler is available, exactly like tapping an avatar
 * on YouTube. */
function ChannelAvatar({
  name,
  id,
  size = 36,
  onChannel,
  avatar,
}: {
  name: string;
  id?: string;
  size?: number;
  onChannel?: (id: string, name: string) => void;
  /** card-carried avatar URL (server-stamped) — wins over the store. */
  avatar?: string;
}) {
  const ver = useAvatarVersion(); /* re-render when backfills land */
  void ver;
  const src = avatar || avatarStore.get(id);
  const hue = avatarHue(id || name || "?");
  const initial = (name || "?").trim().slice(0, 1).toUpperCase() || "?";
  const disc = (
    <span
      aria-hidden
      className="relative flex select-none items-center justify-center overflow-hidden rounded-full shadow-inner shadow-black/20"
      style={{
        width: size,
        height: size,
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 62% 44%), hsl(${(hue + 45) % 360} 62% 28%))`,
      }}
    >
      <span
        className="flex h-full w-full items-center justify-center font-semibold text-white/95"
        style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}
      >
        {initial}
      </span>
      {src && <AvatarImg key={src} src={src} alt={name} size={size} />}
    </span>
  );
  if (id && onChannel) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChannel(id, name);
        }}
        aria-label={`Open channel: ${name}`}
        className="mt-0.5 shrink-0 rounded-full outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-rose-500/50 active:scale-95"
      >
        {disc}
      </button>
    );
  }
  return <div className="mt-0.5 shrink-0">{disc}</div>;
}

/** The real-logo layer inside a ChannelAvatar disc — fades in over the
 * gradient initial once loaded. Handles the classic cached-image race
 * (an image can finish loading BEFORE React attaches the non-bubbling
 * load listener) by checking `complete` right after mount; on error it
 * stays hidden (the gradient keeps doing its job). */
function AvatarImg({ src, alt, size }: { src: string; alt: string; size: number }) {
  const [ok, setOk] = React.useState(false);
  const [err, setErr] = React.useState(false);
  const ref = React.useRef<HTMLImageElement | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el?.complete) {
      if (el.naturalWidth > 0) setOk(true);
      else setErr(true);
    }
  }, [src]);
  if (err) return null;
  return (
    <img
      ref={ref}
      src={src}
      alt={ok ? `${alt} channel avatar` : ""}
      loading="lazy"
      decoding="async"
      onLoad={() => setOk(true)}
      onError={() => setErr(true)}
      className={cn(
        "absolute inset-0 size-full rounded-full object-cover transition-opacity duration-300",
        ok ? "opacity-100" : "opacity-0",
      )}
      style={{ width: size, height: size }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Thumbnail with skeleton + fallback                                   */
/* ------------------------------------------------------------------ */

function Thumb({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [loaded, setLoaded] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  return (
    <div className={cn("relative size-full overflow-hidden bg-zinc-800", className)}>
      {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-zinc-800/80" />}
      {failed ? (
        <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
          <Clapperboard aria-hidden className="size-7 text-zinc-600" />
        </div>
      ) : (
        src && (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              "size-full object-cover transition-[opacity,transform] duration-500 group-hover:scale-[1.04]",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hover preview — YouTube-style storyboard peek                        */
/* ------------------------------------------------------------------ */

/** Desktop-hover card preview in YouTube's shape: while `active` (the
 * parent arms it after a 600ms pointer dwell — touch taps navigate
 * before the dwell completes, so phones never see it), cycle through
 * the per-video frame thumbnails YouTube serves for every upload
 * (hq1/hq2/hq3 — start/middle/end samples) with a storyboard progress
 * bar. The real storyboards are player-response sprites; these static
 * frames are the honest lightweight equivalent, proxied through
 * /api/yt/s like every other image. */
function HoverPreview({ videoId, active }: { videoId: string; active: boolean }) {
  const reduceMotion = useReducedMotion();
  const [frame, setFrame] = React.useState(0);
  const [failed, setFailed] = React.useState(false);

  const frames = React.useMemo(
    () =>
      [1, 2, 3].map(
        (n) =>
          "/api/yt/s?u=" +
          encodeURIComponent(`https://i.ytimg.com/vi/${videoId}/hq${n}.jpg`),
      ),
    [videoId],
  );

  React.useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    if (reduceMotion || failed) return;
    const t = window.setInterval(() => setFrame((f) => (f + 1) % 3), 900);
    return () => window.clearInterval(t);
  }, [active, reduceMotion, failed]);

  if (!active || reduceMotion || failed) return null;

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {frames.map((src, i) => (
        <img
          key={src}
          src={src}
          alt=""
          decoding="async"
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-200",
            i === frame ? "opacity-100" : "opacity-0",
          )}
        />
      ))}
      {/* storyboard scrub progress */}
      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/60">
        <div
          className="h-full bg-rose-500 transition-[width] duration-500 ease-linear"
          style={{ width: `${((frame + 1) / 3) * 100}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Video card                                                           */
/* ------------------------------------------------------------------ */

function VideoCard({
  card,
  index,
  onWatch,
  onChannel,
  dimWatched = true,
}: {
  card: YtCard;
  index: number;
  onWatch: (id: string, card: YtCard) => void;
  onChannel?: (id: string, name: string) => void;
  /** show the feed's watched treatment (dim + badge). History-like
   * contexts (the Watched slice, the History page) pass false — there
   * the cards are pure re-watch invites, not "you've seen this"
   * markers, and a wall of dimmed cards reads as disabled. */
  dimWatched?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const histV = useHistoryVersion(); /* re-render when history changes */
  void histV;
  const watched = watchedIdsSnapshot().has(card.id);
  /* hover-preview dwell state — armed by the thumb box's mouseenter
   * after a 600ms dwell, disarmed instantly on mouseleave */
  const [peek, setPeek] = React.useState(false);
  const peekArm = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (peekArm.current !== null) window.clearTimeout(peekArm.current);
    },
    [],
  );
  const startPreview = React.useCallback(() => {
    if (peekArm.current !== null) return;
    peekArm.current = window.setTimeout(() => {
      peekArm.current = null;
      setPeek(true);
    }, 600);
  }, []);
  const stopPreview = React.useCallback(() => {
    if (peekArm.current !== null) {
      window.clearTimeout(peekArm.current);
      peekArm.current = null;
    }
    setPeek(false);
  }, []);
  /* NOTE: the card is a div[role=button], not a <button> — the channel
   * line + avatar inside are real <button>s, and button-in-button is
   * invalid HTML (a hydration error). Keyboard users get Enter/Space. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onWatch(card.id, card);
    }
  };
  return (
    <motion.div
      role="button"
      tabIndex={0}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.035, 0.4) }}
      onClick={() => onWatch(card.id, card)}
      onKeyDown={onKeyDown}
      aria-label={`Watch ${card.title} by ${card.author}`}
      className="veil-cv group flex cursor-pointer flex-col rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
    >
      {/* thumb + feedback ⋮ wrapper — the menu (absolute, expands DOWN
       * past the thumb) must NOT live inside the overflow-hidden thumb
       * box or it gets clipped */}
      <div className="relative">
        <div
          className="veil-hover-lift relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-800/80 ring-1 ring-zinc-800/60 transition duration-300 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-zinc-700/80"
          onMouseEnter={startPreview}
          onMouseLeave={stopPreview}
        >
          <Thumb src={card.thumb} alt={card.title} />
          {/* hover storyboard peek — desktop pointers only, never for
           * live streams (no frame thumbnails exist mid-broadcast) */}
          {!card.live && <HoverPreview videoId={card.id} active={peek} />}
          {/* watched dim — YouTube's "Watched" treatment. It lifts on
             hover: the card is still one click from a re-watch, and the
             lightening says so before the label swaps to "watch again". */}
          {watched && dimWatched && (
            <div className="pointer-events-none absolute inset-0 bg-black/45 transition-colors duration-300 group-hover:bg-black/20" />
          )}
          {/* play overlay */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/30 group-hover:opacity-100">
            <span className="veil-press flex size-12 items-center justify-center rounded-full bg-rose-500/95 shadow-xl shadow-rose-500/30 transition-transform duration-200 group-hover:scale-105">
              <Play aria-hidden className="size-5 translate-x-0.5 text-white fill-white" />
            </span>
          </div>
          {/* duration / live badge */}
          {card.live ? (
            <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-rose-600/95 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white">
              <Radio aria-hidden className="size-3" /> live
            </span>
          ) : card.short ? (
            <span className="absolute bottom-2 right-2 rounded-md bg-fuchsia-500/95 px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white">
              short
            </span>
          ) : card.durationSec > 0 ? (
            <span className="absolute bottom-2 right-2 rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-100">
              {fmtTime(card.durationSec)}
            </span>
          ) : null}
          {/* watched tag — swaps to "watch again" on hover: the dim's
           * readable label, and the invitation the moment the pointer
           * arrives (both fade, so the swap reads as one motion) */}
          {watched && dimWatched && (
            <span className="absolute bottom-2 left-2">
              <span className="flex items-center gap-1 rounded-md bg-black/85 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-300 transition-opacity duration-200 group-hover:opacity-0">
                Watched
              </span>
              <span className="absolute inset-0 flex items-center gap-1 rounded-md bg-rose-500/95 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                <RotateCcw aria-hidden className="size-3" /> Watch again
              </span>
            </span>
          )}
        </div>
        {/* feedback ⋮ — YouTube's card overflow (Not interested / Don't
         * recommend channel), feeds the ranker's negative signals */}
        <CardFeedbackMenu card={card} />
      </div>
      {/* meta row — avatar + title + channel + views, like YouTube's card */}
      <div className="mt-3 flex gap-3">
        <ChannelAvatar name={card.author} id={card.authorId} size={36} onChannel={onChannel} avatar={card.avatar} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[14px] font-medium leading-snug text-zinc-100">{card.title}</h3>
          {card.authorId && onChannel ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChannel(card.authorId, card.author);
              }}
              aria-label={`Open channel: ${card.author}`}
              className="mt-1 flex max-w-full items-center gap-1 rounded text-[12.5px] text-zinc-400 transition hover:text-zinc-100"
            >
              <span className="truncate">{card.author}</span>
              {card.verified && <BadgeCheck aria-label="verified channel" className="size-3.5 shrink-0 text-zinc-500" />}
            </button>
          ) : (
            <p className="mt-1 flex items-center gap-1 text-[12.5px] text-zinc-400">
              <span className="truncate">{card.author}</span>
              {card.verified && <BadgeCheck aria-label="verified channel" className="size-3.5 shrink-0 text-zinc-500" />}
            </p>
          )}
          <p className="mt-0.5 truncate text-[12px] tabular-nums text-zinc-500">
            {card.views > 0 && <>{fmtCount(card.views)} views</>}
            {card.views > 0 && card.published && <span className="mx-1">·</span>}
            {ageLabel(card.published)}
          </p>
          {card.why && (
            <p className="mt-1 truncate text-[11.5px] text-zinc-500" title={card.why}>
              {card.why}
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Related card — the compact "Up next" row (the watch page's rail)    */
/* ------------------------------------------------------------------ */

/** YouTube's related row: small thumb left, two-line title, channel and
 * views stacked right. One click plays; the channel line opens the
 * channel without starting the video. */
function RelatedCard({
  card,
  index,
  onWatch,
  onChannel,
}: {
  card: YtCard;
  index: number;
  onWatch: (id: string, card: YtCard) => void;
  onChannel?: (id: string, name: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  /* NOTE: role=button div, same reason as VideoCard — the channel line
   * inside is a real <button> and button-in-button is invalid HTML. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onWatch(card.id, card);
    }
  };
  return (
    <motion.div
      role="button"
      tabIndex={0}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.03, 0.3) }}
      onClick={() => onWatch(card.id, card)}
      onKeyDown={onKeyDown}
      aria-label={`Watch ${card.title} by ${card.author}`}
      className="group flex cursor-pointer gap-2.5 rounded-xl p-1 text-left outline-none transition hover:bg-zinc-800/40 focus-visible:ring-2 focus-visible:ring-rose-500/40"
    >
      <div className="veil-hover-lift relative aspect-video w-[160px] shrink-0 overflow-hidden rounded-lg bg-zinc-800/80 ring-1 ring-zinc-800/60 transition group-hover:ring-zinc-700/80">
        <Thumb src={card.thumb} alt={card.title} />
        {card.live ? (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-rose-600/95 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            <Radio aria-hidden className="size-2.5" /> live
          </span>
        ) : card.durationSec > 0 ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/85 px-1 py-0.5 text-[10.5px] font-semibold tabular-nums text-zinc-100">
            {fmtTime(card.durationSec)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 py-0.5 pr-1">
        <h4 className="line-clamp-2 text-[13px] font-medium leading-snug text-zinc-100">{card.title}</h4>
        {card.authorId && onChannel ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChannel(card.authorId, card.author);
            }}
            aria-label={`Open channel: ${card.author}`}
            className="mt-1 flex max-w-full items-center gap-1 rounded text-[11.5px] text-zinc-400 transition hover:text-zinc-100"
          >
            <span className="truncate">{card.author}</span>
            {card.verified && <BadgeCheck aria-label="verified channel" className="size-3 shrink-0 text-zinc-500" />}
          </button>
        ) : (
          <p className="mt-1 flex items-center gap-1 text-[11.5px] text-zinc-400">
            <span className="truncate">{card.author}</span>
            {card.verified && <BadgeCheck aria-label="verified channel" className="size-3 shrink-0 text-zinc-500" />}
          </p>
        )}
        <p className="mt-0.5 truncate text-[11px] tabular-nums text-zinc-500">
          {card.views > 0 && <>{fmtCount(card.views)} views</>}
          {card.views > 0 && card.published && <span className="mx-1">·</span>}
          {ageLabel(card.published)}
        </p>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Incremental-reveal sentinel (the History page)                       */
/* ------------------------------------------------------------------ */

/** Renders the "N of M — scroll for more" row and reports when it becomes
 *  visible. Self-observing: the observer attaches in THIS component's mount
 *  effect, so it works no matter when the page (and the sentinel) appears. */
function HistorySentinel({
  shown,
  total,
  onVisible,
}: {
  shown: number;
  total: number;
  onVisible: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  /* keep the callback fresh without re-attaching the observer on every
   * parent render (the inline closure would otherwise churn the IO) */
  const onVisibleRef = React.useRef(onVisible);
  React.useEffect(() => {
    onVisibleRef.current = onVisible;
  }, [onVisible]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onVisibleRef.current();
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="col-span-full flex items-center justify-center gap-3 py-6">
      <span className="text-xs text-zinc-500">
        {shown} of {total} — scroll for more
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card skeletons                                                       */
/* ------------------------------------------------------------------ */

function CardSkeletons({ n = 8 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex flex-col">
          <div className="aspect-video w-full animate-pulse rounded-xl bg-zinc-800/70" />
          <div className="mt-3 flex gap-3">
            <div className="size-9 shrink-0 animate-pulse rounded-full bg-zinc-800/70" />
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
              <div className="h-3.5 w-[92%] animate-pulse rounded bg-zinc-800/70" />
              <div className="h-3 w-[60%] animate-pulse rounded bg-zinc-800/60" />
              <div className="h-3 w-[40%] animate-pulse rounded bg-zinc-800/50" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

function ShortSkeletons({ n = 10 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-2xl border border-zinc-800/60 bg-zinc-900/40 p-2">
          <div className="aspect-[9/16] w-full animate-pulse rounded-xl bg-zinc-800/70" />
          <div className="space-y-1.5 px-1 pb-1">
            <div className="h-3 w-[85%] animate-pulse rounded bg-zinc-800/70" />
            <div className="h-3 w-[45%] animate-pulse rounded bg-zinc-800/50" />
          </div>
        </div>
      ))}
    </>
  );
}

/** A horizontal shorts rail for the For You feed. */
function ShortsRail({ shorts, onWatch }: { shorts: YtCard[]; onWatch: (id: string, card: YtCard) => void }) {
  return (
    <section aria-label="Shorts shelf" className="my-5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/15 ring-1 ring-fuchsia-500/30">
          <Zap aria-hidden className="size-3.5 text-fuchsia-400" />
        </span>
        <h3 className="text-[12.5px] font-semibold uppercase tracking-wider text-zinc-400">Shorts</h3>
        <div aria-hidden className="h-px flex-1 bg-zinc-800/70" />
        <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-600">{shorts.length} on the wire</span>
      </div>
      <div className="veil-scroll-slim -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {shorts.map((c, i) => (
          <div key={`${c.id}-${i}`} className="w-40 shrink-0 sm:w-44">
            <ShortCard card={c} index={i} onWatch={onWatch} />
          </div>
        ))}
      </div>
    </section>
  );
}

function ShortsRailSkeleton() {
  return (
    <section aria-hidden className="my-5">
      <div className="mb-2.5 flex items-center gap-2">
        <div className="size-7 animate-pulse rounded-lg bg-zinc-800/70" />
        <div className="h-3 w-14 animate-pulse rounded bg-zinc-800/70" />
        <div className="h-px flex-1 bg-zinc-800/60" />
      </div>
      <div className="flex gap-3 overflow-hidden pb-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="w-40 shrink-0 sm:w-44">
            <div className="aspect-[9/16] w-full animate-pulse rounded-xl bg-zinc-800/60" />
            <div className="mt-2 space-y-1.5 px-1 pb-1">
              <div className="h-3 w-[85%] animate-pulse rounded bg-zinc-800/60" />
              <div className="h-3 w-[45%] animate-pulse rounded bg-zinc-800/40" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Watch again — the re-watch rail (YouTube home's "Watch it again")    */
/* ------------------------------------------------------------------ */

/** One re-watch invite: the video's thumb, title, channel and how long
 * ago it was watched. NOT dimmed — unlike a feed card, this exists
 * precisely because the video was watched, and its whole job is the
 * click. Partial cards (imported from a Takeout history) render fine:
 * the thumb is a real CDN frame, the player fills in the rest on open. */
function WatchAgainCard({
  entry,
  index,
  onWatch,
}: {
  entry: HistoryEntry;
  index: number;
  onWatch: (id: string, card: YtCard) => void;
}) {
  const { card, at } = entry;
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.4) }}
      onClick={() => onWatch(card.id, card)}
      aria-label={`Watch again: ${card.title} by ${card.author} — watched ${relTime(at)}`}
      className="group flex w-full cursor-pointer flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-zinc-800/80 ring-1 ring-zinc-800/60 transition duration-300 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-zinc-700/80">
        <Thumb src={card.thumb} alt={card.title} />
        {/* re-watch overlay — the ↺ instead of ▶ is the whole point */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/30 group-hover:opacity-100">
          <span className="flex size-11 items-center justify-center rounded-full bg-rose-500/95 shadow-xl shadow-rose-500/30 transition-transform duration-200 group-hover:scale-105">
            <RotateCcw aria-hidden className="size-5 text-white" />
          </span>
        </div>
        {/* duration / short badge */}
        {card.short ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-fuchsia-500/95 px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white">
            short
          </span>
        ) : card.durationSec > 0 ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/85 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-100">
            {fmtTime(card.durationSec)}
          </span>
        ) : null}
        {/* the watched-when label */}
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/85 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-300">
          <RotateCcw aria-hidden className="size-3 text-rose-400" />
          {relTime(at)}
        </span>
      </div>
      <div className="mt-2 px-0.5">
        <h4 className="line-clamp-2 text-[13px] font-medium leading-snug text-zinc-100 group-hover:text-white">
          {card.title}
        </h4>
        <p className="mt-1 truncate text-[11.5px] text-zinc-500 transition group-hover:text-zinc-400">{card.author}</p>
      </div>
    </motion.button>
  );
}

/** "Watch again" — YouTube-home's shelf for videos you've already seen.
 * The For You feed hides watched videos (the server excludes them from
 * every round), so without this rail they'd be unreachable from the main
 * page after a reload. This is their home: the most recent history
 * entries, one click from a re-watch, with a door to the full History
 * page. Hidden while the feed is sliced by a chip — slices are for
 * finding NEW things; this rail is for going back. */
function WatchAgainRail({
  entries,
  paused,
  onWatch,
  onOpenHistory,
}: {
  entries: HistoryEntry[];
  paused: boolean;
  onWatch: (id: string, card: YtCard) => void;
  onOpenHistory: () => void;
}) {
  const shown = entries.slice(0, 14);
  if (shown.length === 0) return null;
  return (
    <section aria-label="Watch again — your recent history" className="my-5">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 ring-1 ring-rose-500/30">
          <RotateCcw aria-hidden className="size-3.5 text-rose-400" />
        </span>
        <h3 className="shrink-0 text-[12.5px] font-semibold uppercase tracking-wider text-zinc-400">Watch again</h3>
        <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-600">
          {entries.length} watched{paused ? " · recording paused" : ""}
        </span>
        <div aria-hidden className="h-px flex-1 bg-zinc-800/70" />
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label="Open the full watch history page"
          className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 transition hover:bg-zinc-800/70 hover:text-zinc-100"
        >
          See all <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </div>
      <div className="veil-scroll-slim -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {shown.map((h, i) => (
          <div key={`${h.card.id}-${h.at}`} className="w-44 shrink-0 sm:w-52">
            <WatchAgainCard entry={h} index={i} onWatch={onWatch} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Page heading for the browse pages (For You / Shorts / Popular / History). */
function PageHeader({
  icon: Icon,
  tone,
  title,
  badge,
  onReload,
  reloading,
  actions,
}: {
  icon: LucideIcon;
  tone: PageKey;
  title: string;
  badge?: string;
  onReload: () => void;
  reloading?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl ring-1", PAGE_TONE[tone].chip)}>
        <Icon aria-hidden className="size-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[16px] font-semibold tracking-tight text-zinc-100">
          {title}
          {badge && <span className="ml-2 align-middle text-[11px] font-medium tabular-nums text-zinc-500">{badge}</span>}
        </h3>
      </div>
      {actions}
      <Button
        size="sm"
        variant="outline"
        onClick={onReload}
        aria-label={`Reload ${title}`}
        className="h-8 shrink-0 rounded-xl border-zinc-700 text-zinc-400 hover:text-zinc-100"
      >
        {reloading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <RefreshCw aria-hidden className="size-3.5" />}
      </Button>
    </div>
  );
}

/** Shared empty / error state for the browse pages. */
function FeedEmptyState({ message, onRetry, retryLabel }: { message: string; onRetry: () => void; retryLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-zinc-800/80">
        <Clapperboard aria-hidden className="size-6 text-zinc-500" />
      </span>
      <p className="max-w-sm text-[13.5px] text-zinc-400">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry} className="h-8 rounded-xl border-zinc-700">
        <RefreshCw aria-hidden className="size-3.5" /> {retryLabel}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The player                                                           */
/* ------------------------------------------------------------------ */

interface Level {
  index: number;
  label: string;
}

/* ------------------------------------------------------------------ */
/* Adaptive (1080p+) playback — MSE pairing of video-only + audio       */
/* ------------------------------------------------------------------ */

/** The best MSE combo for a video answer: the highest video-only track
 * ≤ maxHeight (falls back to the lowest rung when everything is bigger)
 * plus the highest-bitrate audio track the browser can decode. Null
 * when MSE or the codecs aren't available — the caller falls back to
 * the progressive/HLS lanes. */
function pickAdaptiveCombo(video: YtVideo, maxHeight = 1080): { v: YtFormat; a: YtFormat } | null {
  if (typeof window === "undefined" || !("MediaSource" in window)) return null;
  const MS = window.MediaSource;
  if (typeof MS.isTypeSupported !== "function") return null;
  const ladder = video.formats.filter((f) => f.kind === "adaptive" && (f.height ?? 0) > 0);
  if (ladder.length === 0) return null;
  const audio = video.audio.find((a) => MS.isTypeSupported(a.mime));
  if (!audio) return null;
  /* walk the ladder height-desc and take the FIRST rung this browser can
   * actually decode — YouTube offers avc1 + vp9 (+ av1) at every height,
   * so a browser without proprietary codecs (headless, some Linux/Firefox
   * builds) lands on vp9/av1 instead of giving up on the whole combo */
  const byHeight = [...ladder].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0),
  );
  for (const f of byHeight) {
    if ((f.height ?? 0) > maxHeight) continue;
    if (MS.isTypeSupported(f.mime)) return { v: f, a: audio };
  }
  /* nothing under the cap decodes — any supported rung still beats muxed */
  for (const f of byHeight) {
    if (MS.isTypeSupported(f.mime)) return { v: f, a: audio };
  }
  return null;
}

/** Pair a video-only track with an audio track through MediaSource —
 * the 1080p/1440p/4K lane. Both files stream through the same-origin
 * proxy and land in two SourceBuffers chunk-by-chunk as they arrive
 * (the init segment leads each file, so playback starts before the
 * fetch finishes). Quota overflow trims behind the playhead and
 * keeps going. Returns null when the pairing can't attach (caller
 * falls back); the handle's destroy() aborts both fetches. */
function attachAdaptiveCombo(
  el: HTMLVideoElement,
  vFmt: YtFormat,
  aFmt: YtFormat,
  onBroken?: () => void,
): { destroy: () => void } | null {
  const MS = (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
  if (!MS || typeof MS.isTypeSupported !== "function") return null;
  if (!MS.isTypeSupported(vFmt.mime) || !MS.isTypeSupported(aFmt.mime)) return null;
  const ms = new MS();
  el.src = URL.createObjectURL(ms);
  let destroyed = false;
  const controllers: AbortController[] = [];

  /* append one chunk, waiting politely while the buffer is busy */
  const append = (sb: SourceBuffer, chunk: ArrayBuffer) =>
    new Promise<void>((resolve) => {
      const step = () => {
        if (destroyed) return resolve();
        if (sb.updating) {
          sb.addEventListener("updateend", step, { once: true });
          return;
        }
        try {
          sb.appendBuffer(chunk);
          resolve();
        } catch (err) {
          if ((err as DOMException)?.name === "QuotaExceededError") {
            /* buffer full — trim well behind the playhead, retry */
            try {
              if (!sb.updating) sb.remove(0, Math.max(0.1, el.currentTime - 30));
            } catch { /* mid-update — the retry below catches up */ }
            setTimeout(step, 60);
          } else {
            sb.addEventListener("updateend", step, { once: true });
          }
        }
      };
      step();
    });

  /* stream one media file into its SourceBuffer — with the three hardenings
   * the freeze reports demanded:
   *   ① STALL RECONNECT: a read that yields nothing for 20s (googlevideo
   *      throttling this box's egress mid-stream) aborts and refetches
   *      with a Range from the bytes already landed — the stream picks
   *      up where it left off instead of freezing at the buffer edge.
   *   ② FORWARD-BUFFER PACING: appending pauses whenever a minute of
   *      runway is already buffered — pumping a whole 4K movie into the
   *      SourceBuffer at full line speed is what OOM-crashed tabs; now
   *      the lane fetches just ahead of the playhead (quota trims cover
   *      the very-high-bitrate tail).
   *   ③ PROGRESS-EARNED RECONNECTS: pacing idles the upstream socket for
   *      up to a minute at a time, and CDNs kill idle connections — so
   *      mid-video stalls are ROUTINE, not exceptional. Reconnect attempts
   *      now reset after 8 MB of fresh progress: only four consecutive
   *      no-progress failures give up (the old lifetime budget of four
   *      exhausted itself a few minutes in and killed long videos — the
   *      "pauses then stops working" reports).
   * Four straight failures without progress → onBroken (the caller falls
   * back instead of a silent freeze). */
  const pump = async (url: string, sb: SourceBuffer) => {
    let landed = 0;
    let landedSinceFail = 0;
    let fails = 0;
    while (!destroyed) {
      if (fails >= 4) break;
      const ac = new AbortController();
      controllers.push(ac);
      let finished = false;
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          cache: "no-store",
          ...(landed > 0 ? { headers: { Range: `bytes=${landed}-` } } : {}),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const readP = reader.read();
          /* a lost race must not become an unhandled rejection */
          readP.catch(() => {});
          const raced: ReadableStreamReadResult<Uint8Array> | "stall" = await Promise.race([
            readP,
            new Promise<"stall">((resolve) => setTimeout(resolve, 20000, "stall")),
          ]);
          if (raced === "stall") {
            /* upstream went quiet — kill the connection, reconnect with
             * a Range from the bytes already in the buffer */
            ac.abort();
            break;
          }
          const { done, value } = raced;
          if (done) {
            finished = true;
            break;
          }
          if (destroyed) break;
          if (!value?.length) continue;
          /* pacing — let the playhead eat into the runway first */
          for (;;) {
            if (destroyed) break;
            let ahead = -1;
            try {
              if (sb.buffered.length > 0) ahead = sb.buffered.end(sb.buffered.length - 1) - (el.currentTime || 0);
            } catch { /* mid-update */ }
            if (ahead < 60) break;
            await new Promise((r) => setTimeout(r, 1500));
          }
          if (destroyed) break;
          const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
          await append(sb, chunk);
          landed += chunk.byteLength;
          landedSinceFail += chunk.byteLength;
          /* progress earns reconnect attempts back */
          if (landedSinceFail > 8 * 1024 * 1024) fails = 0;
        }
      } catch {
        /* aborted (destroy) or a network hiccup — the fails counter decides */
      }
      if (finished || destroyed) return;
      fails++;
      landedSinceFail = 0;
    }
    /* out of consecutive failures without a clean finish — surface it so
     * the caller can fall back rather than freeze silently */
    if (!destroyed) onBroken?.();
  };

  ms.addEventListener("sourceopen", () => {
    if (destroyed) return;
    let pending = 2;
    const done = () => {
      if (--pending > 0 || destroyed) return;
      try {
        if (ms.readyState === "open") ms.endOfStream();
      } catch {
        /* raced a late append — the media still plays */
      }
    };
    try {
      const vb = ms.addSourceBuffer(vFmt.mime);
      const ab = ms.addSourceBuffer(aFmt.mime);
      pump(vFmt.url, vb).then(done);
      pump(aFmt.url, ab).then(done);
    } catch {
      onBroken?.();
    }
  });

  return {
    destroy: () => {
      destroyed = true;
      for (const ac of controllers) ac.abort();
    },
  };
}

function StreamPlayer({
  initialCard,
  video,
  onWatch,
  onChannel,
  onEnded,
  healing,
  onStreamError,
}: {
  initialCard: YtCard | null;
  video: YtVideo | null;
  onWatch: (id: string, card: YtCard | null) => void;
  onChannel: (id: string, name: string) => void;
  /** marathon: a playlist is playing — advance on ended (loop off). */
  onEnded?: () => void;
  /** SELF-HEAL: true while the parent force-refreshes a fresh extraction
   * (the fatal panel swaps to a "reconnecting" state). */
  healing?: boolean;
  /** SELF-HEAL: fired when the stream itself broke (403s from stale
   * signatures, unrecoverable HLS/stall) — the parent answers by
   * re-extracting and hot-swapping `video`, which re-picks the format
   * and resumes at the same timestamp. */
  onStreamError?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const prefsV = usePrefsVersion();
  const meta = video?.card ?? initialCard ?? {
    id: "", title: "Loading…", author: "", authorId: "", verified: false,
    durationSec: 0, views: 0, published: "", live: false, thumb: "",
  };
  const noFormats = Boolean(video && video.formats.length === 0);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const hlsRef = React.useRef<{ destroy: () => void; currentLevel: number; levels: unknown[] } | null>(null);

  // active format + its kind
  const [format, setFormat] = React.useState<YtFormat | null>(null);
  // playback state
  const [playing, setPlaying] = React.useState(false);
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [buffered, setBuffered] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [waiting, setWaiting] = React.useState(true);
  const [fatal, setFatal] = React.useState<string | null>(null);
  // chrome
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [isFs, setIsFs] = React.useState(false);
  const [activeLevel, setActiveLevel] = React.useState(-1); // hls level (-1 auto)
  const [levels, setLevels] = React.useState<Level[]>([]);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveries = React.useRef(0);
  const stallFixes = React.useRef(0);
  /* the heal callback rides a ref — the effects below must not re-run
   * (re-attaching media) every time the parent rebuilds it */
  const onStreamErrorRef = React.useRef(onStreamError);
  React.useEffect(() => {
    onStreamErrorRef.current = onStreamError;
  }, [onStreamError]);

  /* ---- closed captions: the active track's URL (null = off). The
   * <track> elements render in caption order, so the textTracks list
   * maps 1:1 onto video.captions — mode switches by index. */
  const [ccUrl, setCcUrl] = React.useState<string | null>(null);

  /* ---- marathon: notify when the video ends (loop off only) ---- */
  const onEndedRef = React.useRef(onEnded);
  React.useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  /* ---- stale-frame kill: switching videos must NEVER keep showing the
   * previous video's last frame while the new stream negotiates (the
   * "same thumbnail all the time" bug — the old frame sat there for the
   * whole slow cold-start). Pause + drop the source + load() blanks the
   * element instantly so the POSTER (the new video's own thumbnail)
   * takes over. Declared BEFORE the format effect so a fresh src always
   * lands after the clear. */
  const lastVideoIdRef = React.useRef<string>("");
  React.useEffect(() => {
    const el = videoRef.current;
    const id = meta.id;
    if (!el || !id || id === lastVideoIdRef.current) return;
    const isFirst = lastVideoIdRef.current === "";
    lastVideoIdRef.current = id;
    if (isFirst) return; /* nothing loaded yet — nothing to clear */
    try {
      el.pause();
    } catch {
      /* already dead */
    }
    el.removeAttribute("src");
    try {
      el.load();
    } catch {
      /* ignore */
    }
  }, [meta.id]);

  React.useEffect(() => {
    const list = video?.formats;
    if (!list || list.length === 0) return;
    /* the QUALITY ladder leads: the best rung under the SAVED quality
     * ceiling (default 1080p) when a decodable audio pairing exists
     * (MSE combo), else HLS, else the first progressive. The settings
     * menu can push it up/down and the ceiling sticks for new videos. */
    const combo = video ? pickAdaptiveCombo(video, readPrefs().maxHeight) : null;
    const hls = list.find((f) => f.kind === "hls");
    setFormat(combo ? combo.v : (hls ?? list[0]));
    setLevels([]);
    setActiveLevel(-1);
    setFatal(null);
    setWaiting(true);
    setCurrent(0);
    setCcUrl(null);
  }, [video]);

  /* ---- saved speed + loop apply to the playing element (live) ---- */
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const p = readPrefs();
    el.playbackRate = p.speed;
    el.loop = p.loop;
  }, [format, prefsV, video]);

  /* ---- load the active format ---- */
  /* mid-playback format switches (the Quality menu) resume where they
   * left off instead of restarting — captured on teardown, applied on
   * the new media's loadedmetadata */
  const resumeAtRef = React.useRef(0);
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el || !format) return;
    let disposed = false;
    recoveries.current = 0;
    stallFixes.current = 0;
    const resume = () => {
      if (resumeAtRef.current > 2 && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(resumeAtRef.current, Math.max(0, el.duration - 0.5));
      }
      resumeAtRef.current = 0;
      el.play().catch(() => {});
    };
    el.addEventListener("loadedmetadata", resume, { once: true });

    const playNative = (url: string) => {
      el.src = url;
      el.play().catch(() => {}); // autoplay may need a gesture — controls remain
    };

    if (format.kind === "progressive") {
      playNative(format.url);
      return () => {
        disposed = true;
        el.removeEventListener("loadedmetadata", resume);
        resumeAtRef.current = el.currentTime;
      };
    }

    /* ADAPTIVE (video-only track + audio pairing through MediaSource) —
     * the 1080p+ lane. Falls back to the best non-adaptive format when
     * the pairing can't attach (no MSE / unsupported codec). */
    if (format.kind === "adaptive") {
      const MS = (window as unknown as { MediaSource?: typeof MediaSource }).MediaSource;
      const aFmt = (video?.audio ?? []).find((a) => MS?.isTypeSupported?.(a.mime)) ?? null;
      const handle = aFmt
        ? attachAdaptiveCombo(el, format, aFmt, () => {
            const fb = video?.formats.find((f) => f.kind !== "adaptive");
            if (fb && !disposed) setFormat(fb);
          })
        : null;
      if (handle) {
        el.play().catch(() => {}); // autoplay may need a gesture — controls remain
        return () => {
          disposed = true;
          handle.destroy();
          el.removeEventListener("loadedmetadata", resume);
          resumeAtRef.current = el.currentTime;
        };
      }
      const fb = video?.formats.find((f) => f.kind !== "adaptive");
      if (fb) {
        setFormat(fb);
        return () => {
          disposed = true;
          el.removeEventListener("loadedmetadata", resume);
        };
      }
      setFatal("this stream's high-quality lane couldn't attach — try the Quality menu");
      return () => {
        disposed = true;
        el.removeEventListener("loadedmetadata", resume);
      };
    }

    // HLS: hls.js where supported, native (Safari) otherwise.
    let hls: { destroy: () => void } | null = null;
    (async () => {
      const canNative = el.canPlayType("application/vnd.apple.mpegurl");
      if (!canNative) {
        try {
          const mod = await import("hls.js");
          const Hls = mod.default;
          if (disposed || !Hls.isSupported()) {
            if (!disposed && !Hls.isSupported()) playNative(format.url);
            return;
          }
          const instance = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: 30,
            maxBufferLength: 60,
          });
          hls = instance;
          hlsRef.current = instance as unknown as { destroy: () => void; currentLevel: number; levels: unknown[] };
          instance.loadSource(format.url);
          instance.attachMedia(el);
          instance.on(mod.default.Events.MANIFEST_PARSED, () => {
            if (disposed) return;
            const ls = (instance.levels ?? []).map((l: { height?: number; bitrate?: number }, i: number) => ({
              index: i,
              label: l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)} kbps`,
            }));
            setLevels(ls);
            el.play().catch(() => {});
          });
          instance.on(mod.default.Events.FRAG_LOADED, () => {
            if (disposed) return;
            /* every landed fragment earns the network-recovery budget back —
             * idle-connection kills are routine on long HLS streams and a
             * lifetime budget strangled them mid-video */
            recoveries.current = 0;
          });
          instance.on(mod.default.Events.ERROR, (_e: unknown, data: { fatal?: boolean; type?: string }) => {
            if (disposed) return;
            if (!data?.fatal) return;
            if (recoveries.current < 8 && data.type === mod.default.ErrorTypes.NETWORK_ERROR) {
              recoveries.current++;
              instance.startLoad();
              return;
            }
            if (recoveries.current < 2 && data.type === mod.default.ErrorTypes.MEDIA_ERROR) {
              recoveries.current++;
              instance.recoverMediaError();
              return;
            }
            setFatal("the stream broke mid-play — reconnecting to the source…");
            onStreamErrorRef.current?.();
          });
        } catch {
          if (!disposed) playNative(format.url);
        }
      } else {
        playNative(format.url);
      }
    })();

    return () => {
      disposed = true;
      try {
        (hls as unknown as { destroy: () => void } | null)?.destroy();
      } catch { /* already gone */ }
      hlsRef.current = null;
      el.removeEventListener("loadedmetadata", resume);
      resumeAtRef.current = el.currentTime;
    };
  }, [format]);

  /* ---- apply the active caption track (mode switch by index — the
   * <track> elements render in the same order as video.captions) ---- */
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const caps = video?.captions ?? [];
    const tracks = el.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = ccUrl && caps[i]?.url === ccUrl ? "showing" : "disabled";
    }
  }, [ccUrl, video, format]);

  /* ---- video element events ---- */
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    const onEndedEv = () => {
      if (!readPrefs().loop) onEndedRef.current?.();
    };
    const onProgress = () => {
      try {
        if (el.buffered.length > 0) setBuffered(el.buffered.end(el.buffered.length - 1));
      } catch { /* mid-seek */ }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    const onCanPlay = () => setWaiting(false);
    const onVol = () => {
      setVolume(el.volume);
      setMuted(el.muted);
    };
    const onErr = () => {
      if (!hlsRef.current) {
        setFatal("this stream's link went stale — reconnecting to the source…");
        onStreamErrorRef.current?.();
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("progress", onProgress);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("canplay", onCanPlay);
    el.addEventListener("volumechange", onVol);
    el.addEventListener("ended", onEndedEv);
    el.addEventListener("error", onErr);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("canplay", onCanPlay);
      el.removeEventListener("volumechange", onVol);
      el.removeEventListener("ended", onEndedEv);
      el.removeEventListener("error", onErr);
    };
  }, []);

  /* ---- fullscreen state ---- */
  React.useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* ---- controls auto-hide ---- */
  const wake = React.useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!videoRef.current?.paused && !menuOpen) setControlsVisible(false);
    }, 2600);
  }, [menuOpen]);
  React.useEffect(() => {
    if (!playing || menuOpen) setControlsVisible(true);
    else wake();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [playing, menuOpen, wake]);

  /* ---- actions ---- */
  const togglePlay = React.useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, []);

  const seekTo = React.useCallback((t: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(t)) return;
    el.currentTime = Math.max(0, Math.min(t, el.duration || t));
    setCurrent(el.currentTime);
  }, []);

  const toggleMute = React.useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    if (!el.muted && el.volume === 0) el.volume = 0.5;
  }, []);

  const setVol = React.useCallback((v: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = v;
    el.muted = v === 0;
  }, []);

  const toggleFs = React.useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shellRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  const togglePip = React.useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch { /* unsupported — ignore */ }
  }, []);

  const pickLevel = React.useCallback((index: number) => {
    setActiveLevel(index);
    const hls = hlsRef.current as ({ currentLevel: number } | null);
    if (hls) hls.currentLevel = index;
    setMenuOpen(false);
  }, []);

  const retry = React.useCallback(() => {
    setFatal(null);
    const el = videoRef.current;
    /* re-run the whole attach: a fresh format object re-keys the load
     * effect — MSE combos rebuild, hls reloads, progressive re-srcs —
     * and the resume logic seeks back where the stream died. (The old
     * el.load() path detached the MediaSource and never recovered.) */
    if (el && el.currentTime > 2) resumeAtRef.current = el.currentTime;
    setFormat((f) => (f ? { ...f } : f));
  }, []);

  /* ---- stall watchdog (the native lane) ----
   * A proxied stream can choke mid-play with no error event at all —
   * the element just sits in `waiting` on a frozen frame forever. If
   * we've been waiting 30s with no buffer growth, re-run the format
   * load from the stuck position (the same re-attach retry() uses);
   * twice inside two minutes escalates to the fatal + heal path —
   * healthy stretches of playback heal the budget back, so a LONG
   * video with occasional routine stalls never runs dry (mirrors the
   * pump's progress-earned reconnects). Reset when the format (re)loads. */
  const lastStallFixAt = React.useRef(0);
  React.useEffect(() => {
    if (!waiting || fatal) return;
    const since = { at: Date.now(), buf: buffered };
    const t = setInterval(() => {
      if (buffered > since.buf + 0.5) {
        since.buf = buffered;
        since.at = Date.now();
        /* sustained healthy playback earns stall fixes back */
        if (stallFixes.current > 0 && lastStallFixAt.current && Date.now() - lastStallFixAt.current > 120_000) {
          stallFixes.current = 0;
        }
        return;
      }
      if (Date.now() - since.at < 30000) return;
      if (stallFixes.current < 2) {
        stallFixes.current += 1;
        lastStallFixAt.current = Date.now();
        retry();
      } else {
        setFatal("this stream keeps stalling — reconnecting to the source…");
        onStreamErrorRef.current?.();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [waiting, buffered, fatal, retry]);

  /* ---- keyboard ---- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      const el = videoRef.current;
      if (!el) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          seekTo(el.currentTime - 5);
          break;
        case "ArrowRight":
          seekTo(el.currentTime + 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVol(Math.min(1, el.volume + 0.1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVol(Math.max(0, el.volume - 0.1));
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFs();
          break;
        default:
          break;
      }
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, setVol, toggleMute, toggleFs, wake]);

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div className="min-w-0">
      {/* ── player shell ── */}
      <div
        ref={shellRef}
        onPointerMove={wake}
        onPointerLeave={() => {
          if (playing && !menuOpen) setControlsVisible(false);
        }}
        className="group/player relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/50 ring-1 ring-white/10"
      >
        <video
          ref={videoRef}
          onClick={togglePlay}
          onDoubleClick={toggleFs}
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          poster={meta.thumb || undefined}
          className="size-full cursor-pointer bg-black"
          aria-label={`video player: ${meta.title}`}
        >
          {/* caption tracks render in video.captions order — the mode
           * switch (showing/disabled) is driven by the ccUrl effect */}
          {(video?.captions ?? []).map((c) => (
            <track key={c.url} kind="subtitles" src={c.url} srcLang={c.code || undefined} label={c.label} />
          ))}
        </video>

        {/* loading spinner */}
        {waiting && !fatal && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 aria-hidden className="size-10 animate-spin text-rose-400/90" />
          </div>
        )}

        {/* fatal error panel — SELF-HEAL variant while the parent re-extracts */}
        {fatal && healing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center backdrop-blur-sm">
            <Loader2 aria-hidden className="size-8 animate-spin text-rose-400" />
            <p className="max-w-sm text-[13.5px] leading-relaxed text-zinc-300">{fatal}</p>
            <p className="text-[11.5px] text-zinc-500">
              pulling a fresh stream from the source — this can take up to a minute
            </p>
          </div>
        )}

        {/* fatal error panel */}
        {fatal && !healing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center backdrop-blur-sm">
            <ShieldAlert aria-hidden className="size-8 text-rose-400" />
            <p className="max-w-sm text-[13.5px] leading-relaxed text-zinc-300">{fatal}</p>
            <div className="flex gap-2">
              <Button size="sm" onClick={retry} className="h-8 rounded-xl bg-rose-500 text-rose-950 hover:bg-rose-400">
                <RefreshCw aria-hidden className="size-3.5" /> Retry
              </Button>
            </div>
          </div>
        )}

        {/* no playable formats in the answer */}
        {noFormats && !fatal && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center backdrop-blur-sm">
            <ShieldAlert aria-hidden className="size-8 text-amber-300" />
            <p className="max-w-sm text-[13.5px] leading-relaxed text-zinc-300">
              The gate handed this video over without a playable stream — it usually rotates back within a minute.
            </p>
            <Button
              size="sm"
              onClick={() => setFormat((f) => (f ? { ...f } : f))}
              className="h-8 rounded-xl bg-rose-500 text-rose-950 hover:bg-rose-400"
            >
              <RefreshCw aria-hidden className="size-3.5" /> Retry
            </Button>
          </div>
        )}

        {/* center play (when paused at start) */}
        {!playing && !waiting && !fatal && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-rose-500/95 text-white shadow-xl shadow-rose-500/30 transition hover:scale-105 hover:bg-rose-400"
          >
            <Play aria-hidden className="size-6 translate-x-0.5 fill-white" />
          </button>
        )}

        {/* ── control bar ── */}
        <AnimatePresence>
          {controlsVisible && !fatal && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-10 sm:px-4"
            >
              {/* seek */}
              <div className="relative flex h-4 items-center">
                <div aria-hidden className="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-white/15">
                  <div className="h-full bg-white/25" style={{ width: `${Math.min(100, bufPct)}%` }} />
                </div>
                <Slider
                  value={[Math.min(current, duration || current)]}
                  max={Math.max(duration, 1)}
                  step={0.5}
                  onValueChange={(v) => seekTo(v[0] ?? 0)}
                  aria-label="Seek"
                  className="relative z-10 cursor-pointer [&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-transparent [&_[data-slot=slider-range]]:bg-rose-500 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-rose-500 [&_[data-slot=slider-thumb]]:shadow-md"
                />
              </div>
              {/* buttons row */}
              <div className="mt-1 flex items-center gap-1 text-zinc-200">
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={playing ? "Pause" : "Play"}
                  className="flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white"
                >
                  {playing ? (
                    <Pause aria-hidden className="size-4.5 fill-current" />
                  ) : (
                    <Play aria-hidden className="size-4.5 translate-x-px fill-current" />
                  )}
                </button>
                {/* volume */}
                <div className="group/vol flex items-center">
                  <button
                    type="button"
                    onClick={toggleMute}
                    aria-label={muted ? "Unmute" : "Mute"}
                    className="flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white"
                  >
                    {muted || volume === 0 ? (
                      <VolumeX aria-hidden className="size-4.5" />
                    ) : (
                      <Volume2 aria-hidden className="size-4.5" />
                    )}
                  </button>
                  <div className="w-0 overflow-hidden transition-all duration-200 group-hover/vol:w-20 group-focus-within/vol:w-20">
                    <Slider
                      value={[muted ? 0 : volume]}
                      max={1}
                      step={0.05}
                      onValueChange={(v) => setVol(v[0] ?? 1)}
                      aria-label="Volume"
                      className="mx-2.5 cursor-pointer [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-range]]:bg-white/70 [&_[data-slot=slider-thumb]]:size-2.5 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-white"
                    />
                  </div>
                </div>
                {/* time */}
                <span className="ml-1 select-none text-[12px] font-medium tabular-nums text-zinc-300">
                  {fmtTime(current)} <span className="text-zinc-500">/ {fmtTime(duration || meta.durationSec)}</span>
                </span>
                <div className="flex-1" />
                {/* settings: quality ladder + speed + loop (the gear) */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-label="Player settings"
                    aria-expanded={menuOpen}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white",
                      menuOpen && "bg-white/10 text-white",
                    )}
                  >
                    <Settings aria-hidden className={cn("size-4", menuOpen && "rotate-45 transition-transform")} />
                  </button>
                  {menuOpen && (
                    <>
                      <button
                        type="button"
                        aria-label="Close menu"
                        className="fixed inset-0 z-20 cursor-default"
                        onClick={() => setMenuOpen(false)}
                      />
                      <div className="veil-scroll-slim absolute bottom-10 right-0 z-30 max-h-[22rem] w-52 overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900/95 py-1 shadow-2xl backdrop-blur-md">
                        <p className="px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                          Quality
                        </p>
                        {format?.kind === "hls" && (
                          <MenuItem
                            label="Auto"
                            active={activeLevel === -1}
                            onClick={() => pickLevel(-1)}
                          />
                        )}
                        {levels.map((l) => (
                          <MenuItem
                            key={l.index}
                            label={l.label}
                            active={activeLevel === l.index}
                            onClick={() => pickLevel(l.index)}
                          />
                        ))}
                        {(() => {
                          /* the quality ladder first (adaptive combos, deduped
                           * per label — YouTube offers h264 + vp9 at the same
                           * height), then HLS, then progressive */
                          const seen = new Set<string>();
                          const ladder = (video?.formats ?? [])
                            .filter((f) => f.kind === "adaptive")
                            .filter((f) => (seen.has(f.label) ? false : (seen.add(f.label), true)))
                            .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
                          const rest = (video?.formats ?? []).filter((f) => f.kind !== "adaptive");
                          return [...ladder, ...rest].map((f) => (
                            <MenuItem
                              key={f.url}
                              label={f.kind === "hls" ? "Adaptive stream" : f.label}
                              active={format?.url === f.url}
                              onClick={() => {
                                setFormat(f);
                                /* remember the ceiling so NEW videos start here too */
                                const h = parseInt(f.label, 10);
                                if (Number.isFinite(h) && h > 0) savePrefs({ maxHeight: h });
                                setMenuOpen(false);
                              }}
                            />
                          ));
                        })()}
                        {video && video.formats.length === 0 && (
                          <p className="px-3 py-2 text-[12px] text-zinc-500">no streams in this answer</p>
                        )}
                        {/* captions (CC) — the track list when the body carries them */}
                        {(video?.captions ?? []).length > 0 && (
                          <>
                            <p className="mt-1 border-t border-zinc-800 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                              <span className="flex items-center gap-1.5">
                                <Subtitles aria-hidden className="size-3" /> Subtitles
                              </span>
                            </p>
                            <MenuItem label="Off" active={ccUrl === null} onClick={() => { setCcUrl(null); setMenuOpen(false); }} />
                            {(video?.captions ?? []).map((c) => (
                              <MenuItem
                                key={c.url}
                                label={c.label}
                                active={ccUrl === c.url}
                                onClick={() => { setCcUrl(c.url); setMenuOpen(false); }}
                              />
                            ))}
                          </>
                        )}
                        {/* speed */}
                        <p className="mt-1 border-t border-zinc-800 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                          Speed
                        </p>
                        <div className="flex flex-wrap gap-1 px-2.5 pb-2 pt-0.5">
                          {SPEED_STEPS.map((s) => {
                            const active = Math.abs(readPrefs().speed - s) < 0.01;
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={() => savePrefs({ speed: s })}
                                aria-pressed={active}
                                className={cn(
                                  "rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition",
                                  active
                                    ? "bg-rose-500/20 text-rose-300 ring-1 ring-rose-500/40"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                                )}
                              >
                                {s === 1 ? "1×" : `${s}×`}
                              </button>
                            );
                          })}
                        </div>
                        {/* loop */}
                        <button
                          type="button"
                          onClick={() => savePrefs({ loop: !readPrefs().loop })}
                          aria-pressed={readPrefs().loop}
                          className="flex w-full items-center justify-between border-t border-zinc-800 px-3 py-2 text-left text-[12.5px] text-zinc-300 transition hover:bg-white/5 hover:text-white"
                        >
                          <span className="flex items-center gap-2">
                            <Repeat aria-hidden className="size-3.5" /> Loop
                          </span>
                          <span
                            aria-hidden
                            className={cn(
                              "flex h-4.5 w-8 items-center rounded-full px-0.5 transition",
                              readPrefs().loop ? "justify-end bg-rose-500" : "justify-start bg-zinc-700",
                            )}
                          >
                            <span className="size-3.5 rounded-full bg-white" />
                          </span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {/* pip */}
                <button
                  type="button"
                  onClick={togglePip}
                  aria-label="Picture in picture"
                  className="hidden size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white sm:flex"
                >
                  <PictureInPicture2 aria-hidden className="size-4" />
                </button>
                {/* fullscreen */}
                <button
                  type="button"
                  onClick={toggleFs}
                  aria-label={isFs ? "Exit fullscreen" : "Fullscreen"}
                  className="flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white"
                >
                  {isFs ? <Minimize aria-hidden className="size-4.5" /> : <Maximize aria-hidden className="size-4.5" />}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── metadata ── */}
      <div className="mt-4 min-w-0">
        <h2 className="text-[17px] font-semibold leading-snug tracking-tight text-zinc-50">{meta.title}</h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {meta.authorId ? (
            <button
              type="button"
              onClick={() => onChannel(meta.authorId, meta.author)}
              aria-label={`Open channel: ${meta.author}`}
              className="group/ch flex min-w-0 items-center gap-2.5 rounded-xl p-1 pr-2.5 text-left transition hover:bg-zinc-900/80"
            >
              {video?.authorAvatar ? (
                <Thumb src={video.authorAvatar} alt="" className="size-8 shrink-0 rounded-full" />
              ) : (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-[12px] font-bold text-rose-300 ring-1 ring-rose-500/30">
                  {meta.author.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="min-w-0">
                <span className="flex items-center gap-1 truncate text-[13.5px] font-medium text-zinc-100 transition group-hover/ch:text-rose-300">
                  {meta.author}
                  {meta.verified && (
                    <ShieldCheck aria-label="verified channel" className="inline size-3 shrink-0 align-[-1px] text-zinc-400" />
                  )}
                </span>
                <span className="block truncate text-[11.5px] tabular-nums text-zinc-500">
                  {fmtCount(meta.views)} views · {ageLabel(meta.published)}
                </span>
              </span>
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-2.5">
              {video?.authorAvatar ? (
                <Thumb src={video.authorAvatar} alt="" className="size-8 shrink-0 rounded-full" />
              ) : (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-[12px] font-bold text-rose-300 ring-1 ring-rose-500/30">
                  {meta.author.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-zinc-100">
                  {meta.author}
                  {meta.verified && (
                    <ShieldCheck aria-label="verified channel" className="ml-1 inline size-3 align-[-1px] text-zinc-400" />
                  )}
                </p>
                <p className="truncate text-[11.5px] tabular-nums text-zinc-500">
                  {fmtCount(meta.views)} views · {ageLabel(meta.published)}
                </p>
              </div>
            </div>
          )}
          <div className="flex-1" />
          {meta.authorId && (
            <SubscribeButton channelId={meta.authorId} name={meta.author} avatar={video?.authorAvatar} tone="rose" />
          )}
          <LikeBar videoId={meta.id} likes={video?.likes ?? 0} dislikes={video?.dislikes ?? 0} chan={{ authorId: meta.authorId, author: meta.author }} />
          {meta.id && <SaveToPlaylist card={meta} />}
        </div>
        {video?.description && (
          <details className="group mt-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 px-4 py-3">
            <summary className="cursor-pointer select-none list-none text-[12.5px] font-semibold text-zinc-300 transition hover:text-zinc-100">
              Description
              <span className="ml-1.5 text-zinc-500 group-open:hidden">— tap to expand</span>
            </summary>
            <p className="mt-2.5 max-h-64 overflow-y-auto whitespace-pre-line text-[13px] leading-relaxed text-zinc-400 veil-scroll-slim">
              {video.description}
            </p>
          </details>
        )}
      </div>

      {/* ── comments (read-only YouTube threads) ── */}
      {meta.id && <CommentsPanel videoId={meta.id} />}
    </div>
  );
}

function MenuItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] transition",
        active ? "bg-rose-500/15 text-rose-300" : "text-zinc-300 hover:bg-white/5 hover:text-white",
      )}
    >
      <span className="truncate">{label}</span>
      {active && <ShieldCheck aria-hidden className="ml-2 size-3.5 shrink-0" />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Channel browsing                                                      */
/* ------------------------------------------------------------------ */

/** A vertical shorts card for the channel shelf. */
function ShortCard({ card, index, onWatch }: { card: YtCard; index: number; onWatch: (id: string, card: YtCard) => void }) {
  const reduceMotion = useReducedMotion();
  /* NOTE: div[role=button], not a <button> — the feedback ⋮ menu (and
   * its nested <button>s) live inside this card, and button-in-button
   * is invalid HTML (a hydration error). Keyboard users get Enter/Space. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onWatch(card.id, card);
    }
  };
  return (
    <motion.div
      role="button"
      tabIndex={0}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.03, 0.3) }}
      onClick={() => onWatch(card.id, card)}
      onKeyDown={onKeyDown}
      aria-label={`Watch short: ${card.title}`}
      className="group flex w-full cursor-pointer flex-col gap-2.5 rounded-xl text-left outline-none transition-transform duration-200 focus-visible:ring-2 focus-visible:ring-fuchsia-500/40"
    >
      {/* thumb + feedback ⋮ wrapper — the menu expands DOWN past the
       * thumb, so it can't live inside the overflow-hidden box */}
      <div className="relative">
        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-xl ring-1 ring-zinc-800/60 transition duration-300 group-hover:shadow-2xl group-hover:shadow-black/60 group-hover:ring-zinc-700/80">
          <Thumb src={card.thumb} alt={card.title} />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/30 group-hover:opacity-100">
            <span className="flex size-11 items-center justify-center rounded-full bg-fuchsia-500/95 shadow-xl shadow-fuchsia-500/30">
              <Play aria-hidden className="size-5 translate-x-0.5 text-white fill-white" />
            </span>
          </div>
          <span className="absolute bottom-2 right-2 rounded-md bg-fuchsia-500/95 px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-white">
            short
          </span>
        </div>
        <CardFeedbackMenu card={card} />
      </div>
      <div className="min-w-0">
        <h3 className="line-clamp-2 text-[12.5px] font-medium leading-snug text-zinc-100">{card.title}</h3>
        {/* channel row - real logo + name, like YouTube's shorts shelf */}
        <div className="mt-1 flex items-center gap-1.5">
          <ChannelAvatar name={card.author} id={card.authorId} size={20} avatar={card.avatar} />
          <span className="min-w-0 truncate text-[11px] text-zinc-400">{card.author}</span>
        </div>
        {card.why && (
          <p className="mt-1 flex items-center gap-1 truncate text-[10.5px] text-fuchsia-300/75" title={card.why}>
            <Sparkles aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{card.why}</span>
          </p>
        )}
        <p className="mt-0.5 truncate text-[11px] tabular-nums text-zinc-500">
          {card.views > 0 ? `${fmtCount(card.views)} views` : ageLabel(card.published) || "short"}
        </p>
      </div>
    </motion.div>
  );
}

/** Sort orders for a channel's shelves — Popular (views), Newest,
 * Oldest. `publishedAt` (unix seconds) is mapped on every card the
 * compat service emits; `published` text is the fallback. */
type ChannelSort = "popular" | "newest" | "oldest";

function sortChannelCards(cards: YtCard[], sort: ChannelSort): YtCard[] {
  const list = [...cards];
  if (sort === "popular") list.sort((a, b) => b.views - a.views);
  else if (sort === "newest") list.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  else list.sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));
  return list;
}

/** One community post — text, publish age, image attachments, poll,
 * like/comment counts. Images/avatars arrive as same-origin proxy URLs. */
function ChannelPostCard({ post }: { post: YtPost }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50">
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        {post.avatar ? (
          <Thumb src={post.avatar} alt="" className="size-8 shrink-0 rounded-full" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-[12px] font-bold text-sky-300">
            {(post.author || "•").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-zinc-100">{post.author}</p>
          <p className="text-[11px] text-zinc-500">{post.published || "community post"}</p>
        </div>
      </div>
      {post.text && (
        <p className="whitespace-pre-line px-4 pt-2.5 text-[13px] leading-relaxed text-zinc-200">{post.text}</p>
      )}
      {post.images.length > 0 && (
        <div className={cn("mt-3 grid gap-0.5", post.images.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
          {post.images.slice(0, 4).map((src, i) => (
            <Thumb
              key={`${post.id}-${i}`}
              src={src}
              alt=""
              className={cn("w-full object-cover", post.images.length > 1 ? "aspect-video" : "max-h-96")}
            />
          ))}
        </div>
      )}
      {post.poll && (
        <div className="mt-3 space-y-1.5 px-4">
          <p className="text-[12.5px] font-semibold text-zinc-100">{post.poll.question}</p>
          {post.poll.options.map((o, i) => (
            <div key={i} className="relative h-7 overflow-hidden rounded-lg bg-zinc-800/60">
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 bg-sky-500/25"
                style={{ width: `${Math.min(100, Math.max(3, o.pct))}%` }}
              />
              <span className="relative flex h-full items-center justify-between gap-3 px-2.5 text-[11.5px] text-zinc-200">
                <span className="truncate">{o.text}</span>
                <span className="shrink-0 tabular-nums text-zinc-400">{o.pct}%</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-4 border-t border-zinc-800/70 px-4 py-2.5 text-[11.5px] tabular-nums text-zinc-500">
        <span className="flex items-center gap-1.5">
          <ThumbsUp aria-hidden className="size-3.5" /> {post.likes > 0 ? fmtCount(post.likes) : "—"}
        </span>
        <span className="flex items-center gap-1.5">
          <MessageSquare aria-hidden className="size-3.5" /> {post.comments > 0 ? fmtCount(post.comments) : "—"}
        </span>
      </div>
    </article>
  );
}

/** The channel page — header + Videos / Shorts / Live / Posts tabs
 * (Videos + Shorts arrive with the channel answer; Live + Posts
 * lazy-load their first page on first visit), each video shelf sortable
 * by Popular / Newest / Oldest. */
function ChannelPanel({
  channel,
  onWatch,
  onChannel,
  onOpenShort,
}: {
  channel: YtChannel;
  onWatch: (id: string, card: YtCard) => void;
  onChannel: (id: string, name: string) => void;
  /** opens the vertical shorts viewer with this channel's shorts */
  onOpenShort: (card: YtCard) => void;
}) {
  const [tab, setTab] = React.useState<"videos" | "shorts" | "live" | "posts">("videos");
  const [sort, setSort] = React.useState<ChannelSort>("newest");
  const reduceMotion = useReducedMotion();

  /* the channel's REAL logo rides the global avatar store — every card
   * on this page (and every mention of the channel anywhere else in the
   * app) picks it up with ZERO extra requests. */
  React.useEffect(() => {
    if (channel.avatar) avatarStore.put({ [channel.id]: channel.avatar });
  }, [channel.id, channel.avatar]);

  /* ── lazy Live / Posts tabs — fetched on FIRST visit of the tab (an
   * empty continuation asks the server for that tab's first page); the
   * videos/shorts shelves above arrive with the channel answer ── */
  const [streams, setStreams] = React.useState<YtCard[] | null>(null);
  const [streamsNext, setStreamsNext] = React.useState<string | null>(null);
  const [streamsBusy, setStreamsBusy] = React.useState(false);
  const [streamsErr, setStreamsErr] = React.useState<string | null>(null);
  const [posts, setPosts] = React.useState<YtPost[] | null>(null);
  const [postsNext, setPostsNext] = React.useState<string | null>(null);
  const [postsBusy, setPostsBusy] = React.useState(false);
  const [postsErr, setPostsErr] = React.useState<string | null>(null);

  const loadTab = React.useCallback(
    (which: "streams" | "posts", token?: string | null) => {
      const isLive = which === "streams";
      const busy = isLive ? streamsBusy : postsBusy;
      if (busy) return;
      (isLive ? setStreamsBusy : setPostsBusy)(true);
      (isLive ? setStreamsErr : setPostsErr)(null);
      fetchJsonSafe<{ cards?: YtCard[]; posts?: YtPost[]; next?: string | null } | YtGate>(
        `/api/yt/channel/${encodeURIComponent(channel.id)}?more=${which}${token ? `&continuation=${encodeURIComponent(token)}` : ""}`,
      )
        .then((body) => {
          if (body && "gated" in body) {
            (isLive ? setStreamsErr : setPostsErr)(body.message);
            return;
          }
          if (isLive) {
            const fresh = (body.cards ?? []).filter((c) => c && c.id);
            setStreams((prev) => {
              const have = new Set((prev ?? []).map((c) => c.id));
              return [...(prev ?? []), ...fresh.filter((c) => !have.has(c.id))];
            });
            setStreamsNext(body.next ?? null);
          } else {
            const fresh = (body.posts ?? []).filter((p) => p && p.id);
            setPosts((prev) => {
              const have = new Set((prev ?? []).map((p) => p.id));
              return [...(prev ?? []), ...fresh.filter((p) => !have.has(p.id))];
            });
            setPostsNext(body.next ?? null);
          }
        })
        .catch((e: Error) => {
          (isLive ? setStreamsErr : setPostsErr)(e.message || (isLive ? "the live shelf didn't load" : "the posts didn't load"));
        })
        .finally(() => (isLive ? setStreamsBusy : setPostsBusy)(false));
    },
    [channel.id, streamsBusy, postsBusy],
  );

  /* first visit of a lazy tab pulls its first page */
  React.useEffect(() => {
    if (tab === "live" && streams === null && !streamsBusy) loadTab("streams", null);
    if (tab === "posts" && posts === null && !postsBusy) loadTab("posts", null);
  }, [tab, streams, posts, streamsBusy, postsBusy, loadTab]);

  /* ── shelf pagination — Piped hands ~30 videos / ~48 shorts per page;
   * "Load more" pulls the next page via the continuation tokens until a
   * page comes back empty or the channel runs dry. The parent keys this
   * component by channel id, so a channel switch resets the state. */
  const [vidList, setVidList] = React.useState<YtCard[]>(channel.videos);
  const [shortList, setShortList] = React.useState<YtCard[]>(channel.shorts);
  const [vNext, setVNext] = React.useState<string | null>(channel.videosNext);
  const [sNext, setSNext] = React.useState<string | null>(channel.shortsNext);
  const [vMore, setVMore] = React.useState(false);
  const [sMore, setSMore] = React.useState(false);
  const [vErr, setVErr] = React.useState<string | null>(null);
  const [sErr, setSErr] = React.useState<string | null>(null);

  const loadMoreShelf = React.useCallback(
    (which: "videos" | "shorts") => {
      const token = which === "videos" ? vNext : sNext;
      if (!token || (which === "videos" ? vMore : sMore)) return;
      (which === "videos" ? setVMore : setSMore)(true);
      (which === "videos" ? setVErr : setSErr)(null);
      fetchJsonSafe<{ cards?: YtCard[]; next?: string | null } | YtGate>(
        `/api/yt/channel/${encodeURIComponent(channel.id)}?more=${which}&continuation=${encodeURIComponent(token)}`,
      )
        .then((body) => {
          if (body && "gated" in body) {
            (which === "videos" ? setVErr : setSErr)(body.message);
            return;
          }
          const fresh = (body.cards ?? []).filter(Boolean);
          (which === "videos" ? setVidList : setShortList)((prev) => {
            const have = new Set(prev.map((c) => c.id));
            const add = fresh.filter((c) => c.id && !have.has(c.id));
            /* a page that only recycles already-seen ids = shelf end */
            if (add.length === 0 && fresh.length > 0 && !body.next) return prev;
            return [...prev, ...add];
          });
          const nextToken = body.next ?? null;
          (which === "videos" ? setVNext : setSNext)(nextToken);
        })
        .catch((e: Error) => {
          (which === "videos" ? setVErr : setSErr)(e.message || "the next page didn't load");
        })
        .finally(() => (which === "videos" ? setVMore : setSMore)(false));
    },
    [channel.id, vNext, sNext, vMore, sMore],
  );

  const videos = sortChannelCards(vidList, sort);
  const shorts = sortChannelCards(shortList, sort);
  const liveCards = React.useMemo(() => (streams ? sortChannelCards(streams, sort) : []), [streams, sort]);
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      {/* ── channel header ── */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5 sm:p-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-rose-500/[0.08] via-rose-500/[0.03] to-transparent"
        />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
          {channel.avatar ? (
            <Thumb src={channel.avatar} alt="" className="size-20 shrink-0 rounded-full ring-2 ring-zinc-700/60 sm:size-24" />
          ) : (
            <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-[26px] font-bold text-rose-300 ring-2 ring-zinc-700/60 sm:size-24">
              {channel.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-[19px] font-semibold tracking-tight text-zinc-50">
              <span className="break-words">{channel.name}</span>
              {channel.verified && <ShieldCheck aria-label="verified channel" className="size-4.5 shrink-0 text-zinc-400" />}
            </h2>
            {channel.subs > 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-[12.5px] tabular-nums text-zinc-400">
                <Users aria-hidden className="size-3.5 text-rose-400/80" />
                {fmtSubs(channel.subs)}
                <span className="mx-1 text-zinc-600">·</span>
                {videos.length + shorts.length} items on this page
              </p>
            )}
            {channel.description && (
              <details className="group mt-3">
                <summary className="cursor-pointer select-none text-[12px] font-medium text-zinc-500 transition hover:text-zinc-300">
                  About the channel
                  <span className="ml-1.5 text-zinc-600 group-open:hidden">— tap to expand</span>
                </summary>
                <p className="veil-scroll-slim mt-2 max-h-32 max-w-3xl overflow-y-auto whitespace-pre-line text-[12.5px] leading-relaxed text-zinc-400">
                  {channel.description}
                </p>
              </details>
            )}
          </div>
          <SubscribeButton channelId={channel.id} name={channel.name} avatar={channel.avatar} tone="zinc" />
        </div>
      </div>

      {/* ── tabs + sort ── */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-2xl border border-zinc-800 bg-zinc-900/60 p-1">
          {([
            ["videos", `Videos${videos.length ? ` · ${videos.length}` : ""}`],
            ["shorts", `Shorts${shorts.length ? ` · ${shorts.length}` : ""}`],
            ["live", "Live"],
            ["posts", "Posts"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn(
                "rounded-xl px-4 py-1.5 text-[12.5px] font-semibold transition",
                tab === key
                  ? key === "shorts"
                    ? "bg-fuchsia-500 text-fuchsia-950"
                    : key === "live"
                      ? "bg-red-500 text-red-950"
                      : key === "posts"
                        ? "bg-sky-500 text-sky-950"
                        : "bg-rose-500 text-rose-950"
                  : "text-zinc-400 hover:text-zinc-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* sort order — Popular (views) / Newest / Oldest, applies to the video shelves (not posts) */}
        {tab !== "posts" && (
        <div
          role="group"
          aria-label="Sort order"
          className="flex items-center gap-0.5 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-1"
        >
          {(
            [
              ["popular", "Popular"],
              ["newest", "Newest"],
              ["oldest", "Oldest"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSort(key)}
              aria-pressed={sort === key}
              className={cn(
                "rounded-xl px-3 py-1.5 text-[11.5px] font-semibold transition",
                sort === key
                  ? "bg-zinc-100 text-zinc-900"
                  : "text-zinc-400 hover:text-zinc-100",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        )}
        <div className="h-px min-w-6 flex-1 bg-zinc-800/70" />
      </div>

      {/* ── shelf ── */}
      <div className="mt-4">
        {tab === "videos" ? (
          videos.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {videos.map((c, i) => (
                  <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={onWatch} onChannel={onChannel} />
                ))}
              </div>
              {/* load the next page of uploads (~30 per page upstream) */}
              {vNext ? (
                <div className="mt-6 flex flex-col items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => loadMoreShelf("videos")}
                    disabled={vMore}
                    className="h-9 gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:border-rose-500/40 hover:text-rose-300"
                  >
                    {vMore ? (
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <ChevronDown aria-hidden className="size-3.5" />
                    )}
                    {vMore ? "loading…" : "Load more videos"}
                  </Button>
                  {vErr && <p className="text-[11.5px] text-amber-300/80">{vErr}</p>}
                </div>
              ) : (
                <p className="mt-6 text-center text-[11.5px] text-zinc-600">
                  that's every upload on the first pages — the shelf ends here
                </p>
              )}
            </>
          ) : (
            <p className="py-10 text-center text-[13px] text-zinc-500">no videos came back for this channel</p>
          )
        ) : tab === "shorts" ? (
          shorts.length > 0 ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {shorts.map((c, i) => (
                <ShortCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => onOpenShort(card)} />
              ))}
            </div>
            {/* load the next page of shorts (~48 per page upstream) */}
            {sNext ? (
              <div className="mt-6 flex flex-col items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadMoreShelf("shorts")}
                  disabled={sMore}
                  className="h-9 gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:border-fuchsia-500/40 hover:text-fuchsia-300"
                >
                  {sMore ? (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  ) : (
                    <ChevronDown aria-hidden className="size-3.5" />
                  )}
                  {sMore ? "loading…" : "Load more shorts"}
                </Button>
                {sErr && <p className="text-[11.5px] text-amber-300/80">{sErr}</p>}
              </div>
            ) : (
              <p className="mt-6 text-center text-[11.5px] text-zinc-600">that's the whole shorts shelf</p>
            )}
          </>
          ) : (
            <p className="py-10 text-center text-[13px] text-zinc-500">this channel has no shorts shelf</p>
          )
        ) : tab === "live" ? (
          streams === null ? (
            <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              <CardSkeletons n={4} />
            </div>
          ) : streamsErr && streams.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-[13px] text-zinc-500">{streamsErr}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => loadTab("streams", null)}
                className="h-8 rounded-xl border-zinc-700"
              >
                <RefreshCw aria-hidden className="size-3.5" /> Retry
              </Button>
            </div>
          ) : liveCards.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {liveCards.map((c, i) => (
                  <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={onWatch} onChannel={onChannel} />
                ))}
              </div>
              {streamsNext ? (
                <div className="mt-6 flex flex-col items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => loadTab("streams", streamsNext)}
                    disabled={streamsBusy}
                    className="h-9 gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:border-red-500/40 hover:text-red-300"
                  >
                    {streamsBusy ? (
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <ChevronDown aria-hidden className="size-3.5" />
                    )}
                    {streamsBusy ? "loading…" : "Load more streams"}
                  </Button>
                </div>
              ) : (
                <p className="mt-6 text-center text-[11.5px] text-zinc-600">that's the whole live shelf</p>
              )}
            </>
          ) : (
            <p className="py-10 text-center text-[13px] text-zinc-500">no live streams on this channel right now</p>
          )
        ) : posts === null ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Loader2 aria-hidden className="size-5 animate-spin text-sky-300/80" />
            <p className="text-[12.5px] text-zinc-500">fetching the community tab…</p>
          </div>
        ) : postsErr && posts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-[13px] text-zinc-500">{postsErr}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => loadTab("posts", null)}
              className="h-8 rounded-xl border-zinc-700"
            >
              <RefreshCw aria-hidden className="size-3.5" /> Retry
            </Button>
          </div>
        ) : posts.length > 0 ? (
          <>
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
              {posts.map((p) => (
                <ChannelPostCard key={p.id} post={p} />
              ))}
            </div>
            {postsNext ? (
              <div className="mt-6 flex flex-col items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => loadTab("posts", postsNext)}
                  disabled={postsBusy}
                  className="h-9 gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:border-sky-500/40 hover:text-sky-300"
                >
                  {postsBusy ? (
                    <Loader2 aria-hidden className="size-3.5 animate-spin" />
                  ) : (
                    <ChevronDown aria-hidden className="size-3.5" />
                  )}
                  {postsBusy ? "loading…" : "Load more posts"}
                </Button>
              </div>
            ) : (
              <p className="mt-6 text-center text-[11.5px] text-zinc-600">that's the whole community tab</p>
            )}
          </>
        ) : (
          <p className="py-10 text-center text-[13px] text-zinc-500">this channel hasn't posted anything yet</p>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Relay player — the fallback lane when the gate is shut              */
/* ------------------------------------------------------------------ */

/* YouTube iframe player states (infoDelivery.playerState) */
const YT_UNSTARTED = -1;
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
const YT_CUED = 5;

/** Frame events that prove the embed's widget session is ALIVE — the
 * zombie watchdog stamps liveness from these only, so widgetspeak like
 * "alreadyInitialized" (the zombie's entire vocabulary) can't fake it. */
const LIVE_FRAME_EVENTS = new Set([
  "infoDelivery",
  "onStateChange",
  "initialDelivery",
  "onPlaybackQualityChange",
  "onReady",
  "onError",
  "onVolumeChange",
  "onApiChange",
]);

function RelayPlayer({
  card,
  gateMessage,
  healed,
  likes,
  dislikes,
  description,
  onTryNative,
  onWatch,
  onChannel,
  onEnded,
  more,
}: {
  card: YtCard;
  /** the gate message (kept for the latch decision upstream) */
  gateMessage: string | null;
  /** true when a background probe landed a native body mid-relay */
  healed: boolean;
  /** like/dislike counts from the gate-independent /next meta */
  likes: number;
  dislikes: number;
  /** the video description from the gate-independent /next meta — the
   * relay lane shows the real description even while extraction is
   * gated (the old behavior: no description at all on relayed videos) */
  description?: string;
  onTryNative: () => void;
  onWatch: (id: string, card: YtCard | null) => void;
  /** opens the channel page */
  onChannel: (id: string, name: string) => void;
  /** marathon: a playlist is playing — advance on ended (loop off). */
  onEnded?: () => void;
  /** cards from the browsing context — the "Up next" rail while relaying */
  more: YtCard[];
}) {
  const reduceMotion = useReducedMotion();
  const shellRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<HTMLIFrameElement>(null);

  /* playback state, mirrored from infoDelivery messages */
  const [state, setState] = React.useState<number>(YT_UNSTARTED);
  const [current, setCurrent] = React.useState(0);
  const [duration, setDuration] = React.useState(card.durationSec || 0);
  const [volume, setVolume] = React.useState(100);
  const [muted, setMuted] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [isFs, setIsFs] = React.useState(false);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefsV = usePrefsVersion();

  /* marathon: advance on ended (loop off only) */
  const onEndedRef = React.useRef(onEnded);
  React.useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);
  /* relay CC (best-effort): YouTube's own caption renderer, driven over
   * the iframe API — on picks the track, {} turns it off. */
  const [ccOn, setCcOn] = React.useState(false);
  /* the quality the frame is ACTUALLY playing ("hd1080"…) — mirrored from
   * infoDelivery / onPlaybackQualityChange so the gear can show it */
  const [qNow, setQNow] = React.useState<string>("");

  /* position/playing snapshot for lane re-tunes (a quality pick or a stall
   * re-key) — the fresh embed seeks back to it on ready */
  const relayResumeRef = React.useRef<{ at: number; play: boolean } | null>(null);
  /* message liveness — real frame events stamp these; the zombie watchdog
   * compares them against "the embed should be talking right now" */
  const lastMsgAtRef = React.useRef(Date.now());
  const lastClockAtRef = React.useRef(Date.now());
  const expectPlayAtRef = React.useRef(0);
  const currentRef = React.useRef(0);
  React.useEffect(() => {
    currentRef.current = current;
  }, [current]);
  React.useEffect(() => {
    lastClockAtRef.current = Date.now();
  }, [current]);
  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const playing = state === YT_PLAYING;
  const buffering = state === YT_BUFFERING;

  /* ---- postMessage bridge ---- */
  const send = React.useCallback((func: string, ...args: unknown[]) => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  }, []);

  /* THE handshake: a chrome-less YouTube embed posts ZERO events until
   * the parent first sends {"event":"listening"} into the iframe — without
   * it the video can happily play (the user clicked inside the frame) while
   * our whole control bar stays deaf: the tuning shimmer never lifts, the
   * clock never ticks, our play/pause button does nothing. We knock
   * repeatedly until the first answer latches the lane. */
  const listen = React.useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(JSON.stringify({ event: "listening", id: "veil-relay", channel: "veil-relay" }), "*");
  }, []);

  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string" || !e.origin.includes("youtube")) return;
      let data: { event?: string; info?: Record<string, unknown> };
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (LIVE_FRAME_EVENTS.has(data.event ?? "")) lastMsgAtRef.current = Date.now();
      if (
        (data.event === "infoDelivery" || data.event === "onStateChange" || data.event === "initialDelivery" || data.event === "onPlaybackQualityChange") &&
        data.info &&
        typeof data.info === "object"
      ) {
        setConnected(true);
        connectedRef.current = true;
        const info = data.info as {
          currentTime?: number;
          duration?: number;
          playerState?: number;
          muted?: boolean;
          volume?: number;
          playbackQuality?: string;
        };
        if (typeof info.currentTime === "number") setCurrent(info.currentTime);
        if (typeof info.duration === "number" && info.duration > 0) setDuration(info.duration);
        if (typeof info.playbackQuality === "string" && info.playbackQuality) setQNow(info.playbackQuality);
        if (typeof info.playerState === "number") {
          setState(info.playerState);
          if (info.playerState === YT_PLAYING) setReady(true);
          /* loop the relay lane too — the saved preference drives it */
          if (info.playerState === YT_ENDED) {
            if (readPrefs().loop) {
              send("seekTo", 0, true);
              send("playVideo");
            } else {
              onEndedRef.current?.();
            }
          }
        }
        if (typeof info.muted === "boolean") setMuted(info.muted);
        if (typeof info.volume === "number") setVolume(info.volume);
      } else if (data.event === "onReady") {
        setConnected(true);
        connectedRef.current = true;
        setReady(true);
        /* prime the state mirror */
        send("getCurrentTime");
        send("getDuration");
        send("getPlayerState");
        send("getVolume");
        send("isMuted");
        send("getPlaybackQuality");
        /* a re-tune (quality pick / stall re-key) picks up where the old
         * frame left off — best effort, the embed seeks on cue */
        const rr = relayResumeRef.current;
        relayResumeRef.current = null;
        if (rr && rr.at > 1) {
          send("seekTo", rr.at, true);
          if (rr.play) send("playVideo");
          /* a seek issued before the fresh embed has cued is silently
           * ignored — re-issue once if the lane still hasn't started */
          setTimeout(() => {
            if (stateRef.current === YT_UNSTARTED || stateRef.current === YT_CUED) {
              send("seekTo", rr.at, true);
              if (rr.play) {
                send("playVideo");
                expectPlayAtRef.current = Date.now();
              }
            }
          }, 1800);
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [send]);

  /* poll the clock while playing (infoDelivery only arrives on change
   * or when asked — a steady poll keeps the seek bar honest) */
  React.useEffect(() => {
    if (state !== YT_PLAYING) return;
    const t = setInterval(() => {
      send("getCurrentTime");
      send("getDuration");
      send("getPlaybackQuality");
    }, 500);
    return () => clearInterval(t);
  }, [state, send]);

  /* ---- relay handshake patience ----
   * The embed can take a while to boot on cold or busy connections —
   * that is NOT a failure, so this player never declares one. While the
   * lane is quiet we show a calm tuning shimmer; only after a full
   * half-minute of total silence does a small, non-blocking escape
   * hatch surface — and the FIRST postMessage from the frame latches
   * the lane healthy and clears it for good. A late answer always
   * wins over any message we may have put on screen. */
  const connectedRef = React.useRef(false);
  const [longQuiet, setLongQuiet] = React.useState(false);
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (!connectedRef.current) setLongQuiet(true);
    }, 30000);
    return () => clearTimeout(t);
  }, []);
  React.useEffect(() => {
    if (connected) setLongQuiet(false);
  }, [connected]);

  /* gently knock on the frame while it's quiet — first with the
   * listening handshake (the embed is silent until it receives one,
   * and it can race ahead of its bridge being ready), then a state
   * probe so a booted-but-quiet API answers infoDelivery and the
   * handshake latches. Re-knocking is always safe: the embed treats
   * repeats as idempotent — the interval simply dies with the effect
   * the moment a message latches the lane (connected flips true). */
  React.useEffect(() => {
    if (connected) return;
    listen();
    const t = setInterval(() => {
      listen();
      send("getPlayerState");
    }, 1200);
    return () => clearInterval(t);
  }, [connected, send, listen]);

  /* ---- relay quality as LIVE state ----
   * Starts "auto" (SSR/hydration-safe), syncs from prefs on mount and on
   * every change. Drives the vq URL param, the layout-size trick and the
   * frame re-key — a pick re-tunes the lane at the new rung. */
  const [relayQ, setRelayQ] = React.useState("auto");
  React.useEffect(() => {
    const sync = () => setRelayQ(readPrefs().relayQuality);
    sync();
    window.addEventListener("veil-stream-prefs", sync);
    return () => window.removeEventListener("veil-stream-prefs", sync);
  }, []);

  /* the shell's box — the size trick scales the rung-sized frame to fit */
  const [shellBox, setShellBox] = React.useState<{ w: number; h: number } | null>(null);
  React.useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setShellBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---- stall watchdog ----
   * A lane wedged in buffering for 45s straight (the embed stalls on this
   * egress IP more often than it should) gets a FRESH frame from the stuck
   * position — up to twice, then a manual "reload the lane" affordance
   * instead of an eternal spinner. */
  const [reloadKey, setReloadKey] = React.useState(0);
  const reloadsRef = React.useRef(0);
  const [stuck, setStuck] = React.useState(false);
  const relane = React.useCallback(() => {
    relayResumeRef.current = { at: currentRef.current, play: true };
    expectPlayAtRef.current = Date.now();
    setReloadKey((k) => k + 1);
    setConnected(false);
    setReady(false);
    setState(YT_UNSTARTED);
    setQNow("");
  }, []);
  React.useEffect(() => {
    if (state !== YT_BUFFERING) {
      setStuck(false);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => {
      if (stateRef.current !== YT_BUFFERING) return;
      if (Date.now() - started < 45000) return;
      if (reloadsRef.current < 2) {
        reloadsRef.current += 1;
        relane();
      } else {
        setStuck(true);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [state, relane]);

  /* ---- card change: a fresh video gets a fresh lane ----
   * The component persists across videos (only the frame re-keys), so a
   * new card would inherit the old latch — the knock loop stays retired
   * and the new embed races the single onLoad knock for the handshake,
   * which is exactly how "some videos" land frozen from the start. Drop
   * the latch (the knock loop re-runs) and clear the stale mirror. */
  const cardIdRef = React.useRef(card.id);
  React.useEffect(() => {
    if (cardIdRef.current === card.id) return;
    cardIdRef.current = card.id;
    relayResumeRef.current = null;
    reloadsRef.current = 0;
    setStuck(false);
    setConnected(false);
    setReady(false);
    setState(YT_UNSTARTED);
    setCurrent(0);
    setDuration(card.durationSec || 0);
    setQNow("");
  }, [card.id, card.durationSec]);

  /* ---- zombie-lane watchdog + bridge heartbeat ----
   * Two freeze modes the lane has actually shown (the frame answers a
   * repeat handshake with "alreadyInitialized" and then goes silent —
   * every command falls into the void while our latch stays true):
   *  ① the widget session dies outright (clock stuck, play button dead)
   *  ② the embed document reloads itself mid-play and won't speak until
   *     it hears "listening" again — but the knock loop retired at latch
   * The heartbeat re-knocks every 8s (idempotent) so ② heals silently.
   * The watchdog catches ① and hard mid-play stalls: while playback is
   * expected (state PLAYING, or a play command sent recently) but the
   * frame has gone silent (no real events 12s) or its clock is dead (no
   * movement 20s), re-key the lane from the stuck position. Bounded by
   * the shared reload debt; a lane that plays 15s straight earns it back. */
  React.useEffect(() => {
    const hb = setInterval(() => {
      if (connectedRef.current) listen();
    }, 8000);
    return () => clearInterval(hb);
  }, [listen]);
  React.useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) {
        /* a background tab throttles everything — don't judge liveness */
        lastMsgAtRef.current = Date.now();
        lastClockAtRef.current = Date.now();
        return;
      }
      if (!connectedRef.current) return;
      if (stateRef.current === YT_BUFFERING) return; /* the stall watchdog owns buffering */
      const expecting =
        stateRef.current === YT_PLAYING || Date.now() - expectPlayAtRef.current < 20000;
      if (!expecting) return;
      const silent = Date.now() - lastMsgAtRef.current > 12000;
      const clockDead =
        stateRef.current === YT_PLAYING && Date.now() - lastClockAtRef.current > 20000;
      if (!silent && !clockDead) return;
      if (reloadsRef.current >= 2) {
        setStuck(true);
        return;
      }
      reloadsRef.current += 1;
      relane();
    }, 4000);
    return () => clearInterval(t);
  }, [relane]);
  /* healthy-play credit — a lane that plays 15s straight has genuinely
   * healed; hand its reload debt back (the stall watchdog shares it) */
  React.useEffect(() => {
    if (state !== YT_PLAYING) return;
    const t = setTimeout(() => {
      reloadsRef.current = 0;
      setStuck(false);
    }, 15000);
    return () => clearTimeout(t);
  }, [state]);

  /* ---- relay settings: speed + loop travel over the iframe API ---- */
  React.useEffect(() => {
    if (!connected) return;
    send("setPlaybackRate", readPrefs().speed);
  }, [connected, prefsV, send]);

  /* ---- relay quality: the saved preference travels over the iframe
   * API too (setPlaybackQuality is YouTube's documented quality hint —
   * it clamps to what the video actually offers). Re-applied on every
   * state change because the embed resets its ladder at stream
   * switches; "auto" leaves the decision to YouTube. ---- */
  React.useEffect(() => {
    if (!connected) return;
    const q = readPrefs().relayQuality;
    if (q && q !== "auto") send("setPlaybackQuality", q);
  }, [connected, state, prefsV, send]);

  /* ---- relay CC: pick / clear YouTube's own caption track ---- */
  React.useEffect(() => {
    if (!connected) return;
    if (ccOn) send("setOption", "captions", "track", { languageCode: "en" });
    else send("setOption", "captions", "track", {});
  }, [connected, ccOn, send]);

  /* ---- fullscreen ---- */
  React.useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* ---- controls auto-hide ---- */
  const wake = React.useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (state === YT_PLAYING) setControlsVisible(false);
    }, 2600);
  }, [state]);
  React.useEffect(() => {
    if (state !== YT_PLAYING) setControlsVisible(true);
    else wake();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [state, wake]);

  /* ---- actions ---- */
  const togglePlay = React.useCallback(() => {
    if (state === YT_PLAYING) send("pauseVideo");
    else {
      send("playVideo");
      send("unMute");
      /* playback is now expected — the zombie watchdog keys off this */
      expectPlayAtRef.current = Date.now();
    }
  }, [state, send]);

  const seekTo = React.useCallback(
    (t: number) => {
      if (!Number.isFinite(t)) return;
      send("seekTo", Math.max(0, Math.min(t, duration || t)), true);
      setCurrent(t);
    },
    [duration, send],
  );

  const setVol = React.useCallback(
    (v: number) => {
      send("setVolume", Math.round(Math.max(0, Math.min(1, v)) * 100));
      if (v > 0) send("unMute");
      setVolume(Math.round(v * 100));
      setMuted(v === 0);
    },
    [send],
  );

  const toggleMute = React.useCallback(() => {
    if (muted || volume === 0) {
      send("unMute");
      if (volume === 0) send("setVolume", 70);
      setMuted(false);
      if (volume === 0) setVolume(70);
    } else {
      send("mute");
      setMuted(true);
    }
  }, [muted, volume, send]);

  const toggleFs = React.useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shellRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  /* ---- keyboard ---- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          seekTo(current - 5);
          break;
        case "ArrowRight":
          seekTo(current + 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVol((muted ? 0 : volume / 100) + 0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVol((muted ? 0 : volume / 100) - 0.1);
          break;
        case "m":
          toggleMute();
          break;
        case "f":
          toggleFs();
          break;
        default:
          break;
      }
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, setVol, toggleMute, toggleFs, wake, current, volume, muted]);

  /* vq rides the URL (a load-time hint); the SIZE TRICK does the real
   * steering: YouTube's embed picks its rung from the frame's LAYOUT
   * size, so a picked quality renders the frame at that rung's pixels
   * (RELAY_Q_SIZES) and CSS-scales it to fit the shell. */
  const qSize = RELAY_Q_SIZES[relayQ] ?? null;
  const scale = qSize && shellBox ? Math.min(shellBox.w / qSize[0], shellBox.h / qSize[1]) : 1;
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(card.id)}?enablejsapi=1&controls=0&disablekb=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3${relayQ !== "auto" ? `&vq=${relayQ}` : ""}&origin=${encodeURIComponent(typeof window === "undefined" ? "https://veil.local" : window.location.origin)}`;

  return (
    <div className="min-w-0">
      {/* heal offer — compact, no lane narration: the relay badge in the
       * control bar already says which lane is playing */}
      {healed && (
        <div className="mb-3 flex justify-end">
          <Button
            size="sm"
            onClick={onTryNative}
            className="h-8 shrink-0 gap-1.5 rounded-xl bg-rose-500 text-rose-950 hover:bg-rose-400"
          >
            <RefreshCw aria-hidden className="size-3.5" /> Play natively
          </Button>
        </div>
      )}

      {/* ── player shell ── */}
      <div
        ref={shellRef}
        onPointerMove={wake}
        onPointerLeave={() => {
          if (state === YT_PLAYING) setControlsVisible(false);
        }}
        className="group/relay relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/50 ring-1 ring-white/10"
      >
        {qSize && shellBox ? (
          <iframe
            key={`relay:${card.id}:${relayQ}:${reloadKey}`}
            ref={frameRef}
            src={src}
            width={qSize[0]}
            height={qSize[1]}
            title={`relay player: ${card.title}`}
            allow="autoplay; encrypted-media; fullscreen"
            onLoad={listen}
            style={{
              position: "absolute",
              left: `${Math.max(0, (shellBox.w - qSize[0] * scale) / 2)}px`,
              top: `${Math.max(0, (shellBox.h - qSize[1] * scale) / 2)}px`,
              width: `${qSize[0]}px`,
              height: `${qSize[1]}px`,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
            className="border-0 bg-black"
          />
        ) : (
          <iframe
            key={`relay:${card.id}:${relayQ}:${reloadKey}`}
            ref={frameRef}
            src={src}
            title={`relay player: ${card.title}`}
            allow="autoplay; encrypted-media; fullscreen"
            onLoad={listen}
            className="size-full border-0 bg-black"
          />
        )}

        {/* buffering spinner */}
        {buffering && connected && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 aria-hidden className="size-10 animate-spin text-rose-400/90" />
          </div>
        )}

        {/* tuning shimmer — the lane is quiet, not broken. No verdicts,
         * ever: this disappears the instant the frame answers */}
        {!connected && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 aria-hidden className="size-9 animate-spin text-amber-300/80" />
            <p className="text-[12px] font-medium tracking-wide text-zinc-400/90">
              tuning the relay<span className="animate-pulse">…</span>
            </p>
          </div>
        )}

        {/* a very slow lane earns a small escape hatch — never a takeover.
         * The video stays fully visible underneath; if it wakes up, this
         * vanishes on its own. */}
        {longQuiet && !connected && (
          <div className="absolute bottom-16 right-3 flex max-w-[92%] items-center gap-2 rounded-xl border border-white/10 bg-black/80 px-3 py-2 text-[11.5px] leading-snug text-zinc-300 backdrop-blur-sm">
            <span>still tuning — it&rsquo;s slow, not broken.</span>
            <a
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(card.id)}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 font-semibold text-rose-300 underline decoration-rose-400/40 underline-offset-4 hover:text-rose-200"
            >
              open on youtube ↗
            </a>
          </div>
        )}

        {/* the stall watchdog gave the lane two fresh frames and it keeps
         * wedging — hand the user the re-key instead of an eternal spinner */}
        {stuck && (
          <div className="absolute bottom-16 right-3 flex max-w-[92%] items-center gap-2 rounded-xl border border-white/10 bg-black/80 px-3 py-2 text-[11.5px] leading-snug text-zinc-300 backdrop-blur-sm">
            <span>the lane keeps stalling.</span>
            <button
              type="button"
              onClick={() => {
                reloadsRef.current = 0;
                setStuck(false);
                relane();
              }}
              className="shrink-0 font-semibold text-rose-300 underline decoration-rose-400/40 underline-offset-4 hover:text-rose-200"
            >
              reload the lane
            </button>
          </div>
        )}

        {/* center play (before first play / ended — guarantees a user gesture) */}
        {connected && (state === YT_UNSTARTED || state === YT_CUED || state === YT_PAUSED || state === YT_ENDED) && ready && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-rose-500/95 text-white shadow-xl shadow-rose-500/30 transition hover:scale-105 hover:bg-rose-400"
          >
            <Play aria-hidden className="size-6 translate-x-0.5 fill-white" />
          </button>
        )}

        {/* ── control bar (ours — the iframe is chrome-less) ── */}
        <AnimatePresence>
          {controlsVisible && (
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2.5 pt-10 sm:px-4"
            >
              {/* seek */}
              <div className="relative flex h-4 items-center">
                <Slider
                  value={[Math.min(current, duration || current)]}
                  max={Math.max(duration, 1)}
                  step={0.5}
                  onValueChange={(v) => seekTo(v[0] ?? 0)}
                  aria-label="Seek"
                  className="relative z-10 cursor-pointer [&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:bg-white/15 [&_[data-slot=slider-range]]:bg-amber-400 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-amber-400 [&_[data-slot=slider-thumb]]:shadow-md"
                />
              </div>
              {/* buttons row */}
              <div className="mt-1 flex items-center gap-1 text-zinc-200">
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={playing ? "Pause" : "Play"}
                  className="flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white"
                >
                  {playing ? (
                    <Pause aria-hidden className="size-4.5 fill-current" />
                  ) : (
                    <Play aria-hidden className="size-4.5 translate-x-px fill-current" />
                  )}
                </button>
                {/* volume */}
                <div className="group/vol flex items-center">
                  <button
                    type="button"
                    onClick={toggleMute}
                    aria-label={muted ? "Unmute" : "Mute"}
                    className="flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white"
                  >
                    {muted || volume === 0 ? (
                      <VolumeX aria-hidden className="size-4.5" />
                    ) : (
                      <Volume2 aria-hidden className="size-4.5" />
                    )}
                  </button>
                  <div className="w-0 overflow-hidden transition-all duration-200 group-hover/vol:w-20 group-focus-within/vol:w-20">
                    <Slider
                      value={[muted ? 0 : volume / 100]}
                      max={1}
                      step={0.05}
                      onValueChange={(v) => setVol(v[0] ?? 1)}
                      aria-label="Volume"
                      className="mx-2.5 cursor-pointer [&_[data-slot=slider-track]]:h-1 [&_[data-slot=slider-range]]:bg-white/70 [&_[data-slot=slider-thumb]]:size-2.5 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-white"
                    />
                  </div>
                </div>
                {/* time */}
                <span className="ml-1 select-none text-[12px] font-medium tabular-nums text-zinc-300">
                  {fmtTime(current)} <span className="text-zinc-500">/ {fmtTime(duration)}</span>
                </span>
                <div className="flex-1" />
                {/* relay badge */}
                <span className="mr-1 hidden items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-amber-300/90 sm:flex">
                  <Radio aria-hidden className="size-3" /> relay
                </span>
                {/* settings: speed + loop (the iframe lane's gear) */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-label="Player settings"
                    aria-expanded={menuOpen}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white",
                      menuOpen && "bg-white/10 text-white",
                    )}
                  >
                    <Settings aria-hidden className={cn("size-4", menuOpen && "rotate-45 transition-transform")} />
                  </button>
                  {menuOpen && (
                    <>
                      <button
                        type="button"
                        aria-label="Close menu"
                        className="fixed inset-0 z-20 cursor-default"
                        onClick={() => setMenuOpen(false)}
                      />
                      <div className="absolute bottom-10 right-0 z-30 w-52 rounded-xl border border-zinc-700/80 bg-zinc-900/95 py-1 shadow-2xl backdrop-blur-md">
                        {/* quality — YouTube's own ladder, driven over the
                         * iframe API (setPlaybackQuality). "Auto" hands the
                         * decision back to YouTube. */}
                        <p className="px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                          Quality
                        </p>
                        <div className="flex flex-wrap gap-1 px-2.5 pb-1.5 pt-0.5">
                          {RELAY_QUALITIES.map((q) => {
                            const active = relayQ === q.v;
                            return (
                              <button
                                key={q.v}
                                type="button"
                                onClick={() => {
                                  if (q.v === relayQ) {
                                    setMenuOpen(false);
                                    return;
                                  }
                                  /* save the position to restore after the
                                   * re-tune, then swap the lane: the fresh
                                   * frame boots at the new rung (vq + the
                                   * layout-size trick) and seeks back */
                                  relayResumeRef.current = {
                                    at: currentRef.current,
                                    play: stateRef.current === YT_PLAYING || stateRef.current === YT_BUFFERING,
                                  };
                                  savePrefs({ relayQuality: q.v });
                                  setConnected(false);
                                  connectedRef.current = false;
                                  setReady(false);
                                  setState(YT_UNSTARTED);
                                  setQNow("");
                                  setMenuOpen(false);
                                }}
                                aria-pressed={active}
                                className={cn(
                                  "rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition",
                                  active
                                    ? "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/40"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                                )}
                              >
                                {q.label}
                              </button>
                            );
                          })}
                        </div>
                        <p className="px-3 pb-1.5 text-[10.5px] leading-relaxed text-zinc-600">
                          {qNow && qNow !== "unknown"
                            ? `playing at ${relayQualityLabel(qNow)} · a pick re-tunes the lane instantly`
                            : "picks re-tune the lane at the chosen rung"}
                        </p>
                        <p className="border-t border-zinc-800 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                          Speed
                        </p>
                        <div className="flex flex-wrap gap-1 px-2.5 pb-2 pt-0.5">
                          {SPEED_STEPS.map((s) => {
                            const active = Math.abs(readPrefs().speed - s) < 0.01;
                            return (
                              <button
                                key={s}
                                type="button"
                                onClick={() => savePrefs({ speed: s })}
                                aria-pressed={active}
                                className={cn(
                                  "rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition",
                                  active
                                    ? "bg-amber-400/20 text-amber-200 ring-1 ring-amber-400/40"
                                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                                )}
                              >
                                {s === 1 ? "1×" : `${s}×`}
                              </button>
                            );
                          })}
                        </div>
                        <button
                          type="button"
                          onClick={() => savePrefs({ loop: !readPrefs().loop })}
                          aria-pressed={readPrefs().loop}
                          className="flex w-full items-center justify-between border-t border-zinc-800 px-3 py-2 text-left text-[12.5px] text-zinc-300 transition hover:bg-white/5 hover:text-white"
                        >
                          <span className="flex items-center gap-2">
                            <Repeat aria-hidden className="size-3.5" /> Loop
                          </span>
                          <span
                            aria-hidden
                            className={cn(
                              "flex h-4.5 w-8 items-center rounded-full px-0.5 transition",
                              readPrefs().loop ? "justify-end bg-amber-400" : "justify-start bg-zinc-700",
                            )}
                          >
                            <span className="size-3.5 rounded-full bg-white" />
                          </span>
                        </button>
                        {/* subtitles — YouTube's own caption renderer, best-effort */}
                        <button
                          type="button"
                          onClick={() => setCcOn((v) => !v)}
                          aria-pressed={ccOn}
                          className="flex w-full items-center justify-between border-t border-zinc-800 px-3 py-2 text-left text-[12.5px] text-zinc-300 transition hover:bg-white/5 hover:text-white"
                        >
                          <span className="flex items-center gap-2">
                            <Subtitles aria-hidden className="size-3.5" /> Subtitles
                          </span>
                          <span
                            aria-hidden
                            className={cn(
                              "flex h-4.5 w-8 items-center rounded-full px-0.5 transition",
                              ccOn ? "justify-end bg-amber-400" : "justify-start bg-zinc-700",
                            )}
                          >
                            <span className="size-3.5 rounded-full bg-white" />
                          </span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
                {/* fullscreen (relay) */}
                <button
                  type="button"
                  onClick={toggleFs}
                  aria-label={isFs ? "Exit fullscreen" : "Fullscreen"}
                  className="flex size-8 items-center justify-center rounded-lg transition hover:bg-white/10 hover:text-white"
                >
                  {isFs ? <Minimize aria-hidden className="size-4.5" /> : <Maximize aria-hidden className="size-4.5" />}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── metadata (from the card — instant) ── */}
      <div className="mt-4 min-w-0">
        <h2 className="text-[17px] font-semibold leading-snug tracking-tight text-zinc-50">{card.title}</h2>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {card.authorId ? (
            <button
              type="button"
              onClick={() => onChannel(card.authorId, card.author)}
              aria-label={`Open channel: ${card.author}`}
              className="group/ch flex min-w-0 items-center gap-2.5 rounded-xl p-1 pr-2.5 text-left transition hover:bg-zinc-900/80"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[12px] font-bold text-amber-300 ring-1 ring-amber-500/30">
                {card.author.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1 truncate text-[13.5px] font-medium text-zinc-100 transition group-hover/ch:text-amber-200">
                  {card.author}
                  {card.verified && <ShieldCheck aria-label="verified channel" className="inline size-3 shrink-0 align-[-1px] text-zinc-400" />}
                </span>
                <span className="block truncate text-[11.5px] tabular-nums text-zinc-500">
                  {fmtCount(card.views)} views{card.published ? " · " : ""}
                  {ageLabel(card.published)}
                </span>
              </span>
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[12px] font-bold text-amber-300 ring-1 ring-amber-500/30">
                {card.author.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-zinc-100">
                  {card.author}
                  {card.verified && <ShieldCheck aria-label="verified channel" className="ml-1 inline size-3 align-[-1px] text-zinc-400" />}
                </p>
                <p className="truncate text-[11.5px] tabular-nums text-zinc-500">
                  {fmtCount(card.views)} views{card.published ? " · " : ""}
                  {ageLabel(card.published)}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {card.authorId && (
            <SubscribeButton channelId={card.authorId} name={card.author} tone="amber" />
          )}
          <LikeBar videoId={card.id} likes={likes} dislikes={dislikes} chan={{ authorId: card.authorId, author: card.author }} />
          <SaveToPlaylist card={card} />
        </div>
        {description && (
          <details className="group mt-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 px-4 py-3">
            <summary className="cursor-pointer select-none list-none text-[12.5px] font-semibold text-zinc-300 transition hover:text-zinc-100">
              Description
              <span className="ml-1.5 text-zinc-500 group-open:hidden">— tap to expand</span>
            </summary>
            <p className="mt-2.5 max-h-64 overflow-y-auto whitespace-pre-line text-[13px] leading-relaxed text-zinc-400 veil-scroll-slim">
              {description}
            </p>
          </details>
        )}
      </div>

      {/* ── comments (read-only YouTube threads) ── */}
      <CommentsPanel videoId={card.id} />

      {/* suggestions from the browsing context */}
      {more.length > 0 && (
        <section aria-label="More videos" className="mt-8">
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-zinc-500">Up next</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {more.slice(0, 8).map((c, i) => (
              <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={onWatch} onChannel={onChannel} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Gated panel (kept for hard failures with no card to relay from)      */
/* ------------------------------------------------------------------ */

function GatePanel({
  message,
  onRetry,
  since,
  rounds,
  more,
  onPick,
}: {
  message: string;
  onRetry: () => void;
  /** epoch ms of the first gate answer for this watch — drives the
   * "trying for Mm Ss" clock; null resets it. */
  since: number | null;
  rounds: number;
  more: YtCard[];
  onPick: (id: string, card: YtCard) => void;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  /* retry cadence: eager for the first ~2 minutes (the per-video gate
   * often rotates on short scales), then a patient every-minute probe
   * for as long as the watch view stays open — the background healer on
   * the service side keeps probing for 45 minutes either way. */
  const round = Math.max(0, rounds);
  const waitMs = round < 8 ? 15_000 : 60_000;
  const nextIn = Math.max(0, Math.ceil(waitMs / 1000 - ((now - (since ?? now)) / 1000) % (waitMs / 1000)));
  const elapsed = since ? Math.max(0, now - since) : 0;
  const mm = Math.floor(elapsed / 60000);
  const ss = Math.floor((elapsed % 60000) / 1000);
  return (
    <div className="w-full">
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-2xl border border-amber-500/25 bg-zinc-900/70 px-6 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-amber-500/15 ring-1 ring-amber-500/30">
          <ShieldAlert aria-hidden className="size-7 text-amber-300" />
        </span>
        <div>
          <p className="text-[15px] font-semibold text-zinc-100">YouTube is throttling this video right now</p>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-zinc-400">{message}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button
            size="sm"
            onClick={onRetry}
            className="h-9 gap-1.5 rounded-xl bg-amber-400 text-amber-950 hover:bg-amber-300"
          >
            <RefreshCw aria-hidden className="size-3.5" /> Try again now
          </Button>
          <span className="text-[12px] tabular-nums text-zinc-500">
            {round < 8 ? "auto-retrying in " : "slow-probing in "}
            <span className="font-semibold text-amber-300/90">{nextIn}s</span>
            {since ? (
              <>
                {" · trying for "}
                <span className="font-semibold text-zinc-400">
                  {mm > 0 ? `${mm}m ` : ""}
                  {ss}s
                </span>
              </>
            ) : null}
            <Loader2 aria-hidden className="ml-1.5 inline size-3 animate-spin text-amber-400/70" />
          </span>
        </div>
        <p className="text-[11.5px] text-zinc-600">
          the gate rotates — Veil keeps probing in the background for 45 minutes, and this page reloads the video the moment it opens
        </p>
      </div>
      {more.length > 0 && (
        <div className="mt-5">
          <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-wider text-zinc-500">
            Or try another video
          </p>
          <div className="veil-scroll-slim flex gap-3 overflow-x-auto pb-2">
            {more.slice(0, 12).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c.id, c)}
                className="group w-44 shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 text-left transition hover:border-rose-500/40 hover:bg-zinc-800/70"
              >
                <span className="relative block aspect-video w-full overflow-hidden bg-zinc-800">
                  {c.thumb ? (
                    <img
                      src={c.thumb}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover transition duration-300 group-hover:scale-105"
                    />
                  ) : null}
                </span>
                <span className="block px-2.5 py-2">
                  <span className="line-clamp-2 text-[12px] font-medium leading-snug text-zinc-200">{c.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{c.author}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shorts viewer — vertical, scroll-snapped, one short per screen      */
/* ------------------------------------------------------------------ */

interface SlideInfo {
  status: "idle" | "loading" | "ready" | "gate" | "error" | "relay";
  url?: string;
  kind?: "hls" | "progressive" | "adaptive";
  message?: string;
  /** adaptive lane — the video-only track + its audio pairing */
  vFmt?: YtFormat;
  aFmt?: YtFormat;
  /** the muxed fallback if the combo can't attach */
  fallback?: YtFormat;
  /** like count from the video answer (0 = hidden) */
  likes?: number;
}

/** imperative handle into a relay slide (ShortSlide's chrome buttons) */
interface RelayHandle {
  play: () => void;
  pause: () => void;
}

/** The relay lane for one short — a chrome-less YouTube iframe with the
 *  SAME listening handshake the watch view's RelayPlayer uses (the embed
 *  is silent until it receives {"event":"listening"}), looping, muted
 *  synced with the viewer, and PAUSED the moment its slide scrolls out
 *  of view (an unpaused iframe keeps playing its audio behind the next
 *  short — exactly the "the first short's audio keeps playing" bug).
 *  This is the fallback that keeps shorts PLAYING when the stream-
 *  extraction gate is shut: the embed doesn't need extraction. */
function RelayShort({
  card,
  active,
  muted,
  handleRef,
  onWatched,
  onPlayingChange,
  onProgress,
  onLatch,
}: {
  card: YtCard;
  /** only the on-screen slide plays; scrolled-away slides pause */
  active: boolean;
  muted: boolean;
  handleRef: React.MutableRefObject<RelayHandle | null>;
  onWatched: () => void;
  onPlayingChange: (playing: boolean) => void;
  onProgress: (p: number) => void;
  /** fires once, the first time the embed answers — the slide can then
   *  trust its play/pause chrome (and stop showing the tuning state). */
  onLatch: () => void;
}) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const latchedRef = React.useRef(false);
  const watchedRef = React.useRef(false);
  const mutedRef = React.useRef(muted);
  const userPausedRef = React.useRef(false);
  /* the LIVE active flag — the message listener (and its onReady) can't
   * close over `active` without re-subscribing on every flip, so they read
   * this ref instead. THE fix for "previous shorts also play": an embed
   * that finishes its handshake AFTER its slide scrolled away used to
   * receive an unconditional playVideo — now it checks this ref and is
   * paused the moment it answers. */
  const activeRef = React.useRef(active);
  React.useEffect(() => {
    activeRef.current = active;
  }, [active]);
  React.useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const send = React.useCallback((func: string, ...args: unknown[]) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*",
    );
  }, []);

  /* THE handshake — knock every 400ms until the embed answers */
  React.useEffect(() => {
    const t = setInterval(() => {
      if (latchedRef.current) return;
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: "veil-relay", channel: "veil-relay" }),
        "*",
      );
    }, 400);
    return () => clearInterval(t);
  }, []);

  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== "string" || !e.origin.includes("youtube")) return;
      let data: { event?: string; info?: Record<string, unknown> };
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      if (data.event === "onReady") {
        latchedRef.current = true;
        onLatch();
        /* pause BEFORE anything else when this slide isn't the one on
         * screen — the embed self-autoplays (autoplay=1 rides the URL),
         * so a late-latching scrolled-away slide must be stopped the
         * moment it answers, or its audio runs behind the next short */
        if (!activeRef.current || userPausedRef.current) send("pauseVideo");
        if (mutedRef.current) send("mute");
        else send("unMute");
        /* the saved relay quality preference rides along — shorts drink
         * data fast, a lower rung is a common ask */
        const q = readPrefs().relayQuality;
        if (q && q !== "auto") send("setPlaybackQuality", q);
        if (activeRef.current && !userPausedRef.current) send("playVideo");
        send("getCurrentTime");
        send("getDuration");
        send("getPlayerState");
        return;
      }
      if (data.event === "infoDelivery" && data.info && typeof data.info === "object") {
        latchedRef.current = true;
        const info = data.info as { currentTime?: number; duration?: number; playerState?: number };
        if (typeof info.playerState === "number") {
          if (info.playerState === 0) {
            /* ended → loop like the native lane does — but ONLY the
             * on-screen slide; a scrolled-away one stays parked */
            if (activeRef.current && !userPausedRef.current) {
              send("seekTo", 0, true);
              send("playVideo");
            }
            return;
          }
          const playing = info.playerState === 1;
          if (playing && !activeRef.current) {
            /* stray playback on a scrolled-away slide (dropped pause
             * command, embed quirk, late latch) — silence it NOW */
            send("pauseVideo");
            onPlayingChange(false);
            return;
          }
          onPlayingChange(playing);
          if (playing && !watchedRef.current) {
            watchedRef.current = true;
            onWatched();
          }
        }
        if (typeof info.currentTime === "number" && typeof info.duration === "number" && info.duration > 0) {
          onProgress(info.currentTime / info.duration);
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [send, onWatched, onPlayingChange, onProgress, onLatch]);

  /* keep the embed's mute in step with the viewer's mute pill (the
   * handshake-latch case is covered in onReady via mutedRef) */
  React.useEffect(() => {
    if (!latchedRef.current) return;
    if (muted) send("mute");
    else send("unMute");
  }, [muted, send]);

  /* the ACTIVE slide plays; everything else pauses — the iframe has no
   * auto-pause of its own and would happily keep its audio running
   * behind the next short. A slide the user paused stays paused until
   * they press play again. (If the embed hadn't latched yet when the
   * slide scrolled away, this effect no-ops — onReady covers that case:
   * it checks activeRef and pauses instead of playing.) */
  React.useEffect(() => {
    if (!latchedRef.current) return;
    if (active && !userPausedRef.current) send("playVideo");
    else if (!active) send("pauseVideo");
  }, [active, send]);

  /* expose play/pause to the slide chrome (play clears the user pause) */
  React.useEffect(() => {
    handleRef.current = {
      play: () => {
        userPausedRef.current = false;
        send("playVideo");
      },
      pause: () => {
        userPausedRef.current = true;
        send("pauseVideo");
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, send]);

  /* the saved relay quality rides the URL as vq — a load-time hint; the
   * saved rung also re-keys the frame when it changes (prefsV re-renders,
   * the src changes, the embed navigates). Shorts drink data fast, a
   * lower rung is a common ask. */
  const prefsV = usePrefsVersion();
  const relayQ = React.useMemo(
    () => (typeof window === "undefined" ? "auto" : readPrefs().relayQuality),
    [prefsV],
  );
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(card.id)}?enablejsapi=1&controls=0&disablekb=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&autoplay=1&mute=1${relayQ !== "auto" ? `&vq=${relayQ}` : ""}&origin=${encodeURIComponent(
    typeof window === "undefined" ? "https://veil.local" : window.location.origin,
  )}`;

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={`short: ${card.title}`}
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
      className="size-full border-0 bg-black"
    />
  );
}

/** One vertical short. Native lane first (the same-origin stream); a
 *  gated or broken short retries itself a few times, then falls back
 *  to the RELAY lane (a chrome-less YouTube iframe — it plays without
 *  stream extraction, so the gate can't stop it), with a manual
 *  "Play here" jump on the gate panel too. */
function ShortSlide({
  card,
  active,
  preload,
  muted,
  onToggleMute,
  onWatched,
  onChannel,
  onOpenVideo,
  onOpenComments,
}: {
  card: YtCard;
  active: boolean;
  preload: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onWatched: (card: YtCard) => void;
  onChannel: (id: string, name: string) => void;
  onOpenVideo: (card: YtCard) => void;
  /** opens the comments side sheet for this short */
  onOpenComments: (card: YtCard) => void;
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const hlsRef = React.useRef<{ destroy: () => void } | null>(null);
  const fetchedRef = React.useRef(false);
  const watchedRef = React.useRef(false);
  const autoRef = React.useRef(0);
  const relayRef = React.useRef<RelayHandle | null>(null);
  const [info, setInfo] = React.useState<SlideInfo>({ status: "idle" });
  const [playing, setPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [tick, setTick] = React.useState(0);
  /* the relay lane's latch — until the embed answers, the slide shows a
   * calm tuning state instead of a play button it can't honor (the
   * "the play button just sits on the short" stuck overlay). */
  const [relayLive, setRelayLive] = React.useState(false);
  const prefsV = usePrefsVersion();

  /* fetch the stream info (active + two-ahead lookahead, on the quick
   * lane — a cold stream becomes a fast "press play again" instead of a
   * half-minute spinner, and the background warm makes that play-again
   * land instantly).
   *
   * NOTE: the response is deliberately NOT discarded when the slide's
   * active/preload flags flip (scrolling) — the fetch was started once
   * (fetchedRef) and its answer must land no matter what the user is
   * looking at; discarding it mid-flight left slides stuck on the
   * loading spinner forever (the "shorts freeze and nothing happens"
   * bug). React 18 no-ops setState after unmount, so no guard needed. */
  React.useEffect(() => {
    if ((!active && !preload) || fetchedRef.current) return;
    fetchedRef.current = true;
    setInfo({ status: "loading" });
    /* shorts ALWAYS ride the soft lane (3s budget): a warm body answers
     * instantly, a cold one hands back fast so the auto-flow (soft retry
     * @3s → relay @+1.5s) can start playing in ~7s instead of ~19 — the
     * background warm keeps running server-side either way, and a later
     * soft retry lands the native body the moment it parks. */
    fetchJsonSafe<YtVideo | YtGate>(`/api/yt/video/${encodeURIComponent(card.id)}?quick=1&soft=1`)
      .then((body) => {
        if (body && "gated" in body) {
          setInfo({ status: "gate", message: body.message });
        } else if (body.formats.length === 0) {
          setInfo({
            status: "gate",
            message: "the gate handed this short over without a stream — it usually rotates back within a minute",
          });
        } else {
          /* the QUALITY ladder: shorts default to the best rung under
           * the SAVED quality ceiling (1080p out of the box — a vertical
           * 1080p short is exactly phone resolution) paired with audio
           * through MSE when the browser supports it. Muxed progressive
           * stays the fallback. */
          const combo = pickAdaptiveCombo(body, readPrefs().maxHeight);
          if (combo) {
            const progs = body.formats.filter((f) => f.kind === "progressive");
            const bestProg = progs.reduce(
              (a, b) => (parseInt(b.label, 10) > parseInt(a.label, 10) ? b : a),
              progs[0] ?? body.formats[0],
            );
            setInfo({
              status: "ready",
              url: combo.v.url,
              kind: "adaptive",
              vFmt: combo.v,
              aFmt: combo.a,
              fallback: bestProg,
              likes: body.likes,
            });
            return;
          }
          const progs = body.formats.filter((f) => f.kind === "progressive");
          const best = progs.reduce(
            (a, b) => (parseInt(b.label, 10) > parseInt(a.label, 10) ? b : a),
            progs[0] ?? body.formats[0],
          );
          setInfo({ status: "ready", url: best.url, kind: best.kind, likes: body.likes });
        }
      })
      .catch((e: Error) => {
        setInfo({ status: "error", message: e.message || "this short didn't load" });
      });
  }, [active, preload, card.id, tick]);

  /* auto-flow for a gated short on the ACTIVE slide — it should just
   * PLAY: one quick soft re-probe (~1.5s later, the background warm can
   * park the body that fast), then the relay lane takes over the MOMENT
   * the second answer is also a gate. No Retry / "Play here" interlude —
   * the embed needs no stream extraction, so the gate can't hold the
   * slide hostage. (~9s worst case from open to playing.) */
  React.useEffect(() => {
    if (!active || (info.status !== "gate" && info.status !== "error")) return;
    if (autoRef.current >= 1) {
      /* second gate — relay NOW */
      setInfo({ status: "relay" });
      return;
    }
    const t = setTimeout(
      () => {
        autoRef.current += 1;
        fetchedRef.current = false;
        setInfo({ status: "loading" });
        setTick((v) => v + 1);
      },
      1500,
    );
    return () => clearTimeout(t);
  }, [active, info.status, tick]);

  /* attach the chosen format */
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el || info.status !== "ready" || !info.url) return;
    let disposed = false;
    /* ADAPTIVE combo — the same 1080p MSE pairing the watch view uses */
    if (info.kind === "adaptive" && info.vFmt && info.aFmt) {
      const handle = attachAdaptiveCombo(el, info.vFmt, info.aFmt);
      if (handle) {
        return () => {
          disposed = true;
          handle.destroy();
        };
      }
      /* MSE/codec refused — play the muxed fallback instead */
      if (info.fallback) {
        el.src = info.fallback.url;
      }
      return () => {
        disposed = true;
      };
    }
    if (info.kind === "progressive") {
      el.src = info.url;
    } else {
      (async () => {
        if (el.canPlayType("application/vnd.apple.mpegurl")) {
          el.src = info.url!;
          return;
        }
        try {
          const mod = await import("hls.js");
          const Hls = mod.default;
          if (disposed) return;
          if (!Hls.isSupported()) {
            el.src = info.url!;
            return;
          }
          const instance = new Hls({ enableWorker: true, maxBufferLength: 30 });
          hlsRef.current = instance;
          instance.loadSource(info.url!);
          instance.attachMedia(el);
        } catch {
          if (!disposed) el.src = info.url!;
        }
      })();
    }
    return () => {
      disposed = true;
      try {
        hlsRef.current?.destroy();
      } catch {
        /* already gone */
      }
      hlsRef.current = null;
    };
  }, [info.status, info.url, info.kind]);

  /* the active slide plays (muted autoplay is always allowed); the rest pause */
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (active) {
      el
        .play()
        .then(() => {
          if (!watchedRef.current) {
            watchedRef.current = true;
            onWatched(card);
          }
        })
        .catch(() => {
          /* autoplay refused — the center play button shows */
        });
    } else {
      el.pause();
    }
  }, [active, info.status, onWatched, card]);

  React.useEffect(() => {
    const el = videoRef.current;
    if (el) el.muted = muted;
  }, [muted, info.status]);

  /* saved speed applies to the native lane live */
  React.useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = readPrefs().speed;
  }, [muted, info.status, prefsV]);

  const togglePlay = () => {
    if (info.status === "relay") {
      if (playing) relayRef.current?.pause();
      else relayRef.current?.play();
      return;
    }
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  };

  const retry = () => {
    fetchedRef.current = false;
    autoRef.current = 0; /* a manual press earns a fresh auto-retry budget */
    setInfo({ status: "idle" });
    setTick((t) => t + 1);
  };

  /* stable relay callbacks (the message listener re-registers less) */
  const handleRelayWatched = React.useCallback(() => {
    if (!watchedRef.current) {
      watchedRef.current = true;
      onWatched(card);
    }
  }, [onWatched, card]);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-zinc-950 sm:aspect-[9/16] sm:w-auto sm:rounded-3xl sm:ring-1 sm:ring-white/10"
      /* full-slide tap = pause/unpause in the lanes that can play —
       * "you can't pause or unpause it" is exactly this missing */
      onClick={info.status === "relay" ? togglePlay : undefined}
    >
      {info.status === "ready" ? (
        <video
          ref={videoRef}
          className="size-full cursor-pointer bg-black object-cover"
          playsInline
          loop
          muted={muted}
          autoPlay={active}
          preload="auto"
          crossOrigin="anonymous"
          onClick={togglePlay}
          onPlay={(e) => {
            /* a scrolled-away slide must never run — stray autoplay on
             * an inactive native video is paused on the spot */
            if (!active) {
              e.currentTarget.pause();
              return;
            }
            setPlaying(true);
          }}
          onPause={() => setPlaying(false)}
          onError={() =>
            setInfo((s) => (s.status === "ready" ? { status: "error", message: "the stream broke — try again" } : s))
          }
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration > 0) setProgress(el.currentTime / el.duration);
          }}
          aria-label={`short: ${card.title}`}
        />
      ) : info.status === "relay" ? (
        <RelayShort
          card={card}
          active={active}
          muted={muted}
          handleRef={relayRef}
          onWatched={handleRelayWatched}
          onPlayingChange={setPlaying}
          onProgress={setProgress}
          onLatch={() => setRelayLive(true)}
        />
      ) : card.thumb ? (
        <Thumb src={card.thumb} alt={card.title} />
      ) : (
        <div className="size-full bg-zinc-950" />
      )}

      {/* loading — calm, active slide only */}
      {active && info.status === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 aria-hidden className="size-9 animate-spin text-fuchsia-300/90" />
        </div>
      )}

      {/* gate / error — the AUTO-FLOW is the fix (soft re-probe, then
       * relay by itself), so this stays calm: a tuning hint over the
       * thumbnail with two quiet escape hatches, never a wall of buttons */}
      {(info.status === "gate" || info.status === "error") && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-end gap-3 bg-gradient-to-t from-black/85 via-black/35 to-black/10 px-7 pb-28 text-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 ring-1 ring-white/10 backdrop-blur-sm">
            <Loader2 aria-hidden className="size-3.5 animate-spin text-fuchsia-300" />
            <span className="text-[12px] font-medium text-zinc-200">tuning this short…</span>
          </div>
          <div className="pointer-events-auto flex items-center gap-3 text-[11px] text-zinc-400">
            <button
              type="button"
              onClick={retry}
              className="rounded-lg px-2 py-1 font-medium text-zinc-300 underline decoration-zinc-600 underline-offset-4 transition hover:text-white"
            >
              retry native
            </button>
            <span aria-hidden className="text-zinc-600">·</span>
            <button
              type="button"
              onClick={() => onOpenVideo(card)}
              className="rounded-lg px-2 py-1 font-medium text-zinc-300 underline decoration-zinc-600 underline-offset-4 transition hover:text-white"
            >
              open as video
            </button>
          </div>
        </div>
      )}

      {/* relay lane not yet latched — a calm spinner (the embed is
       * already autoplaying muted); NEVER a play button the lane can't
       * honor (the stuck "purple play button" was exactly this) */}
      {active && info.status === "relay" && !relayLive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 aria-hidden className="size-9 animate-spin text-fuchsia-300/80" />
        </div>
      )}

      {/* center play (paused) — only in lanes we can actually control:
       * the native element, or a relay that has latched its handshake */}
      {active && (info.status === "ready" || (info.status === "relay" && relayLive)) && !playing && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play"
          className="absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-fuchsia-500/95 text-white shadow-xl shadow-fuchsia-500/30 transition hover:scale-105 hover:bg-fuchsia-400"
        >
          <Play aria-hidden className="size-6 translate-x-0.5 fill-white" />
        </button>
      )}

      {/* info overlay — title + channel + controls, active slide only */}
      {active && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-4 pb-5 pt-20">
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              {card.authorId && (
                <button
                  type="button"
                  onClick={() => onChannel(card.authorId, card.author)}
                  aria-label={`Open channel: ${card.author}`}
                  className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 text-left ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/15"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fuchsia-500/90 text-[11px] font-bold text-white">
                    {card.author.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="truncate text-[12.5px] font-semibold text-zinc-100">{card.author}</span>
                  {card.verified && <ShieldCheck aria-label="verified channel" className="size-3 shrink-0 text-zinc-400" />}
                </button>
              )}
              <h3 className="mt-2 line-clamp-2 text-[13.5px] font-semibold leading-snug text-zinc-100">{card.title}</h3>
              {card.views > 0 && (
                <p className="mt-0.5 text-[11px] tabular-nums text-zinc-400">{fmtCount(card.views)} views</p>
              )}
            </div>
            <div className="pointer-events-auto flex flex-col items-center gap-2 pb-1">
              <button
                type="button"
                onClick={onToggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20"
              >
                {muted ? <VolumeX aria-hidden className="size-4.5" /> : <Volume2 aria-hidden className="size-4.5" />}
              </button>
              {/* pause / play — always visible in both play lanes */}
              {(info.status === "ready" || info.status === "relay") && (
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={playing ? "Pause" : "Play"}
                  title={playing ? "Pause (space)" : "Play (space)"}
                  className="flex size-10 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20"
                >
                  {playing ? (
                    <Pause aria-hidden className="size-4.5 fill-white" />
                  ) : (
                    <Play aria-hidden className="size-4.5 translate-x-0.5 fill-white" />
                  )}
                </button>
              )}
              <ShortLikeButtons videoId={card.id} likes={info.likes ?? 0} chan={{ authorId: card.authorId, author: card.author }} />
              <button
                type="button"
                onClick={() => onOpenComments(card)}
                aria-label="Comments"
                title="Comments"
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20"
              >
                <MessageSquare aria-hidden className="size-4.5" />
              </button>
              <button
                type="button"
                onClick={() => onOpenVideo(card)}
                aria-label="Open as a regular video"
                title="Open as a regular video"
                className="flex size-10 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20"
              >
                <MonitorPlay aria-hidden className="size-4.5" />
              </button>
            </div>
          </div>
          {/* progress */}
          <div aria-hidden className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-fuchsia-500 transition-[width] duration-200"
              style={{ width: `${Math.min(100, progress * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** The fullscreen vertical shorts experience — scroll or swipe to move
 *  between shorts, one per screen, exactly like the phone apps. When
 *  `onNeedMore` is provided the feed is INFINITE: nearing the end deals
 *  the next hand of unseen shorts from the server (your channels' first),
 *  and a dry round backs off briefly — the "deal more" pill at the
 *  bottom always forces a fresh hand, so the feed never hard-stops. */
function ShortsViewer({
  list,
  startId,
  label,
  onClose,
  onChannel,
  onOpenVideo,
  onWatched,
  onNeedMore,
}: {
  list: YtCard[];
  startId: string;
  label: string;
  onClose: () => void;
  onChannel: (id: string, name: string) => void;
  onOpenVideo: (card: YtCard) => void;
  onWatched: (card: YtCard) => void;
  /** infinite mode — deals more shorts as the end nears (absent when
   * the viewer was opened on one channel's finite shelf) */
  onNeedMore?: (seen: string[], force?: boolean) => Promise<YtCard[]>;
}) {
  const reduceMotion = useReducedMotion();
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  /* the live deck — starts as the list it was opened with and grows as
   * the infinite loader appends fresh deals */
  const [items, setItems] = React.useState<YtCard[]>(list);
  React.useEffect(() => setItems(list), [list]);
  const startIndex = Math.max(0, list.findIndex((c) => c.id === startId));
  const activeRef = React.useRef(startIndex);
  const [active, setActive] = React.useState(startIndex);
  /* sound memory — first visit starts muted (autoplay-safe), but once
   * the user turns sound on it stays on for every future session */
  const [muted, setMuted] = React.useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return window.localStorage.getItem("veil.stream.shortsSound") !== "on";
    } catch {
      return true;
    }
  });
  React.useEffect(() => {
    try {
      window.localStorage.setItem("veil.stream.shortsSound", muted ? "off" : "on");
    } catch {
      /* best-effort */
    }
  }, [muted]);
  const [moreLoading, setMoreLoading] = React.useState(false);
  const [dry, setDry] = React.useState(false);
  const dryUntilRef = React.useRef(0);
  /* viewer settings popover (speed + quality cap) */
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const prefsV = usePrefsVersion();
  /* the comments side sheet — which short's thread is open (null = closed) */
  const [commentsFor, setCommentsFor] = React.useState<YtCard | null>(null);

  /* ---- the infinite loader: fire when the active slide comes within
   * 4 of the end; a zero-new round backs off 8s (the pill overrides) */
  const loadMore = React.useCallback(
    (force = false) => {
      if (!onNeedMore || moreLoading) return;
      if (!force && Date.now() < dryUntilRef.current) return;
      setMoreLoading(true);
      setDry(false);
      const seen = items.slice(-150).map((c) => c.id).filter(Boolean);
      onNeedMore(seen, force)
        .then((batch) => {
          const have = new Set(items.map((c) => c.id));
          const fresh = (Array.isArray(batch) ? batch : []).filter((c) => c && c.id && !have.has(c.id));
          if (fresh.length > 0) {
            setItems((prev) => {
              const ids = new Set(prev.map((c) => c.id));
              return [...prev, ...fresh.filter((c) => !ids.has(c.id))];
            });
          } else if (!force) {
            dryUntilRef.current = Date.now() + 8000;
            setDry(true);
          }
        })
        .catch(() => {
          dryUntilRef.current = Date.now() + 8000;
          setDry(true);
        })
        .finally(() => setMoreLoading(false));
    },
    [items, moreLoading, onNeedMore],
  );
  React.useEffect(() => {
    if (!onNeedMore) return;
    if (active >= items.length - 4) loadMore();
  }, [active, items.length, onNeedMore, loadMore]);

  /* land on the chosen short before anything paints */
  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = startIndex * el.clientHeight;
  }, [startIndex]);

  /* which slide is on screen → the active one */
  React.useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting && en.intersectionRatio >= 0.55) {
            const idx = Number((en.target as HTMLElement).dataset.index ?? "-1");
            if (idx >= 0 && idx !== activeRef.current) {
              activeRef.current = idx;
              setActive(idx);
            }
          }
        }
      },
      { root, threshold: [0.55] },
    );
    root.querySelectorAll<HTMLElement>("[data-index]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);

  const go = React.useCallback(
    (dir: 1 | -1) => {
      const el = scrollerRef.current;
      if (!el) return;
      const next = Math.max(0, Math.min(items.length - 1, activeRef.current + dir));
      if (next === activeRef.current) return;
      el.scrollTo({ top: next * el.clientHeight, behavior: reduceMotion ? "auto" : "smooth" });
    },
    [items.length, reduceMotion],
  );

  /* keyboard — captured on document so Escape closes the viewer before
   * the app's window-level Esc (which would close the whole section) */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          /* the comments sheet closes first — the viewer itself stays */
          if (commentsFor) {
            setCommentsFor(null);
            return;
          }
          onClose();
          break;
        case "ArrowDown":
        case "PageDown":
          e.preventDefault();
          e.stopPropagation();
          go(1);
          break;
        case "ArrowUp":
        case "PageUp":
          e.preventDefault();
          e.stopPropagation();
          go(-1);
          break;
        case "m":
        case "M":
          e.stopPropagation();
          setMuted((v) => !v);
          break;
        case " ": {
          e.preventDefault();
          e.stopPropagation();
          const slide = scrollerRef.current?.querySelector(`[data-index="${activeRef.current}"]`);
          const vid = slide?.querySelector("video");
          if (vid) {
            if (vid.paused) vid.play().catch(() => {});
            else vid.pause();
          } else {
            /* relay lane — the slide's own pause/play button (or the
             * center play overlay when paused) toggles it */
            (slide?.querySelector('button[aria-label="Pause"], button[aria-label="Play"]') as HTMLElement | null)?.click();
          }
          break;
        }
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [go, onClose, commentsFor]);

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduceMotion ? undefined : { opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="dialog"
      aria-modal="true"
      aria-label="Shorts viewer"
      className="fixed inset-0 z-[70] bg-black"
    >
      {/* top bar */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-center gap-2.5 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 py-3.5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close shorts viewer"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20"
        >
          <X aria-hidden className="size-4.5" />
        </button>
        <span className="flex min-w-0 items-center gap-2 rounded-full bg-fuchsia-500/15 px-3 py-1 ring-1 ring-fuchsia-500/30">
          <Zap aria-hidden className="size-3.5 shrink-0 text-fuchsia-300" />
          <span className="truncate text-[12.5px] font-semibold text-fuchsia-100">{label}</span>
        </span>
        <span className="shrink-0 text-[11.5px] tabular-nums text-zinc-500">
          {active + 1}
          {onNeedMore ? <span className="text-fuchsia-400/70"> / ∞</span> : ` / ${items.length}`}
        </span>
        <div className="flex-1" />
        <span className="hidden shrink-0 text-[11px] text-zinc-600 sm:block">scroll · ↑↓ · space · m</span>
        {/* viewer settings — speed + quality cap (applies to shorts as
         * they load; the cap is shared with the watch view) */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="Shorts settings"
            aria-expanded={settingsOpen}
            className={cn(
              "flex size-9 items-center justify-center rounded-full ring-1 ring-white/15 backdrop-blur-sm transition",
              settingsOpen ? "bg-white/20 text-white" : "bg-white/10 text-zinc-100 hover:bg-white/20",
            )}
          >
            <Settings aria-hidden className={cn("size-4", settingsOpen && "rotate-45 transition-transform")} />
          </button>
          {settingsOpen && (
            <>
              <button
                type="button"
                aria-label="Close settings"
                className="fixed inset-0 z-20 cursor-default"
                onClick={() => setSettingsOpen(false)}
              />
              <div key={prefsV} className="absolute right-0 top-11 z-30 w-56 rounded-xl border border-zinc-700/80 bg-zinc-900/95 py-1.5 shadow-2xl backdrop-blur-md">
                <p className="px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Speed</p>
                <div className="flex flex-wrap gap-1 px-2.5 pb-2 pt-0.5">
                  {SPEED_STEPS.map((s) => {
                    const on = Math.abs(readPrefs().speed - s) < 0.01;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => savePrefs({ speed: s })}
                        aria-pressed={on}
                        className={cn(
                          "rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition",
                          on
                            ? "bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-500/40"
                            : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                        )}
                      >
                        {s === 1 ? "1×" : `${s}×`}
                      </button>
                    );
                  })}
                </div>
                <p className="border-t border-zinc-800 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                  Quality
                </p>
                <div className="flex flex-wrap gap-1 px-2.5 pb-1.5 pt-0.5">
                  {[2160, 1440, 1080, 720, 480, 360].map((h) => {
                    const on = readPrefs().maxHeight === h;
                    return (
                      <button
                        key={h}
                        type="button"
                        onClick={() => savePrefs({ maxHeight: h })}
                        aria-pressed={on}
                        className={cn(
                          "rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition",
                          on
                            ? "bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-500/40"
                            : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                        )}
                      >
                        {h}p
                      </button>
                    );
                  })}
                </div>
                {/* relay quality — what the embed lane asks YouTube for when
                 * the native lane is gated and the short rides the iframe */}
                <p className="border-t border-zinc-800 px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
                  Relay quality
                </p>
                <div className="flex flex-wrap gap-1 px-2.5 pb-1.5 pt-0.5">
                  {RELAY_QUALITIES.map((q) => {
                    const on = readPrefs().relayQuality === q.v;
                    return (
                      <button
                        key={q.v}
                        type="button"
                        onClick={() => savePrefs({ relayQuality: q.v })}
                        aria-pressed={on}
                        className={cn(
                          "rounded-lg px-2 py-1 text-[11px] font-semibold tabular-nums transition",
                          on
                            ? "bg-fuchsia-500/20 text-fuchsia-200 ring-1 ring-fuchsia-500/40"
                            : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                        )}
                      >
                        {q.label}
                      </button>
                    );
                  })}
                </div>
                <p className="border-t border-zinc-800 px-3 pb-1.5 pt-2 text-[10.5px] leading-relaxed text-zinc-600">
                  quality applies to shorts as they load · sound stays {muted ? "muted" : "on"} between sessions
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* the vertical feed — one short per screen, snap-scrolled */}
      <div
        ref={scrollerRef}
        className="veil-scroll-slim h-full w-full snap-y snap-mandatory overflow-y-auto overscroll-y-contain"
      >
        {items.map((card, i) => (
          <div
            key={`${card.id}-${i}`}
            data-index={i}
            className="flex h-full w-full snap-start snap-always items-center justify-center"
          >
            <ShortSlide
              card={card}
              active={i === active}
              preload={i === active + 1 || i === active + 2}
              muted={muted}
              onToggleMute={() => setMuted((v) => !v)}
              onWatched={onWatched}
              onChannel={onChannel}
              onOpenVideo={onOpenVideo}
              onOpenComments={setCommentsFor}
            />
          </div>
        ))}
        {/* the loader slide — keeps the snap flow while the next hand
         * is being dealt; also the manual override when the well ran dry */}
        {onNeedMore && (
          <div className="flex h-full w-full snap-start snap-always items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              {moreLoading ? (
                <>
                  <Loader2 aria-hidden className="size-7 animate-spin text-fuchsia-300/80" />
                  <p className="text-[12px] text-zinc-500">dealing more shorts…</p>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => loadMore(true)}
                  className="flex items-center gap-2 rounded-full bg-fuchsia-500/15 px-4 py-2.5 text-[12.5px] font-semibold text-fuchsia-200 ring-1 ring-fuchsia-500/30 backdrop-blur-sm transition hover:bg-fuchsia-500/25"
                >
                  <RefreshCw aria-hidden className="size-3.5" />
                  {dry ? "that's the wire — deal a fresh hand" : "deal more shorts"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* the infinite status pill (non-blocking, floats over the feed) */}
      {onNeedMore && moreLoading && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-black/60 px-3.5 py-1.5 text-[11.5px] font-medium text-zinc-300 ring-1 ring-white/10 backdrop-blur-sm">
            <Loader2 aria-hidden className="size-3.5 animate-spin text-fuchsia-300" />
            dealing more shorts…
          </span>
        </div>
      )}

      {/* comments side sheet — the open short's thread, YouTube-style */}
      <AnimatePresence>
        {commentsFor && (
          <motion.aside
            key="shorts-comments"
            initial={reduceMotion ? false : { x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduceMotion ? undefined : { x: 40, opacity: 0 }}
            transition={{ duration: 0.2 }}
            aria-label="Short comments"
            className="absolute inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-white/10 bg-zinc-950/90 backdrop-blur-md"
          >
            <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-3">
              <MessageSquare aria-hidden className="size-4 shrink-0 text-fuchsia-300" />
              <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100">{commentsFor.title}</p>
              <button
                type="button"
                onClick={() => setCommentsFor(null)}
                aria-label="Close comments"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 transition hover:bg-white/20"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
            <CommentsPanel key={commentsFor.id} videoId={commentsFor.id} sheet />
          </motion.aside>
        )}
      </AnimatePresence>

      {/* desktop up/down */}
      <div className="absolute right-3 top-1/2 z-20 hidden -translate-y-1/2 flex-col gap-2.5 md:flex">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={active === 0}
          aria-label="Previous short"
          className="flex size-11 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20 disabled:opacity-30"
        >
          <ChevronUp aria-hidden className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={!onNeedMore && active === items.length - 1}
          aria-label="Next short"
          className="flex size-11 items-center justify-center rounded-full bg-white/10 text-zinc-100 ring-1 ring-white/15 backdrop-blur-sm transition hover:bg-white/20 disabled:opacity-30"
        >
          <ChevronDown aria-hidden className="size-5" />
        </button>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* The section                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Subscriptions + Playlists pages                                      */
/* ------------------------------------------------------------------ */

/** The Subscriptions page — new uploads from the channels this device
 * follows, newest first, with unseen dots on never-watched cards and a
 * manage strip for unfollowing. The river is INFINITE (YouTube-style):
 * scrolling past the sentinel loads the next ~6 uploads from every
 * followed channel, appended in strict chronological order, until every
 * channel's shelf is exhausted ("You're all caught up"). */
function SubsPage({
  cards,
  loading,
  error,
  histEntries,
  onReload,
  onWatch,
  onChannel,
  onLoadMore,
  moreLoading,
  hasMore,
}: {
  cards: YtCard[] | null;
  loading: boolean;
  error: string | null;
  histEntries: HistoryEntry[] | null;
  onReload: () => void;
  onWatch: (id: string, card: YtCard) => void;
  onChannel: (id: string, name: string) => void;
  /** infinite river — call when the sentinel scrolls into view */
  onLoadMore: () => void;
  moreLoading: boolean;
  /** false = every followed channel's shelf is exhausted */
  hasMore: boolean;
}) {
  const subsV = useSubsVersion();
  void subsV; /* re-render on follow-list changes */
  const subs = readSubs();
  const followIds = Object.keys(subs);
  /* real logos for the subs grid too (one batched backfill — covers the
   * whole river, not just the first screen, so deep rounds get avatars
   * the moment they append) */
  useAvatarBackfill(React.useMemo(() => (cards ?? []).slice(0, 120), [cards]));
  const watched = React.useMemo(
    () => new Set((histEntries ?? []).map((h) => h.card.id)),
    [histEntries],
  );

  /* ---- infinite scroll sentinel ---- */
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || moreLoading || loading || (cards ?? []).length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { rootMargin: "900px 0px" /* start the round before the user hits the floor */ },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, moreLoading, loading, cards, onLoadMore]);

  return (
    <section aria-label="Subscriptions">
      <PageHeader
        icon={Rss}
        tone="subs"
        title="Subscriptions"
        badge={followIds.length > 0 ? `${followIds.length} channel${followIds.length === 1 ? "" : "s"}` : undefined}
        onReload={onReload}
        reloading={loading}
        actions={<TakeoutImport onDone={onReload} />}
      />
      {/* manage strip — followed channels, one-tap unfollow */}
      {followIds.length > 0 && (
        <div className="veil-scroll-slim mb-4 flex gap-2 overflow-x-auto pb-1">
          {followIds.map((id) => {
            const e = subs[id];
            return (
              <span
                key={id}
                className="flex shrink-0 items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 py-1 pl-1 pr-1.5"
              >
                {e.avatar ? (
                  <Thumb src={e.avatar} alt="" className="size-6 shrink-0 rounded-full" />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-[10px] font-bold text-cyan-300">
                    {(e.name || "?").slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="max-w-28 truncate text-[11.5px] font-medium text-zinc-300">{e.name || id}</span>
                <button
                  type="button"
                  onClick={() => toggleSub(id, { name: e.name, avatar: e.avatar, at: Date.now() })}
                  aria-label={`Unsubscribe from ${e.name || id}`}
                  className="flex size-5 items-center justify-center rounded-full text-zinc-500 transition hover:bg-rose-500/20 hover:text-rose-300"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {followIds.length === 0 ? (
        <FeedEmptyState
          message="you're not following any channels yet — open a channel and hit Subscribe, or import your real YouTube subscriptions below"
          onRetry={onReload}
          retryLabel="Refresh"
        />
      ) : loading && cards === null ? (
        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          <CardSkeletons n={8} />
        </div>
      ) : error ? (
        <FeedEmptyState message={error} onRetry={onReload} retryLabel="Reload feed" />
      ) : (cards ?? []).length === 0 ? (
        <FeedEmptyState
          message="no new uploads came back from the channels you follow — try a reload"
          onRetry={onReload}
          retryLabel="Reload feed"
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {(cards ?? []).map((c, i) => {
              const isNew = !watched.has(c.id);
              return (
                <div key={`${c.id}-${i}`} className="relative">
                  {isNew && (
                    <span
                      aria-label="new upload"
                      title="new upload — not watched yet"
                      className="absolute left-4 top-4 z-10 flex size-2.5 items-center justify-center rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
                    />
                  )}
                  <VideoCard card={c} index={i} onWatch={onWatch} onChannel={onChannel} />
                </div>
              );
            })}
          </div>
          {/* the river's tail — more skeletons while a round is in
           * flight, the caught-up end mark when every shelf is dry */}
          {hasMore || moreLoading ? (
            <div
              ref={sentinelRef}
              aria-live="polite"
              className="mt-8 grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            >
              <CardSkeletons n={4} />
              <p className="col-span-full text-center text-[11.5px] text-zinc-600">
                {moreLoading ? "loading deeper uploads…" : "keep scrolling — older uploads from your channels"}
              </p>
            </div>
          ) : (
            (cards ?? []).length > 0 && (
              <p className="mt-8 flex items-center justify-center gap-2 text-[12px] text-zinc-600">
                <span className="size-1.5 rounded-full bg-zinc-700" aria-hidden />
                You&apos;re all caught up — every upload from your {followIds.length} channel
                {followIds.length === 1 ? "" : "s"} is on screen
                <span className="size-1.5 rounded-full bg-zinc-700" aria-hidden />
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* YouTube Takeout import — bring your REAL subscriptions over          */
/* ------------------------------------------------------------------ */

/** Parse a Google Takeout YouTube subscriptions export (CSV or JSON)
 * into {id, name} pairs. Shapes handled:
 *   CSV   — "Channel Id,Channel Url,Channel Title" rows (the classic
 *           export; the url column is a /channel/UC… link)
 *   JSON  — the newer export: [{ contentDetails: { resourceId:
 *           { channelId } }, snippet: { title } }, …]
 * Channel ids are pulled from the id column, the url column, or the
 * JSON resourceId — whatever is present; non-UC entries (legacy
 * usernames) are counted and skipped with an honest note. */
export function parseTakeoutSubs(
  text: string,
): { channels: { id: string; name: string }[]; skipped: number } {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const push = (id: string, name: string) => {
    if (!/^(UC|HC)[\w-]{6,}$/.test(id)) {
      skipped++;
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: name.slice(0, 80) });
  };

  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(j) ? j : [j];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const o = item as Record<string, any>;
        const id =
          o?.contentDetails?.resourceId?.channelId ??
          o?.resourceId?.channelId ??
          o?.snippet?.resourceId?.channelId ??
          o?.channelId;
        const name = o?.snippet?.title ?? o?.title ?? "";
        if (typeof id === "string") push(id, typeof name === "string" ? name : "");
      }
      if (out.length > 0 || skipped > 0) return { channels: out, skipped };
    } catch {
      /* fall through to CSV parsing — some exports are JSON-ish but
       * hand-edited; the CSV branch may still find rows */
    }
  }

  /* CSV — quote-aware minimal parser (channel titles contain commas) */
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuotes) {
      if (ch === '"') {
        if (trimmed[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && trimmed[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  for (const r of rows) {
    if (r.length < 2) {
      skipped++;
      continue;
    }
    /* header row? */
    if (/^channel\s*id$/i.test(r[0].trim())) continue;
    const idCol = r[0].trim();
    const urlCol = r[1].trim();
    const nameCol = (r[2] ?? "").trim();
    const urlMatch = urlCol.match(/channel\/(UC[\w-]{6,})/);
    const id = /^(UC|HC)[\w-]{6,}$/.test(idCol) ? idCol : urlMatch ? urlMatch[1] : "";
    if (!id) {
      skipped++;
      continue;
    }
    push(id, nameCol);
  }
  return { channels: out, skipped };
}


/** Merge Takeout watch-history rows into this device's history store.
 * Imported entries carry a synthesized PARTIAL card — real thumbnail
 * (through the /api/yt/s proxy, exactly like every other image), title
 * + channel from the activity log; duration/views are unknown until
 * the video is opened (which refetches full metadata). Existing
 * entries win (their cards are complete). Returns how many landed —
 * the honest post-cap, post-quota count from the IndexedDB write. */
async function importWatchHistory(rows: TakeoutHistoryRow[]): Promise<number> {
  const fresh: HistoryEntry[] = [];
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r?.id || ids.has(r.id)) continue;
    ids.add(r.id);
    fresh.push({
      card: {
        id: r.id,
        title: r.t || "(untitled)",
        author: r.c || "YouTube",
        authorId: r.cid || "",
        verified: false,
        durationSec: 0,
        views: 0,
        published: "",
        live: false,
        thumb: "/api/yt/s?u=" + encodeURIComponent(`https://i.ytimg.com/vi/${r.id}/hqdefault.jpg`),
      },
      at: typeof r.at === "number" && r.at > 0 ? r.at : 0,
    });
  }
  if (fresh.length === 0) return 0;
  const landed = await historyImportTakeout(fresh);
  _watchedIds = null;
  return landed;
}

/** The full "Import from YouTube" flow — shared by the Subscriptions
 * header button AND the Stream data gear menu. Accepts, by content:
 *   - Google Takeout archives of ANY size: .tgz / .tar.gz / .tar AND
 *     .zip — magic-sniffed, so a renamed file still works. The
 *     archive is streamed through IN THE BROWSER (nothing is
 *     uploaded — a full multi-GB Takeout with videos included is
 *     fine): subscriptions csv/json AND watch-history json/html are
 *     pulled out wherever Google nested them. Browsers without
 *     DecompressionStream fall back to the server route (≤48MB).
 *   - a bare subscriptions .csv or .json (both Google export shapes)
 *   - a Veil backup .json (veil.backup.v2 envelope or the legacy flat
 *     map) — the file exported from another Veil browser; it carries
 *     channels, watch history, playlists and settings, and restoring
 *     it here is obviously what the dropper wanted.
 * Returns a note for the UI; never throws (except user cancel, which
 * returns an honest "cancelled" note). */
async function runYouTubeImport(
  file: File,
  onDone: () => void,
  onProgress?: (p: YouTubeImportProgress) => void,
  signal?: AbortSignal,
): Promise<YouTubeImportResult> {
  try {
    /* the history store's mirror must be primed before merges land */
    await historyReady();
    let texts: { name: string; text: string }[];
    let historyRows: TakeoutHistoryRow[] = [];
    let truncated = false;
    let kind: "gzip" | "zip" | "tar" | "text";
    const hasDS = typeof DecompressionStream !== "undefined";
    if (hasDS) {
      /* INLINE for small archives, WORKER for big ones — a multi-GB
       * Takeout walk is minutes of pure CPU and used to freeze the
       * whole app when it ran on the main thread. */
      const r = await runArchiveExtraction(file, onProgress, signal);
      kind = r.kind;
      texts = r.texts;
      historyRows = r.historyRows;
      truncated = r.truncated;
      /* QA/debug aid — the last extraction's shape, readable from
       * the console (window.__veilTakeout) when someone reports an
       * import that behaved oddly. */
      (window as unknown as { __veilTakeout?: unknown }).__veilTakeout = {
        kind,
        file: { name: file.name, size: file.size },
        truncated,
        entries: r.entries,
        texts: r.texts.map((t) => t.name),
        historyRows: r.historyRows.length,
      };
    } else if (file.size <= 48 * 1024 * 1024) {
      /* legacy fallback — POST the small archive to the server route */
      const res = await fetch(`/api/yt/takeout?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: await file.arrayBuffer(),
        signal,
      });
      const j = (await res.json().catch(() => null)) as
        | { files?: { name: string; text: string }[]; history?: TakeoutHistoryRow[]; error?: string }
        | null;
      if (!res.ok || !j || (!Array.isArray(j.files) && !Array.isArray(j.history))) {
        return { ok: false, text: j?.error || "the archive couldn’t be read — try re-downloading it from Takeout" };
      }
      texts = Array.isArray(j.files) ? j.files : [];
      historyRows = Array.isArray(j.history) ? j.history : [];
      kind = "gzip";
    } else {
      return {
        ok: false,
        text: `this browser can’t stream a ${(file.size / 1e9).toFixed(1)} GB archive locally — import it from a current browser (Chrome, Edge, Firefox, Safari), or re-export from Takeout with just YouTube → subscriptions selected`,
      };
    }

    const bits: string[] = [];
    let feedTouched = false;

    /* pass 1 — the Google Takeout subscriptions shapes. EVERY subs
     * candidate is parsed and merged (multi-part subscriptions files
     * land whole); subscriptions-named files first. */
    let skipped = 0;
    const sorted = [...texts].sort((a, b) => {
      const sa = SUBS_FILE_RE.test(a.name) ? 0 : 1;
      const sb = SUBS_FILE_RE.test(b.name) ? 0 : 1;
      return sa - sb;
    });
    const channels: { id: string; name: string }[] = [];
    const chanIds = new Set<string>();
    for (const f of sorted) {
      const parsed = parseTakeoutSubs(f.text);
      if (parsed.channels.length > 0) {
        for (const ch of parsed.channels) {
          if (chanIds.has(ch.id)) continue;
          chanIds.add(ch.id);
          channels.push(ch);
        }
      }
      skipped += parsed.skipped;
    }
    if (channels.length > 0) {
      const subs = readSubs();
      let added = 0;
      let kept = 0;
      const now = Date.now();
      for (const ch of channels) {
        if (subs[ch.id]) {
          kept++;
          continue;
        }
        subs[ch.id] = { name: ch.name || ch.id, at: now };
        added++;
      }
      writeSubs(subs);
      /* backfill real avatars for the imported channels (one batched
       * request, best-effort — the strip shows initials until then) */
      if (added > 0) {
        const ids = channels.slice(0, 30).map((c) => c.id);
        fetchJsonSafe<{ avatars?: Record<string, string> }>(
          `/api/yt/avatars?ids=${encodeURIComponent(ids.join(","))}`,
        )
          .then((r) => {
            const av = r?.avatars ?? {};
            const cur = readSubs();
            let touched = false;
            for (const [id, url] of Object.entries(av)) {
              if (url && cur[id] && !cur[id].avatar) {
                cur[id].avatar = url;
                touched = true;
              }
            }
            if (touched) writeSubs(cur);
          })
          .catch(() => {
            /* initials are fine */
          });
      }
      bits.push(`${added} channel${added === 1 ? "" : "s"} added`);
      if (kept) bits.push(`${kept} already followed`);
      feedTouched = true;
    }

    /* pass 2 — a Veil backup .json (from another browser/device).
     * Only reached when no Takeout subscriptions were found — a Veil
     * backup is a whole-device restore and returns early. */
    if (bits.length === 0) {
      for (const f of texts) {
        const trimmed = f.text.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const probe = JSON.parse(trimmed) as Record<string, unknown>;
          const looksVeil =
            (typeof probe.format === "string" && (probe.format as string).startsWith("veil.backup")) ||
            probe.app === "Veil" ||
            Object.keys(probe).some((k) => /^veil[.:]/.test(k));
          if (!looksVeil) continue;
          const summary = importVeilBackup(trimmed);
          const desc = describeRestore(summary);
          if (!desc) continue;
          window.setTimeout(() => onDone(), 600);
          return {
            ok: true,
            text: `That was a Veil backup file — restored: ${desc}. Your channels, history and playlists are back.`,
          };
        } catch {
          /* not a Veil backup — next candidate */
        }
      }
    }

    /* pass 3 — watch-history rows from a FULL Takeout (independent of
     * subscriptions — both come from the same archive; JSON and HTML
     * shapes already merged). Imported rows are marked watched: the
     * History tab fills, and the For You feed (client filter + the
     * server `seen` list on the next round) stops recommending
     * everything YouTube already showed them. */
    if (historyRows.length > 0) {
      const n = await importWatchHistory(historyRows);
      if (n > 0) bits.push(`${n.toLocaleString()} video${n === 1 ? "" : "s"} marked as watched`);
    }

    if (bits.length > 0) {
      window.setTimeout(() => onDone(), 600);
      return {
        ok: true,
        text: `Imported from your YouTube account — ${bits.join(" · ")}.${truncated ? " (the archive looked truncated partway through — imported everything readable; re-download it if anything is missing.)" : ""}${feedTouched ? " Your feed is loading…" : ""}`,
      };
    }

    if (truncated) {
      return {
        ok: false,
        text: "that archive is truncated — the download didn’t finish. Nothing importable was readable before the cut; re-download it from takeout.google.com and try again",
      };
    }
    return {
      ok: false,
      text: `no YouTube data found in that file${skipped ? ` (${skipped} row${skipped === 1 ? "" : "s"} skipped — not channel links)` : ""} — expected your Google Takeout archive (.tgz or .zip — any size, subscriptions and/or history), the subscriptions .csv/.json inside it, or a Veil backup .json`,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { ok: false, text: "import cancelled" };
    }
    return { ok: false, text: e instanceof Error ? e.message : "the import didn't complete" };
  }
}

/** The "Import from YouTube" button + flow. Google doesn't allow a
 * sandboxed third-party app to sign users in directly — the OFFICIAL
 * path (the same one FreeTube/NewPipe use) is the Takeout export: the
 * user downloads their archive from takeout.google.com (a .tgz or a
 * .zip — Google offers both) and drops it here. The archive is
 * streamed through IN THE BROWSER — a full multi-GB Takeout (videos,
 * photos, everything) is fine: Veil reads it locally, pulls out the
 * subscriptions csv/json and watch-history json/html wherever Google
 * nested them, and never uploads a byte. Then every channel in it
 * lands in this device's follow list — the Subscriptions river + For
 * You rails become THEIR real feed. A Veil backup .json dropped here
 * works too (restored wholesale — it's the same data). */
function TakeoutImport({ onDone }: { onDone: () => void }) {
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [help, setHelp] = React.useState(false);
  const [scan, setScan] = React.useState<YouTubeImportProgress | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const doImport = async (file: File) => {
    setBusy(true);
    setNote(null);
    setScan(null);
    abortRef.current = new AbortController();
    const r = await runYouTubeImport(
      file,
      onDone,
      (p) => setScan(p),
      abortRef.current.signal,
    );
    setNote({ ok: r.ok, text: r.text });
    setBusy(false);
    setScan(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const fmtBytes = (n: number): string => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
    return `${n} B`;
  };

  return (
    <div className="relative">
      <input
        ref={fileRef}
        type="file"
        data-veil="yt-takeout-input"
        accept=".tgz,.tar.gz,.tar,.zip,.csv,.json,application/gzip,application/x-tar,application/zip,text/csv,application/json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doImport(f);
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Import your YouTube subscriptions from a Google Takeout file"
          className="h-8 shrink-0 gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-200"
        >
          {busy ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <Download aria-hidden className="size-3.5" />
          )}
          Import from YouTube
        </Button>
        <button
          type="button"
          onClick={() => setHelp((v) => !v)}
          aria-expanded={help}
          aria-label="How to get your YouTube subscriptions file"
          className="flex size-8 items-center justify-center rounded-xl text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-300"
        >
          <HelpCircle aria-hidden className="size-4" />
        </button>
      </div>
      {help && (
        <div className="mt-2 rounded-2xl border border-zinc-700/80 bg-zinc-900/95 p-4 text-[12px] leading-relaxed text-zinc-400 shadow-2xl shadow-black/60 backdrop-blur-md sm:absolute sm:right-0 sm:top-10 sm:z-40 sm:mt-0 sm:w-80">
          <p className="mb-2 font-semibold text-zinc-200">Bring your real YouTube feed over</p>
          <ol className="list-decimal space-y-1.5 pl-4">
            <li>
              open{" "}
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                takeout.google.com
              </span>{" "}
              and hit <em>Deselect all</em>
            </li>
            <li>
              pick <strong>YouTube</strong> → <em>subscriptions</em> (and <em>history</em> if you
              want your watched list to come too)
            </li>
            <li>
              export — Google hands you a{" "}
              <span className="font-mono text-[11px]">takeout-….tgz</span> or{" "}
              <span className="font-mono text-[11px]">.zip</span> within minutes
            </li>
            <li>
              drop that archive right here — Veil scans it <strong>on this
              device</strong> and pulls your subscriptions + watch history out
              (any size — a full multi-GB Takeout with your videos is fine;
              a bare{" "}
              <span className="font-mono text-[11px]">subscriptions.csv</span> or{" "}
              <span className="font-mono text-[11px]">.json</span> works too)
            </li>
          </ol>
          <p className="mt-2.5 text-[11px] text-zinc-600">
            Google doesn&apos;t offer third-party sign-in for sandboxed apps — the Takeout file is
            the official, private way (this is exactly how FreeTube and NewPipe do it). The archive
            never leaves this device, and your follow list stays here too. Dropped a Veil backup
            .json here by accident? It imports too — channels, history, playlists, everything.
          </p>
        </div>
      )}
      {scan && busy && (
        <div
          role="status"
          aria-label="Archive scan progress"
          className="mt-2 rounded-2xl border border-zinc-700/80 bg-zinc-900/95 p-3.5 shadow-2xl shadow-black/60 backdrop-blur-md sm:absolute sm:right-0 sm:top-10 sm:z-40 sm:mt-0 sm:w-80"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 text-[12px] font-semibold text-zinc-200">
              <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-cyan-300" />
              <span className="truncate">Scanning your {fmtBytes(scan.total)} archive…</span>
            </p>
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="shrink-0 rounded-lg border border-zinc-700 px-2 py-0.5 text-[10.5px] font-medium text-zinc-400 transition hover:border-rose-500/50 hover:text-rose-300"
            >
              Cancel
            </button>
          </div>
          <div
            className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-zinc-800"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(scan.pct * 100)}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-sky-400 to-rose-500 transition-[width] duration-200 ease-out"
              style={{ width: `${Math.max(2, Math.round(scan.pct * 100))}%` }}
            />
          </div>
          <p className="mt-1.5 flex items-baseline justify-between gap-2 text-[10.5px] tabular-nums text-zinc-500">
            <span>
              {Math.round(scan.pct * 100)}% · {fmtBytes(scan.scanned)} of {fmtBytes(scan.total)}
            </span>
            {scan.found.length > 0 && (
              <span className="truncate text-emerald-400/80" title={scan.found.join(" · ")}>
                found {scan.found.slice(0, 2).join(", ")}
                {scan.found.length > 2 ? ` +${scan.found.length - 2}` : ""}
              </span>
            )}
          </p>
          <p className="mt-1 text-[10px] leading-snug text-zinc-600">
            reading it on this device — nothing is uploaded
          </p>
        </div>
      )}
      {note && (
        <p
          role="status"
          className={cn(
            "mt-2 rounded-xl px-3 py-2 text-[11.5px] leading-snug sm:absolute sm:right-0 sm:top-10 sm:z-40 sm:mt-0 sm:w-80",
            note.ok
              ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border border-rose-500/30 bg-rose-500/10 text-rose-300",
            help && "sm:top-72",
            scan && busy && "sm:top-80",
          )}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}

/** A playlist cover card — the first item's thumb with a stacked look,
 * the item count, and the list name. */
function PlaylistCoverCard({ pl, index, onOpen }: { pl: Playlist; index: number; onOpen: () => void }) {
  const reduceMotion = useReducedMotion();
  const cover = pl.items[0];
  return (
    <motion.button
      type="button"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.3) }}
      onClick={onOpen}
      aria-label={`Open playlist ${pl.name} — ${pl.items.length} videos`}
      className="group flex w-full flex-col gap-2.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-2 text-left outline-none transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-500/50 hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-violet-500/40"
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl">
        {cover ? (
          <Thumb src={cover.thumb} alt="" />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
            <ListVideo aria-hidden className="size-8 text-zinc-600" />
          </div>
        )}
        {/* stacked-sheet look */}
        <span aria-hidden className="absolute inset-x-2 -bottom-1 hidden h-2 rounded-b-xl border border-zinc-700/70 bg-zinc-800/80 group-hover:border-violet-500/30" />
        {pl.items.length > 0 && (
          <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/80 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-zinc-100 backdrop-blur-sm">
            <ListVideo aria-hidden className="size-3" /> {pl.items.length}
          </span>
        )}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/30 group-hover:opacity-100">
          <span className="flex size-12 items-center justify-center rounded-full bg-violet-500/95 shadow-xl shadow-violet-500/30">
            <Play aria-hidden className="size-5 translate-x-0.5 text-white fill-white" />
          </span>
        </div>
      </div>
      <div className="min-w-0 px-1 pb-1">
        <h3 className="truncate text-[13px] font-semibold text-zinc-100">{pl.name}</h3>
        <p className="mt-0.5 truncate text-[11px] text-zinc-500">
          {pl.id === WATCH_LATER_ID
            ? "the default list — saved everywhere"
            : pl.items.length === 1
              ? "1 video"
              : `${pl.items.length} videos`}
        </p>
      </div>
    </motion.button>
  );
}

/** The Playlists page — Watch Later first, then every named list, plus
 * the inline creator. */
function PlaylistsPage({ onOpen }: { onOpen: (plId: string) => void }) {
  const plsV = usePlaylistsVersion();
  void plsV; /* re-render on playlist changes */
  const [newName, setNewName] = React.useState("");
  const lists = React.useMemo(() => {
    const l = readPlaylists();
    watchLaterOf(l); /* lazily ensure Watch Later exists */
    return l;
  }, [plsV]);
  return (
    <section aria-label="Playlists">
      <PageHeader
        icon={ListVideo}
        tone="playlists"
        title="Playlists"
        badge={lists.length > 0 ? `${lists.length} list${lists.length === 1 ? "" : "s"}` : undefined}
        onReload={() => window.dispatchEvent(new Event("veil-stream-playlists"))}
      />
      {/* create a playlist */}
      <form
        className="mb-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (createPlaylist(newName)) setNewName("");
        }}
      >
        <div className="relative min-w-0 flex-1">
          <ListPlus aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New playlist name…"
            aria-label="New playlist name"
            spellCheck={false}
            maxLength={60}
            className="h-10 rounded-2xl border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-[13.5px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-violet-500/60 focus-visible:ring-violet-500/25"
          />
        </div>
        <button
          type="submit"
          disabled={!newName.trim()}
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-2xl bg-violet-500 px-4 text-[13.5px] font-semibold text-white shadow-lg shadow-violet-500/25 transition hover:bg-violet-400 disabled:opacity-50"
        >
          <Plus aria-hidden className="size-4" />
          <span className="hidden sm:inline">Create</span>
        </button>
      </form>
      {lists.length === 0 ? (
        <FeedEmptyState
          message="no playlists yet — save any video with the Save button, or create a list above"
          onRetry={() => setNewName("")}
          retryLabel="Refresh"
        />
      ) : (
        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {lists.map((pl, i) => (
            <PlaylistCoverCard key={pl.id} pl={pl} index={i} onOpen={() => onOpen(pl.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A playlist's detail — the items in order with move/remove controls,
 * "Play all" (marathon), rename + delete for named lists. */
function PlaylistDetail({
  plId,
  onBack,
  onPlay,
}: {
  plId: string;
  onBack: () => void;
  onPlay: (plId: string, index: number) => void;
}) {
  const plsV = usePlaylistsVersion();
  void plsV; /* re-render on playlist changes */
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const pl = readPlaylists().find((p) => p.id === plId);
  if (!pl) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-[13.5px] text-zinc-400">this playlist is gone</p>
        <Button size="sm" variant="outline" onClick={onBack} className="h-8 rounded-xl border-zinc-700">
          <ArrowLeft aria-hidden className="size-3.5" /> Back to playlists
        </Button>
      </div>
    );
  }
  const isWatchLater = pl.id === WATCH_LATER_ID;
  const totalSec = pl.items.reduce((n, i) => n + (i.durationSec || 0), 0);
  return (
    <section aria-label={`Playlist ${pl.name}`}>
      {/* header */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5 sm:p-6">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-violet-500/[0.08] to-transparent" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative hidden h-20 w-32 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/10 sm:block">
            {pl.items[0] ? (
              <Thumb src={pl.items[0].thumb} alt="" />
            ) : (
              <div className="flex size-full items-center justify-center bg-zinc-800">
                <ListVideo aria-hidden className="size-7 text-zinc-600" />
              </div>
            )}
            {pl.items.length > 1 && (
              <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-zinc-100 backdrop-blur-sm">
                <ListVideo aria-hidden className="size-2.5" /> {pl.items.length}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-300">
              <ListVideo aria-hidden className="size-3.5" /> Playlist
            </p>
            {renaming ? (
              <form
                className="mt-1 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  renamePlaylist(pl.id, renameValue);
                  setRenaming(false);
                }}
              >
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                  maxLength={60}
                  aria-label="Playlist name"
                  className="h-9 max-w-sm rounded-xl border-zinc-700 bg-zinc-900 text-[15px] text-zinc-100"
                />
                <Button type="submit" size="sm" className="h-9 rounded-xl bg-violet-500 text-white hover:bg-violet-400">
                  <Check aria-hidden className="size-3.5" /> Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)} className="h-9 rounded-xl text-zinc-400">
                  Cancel
                </Button>
              </form>
            ) : (
              <h2 className="mt-0.5 flex flex-wrap items-center gap-2 text-[19px] font-semibold tracking-tight text-zinc-50">
                <span className="break-words">{pl.name}</span>
                {!isWatchLater && (
                  <button
                    type="button"
                    onClick={() => {
                      setRenameValue(pl.name);
                      setRenaming(true);
                    }}
                    aria-label="Rename this playlist"
                    className="flex size-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    <Pencil aria-hidden className="size-3.5" />
                  </button>
                )}
              </h2>
            )}
            <p className="mt-1 text-[12.5px] tabular-nums text-zinc-400">
              {pl.items.length} video{pl.items.length === 1 ? "" : "s"}
              {totalSec > 0 ? ` · ${fmtTime(totalSec)} total` : ""}
              {isWatchLater ? " · saved from every watch view" : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {pl.items.length > 0 && (
              <Button
                size="sm"
                onClick={() => onPlay(pl.id, 0)}
                className="h-9 gap-1.5 rounded-xl bg-violet-500 text-white shadow-lg shadow-violet-500/25 hover:bg-violet-400"
              >
                <Play aria-hidden className="size-3.5 fill-current" /> Play all
              </Button>
            )}
            {!isWatchLater && (
              <>
                {confirmDelete ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        deletePlaylist(pl.id);
                        onBack();
                      }}
                      className="h-9 gap-1.5 rounded-xl border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
                    >
                      <Trash2 aria-hidden className="size-3.5" /> Delete for real
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} className="h-9 rounded-xl text-zinc-400">
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDelete(true)}
                    className="h-9 gap-1.5 rounded-xl border-zinc-700 text-zinc-400 hover:border-rose-500/40 hover:text-rose-300"
                  >
                    <Trash2 aria-hidden className="size-3.5" /> Delete
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* items */}
      {pl.items.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-2 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-zinc-800/80">
            <ListVideo aria-hidden className="size-6 text-zinc-500" />
          </span>
          <p className="max-w-sm text-[13px] text-zinc-400">
            nothing saved here yet — use the Save button on any watch view to add videos
          </p>
        </div>
      ) : (
        <ol className="mt-5 space-y-2">
          {pl.items.map((c, i) => (
            <li
              key={`${c.id}-${i}`}
              className="group/row flex items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-2 pr-2.5 transition hover:border-zinc-700"
            >
              <span className="w-6 shrink-0 text-center text-[12px] font-semibold tabular-nums text-zinc-500">{i + 1}</span>
              <button
                type="button"
                onClick={() => onPlay(pl.id, i)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={`Play ${c.title}`}
              >
                <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg sm:w-28">
                  <Thumb src={c.thumb} alt={c.title} />
                  {c.durationSec > 0 && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[10px] font-semibold tabular-nums text-zinc-100">
                      {fmtTime(c.durationSec)}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-zinc-100 transition group-hover/row:text-violet-200">{c.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                    {c.author}
                    {c.views > 0 ? ` · ${fmtCount(c.views)} views` : ""}
                  </span>
                </span>
              </button>
              <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/row:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  onClick={() => movePlaylistVideo(pl.id, c.id, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${c.title} up`}
                  className="flex size-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
                >
                  <ChevronUp aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => movePlaylistVideo(pl.id, c.id, 1)}
                  disabled={i === pl.items.length - 1}
                  aria-label={`Move ${c.title} down`}
                  className="flex size-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
                >
                  <ChevronDown aria-hidden className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeFromPlaylist(pl.id, c.id)}
                  aria-label={`Remove ${c.title} from ${pl.name}`}
                  className="flex size-7 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-rose-500/20 hover:text-rose-300"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-6">
        <Button size="sm" variant="outline" onClick={onBack} className="h-8 gap-1.5 rounded-xl border-zinc-700 text-zinc-300">
          <ArrowLeft aria-hidden className="size-3.5" /> All playlists
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Stream data menu — export / import (Takeout-style portability)        */
/* ------------------------------------------------------------------ */

/** The gear menu in the Stream header — export everything Stream keeps
 * on this device (history, subscriptions, playlists, likes, preferences)
 * as one portable JSON in the veil.stream.* format, and merge an export
 * back in on any browser. Nothing is deleted; newest wins. */
function StreamDataMenu() {
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const ytFileRef = React.useRef<HTMLInputElement | null>(null);
  const [ytBusy, setYtBusy] = React.useState(false);
  const [ytScan, setYtScan] = React.useState<YouTubeImportProgress | null>(null);
  const ytAbortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[data-stream-data-menu]")) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        /* swallow Esc — the open menu owns it (else the start page's
         * window listener closes the whole Stream section too) */
        e.stopPropagation();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const doExport = async () => {
    try {
      /* the IndexedDB mirror primes in two stages — the backup must
       * wait for the FULL river, not just the newest slice */
      await historySettled();
      const backup = exportVeilBackup();
      const keys = Object.keys(backup.keys);
      if (keys.length === 0) {
        setNote({ ok: false, text: "nothing to export yet — this browser has no Veil data" });
        return;
      }
      const stamp = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const fname = `veil-backup-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.json`;
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setNote({ ok: true, text: `exported ${keys.length} keys — wallpaper, history, subs, settings… → ${fname}` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "the export didn't complete" });
    }
  };

  const doImport = async (file: File) => {
    setBusy(true);
    setNote(null);
    try {
      const text = await file.text();
      await historyReady();
      const s = importVeilBackup(text);
      const desc = describeRestore(s);
      if (!desc) {
        setNote({ ok: false, text: "that file parsed, but it carries no Veil data keys" });
      } else {
        setNote({ ok: true, text: `restored: ${desc} — reloading…` });
        window.setTimeout(() => window.location.reload(), 1400);
      }
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "the import didn't complete" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="relative" data-stream-data-menu>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen((v) => !v);
          setNote(null);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Stream data — export or import"
        className="h-9 w-9 rounded-xl border border-zinc-800 bg-zinc-900/60 p-0 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
      >
        <Settings aria-hidden className="size-4" />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Stream data"
          className="absolute right-0 top-11 z-40 w-80 rounded-2xl border border-zinc-700/80 bg-zinc-900/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-md"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            Your Veil data
          </p>
          <button
            type="button"
            role="menuitem"
            onClick={doExport}
            className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-white/5"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/25">
              <Download aria-hidden className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold text-zinc-200">Export data</span>
              <span className="block text-[11px] leading-snug text-zinc-500">
                wallpaper, history, subscriptions, playlists, settings — one portable JSON
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-white/5 disabled:opacity-50"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/25">
              {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Upload aria-hidden className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold text-zinc-200">Import data</span>
              <span className="block text-[11px] leading-snug text-zinc-500">
                merge a Veil backup into this device — nothing is removed, newest wins
              </span>
            </span>
          </button>
          <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
            From other apps
          </p>
          <button
            type="button"
            role="menuitem"
            disabled={ytBusy}
            onClick={() => ytFileRef.current?.click()}
            className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-white/5 disabled:opacity-50"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/25">
              {ytBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Youtube aria-hidden className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold text-zinc-200">Import from YouTube</span>
              <span className="block text-[11px] leading-snug text-zinc-500">
                your Google Takeout archive (.tgz / .zip, any size) — every channel you follow lands in Stream
              </span>
            </span>
          </button>
          <p className="px-2.5 pb-1 pt-0.5 text-[10.5px] leading-snug text-zinc-600">
            full device backup (localStorage) — moves everything between browsers
          </p>
          {ytScan && ytBusy && (
            <div className="mx-1.5 mb-1.5" role="status" aria-label="Archive scan progress">
              <div className="flex items-center justify-between gap-2 text-[10.5px] tabular-nums text-zinc-500">
                <span className="truncate">
                  scanning {ytScan.total >= 1e9 ? `${(ytScan.total / 1e9).toFixed(1)} GB` : `${Math.round(ytScan.total / 1e6)} MB`}…
                  {ytScan.found.length > 0 && (
                    <span className="text-emerald-400/80"> found {ytScan.found[0]}</span>
                  )}
                </span>
                <span className="flex items-center gap-1.5">
                  {Math.round(ytScan.pct * 100)}%
                  <button
                    type="button"
                    onClick={() => ytAbortRef.current?.abort()}
                    className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:border-rose-500/50 hover:text-rose-300"
                  >
                    Cancel
                  </button>
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-rose-500 to-orange-400 transition-[width] duration-200"
                  style={{ width: `${Math.max(2, Math.round(ytScan.pct * 100))}%` }}
                />
              </div>
              <p className="mt-1 text-[10px] text-zinc-600">reading it on this device — nothing is uploaded</p>
            </div>
          )}
          {note && (
            <p
              role="status"
              className={cn(
                "mx-1.5 mb-1.5 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug",
                note.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300",
              )}
            >
              {note.text}
            </p>
          )}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void doImport(f);
        }}
      />
      <input
        ref={ytFileRef}
        type="file"
        data-veil="gear-yt-input"
        accept=".tgz,.tar.gz,.tar,.zip,.csv,.json,application/gzip,application/x-tar,application/zip,text/csv,application/json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setYtBusy(true);
          setNote(null);
          setYtScan(null);
          ytAbortRef.current = new AbortController();
          void runYouTubeImport(
            f,
            () => {
              /* NO page reload — the import's reactive stores (subs
               * version, history version) already refresh the feed and
               * history reactively, and a full reload used to wipe the
               * result note and read as "the website froze" on big
               * archives. */
            },
            (p) => setYtScan(p),
            ytAbortRef.current.signal,
          ).then((r) => {
            setNote({ ok: r.ok, text: r.text });
            setYtBusy(false);
            setYtScan(null);
            if (ytFileRef.current) ytFileRef.current.value = "";
          });
        }}
      />
    </div>
  );
}

export function StreamSection({ onBack }: { onBack: () => void }) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = React.useState("");
  const [submitted, setSubmitted] = React.useState<string | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchGate, setSearchGate] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<YtCard[] | null>(null);

  const [feed, setFeed] = React.useState<YtCard[] | null>(null);
  const [feedLoading, setFeedLoading] = React.useState(true);
  const [feedError, setFeedError] = React.useState<string | null>(null);
  /* the INFINITE For You river — deep-round cards append here (ranked
   * per batch, so nothing already on screen ever moves) + the river
   * state the client owns and POSTs back each round */
  const [fyTail, setFyTail] = React.useState<YtCard[]>([]);
  const [fyMoreLoading, setFyMoreLoading] = React.useState(false);
  const [fyHasMore, setFyHasMore] = React.useState(false);
  const fyCursorsRef = React.useRef<Record<string, string>>({});
  /* ranker state — the exploration-jitter seed (bumped on every feed
   * deal) + this device's subscription uploads (candidate-gen merge) */
  const [rankSeed, setRankSeed] = React.useState(1);
  const [subsWire, setSubsWire] = React.useState<YtCard[]>([]);
  /* negative feedback ("Not interested" / "Don't recommend channel") —
   * re-ranks the feed + re-filters the rails the moment feedback lands */
  const niVersion = useNotInterestedVersion();
  const [feedbackNote, setFeedbackNote] = React.useState<{
    text: string;
    sub: string;
    undo: () => void;
  } | null>(null);
  const feedbackActions = React.useMemo<CardFeedbackActions>(
    () => ({
      notInterested: (card: YtCard) => {
        markNotInterested(card);
        setFeedbackNote({
          text: "Video removed",
          sub: "You'll see fewer videos like this.",
          undo: () => unmarkNotInterested(card),
        });
      },
      blockChannel: (card: YtCard) => {
        if (!card.authorId) return;
        blockChannel(card);
        setFeedbackNote({
          text: "We won't recommend this channel again",
          sub: card.author,
          undo: () => unblockChannel(card),
        });
      },
    }),
    [],
  );

  /* ---- browse pages: For You (main) + Shorts / Popular on the right rail ---- */
  const [page, setPage] = React.useState<PageKey>("foryou");
  const [shorts, setShorts] = React.useState<YtCard[] | null>(null);
  const [shortsLoading, setShortsLoading] = React.useState(false);
  const [shortsError, setShortsError] = React.useState<string | null>(null);
  const [popular, setPopular] = React.useState<YtCard[] | null>(null);
  const [popularLoading, setPopularLoading] = React.useState(false);
  const [popularError, setPopularError] = React.useState<string | null>(null);

  const [watchId, setWatchId] = React.useState<string | null>(null);
  const [watchCard, setWatchCard] = React.useState<YtCard | null>(null);
  const [video, setVideo] = React.useState<VideoAnswer | null>(null);
  const [videoLoading, setVideoLoading] = React.useState(false);

  /* ---- channel view ---- */
  const [channelView, setChannelView] = React.useState<{ id: string; name: string } | null>(null);
  const [channelData, setChannelData] = React.useState<YtChannel | null>(null);
  const [channelLoading, setChannelLoading] = React.useState(false);
  const [channelGate, setChannelGate] = React.useState<string | null>(null);
  /** relay latch — once the relay lane is engaged for a watch it stays
   * engaged until the user leaves or explicitly goes native, so a
   * background heal never yanks playback out from under them. */
  const [relayEngaged, setRelayEngaged] = React.useState(false);
  /** epoch ms of the first gate answer for the current watch (null until
   * gated) — drives the GatePanel's elapsed clock + retry cadence. */
  const [gateSince, setGateSince] = React.useState<number | null>(null);
  /** completed auto-retry rounds for the current watch — the cadence
   * shifts from 15s (first 8) to 60s after that. */
  const [gateRounds, setGateRounds] = React.useState(0);
  /** Every card the section has seen, by id — instant metadata for the
   * watch view (the gate-y video answer can arrive slim). */
  const cardsById = React.useRef(new Map<string, YtCard>());
  const remember = React.useCallback((c: YtCard) => {
    if (c?.id) cardsById.current.set(c.id, c);
  }, []);

  /* ---- shorts viewer (vertical, scroll-snap — infinite when opened
  from the main shorts wire, finite on a single channel's shelf) ---- */
  const [shortsView, setShortsView] = React.useState<{
    list: YtCard[];
    startId: string;
    label: string;
    infinite: boolean;
  } | null>(null);

  /* ---- watch history — per device (IndexedDB via history-store) ---- */
  const [histEntries, setHistEntries] = React.useState<HistoryEntry[] | null>(null);
  const histPaused = useHistoryPaused();
  /* Incremental rendering for the History page — a big history (the full
   * 1,000,000-row class) rendered as one wall of cards spiked the tab
   * AND the dev server (one thumbnail request per card at once); the
   * page now reveals in pages (24 at a time) with a sentinel
   * auto-loading the next page on scroll. */
  const HIST_PAGE = 24;
  const [histShown, setHistShown] = React.useState(HIST_PAGE);
  React.useEffect(() => {
    setHistShown(HIST_PAGE);
  }, [histEntries]);

  /* ---- feed (For You) — personalized + rotating ----
   * Every load carries the channels this device actually watches, AND the
   * BOOST list — channels it subscribed to or liked videos from (the
   * user's standing order: those channels' videos surface MORE, leading
   * the blend). The reload button asks for a FRESH mix instead of the
   * same cards again. */
  const subsVersion = useSubsVersion();
  const ratingsVersion = useRatingsVersion();
  /* the ranker's signal bundle — shared by the round-1 memo and every
   * deep-round batch so the whole river sees the same curation. Only
   * the NEWEST 5,000 rows ride along: recency-weighted ranking is
   * statistically identical on the deep tail, and mapping a full
   * million-row history per feed load is pure waste. */
  const foryouSignals = React.useCallback(
    (seed: number) => ({
      history: (histEntries ?? []).slice(0, 5000).map((h) => ({ card: h.card as RankCard, at: h.at })),
      subs: Object.keys(readSubs()),
      likedChannels: likedChannelIds(),
      ...niSignal(),
      seed,
    }),
    [histEntries, subsVersion, ratingsVersion, niVersion],
  );
  /* the fresh-deal backfill ranks its deep round with the CURRENT
   * signals without making loadFeed's identity churn on every history
   * bump (which would re-fetch the whole wire) — the ref always points
   * at the latest bundle */
  const foryouSignalsRef = React.useRef(foryouSignals);
  React.useEffect(() => {
    foryouSignalsRef.current = foryouSignals;
  }, [foryouSignals]);
  const loadFeed = React.useCallback(
    (fresh = false) => {
      void fresh; /* every load is a fresh deal — the POST blend is rebuilt */
      setFeedLoading(true);
      setFeedError(null);
      /* fresh river — round-1 cursors, empty tail */
      setFyTail([]);
      setFyHasMore(false);
      fyCursorsRef.current = {};
      const chans = topWatchedChannels(8);
      const vids = topWatchedVideos(3);
      const boost = boostChannelIds(8);
      /* WATCHED videos never enter the feed — the history rides the
       * request as the server-side exclusion list. Capped at the newest
       * 20,000 ids (a full million-row history would be a 10MB+ POST
       * body; anything older than that is client-filtered anyway) */
      const seen = [...watchedIdsSnapshot()].slice(0, 20000);
      fetchJsonSafe<{ cards?: YtCard[]; next?: Record<string, string> | null } | YtGate>("/api/yt/feed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "foryou", chans, vids, boost, seen, cursors: {} }),
      })
        .then((body) => {
          if (body && !Array.isArray(body) && "cards" in body && Array.isArray(body.cards)) {
            body.cards.forEach(remember);
            /* FRESH HAND — sample the wire on every load (curated head +
             * a seeded-random slice of the tail) so two reloads deal two
             * visibly DIFFERENT pages; the old behavior was the same set
             * in a new order. The dropped slots come right back via the
             * immediate deep round below. */
            const dealt = dealFreshHand(body.cards);
            setFeed(dealt);
            const nextCursors = body.next ?? {};
            fyCursorsRef.current = nextCursors;
            setFyHasMore(Object.keys(nextCursors).length > 0);
            /* immediate refill — one deep river round tops the page back
             * up with uploads that were never on the wire, so the sampled
             * page stays full AND fresh content lands high up instead of
             * one scroll away */
            if (Object.keys(nextCursors).length > 0) {
              const deepSeen = [...watchedIdsSnapshot(), ...dealt.map((c) => c.id)].slice(0, 380);
              fetchJsonSafe<{ cards?: YtCard[]; next?: Record<string, string> | null } | YtGate>("/api/yt/feed", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ kind: "foryou", chans, boost, seen: deepSeen, cursors: nextCursors }),
              })
                .then((b2) => {
                  if (!b2 || Array.isArray(b2) || !("cards" in b2) || !Array.isArray(b2.cards)) return;
                  b2.cards.forEach(remember);
                  const ranked2 = rankFeed(b2.cards as RankCard[], foryouSignalsRef.current(7));
                  const curated2 = ranked2.cards as unknown as YtCard[];
                  setFyTail((prev) => {
                    const known = new Set([...dealt.map((c) => c.id), ...prev.map((c) => c.id)]);
                    const fresh2 = curated2.filter((c) => !known.has(c.id));
                    return fresh2.length > 0 ? [...prev, ...fresh2] : prev;
                  });
                  const nc = b2.next ?? {};
                  fyCursorsRef.current = nc;
                  setFyHasMore(Object.keys(nc).length > 0);
                })
                .catch(() => {
                  /* refill is a bonus — the dealt page stands alone */
                });
            }
          } else if (body && !Array.isArray(body) && "gated" in body) {
            setFeed([]);
            setFeedError((body as YtGate).message);
          } else {
            setFeed([]);
            setFeedError("the feed came back in an unexpected shape — try a reload");
          }
          /* a new deal re-seeds the ranker's exploration jitter too */
          setRankSeed((s) => s + 1);
        })
        .catch((e: Error) => setFeedError(e.message || "the feed didn't load"))
        .finally(() => setFeedLoading(false));
    },
    [remember, subsVersion, ratingsVersion],
  );
  const histLoaded = histEntries !== null;
  React.useEffect(() => {
    /* wait for the history mirror — the first deal should already know
     * what this device watched so `seen` actually excludes it */
    if (histLoaded) loadFeed();
  }, [histLoaded, loadFeed]);
  React.useEffect(() => {
    /* dead-man switch — the mirror prime is deadline-guarded in the
     * store, but if it somehow never lands (wedged IndexedDB, frozen
     * tab), deal the feed unpersonalized at 8s instead of spinning
     * forever. A late announce still refreshes the entries after. */
    if (histLoaded) return;
    const t = window.setTimeout(() => setHistEntries([]), 8_000);
    return () => window.clearTimeout(t);
  }, [histLoaded]);

  /** Infinite For You — one deeper round of the channel river: the
   *  next few uploads of every alive channel (subscribed/liked/watched
   *  first, fresh trending channels joining as the river thins), ranked
   * per batch with the same signals and APPENDED after the head, so
   * nothing already on screen moves while the feed keeps going. */
  const loadMoreForYou = React.useCallback(() => {
    const cursors = fyCursorsRef.current;
    if (fyMoreLoading || !fyHasMore || Object.keys(cursors).length === 0) return;
    setFyMoreLoading(true);
    const chans = topWatchedChannels(8);
    const boost = boostChannelIds(8);
    /* watched + everything already on screen — the river never re-deals */
    const seen = [
      ...watchedIdsSnapshot(),
      ...(feed ?? []).map((c) => c.id),
      ...fyTail.map((c) => c.id),
    ].slice(0, 380);
    fetchJsonSafe<{ cards?: YtCard[]; next?: Record<string, string> | null } | YtGate>("/api/yt/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "foryou", chans, boost, seen, cursors }),
    })
      .then((body) => {
        if (body && !Array.isArray(body) && "cards" in body && Array.isArray(body.cards)) {
          const batch: YtCard[] = body.cards;
          batch.forEach(remember);
          /* rank the batch with the same signals — the tail gets the
           * same why-labels, diversity pass and feedback filters (the
           * spread copies carry every YtCard field, thumb included) */
          const ranked = rankFeed(batch as RankCard[], foryouSignals(rankSeed + 1 + batch.length));
          const curated = ranked.cards as unknown as YtCard[];
          setFyTail((prev) => {
            const known = new Set([...(feed ?? []).map((c) => c.id), ...prev.map((c) => c.id)]);
            const fresh = curated.filter((c) => !known.has(c.id));
            return fresh.length > 0 ? [...prev, ...fresh] : prev;
          });
          const nextCursors = body.next ?? {};
          fyCursorsRef.current = nextCursors;
          setFyHasMore(Object.keys(nextCursors).length > 0);
        } else {
          /* a gate/shape issue ends the river gracefully */
          setFyHasMore(false);
        }
      })
      .catch(() => {
        setFyHasMore(false); /* stop hammering a dead upstream */
      })
      .finally(() => setFyMoreLoading(false));
  }, [fyMoreLoading, fyHasMore, feed, fyTail, remember, foryouSignals, rankSeed]);

  /* the For You river's infinite-scroll sentinel — fires a deep round
   * just before the user reaches the floor (same pattern as Subs) */
  const fySentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = fySentinelRef.current;
    if (!el || !fyHasMore || fyMoreLoading || feedLoading || (feed ?? []).length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreForYou();
      },
      { rootMargin: "900px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [fyHasMore, fyMoreLoading, feedLoading, feed, loadMoreForYou]);

  /* ---- shorts feed (rails on For You + the Shorts page) — carries the
   * channels this device watches so the blend leads with THEIR shorts,
   * tagged with why. Reload deals a fresh hand of shelves server-side,
   * so the shelf actually changes instead of showing the same shorts
   * forever. `needMoreShorts` powers the infinite viewer. */
  const loadShorts = React.useCallback(
    (shuffle = false) => {
      setShortsLoading(true);
      setShortsError(null);
      const qs = new URLSearchParams({ kind: "shorts" });
      const chans = topWatchedChannels(6);
      if (chans.length > 0) qs.set("chans", chans.join(","));
      const boost = boostChannelIds(8);
      if (boost.length > 0) qs.set("boost", boost.join(","));
      if (shuffle) {
        qs.set("shuffle", "1");
        qs.set("t", String(Date.now()));
      }
      fetchJsonSafe<YtCard[] | YtGate>(`/api/yt/feed?${qs.toString()}`)
        .then((body) => {
          if (Array.isArray(body)) {
            body.forEach(remember);
            setShorts(body);
          } else {
            setShorts([]);
            setShortsError(body.message);
          }
        })
        .catch((e: Error) => setShortsError(e.message || "the shorts shelf didn't load"))
        .finally(() => setShortsLoading(false));
    },
    [remember],
  );
  React.useEffect(() => {
    loadShorts();
  }, [loadShorts]);

  /* ---- popular feed (lazy — loaded on first visit) ---- */
  const loadPopular = React.useCallback(() => {
    setPopularLoading(true);
    setPopularError(null);
    fetchJsonSafe<YtCard[] | YtGate>("/api/yt/feed?kind=popular")
      .then((body) => {
        if (Array.isArray(body)) {
          body.forEach(remember);
          setPopular(body);
        } else {
          setPopular([]);
          setPopularError(body.message);
        }
      })
      .catch((e: Error) => setPopularError(e.message || "the popular feed didn't load"))
      .finally(() => setPopularLoading(false));
  }, [remember]);

  /* ---- history reads/writes (per device — IndexedDB store) ---- */
  React.useEffect(() => {
    let alive = true;
    historyReady()
      .then((rows) => {
        if (alive) setHistEntries(rows as unknown as HistoryEntry[]);
      })
      .catch(() => {
        if (alive) setHistEntries([]);
      });
    /* cross-component sync — an import (or another section) rewrote the
     * history; refresh the local copy + the For You personalization */
    const refresh = () => setHistEntries(readHistory());
    window.addEventListener("veil-stream-history", refresh);
    return () => {
      alive = false;
      window.removeEventListener("veil-stream-history", refresh);
    };
  }, []);
  const pushHistory = React.useCallback(
    (card: YtCard) => {
      /* paused history records nothing — the video also stays in the
       * feed, since the watched filter rides this same store */
      if (!card?.id || historyPaused()) return;
      _watchedIds = null;
      historyTouch(card);
      setHistEntries(readHistory());
    },
    [],
  );
  const removeHistory = React.useCallback((id: string) => {
    _watchedIds = null;
    historyDelete(id);
    setHistEntries(readHistory());
  }, []);
  /** Undo target for the removal snackbar — puts the entry back where
   * the timeline says it belongs (sorted by `at`, deduped by id). */
  const restoreHistory = React.useCallback((entry: HistoryEntry) => {
    if (!entry?.card?.id) return;
    _watchedIds = null;
    historyTouch(entry.card, entry.at);
    setHistEntries(readHistory());
  }, []);
  const clearHistory = React.useCallback(() => {
    _watchedIds = null;
    historyClear();
    setHistEntries([]);
  }, []);

  /* ---- open the vertical shorts viewer ---- */
  const openShorts = React.useCallback(
    (list: YtCard[], card: YtCard, label: string, infinite = false) => {
      remember(card);
      setShortsView({ list, startId: card.id, label, infinite });
    },
    [remember],
  );

  /* ---- the infinite shorts dealer — the viewer sends up the ids it
   * has already shown; the server deals the next hand of unseen shorts
   * (your channels first). force = the manual "deal more" pill, which
   * reshuffles the discovery pool too. */
  const needMoreShorts = React.useCallback(async (seen: string[], force = false): Promise<YtCard[]> => {
    const qs = new URLSearchParams({ kind: "shorts" });
    const chans = topWatchedChannels(6);
    if (chans.length > 0) qs.set("chans", chans.join(","));
    const boost = boostChannelIds(8);
    if (boost.length > 0) qs.set("boost", boost.join(","));
    if (seen.length > 0) qs.set("exclude", seen.join(","));
    if (force) {
      qs.set("shuffle", "1");
      qs.set("t", String(Date.now()));
    }
    try {
      const body = await fetchJsonSafe<YtCard[] | YtGate>(`/api/yt/feed?${qs.toString()}`);
      return Array.isArray(body) ? body : [];
    } catch {
      return [];
    }
  }, []);

  /* ---- per-device For You — YouTube's TWO-STAGE architecture, for real:
   *
   * STAGE 1 (candidate generation, server): the /api/yt/feed blend —
   *   trending US+GB + the derived popular wire + watched/subbed channel
   *   rails + "up-next" recs for recent watches — hands over a wide pool.
   *   The client ALSO merges this device's subscription uploads into the
   *   pool (the subs wire below), exactly like YouTube seeds home with
   *   followed-channel uploads.
   *
   * STAGE 2 (ranking, client — src/lib/veil/rank.ts): every candidate is
   *   scored against this device's compact "user embedding" (recency-
   *   decayed watch history, subscriptions, likes, current-session
   *   signals) by MULTIPLE objectives at once — expected watch time,
   *   click probability, satisfaction, freshness, session reaction, and
   *   cold-start exploration — blended into a composite "valued watch
   *   time" score (the deliberate move away from pure CTR, so clickbait
   *   doesn't win). Already-watched videos are demoted, a seeded ε-jitter
   *   keeps the page from ossifying, a diversity pass interleaves
   *   channels like YouTube's home grid, and each visible card carries
   *   an honest "why" label derived from its dominant signal. The memo
   *   re-runs on every history/subs/ratings bump — near-real-time
   *   reaction to the last few actions within a session. */
  /* subscription uploads — candidate-gen merge for For You */
  React.useEffect(() => {
    const ids = Object.keys(readSubs()).slice(0, 12);
    if (ids.length === 0) {
      setSubsWire([]);
      return;
    }
    let alive = true;
    fetchJsonSafe<YtCard[] | YtGate>(`/api/yt/feed?kind=subs&ids=${ids.join(",")}`)
      .then((body) => {
        if (!alive) return;
        const cards = Array.isArray(body) ? body : [];
        cards.forEach(remember);
        setSubsWire(cards);
      })
      .catch(() => {
        /* subs wire is a bonus — the blend stands without it */
      });
    return () => {
      alive = false;
    };
  }, [subsVersion, remember]);

  const foryouRank = React.useMemo<RankResult | null>(() => {
    if (!feed) return null;
    const candidates: RankCard[] = [...feed, ...subsWire];
    return rankFeed(candidates, foryouSignals(rankSeed));
  }, [feed, subsWire, foryouSignals, rankSeed]);

  const foryouCards = foryouRank?.cards ?? null;

  /* ---- For You filter chips (YouTube-home style) — client-side slices
   * of the personalized feed: everything, just your subs' uploads, the
   * freshest drops, live right now, your likes, what you've watched ---- */
  const [fyFilter, setFyFilter] = React.useState<FyFilter>("all");
  /* the whole on-screen river — the ranked round-1 head + the deep-round
   * tail, so chips and counts see everything the user can scroll to */
  const fyAll = React.useMemo(() => [...(foryouCards ?? []), ...fyTail], [foryouCards, fyTail]);
  /* the river after live negative feedback ("not interested" /
   * blocked channels) — shared by the filter and the chip counts so
   * they never disagree */
  const fyBase = React.useMemo(() => {
    if (fyAll.length === 0) return fyAll;
    const ni = niSnapshot();
    const hidden = new Set(Object.keys(ni.videos));
    const blocked = new Set(Object.keys(ni.channels));
    return fyAll.filter((c) => !hidden.has(c.id) && !blocked.has(c.authorId));
  }, [fyAll, niVersion]);
  const fyFiltered = React.useMemo(() => {
    const cards = fyBase;
    if (cards.length === 0) return cards;
    if (fyFilter === "all") {
      /* WATCHED videos never show on the feed itself (the "Watched"
       * chip is where to find them, exactly like YouTube's home hiding
       * what you've already seen) */
      const watched = watchedIdsSnapshot();
      return cards.filter((c) => !watched.has(c.id));
    }
    if (fyFilter === "subs") {
      const subs = new Set(Object.keys(readSubs()));
      return cards.filter((c) => subs.has(c.authorId));
    }
    if (fyFilter === "new") {
      const cutoff = Date.now() / 1000 - 48 * 3600;
      return cards.filter((c) => (c.publishedAt ?? 0) >= cutoff);
    }
    if (fyFilter === "live") return cards.filter((c) => c.live);
    if (fyFilter === "liked") {
      const liked = new Set(Object.entries(readAllRatings()).filter(([, r]) => r === "like").map(([id]) => id));
      return cards.filter((c) => liked.has(c.id));
    }
    /* watched — the REAL history, not the river's intersection: the
     * server excludes watched ids from every round, so after a reload
     * the river holds none of them (the old dead end: chip count 0
     * with a full history). Every watched video — full cards and
     * imported partial cards alike — is one click from a re-watch
     * here, newest first. */
    if (fyFilter === "watched") {
      return (histEntries ?? []).map((h) => h.card);
    }
    const watched = watchedIdsSnapshot();
    return cards.filter((c) => watched.has(c.id));
  }, [fyBase, fyFilter, subsVersion, ratingsVersion, histEntries]);
  /* live counts for every chip (one pass over the base river) — the
   * little numbered badges that tell the user what each slice holds
   * before they click it */
  const fyChipCounts = React.useMemo((): Record<FyFilter, number> => {
    const counts: Record<FyFilter, number> = { all: 0, subs: 0, new: 0, live: 0, liked: 0, watched: 0 };
    if (fyBase.length === 0) return counts;
    const watched = watchedIdsSnapshot();
    const subs = new Set(Object.keys(readSubs()));
    const liked = new Set(
      Object.entries(readAllRatings())
        .filter(([, r]) => r === "like")
        .map(([id]) => id),
    );
    const cutoff = Date.now() / 1000 - 48 * 3600;
    for (const c of fyBase) {
      if (!watched.has(c.id)) counts.all++;
      if (subs.has(c.authorId)) counts.subs++;
      if ((c.publishedAt ?? 0) >= cutoff) counts.new++;
      if (c.live) counts.live++;
      if (liked.has(c.id)) counts.liked++;
      if (watched.has(c.id)) counts.watched++;
    }
    /* the Watched slice is history-backed (see fyFiltered) — its count
     * must match what the slice actually shows, not the river */
    if (histEntries) counts.watched = histEntries.length;
    return counts;
  }, [fyBase, subsVersion, ratingsVersion, histEntries]);
  const fyChipsVisible =
    (fyFilter !== "all" && fyFiltered.length === 0) || fyFiltered.length > 0 || fyAll.length > 0;

  /* ---- REAL channel logos everywhere: batched avatar backfill for
   * whatever cards are on screen right now (deduped by the store, one
   * request per new set of channels). Covers the For You grid, the
   * shorts rails, search results, the watch view's up-next rail, and
   * the subs wire as it arrives. */
  useAvatarBackfill(
    React.useMemo(() => {
      const out: YtCard[] = [];
      if (page === "foryou" || watchId) out.push(...fyFiltered.slice(0, 120));
      if (!shortsView) out.push(...(shorts ?? []).slice(0, 24));
      if (results) out.push(...results.slice(0, 24));
      if (video && "related" in video && Array.isArray(video.related)) out.push(...video.related.slice(0, 24));
      return out;
    }, [page, watchId, fyFiltered, shorts, shortsView, results, video]),
  );

  /* ---- search ---- */
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q || searching) return;
    /* searching from anywhere — leave an open watch / channel first
     * (the search bar lives in the header, exactly like YouTube) */
    setWatchId(null);
    setVideo(null);
    setWatchCard(null);
    setChannelView(null);
    setChannelData(null);
    setChannelGate(null);
    setSubmitted(q);
    setSearching(true);
    setSearchGate(null);
    /* a fresh search leaves any open playlist detail */
    setPlaylistView(null);
    fetchJsonSafe<YtCard[] | YtGate>(`/api/yt/search?q=${encodeURIComponent(q)}`)
      .then((body) => {
        if (Array.isArray(body)) {
          body.forEach(remember);
          setResults(body);
          if (body.length === 0) setSearchGate("Nothing matched — try a shorter query.");
        } else {
          setResults([]);
          setSearchGate(body.message);
        }
      })
      .catch((err: Error) => {
        setResults([]);
        setSearchGate(err.message || "the search didn't complete");
      })
      .finally(() => setSearching(false));
  };

  const clearSearch = () => {
    setQuery("");
    setSubmitted(null);
    setResults(null);
    setSearchGate(null);
  };

  /* ---- channel ---- */
  const openChannel = React.useCallback((id: string, name: string) => {
    if (!id) return;
    /* opening a channel leaves any open watch — the iframe unmounts and
     * playback stops, exactly like tapping a channel on YouTube */
    setWatchId(null);
    setVideo(null);
    setWatchCard(null);
    setChannelView({ id, name: name || "" });
    setChannelData(null);
    setChannelGate(null);
    setChannelLoading(true);
    fetchJsonSafe<YtChannel | YtGate>(`/api/yt/channel/${encodeURIComponent(id)}`)
      .then((body) => {
        if (body && "gated" in body) {
          setChannelData(null);
          setChannelGate(body.message);
        } else {
          setChannelData(body);
          body.videos.concat(body.shorts).forEach(remember);
        }
      })
      .catch((e: Error) => setChannelGate(e.message || "the channel didn't load"))
      .finally(() => setChannelLoading(false));
  }, [remember]);

  const closeChannel = React.useCallback(() => {
    setChannelView(null);
    setChannelData(null);
    setChannelGate(null);
  }, []);

  /* ---- page navigation (right rail / mobile pills) — lives further
   * down, after the subs + playlist state it lazy-loads ---- */

  /* ---- gate-independent /next meta (likes + related) for the relay
   * lane — a gated video still gets real counts + recommendations ---- */
  const [videoMeta, setVideoMeta] = React.useState<{ likes: number; dislikes: number; description: string; related: YtCard[] } | null>(null);

  /* ---- playlists — per-device lists + the marathon context ----
   * (declared before watch() — the callback clears the marathon on a
   * manual pick; playFromPlaylist sets the fresh context after) */
  const [playlistView, setPlaylistView] = React.useState<string | null>(null);
  const [marathon, setMarathon] = React.useState<{ plId: string; index: number } | null>(null);
  const marathonRef = React.useRef<{ plId: string; index: number } | null>(null);
  React.useEffect(() => {
    marathonRef.current = marathon;
  }, [marathon]);

  /* ---- watch ---- */
  const watch = React.useCallback(
    (id: string, card?: YtCard | null) => {
      const initial = card ?? cardsById.current.get(id) ?? null;
      if (initial) {
        cardsById.current.set(id, initial);
        pushHistory(initial);
      }
      setGateRounds(0);
      setGateSince(null);
      setRelayEngaged(false);
      setVideoMeta(null);
      setWatchCard(initial);
      setWatchId(id);
      setVideo(null);
      setVideoLoading(true);
      /* a manual pick ends any running marathon (playFromPlaylist sets
       * the new context AFTER this — the last write wins) */
      setMarathon(null);
    },
    [pushHistory],
  );

  /* ---- subscriptions page — the channels this device follows ---- */
  const [subsCards, setSubsCards] = React.useState<YtCard[] | null>(null);
  const [subsLoading, setSubsLoading] = React.useState(false);
  const [subsError, setSubsError] = React.useState<string | null>(null);
  /* the infinite river — per-channel continuation cursors (the client
   * owns the paging state; the server stays stateless) + round state */
  const subsCursorRef = React.useRef<Record<string, string>>({});
  const [subsMoreLoading, setSubsMoreLoading] = React.useState(false);
  const [subsHasMore, setSubsHasMore] = React.useState(false);
  const subsV = useSubsVersion();

  const loadSubs = React.useCallback(() => {
    const ids = Object.keys(readSubs());
    if (ids.length === 0) {
      setSubsCards([]);
      setSubsError(null);
      setSubsHasMore(false);
      subsCursorRef.current = {};
      return;
    }
    setSubsLoading(true);
    setSubsError(null);
    subsCursorRef.current = {}; /* fresh river */
    fetchJsonSafe<{ cards?: YtCard[]; next?: Record<string, string> } | YtGate>("/api/yt/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "subs", ids, cursors: {} }),
    })
      .then((body) => {
        if (body && !Array.isArray(body) && "cards" in body && Array.isArray(body.cards)) {
          const batch: YtCard[] = body.cards;
          const nextCursors: Record<string, string> = body.next ?? {};
          batch.forEach(remember);
          setSubsCards(batch);
          subsCursorRef.current = nextCursors;
          setSubsHasMore(Object.keys(nextCursors).length > 0);
        } else if (body && !Array.isArray(body) && "gated" in body) {
          setSubsCards([]);
          setSubsError((body as YtGate).message);
          setSubsHasMore(false);
        } else {
          setSubsCards([]);
          setSubsError("the subscriptions feed came back in an unexpected shape — try a reload");
          setSubsHasMore(false);
        }
      })
      .catch((e: Error) => {
        setSubsError(e.message || "the subscriptions feed didn't load");
        setSubsHasMore(false);
      })
      .finally(() => setSubsLoading(false));
  }, [remember]);

  /** Infinite river — one deeper round: the next ~6 uploads of every
   * followed channel that still has pages, appended oldest-last. */
  const loadMoreSubs = React.useCallback(() => {
    const ids = Object.keys(readSubs());
    const cursors = subsCursorRef.current;
    if (ids.length === 0 || Object.keys(cursors).length === 0 || subsMoreLoading) return;
    setSubsMoreLoading(true);
    fetchJsonSafe<{ cards?: YtCard[]; next?: Record<string, string> } | YtGate>("/api/yt/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "subs", ids, cursors }),
    })
      .then((body) => {
        if (body && !Array.isArray(body) && "cards" in body && Array.isArray(body.cards)) {
          const batch: YtCard[] = body.cards;
          const nextCursors: Record<string, string> = body.next ?? {};
          batch.forEach(remember);
          setSubsCards((prev) => {
            if (!prev) return batch;
            /* append + dedupe (a video can straddle two rounds) */
            const seen = new Set(prev.map((c) => c.id));
            return [...prev, ...batch.filter((c) => !seen.has(c.id))];
          });
          subsCursorRef.current = nextCursors;
          setSubsHasMore(Object.keys(nextCursors).length > 0);
        } else {
          /* a gate/shape issue ends the river gracefully */
          setSubsHasMore(false);
        }
      })
      .catch(() => {
        setSubsHasMore(false); /* stop hammering a dead upstream */
      })
      .finally(() => setSubsMoreLoading(false));
  }, [remember, subsMoreLoading]);

  React.useEffect(() => {
    /* the follow list changed (subscribe/unsubscribe anywhere) — drop
     * the cached subs feed so the next visit re-blends */
    setSubsCards(null);
    setSubsHasMore(false);
    subsCursorRef.current = {};
  }, [subsV]);


  /** Start (or continue) a marathon from a playlist index. */
  const playFromPlaylist = React.useCallback(
    (plId: string, index: number) => {
      const pl = readPlaylists().find((p) => p.id === plId);
      const card = pl?.items[index];
      if (!pl || !card) return;
      watch(card.id, card); /* watch() clears the marathon — set after */
      setMarathon({ plId, index });
    },
    [watch],
  );

  /** Advance the marathon (manual Next or ended video). */
  const advanceMarathon = React.useCallback(() => {
    const m = marathonRef.current;
    if (!m) return;
    const pl = readPlaylists().find((p) => p.id === m.plId);
    const next = pl?.items[m.index + 1];
    if (!pl || !next) {
      setMarathon(null);
      return;
    }
    watch(next.id, next);
    setMarathon({ plId: m.plId, index: m.index + 1 });
  }, [watch]);

  /* ---- page navigation (right rail / mobile pills) — after the subs +
   * playlist state, which the lazy-load closures reference ---- */
  const goPage = React.useCallback(
    (p: PageKey) => {
      setPage(p);
      /* leave the search context */
      setQuery("");
      setSubmitted(null);
      setResults(null);
      setSearchGate(null);
      /* leave an open channel view */
      setChannelView(null);
      setChannelData(null);
      setChannelGate(null);
      /* leave an open playlist detail */
      setPlaylistView(null);
      /* lazy-load the page's data on first visit */
      if (p === "popular" && popular === null && !popularLoading) loadPopular();
      if (p === "shorts" && shorts === null && !shortsLoading) loadShorts();
      if (p === "subs" && subsCards === null && !subsLoading) loadSubs();
    },
    [popular, popularLoading, shorts, shortsLoading, subsCards, subsLoading, loadPopular, loadShorts, loadSubs],
  );
  React.useEffect(() => {
    if (!watchId) return;
    const relayLane = !video || "gated" in video || video.formats.length === 0;
    if (!relayLane) return;
    let live = true;
    fetchJsonSafe<{ likes: number; dislikes: number; description: string; related: YtCard[] }>(
      `/api/yt/video/${encodeURIComponent(watchId)}?meta=1`,
    )
      .then((m) => {
        if (live) setVideoMeta(m);
        m?.related?.forEach(remember);
      })
      .catch(() => {
        /* meta is a nicety — the relay lane works without it */
      });
    return () => {
      live = false;
    };
  }, [watchId, video, remember]);

  const loadVideo = React.useCallback((id: string) => {
    setVideoLoading(true);
    /* quick lane — the first probe answers within a bounded budget while
     * the full extraction keeps warming in the background; the gate
     * panel's auto-retry then lands on the warmed body */
    fetchJsonSafe<VideoAnswer>(`/api/yt/video/${encodeURIComponent(id)}?quick=1`)
      .then((body) => {
        setVideo(body);
        /* the watch answer carries the channel's REAL avatar — park it
         * in the store so related cards + every other mention of the
         * channel show the actual logo, zero extra requests */
        if (body && !("gated" in body) && body.card?.authorId && body.authorAvatar) {
          avatarStore.put({ [body.card.authorId]: body.authorAvatar });
        }
        setGateSince("gated" in body && body.gated ? (prev) => prev ?? Date.now() : null);
      })
      .catch((e: Error) => {
        setVideo({ gated: true, message: e.message || "the video didn't load — the source may be rotating" });
        setGateSince((prev) => prev ?? Date.now());
      })
      .finally(() => setVideoLoading(false));
  }, []);

  React.useEffect(() => {
    if (watchId) loadVideo(watchId);
  }, [watchId, loadVideo]);

  /* ── SELF-HEAL: the stream broke mid-session (stale signatures 403ing)
   * ── force a FRESH extraction on the service (it rides the gate flap:
   * innertube multi-round + byte-probed piped pass) and hot-swap the
   * video body. The player re-picks its format on the new object and
   * resumes at the captured timestamp. Budget: 2 auto-heals per video id
   * (the flap may close between them), re-armed by a manual retry. */
  const [healing, setHealing] = React.useState(false);
  const healBudgetRef = React.useRef<Record<string, number>>({});
  const healStream = React.useCallback(() => {
    if (!watchId || healing) return;
    const used = healBudgetRef.current[watchId] ?? 0;
    if (used >= 2) return;
    healBudgetRef.current[watchId] = used + 1;
    setHealing(true);
    fetchJsonSafe<YtVideo>(`/api/yt/video/${encodeURIComponent(watchId)}/refresh`)
      .then((body) => {
        /* a playable answer — hot-swap; the player's format-pick effect
         * re-runs on the new object (setFatal(null) included) and the
         * teardown/apply pair preserves the timestamp */
        if (body && !("gated" in body) && Array.isArray(body.formats) && body.formats.length > 0) {
          setVideo(body);
          if (body.card?.authorId && body.authorAvatar) {
            avatarStore.put({ [body.card.authorId]: body.authorAvatar });
          }
          return;
        }
        /* unexpected shape — treat as a gate */
        setVideo({ gated: true, message: "the refresh came back in an unexpected shape — auto-retrying" });
      })
      .catch((e: Error) => {
        /* the arc stayed gated — hand the watch to the GATE machinery:
         * the GatePanel auto-retry, the relay player offer and the
         * service's background queue take it from here (no dead-URL loop) */
        setVideo({
          gated: true,
          message:
            (e as { message?: string })?.message ||
            "the stream bytes are still gated upstream — auto-retrying; the relay player can play it now",
        });
        setGateSince((prev) => prev ?? Date.now());
      })
      .finally(() => setHealing(false));
  }, [watchId, healing]);

  /* manual "Try again now" — resets the eager-retry budget + clock */
  const retryWatch = React.useCallback(() => {
    if (!watchId) return;
    setGateRounds(0);
    setGateSince(Date.now());
    healBudgetRef.current = {}; // a manual retry re-arms the self-heal
    loadVideo(watchId);
  }, [watchId, loadVideo]);

  /* auto-retry a gated video — eager (15s) for the first 8 rounds while
   * the watch view is open, then a patient every-minute probe. No hard
   * cap: the gate rotates on minute-to-hour scales and the panel heals
   * itself the moment a retry lands a real body. Unmounting the watch
   * view (Browse / another video) cancels it naturally. */
  React.useEffect(() => {
    if (!watchId || !video || !("gated" in video)) return;
    const waitMs = gateRounds < 8 ? 15_000 : 60_000;
    const t = setTimeout(() => {
      setGateRounds((r) => r + 1);
      loadVideo(watchId);
    }, waitMs);
    return () => clearTimeout(t);
  }, [watchId, video, loadVideo, gateRounds]);

  /* the grid's card source — search results when searching, else the
   * server blend. Negative feedback filters BOTH (hidden videos +
   * blocked channels never render; the For You slice additionally
   * re-ranks through rankFeed). */
  const shownCards = React.useMemo(
    () => filterFeedback(results ?? feed ?? []),
    [results, feed, niVersion],
  );
  /* the shorts rails — filtered the same way (a blocked channel must
   * vanish from every recommendation surface, not just the grid) */
  const shortsShown = React.useMemo(
    () => filterFeedback(shorts ?? []),
    [shorts, niVersion],
  );

  /* ── lane selection ──
   * Native lane: the veil's own extraction (formats riding /api/yt/s).
   * Relay lane: engaged when the answer is gated OR stripped of formats,
   * and STAYS engaged for the watch once chosen (a background heal offers
   * "Play natively" instead of interrupting). */
  const relayNeeded = Boolean(video && ("gated" in video || video.formats.length === 0));
  const useRelay = relayEngaged || relayNeeded;
  const relayHealed = relayEngaged && !relayNeeded; // native body landed mid-relay

  /* ---- "Up next" — the watch page's related rail. YouTube keeps it
   * BESIDE the player (a sticky right column on wide screens, a grid
   * under the video everywhere else). The relay + gate surfaces keep
   * their own inline rails, so this feeds the native watch only. */
  const upNext = React.useMemo(() => {
    if (!watchId || useRelay) return [];
    if (video && "related" in video && video.related.length > 0) return video.related.slice(0, 12);
    const fallback = shownCards.filter((c) => c.id !== watchId).slice(0, 12);
    if (fallback.length > 0) return fallback;
    return videoMeta && videoMeta.related.length > 0 ? videoMeta.related.slice(0, 12) : [];
  }, [watchId, useRelay, video, videoMeta, shownCards]);

  /* latch: the moment a watch needs the relay it stays on it — a later
   * background heal flips relayHealed (the "Play natively" offer) instead
   * of yanking the user out of a playing video. */
  React.useEffect(() => {
    if (relayNeeded) setRelayEngaged(true);
  }, [relayNeeded]);

  return (
    <CardFeedbackCtx.Provider value={feedbackActions}>
    <div className="flex h-full w-full flex-col text-zinc-100">
      {/* Header — YouTube-style: logo left, centered search, actions right.
          On mobile the search folds to its own row under the brand row. */}
      <header className="shrink-0 border-b border-zinc-800/80 px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1500px] items-center gap-3 sm:gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={watchId ? () => setWatchId(null) : channelView ? closeChannel : onBack}
            aria-label={watchId ? "Back to browsing" : channelView ? "Back from the channel" : "Back to the start page"}
            className="veil-hover-bounce h-9 shrink-0 gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <ArrowLeft aria-hidden className="size-4" />
            <span className="hidden sm:inline">{watchId ? "Browse" : "Back"}</span>
          </Button>
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30">
              <MonitorPlay aria-hidden className="size-4.5 text-rose-400" />
            </span>
            <h2 className="veil-text-shine truncate text-[17px] font-semibold tracking-tight">
              Veil Stream<span className="text-rose-400">.</span>
            </h2>
          </div>

          {/* Search — always available (desktop, centered like youtube.com) */}
          <form onSubmit={submit} role="search" className="mx-auto hidden min-w-0 max-w-2xl flex-1 items-center gap-2 sm:flex">
            <div className="group relative min-w-0 flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500 transition group-focus-within:text-rose-400"
              />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchGate(null);
                }}
                placeholder="Search YouTube…"
                aria-label="Search YouTube"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                className="veil-focus-bloom h-10 rounded-full border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-[14px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/60 focus-visible:ring-rose-500/25"
              />
            </div>
            <button
              type="submit"
              disabled={searching || !query.trim()}
              aria-label="Search"
              className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-800/60 px-4 text-[13.5px] font-semibold text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-800 disabled:opacity-50"
            >
              {searching ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                <Search aria-hidden className="size-4" />
              )}
            </button>
            {submitted && (
              <Button
                type="button"
                variant="ghost"
                onClick={clearSearch}
                className="h-10 shrink-0 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 text-[12.5px] text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800"
              >
                Clear
              </Button>
            )}
          </form>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
            <OfflineDownload variant="pill" />
            <StreamDataMenu />
          </div>
        </div>

        {/* Search (mobile — its own row under the brand row) */}
        <form onSubmit={submit} role="search" className="mx-auto mt-3 flex w-full max-w-[1500px] items-center gap-2 sm:hidden">
          <div className="group relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500 transition group-focus-within:text-rose-400"
            />
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchGate(null);
              }}
              placeholder="Search YouTube…"
              aria-label="Search YouTube"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              className="h-10 rounded-full border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-[14px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-rose-500/60 focus-visible:ring-rose-500/25"
            />
          </div>
          <button
            type="submit"
            disabled={searching || !query.trim()}
            aria-label="Search"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-rose-500 px-4 text-[13.5px] font-semibold text-rose-950 shadow-lg shadow-rose-500/25 transition hover:bg-rose-400 disabled:opacity-50"
          >
            {searching ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Search aria-hidden className="size-4" />
            )}
          </button>
          {submitted && (
            <Button
              type="button"
              variant="ghost"
              onClick={clearSearch}
              className="h-10 shrink-0 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 text-[12.5px] text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800"
            >
              Clear
            </Button>
          )}
        </form>
        {searchGate && !searching && (
          <p className="mx-auto mt-2 w-full max-w-[1500px] text-[12px] text-amber-300/90" role="alert">
            {searchGate}
          </p>
        )}
      </header>

      {/* Body */}
      <div className="veil-scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-6 sm:px-6">
        {watchId ? (
          /* ── watch view (takes precedence — a video opened from a channel
           * plays over it, and "back" returns to the channel). YouTube's
           * layout: the player column owns the page and "Up next" rides a
           * sticky rail beside it on wide screens ── */
          <div className="mx-auto w-full max-w-6xl xl:max-w-[1440px]">
            {/* marathon strip — a playlist is playing */}
            {marathon && (() => {
              const pl = readPlaylists().find((p) => p.id === marathon.plId);
              if (!pl) return null;
              const hasNext = marathon.index + 1 < pl.items.length;
              return (
                <div className="mb-3 flex flex-wrap items-center gap-2.5 rounded-2xl border border-violet-500/25 bg-violet-500/[0.07] px-3.5 py-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30">
                    <ListVideo aria-hidden className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-300">
                    Playing from <span className="font-semibold text-violet-200">{pl.name}</span>
                    <span className="mx-1.5 text-zinc-600">·</span>
                    <span className="tabular-nums text-zinc-400">{marathon.index + 1} / {pl.items.length}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={advanceMarathon}
                    disabled={!hasNext}
                    className="h-8 shrink-0 gap-1.5 rounded-xl border-violet-500/30 text-violet-200 hover:border-violet-400 hover:text-violet-100"
                  >
                    <SkipForward aria-hidden className="size-3.5" /> Next
                  </Button>
                </div>
              );
            })()}
            <div className="flex items-start gap-6">
              <motion.div
                className="min-w-0 flex-1"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
              {videoLoading && !video ? (
                <div>
                  <div className="aspect-video w-full animate-pulse rounded-2xl bg-zinc-800/60" />
                  <div className="mt-4 space-y-2">
                    <div className="h-5 w-3/4 animate-pulse rounded bg-zinc-800/60" />
                    <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-800/40" />
                  </div>
                </div>
              ) : useRelay && watchCard ? (
                <RelayPlayer
                  card={watchCard}
                  gateMessage={"gated" in (video as YtGate) ? (video as YtGate).message : "the gate handed this video over without a playable stream — retrying in the background"}
                  healed={relayHealed}
                  likes={videoMeta?.likes ?? 0}
                  dislikes={videoMeta?.dislikes ?? 0}
                  description={videoMeta?.description || undefined}
                  onTryNative={() => setRelayEngaged(false)}
                  onWatch={watch}
                  onChannel={openChannel}
                  onEnded={advanceMarathon}
                  more={(
                    videoMeta && videoMeta.related.length > 0
                      ? videoMeta.related
                      : shownCards.filter((c) => c.id !== watchId)
                  ).slice(0, 12)}
                />
              ) : video && "gated" in video ? (
                <GatePanel
                  message={video.message}
                  onRetry={retryWatch}
                  since={gateSince}
                  rounds={gateRounds}
                  more={shownCards.filter((c) => c.id !== watchId).slice(0, 12)}
                  onPick={(id, card) => watch(id, card)}
                />
              ) : video ? (
                <StreamPlayer
                  initialCard={watchCard}
                  video={video}
                  onWatch={watch}
                  onChannel={openChannel}
                  onEnded={advanceMarathon}
                  healing={healing}
                  onStreamError={healStream}
                />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/50 text-zinc-500">
                  pick a video
                </div>
              )}
                {/* Up next — under the player on narrow screens; the sticky
                    rail beside it takes over at xl */}
                {upNext.length > 0 && (
                  <section aria-label="Up next" className="mt-8 xl:hidden">
                    <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-wider text-zinc-500">Up next</h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {upNext.map((c, i) => (
                        <RelatedCard
                          key={`${c.id}-${i}`}
                          card={c}
                          index={i}
                          onWatch={(id, card) => watch(id, card)}
                          onChannel={openChannel}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </motion.div>
              {upNext.length > 0 && (
                <aside aria-label="Up next" className="hidden w-[402px] shrink-0 xl:block">
                  <div className="veil-scroll-slim sticky top-1 max-h-[calc(100vh-5rem)] overflow-y-auto pb-8 pr-1">
                    <h3 className="mb-3 pt-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-500">Up next</h3>
                    <div className="flex flex-col gap-1.5">
                      {upNext.map((c, i) => (
                        <RelatedCard
                          key={`rail-${c.id}-${i}`}
                          card={c}
                          index={i}
                          onWatch={(id, card) => watch(id, card)}
                          onChannel={openChannel}
                        />
                      ))}
                    </div>
                  </div>
                </aside>
              )}
            </div>
          </div>
        ) : channelView ? (
          /* ── channel view ── */
          <div className="mx-auto w-full max-w-6xl">
            {channelLoading && !channelData ? (
              <div>
                <div className="flex flex-col gap-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5 sm:flex-row sm:items-center sm:p-6">
                  <div className="size-20 shrink-0 animate-pulse rounded-full bg-zinc-800/70 sm:size-24" />
                  <div className="flex-1 space-y-2.5">
                    <div className="h-5 w-1/3 animate-pulse rounded bg-zinc-800/70" />
                    <div className="h-3.5 w-1/4 animate-pulse rounded bg-zinc-800/50" />
                    <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-800/40" />
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  <CardSkeletons n={8} />
                </div>
              </div>
            ) : channelData ? (
              <ChannelPanel
                key={channelData.id}
                channel={channelData}
                onWatch={watch}
                onChannel={openChannel}
                onOpenShort={(card) => openShorts(channelData.shorts, card, channelData.name)}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-zinc-800/80">
                  <Users aria-hidden className="size-6 text-zinc-500" />
                </span>
                <p className="max-w-sm text-[13.5px] text-zinc-400">
                  {channelGate ?? "this channel didn't come back — try again in a moment"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openChannel(channelView.id, channelView.name)}
                  className="h-8 rounded-xl border-zinc-700"
                >
                  <RefreshCw aria-hidden className="size-3.5" /> Retry
                </Button>
              </div>
            )}
          </div>
        ) : (
          /* ── browse view — For You main page + Shorts / Popular on the right rail ── */
          <div className="mx-auto w-full max-w-[1500px]">
            {/* mobile page pills — the right rail folds into a sticky pill bar */}
            <nav
              aria-label="Stream pages"
              className="sticky -top-6 z-20 -mx-4 mb-4 border-b border-zinc-800/70 bg-zinc-950/90 px-4 py-2.5 backdrop-blur-md sm:-mx-6 sm:px-6 lg:hidden"
            >
              <div className="veil-scroll-slim flex gap-2 overflow-x-auto">
                {PAGE_NAV.map((item) => {
                  const active = page === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => goPage(item.key)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-semibold transition active:scale-[0.97]",
                        active
                          ? "bg-rose-500 text-rose-950 shadow-lg shadow-rose-500/25"
                          : "border border-zinc-800 bg-zinc-900/70 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100",
                      )}
                    >
                      <item.icon aria-hidden className="size-3.5" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </nav>

            <div className="flex gap-6">
              {/* ── left sidebar — page navigation (desktop, YouTube-style) ── */}
              {/* -top-6 compensates the scroll container's pt-6 so the rail
               * pins flush with the top of the scroll area */}
              <aside aria-label="Stream pages" className="sticky -top-6 hidden h-fit w-56 shrink-0 lg:block">
                <nav className="flex flex-col gap-0.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-2">
                  <p className="px-3 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600">Pages</p>
                  {PAGE_NAV.map((item) => {
                    const active = page === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => goPage(item.key)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group flex items-center gap-4 rounded-xl px-3 py-2.5 text-left outline-none transition active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-rose-500/40",
                          active ? "bg-zinc-800/80 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100",
                        )}
                      >
                        <item.icon
                          aria-hidden
                          className={cn(
                            "size-5 shrink-0 transition",
                            active ? PAGE_TONE[item.key].icon : "text-zinc-500 group-hover:text-zinc-300",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{item.label}</span>
                      </button>
                    );
                  })}
                </nav>
              </aside>

              {/* ── main column ── */}
              <div className="min-w-0 flex-1">
                <motion.div
                  key={playlistView ? `pl-${playlistView}` : submitted ? "search" : page}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22 }}
                >
                  {playlistView ? (
                    /* ── playlist detail ── */
                    <PlaylistDetail
                      plId={playlistView}
                      onBack={() => setPlaylistView(null)}
                      onPlay={playFromPlaylist}
                    />
                  ) : submitted ? (
                    /* ── search results ── */
                    <section aria-label="Search results">
                      <div className="mb-4">
                        <h3 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-500">
                          Results — “{submitted}”
                        </h3>
                      </div>
                      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                        {searching && !searchGate ? (
                          <CardSkeletons n={8} />
                        ) : shownCards.length > 0 ? (
                          shownCards.map((c, i) => (
                            <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => watch(id, card)} onChannel={openChannel} />
                          ))
                        ) : (
                          <div className="col-span-full flex flex-col items-center gap-3 py-16 text-center">
                            <span className="flex size-12 items-center justify-center rounded-2xl bg-zinc-800/80">
                              <Clapperboard aria-hidden className="size-6 text-zinc-500" />
                            </span>
                            <p className="text-[13.5px] text-zinc-400">
                              {searchGate ?? "Nothing matched — try a different query."}
                            </p>
                            <Button size="sm" variant="outline" onClick={clearSearch} className="h-8 rounded-xl border-zinc-700">
                              Clear search
                            </Button>
                          </div>
                        )}
                      </div>
                    </section>
                  ) : page === "foryou" ? (
                    /* ── For You — the main page: filter chips + card rows with shorts rails ── */
                    <section aria-label="For you feed">
                      <PageHeader
                        icon={Sparkles}
                        tone="foryou"
                        title="For you"
                        badge={fyAll.length > 0 ? `${fyAll.length} videos${fyHasMore ? "+" : ""}` : undefined}
                        onReload={() => loadFeed(true)}
                        reloading={feedLoading}
                      />
                      {/* filter chips — the YouTube-home row of feed slices.
                          Sticky at the top of the scroll area on desktop. */}
                      {fyChipsVisible && (
                        <div
                          role="group"
                          aria-label="Filter the For You feed"
                          className="veil-scroll-slim -mx-1 mb-5 flex gap-2.5 overflow-x-auto px-1 pb-1 lg:sticky lg:-top-6 lg:z-10 lg:-mx-6 lg:border-b lg:border-zinc-800/70 lg:bg-zinc-950/90 lg:px-6 lg:py-2.5 lg:backdrop-blur-md"
                        >
                          {FY_CHIPS.map((chip) => {
                            const active = fyFilter === chip.key;
                            const count = fyChipCounts[chip.key];
                            return (
                              <button
                                key={chip.key}
                                type="button"
                                onClick={() => setFyFilter(chip.key)}
                                aria-pressed={active}
                                title={count > 0 ? `${chip.label} — ${count} ${chip.key === "watched" ? "in your history" : "on screen"}` : chip.label}
                                className={cn(
                                  "veil-press veil-hover-glow flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition active:scale-[0.97]",
                                  active
                                    ? "bg-zinc-100 text-zinc-900"
                                    : "bg-zinc-800/70 text-zinc-300 ring-1 ring-zinc-700/50 hover:bg-zinc-800 hover:text-zinc-100",
                                )}
                              >
                                {chip.label}
                                {count > 0 && (
                                  <span
                                    aria-hidden
                                    className={cn(
                                      "rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums",
                                      active
                                        ? "bg-zinc-900/10 text-zinc-600"
                                        : "bg-zinc-950/70 text-zinc-400 ring-1 ring-zinc-700/40",
                                    )}
                                  >
                                    {count}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {/* watch again — the re-watch rail (history-backed;
                          hidden while a chip slices the feed, since slices
                          are for finding new things — the Watched slice IS
                          the full list already) */}
                      {fyFilter === "all" && (histEntries?.length ?? 0) > 0 && (
                        <WatchAgainRail
                          entries={histEntries ?? []}
                          paused={histPaused}
                          onWatch={(id, card) => watch(id, card)}
                          onOpenHistory={() => setPage("history")}
                        />
                      )}
                      {feedLoading && !feedError ? (
                        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                          <CardSkeletons n={8} />
                        </div>
                      ) : feedError ? (
                        <FeedEmptyState message={feedError} onRetry={loadFeed} retryLabel="Reload feed" />
                      ) : (feed ?? []).length === 0 ? (
                        <FeedEmptyState message="Nothing here yet — try a search." onRetry={loadFeed} retryLabel="Reload feed" />
                      ) : fyFilter === "all" && fyFiltered.length === 0 && fyAll.length > 0 ? (
                        /* everything on screen has been watched — the feed
                           hides watched videos, so offer the next moves */
                        <FeedEmptyState
                          message="you&apos;ve watched everything on this page — the river below has more, or deal a fresh mix"
                          onRetry={() => loadFeed(true)}
                          retryLabel="Fresh mix"
                        />
                      ) : fyFilter === "all" ? (
                        <>
                          <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {fyFiltered.slice(0, 8).map((c, i) => (
                              <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => watch(id, card)} onChannel={openChannel} />
                            ))}
                          </div>
                          {shortsLoading && !shortsError ? (
                            <ShortsRailSkeleton />
                          ) : shortsShown.length > 0 ? (
                            <ShortsRail shorts={shortsShown.slice(0, 8)} onWatch={(id, card) => openShorts(shorts ?? [], card, "Shorts", true)} />
                          ) : null}
                          <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {fyFiltered.slice(8, 20).map((c, i) => (
                              <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => watch(id, card)} onChannel={openChannel} />
                            ))}
                          </div>
                          {shortsShown.length > 8 ? (
                            <ShortsRail shorts={shortsShown.slice(8, 16)} onWatch={(id, card) => openShorts(shorts ?? [], card, "Shorts", true)} />
                          ) : null}
                          <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {fyFiltered.slice(20).map((c, i) => (
                              <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => watch(id, card)} onChannel={openChannel} />
                            ))}
                          </div>
                          {/* the river's tail — more skeletons while a deep
                              round is in flight, the end mark when the
                              river is dry */}
                          {fyHasMore || fyMoreLoading ? (
                            <div
                              ref={fySentinelRef}
                              aria-live="polite"
                              className="mt-8 grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
                            >
                              <CardSkeletons n={4} />
                              <p className="col-span-full text-center text-[11.5px] text-zinc-600">
                                {fyMoreLoading ? "loading more for you…" : "keep scrolling — more from your channels and beyond"}
                              </p>
                            </div>
                          ) : fyFiltered.length > 0 ? (
                            <p className="mt-8 flex items-center justify-center gap-2 text-[12px] text-zinc-600">
                              <span className="size-1.5 rounded-full bg-zinc-700" aria-hidden />
                              that&apos;s the whole river for now — hit refresh for a fresh mix
                              <span className="size-1.5 rounded-full bg-zinc-700" aria-hidden />
                            </p>
                          ) : null}
                        </>
                      ) : fyFiltered.length === 0 ? (
                        <FeedEmptyState
                          message={`nothing in “${FY_CHIPS.find((c) => c.key === fyFilter)?.label ?? fyFilter}” right now — the feed rotates, try again or browse everything`}
                          onRetry={() => setFyFilter("all")}
                          retryLabel="Show everything"
                        />
                      ) : (
                        <>
                          {fyFilter === "watched" && (
                            <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-zinc-500">
                              <RotateCcw aria-hidden className="size-3.5 shrink-0 text-rose-400/80" />
                              <span>everything you&apos;ve watched on this device, newest first —</span>
                              <button
                                type="button"
                                onClick={() => setPage("history")}
                                className="rounded font-semibold text-rose-300 underline-offset-2 transition hover:text-rose-200 hover:underline"
                              >
                                manage in History
                              </button>
                            </p>
                          )}
                          <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {fyFiltered.map((c, i) => (
                              <VideoCard
                                key={`${c.id}-${i}`}
                                card={c}
                                index={i}
                                onWatch={(id, card) => watch(id, card)}
                                onChannel={openChannel}
                                dimWatched={fyFilter !== "watched"}
                              />
                            ))}
                          </div>
                        </>
                      )}
                    </section>
                  ) : page === "shorts" ? (
                    /* ── Shorts page ── */
                    <section aria-label="Shorts feed">
                      <PageHeader
                        icon={Zap}
                        tone="shorts"
                        title="Shorts"
                        badge={shorts && shorts.length > 0 ? `${shorts.length} shorts` : undefined}
                        onReload={() => loadShorts(true)}
                        reloading={shortsLoading}
                      />
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
                        {shortsLoading && !shortsError ? (
                          <ShortSkeletons n={10} />
                        ) : shortsError ? (
                          <div className="col-span-full">
                            <FeedEmptyState message={shortsError} onRetry={loadShorts} retryLabel="Reload shorts" />
                          </div>
                        ) : (shorts ?? []).length > 0 ? (
                          (shorts ?? []).map((c, i) => (
                            <ShortCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => openShorts(shorts ?? [], card, "Shorts", true)} />
                          ))
                        ) : (
                          <div className="col-span-full">
                            <FeedEmptyState message="no shorts came back — try a reload" onRetry={loadShorts} retryLabel="Reload shorts" />
                          </div>
                        )}
                      </div>
                    </section>
                  ) : page === "subs" ? (
                    /* ── Subscriptions — the infinite river from the channels you follow ── */
                    <SubsPage
                      cards={subsCards}
                      loading={subsLoading}
                      error={subsError}
                      histEntries={histEntries}
                      onReload={loadSubs}
                      onWatch={(id, card) => watch(id, card)}
                      onChannel={openChannel}
                      onLoadMore={loadMoreSubs}
                      moreLoading={subsMoreLoading}
                      hasMore={subsHasMore}
                    />
                  ) : page === "playlists" ? (
                    /* ── Playlists — Watch Later + named lists ── */
                    <PlaylistsPage onOpen={(plId) => setPlaylistView(plId)} />
                  ) : page === "history" ? (
                    /* ── History page — per device ── */
                    <section aria-label="Watch history">
                      <PageHeader
                        icon={HistoryIcon}
                        tone="history"
                        title="History"
                        badge={
                          histEntries && histEntries.length > 0
                            ? `${histEntries.length} watched${histPaused ? " · paused" : ""}`
                            : histPaused
                              ? "paused"
                              : undefined
                        }
                        onReload={() => setHistEntries(readHistory())}
                        actions={
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setHistoryPaused(!histPaused)}
                              aria-pressed={histPaused}
                              aria-label={histPaused ? "Resume recording watch history" : "Pause watch history"}
                              title={
                                histPaused
                                  ? "Resume recording — future views land in history again and the feed resumes hiding what you watch"
                                  : "Pause — while off the record, watching stores nothing and the For You feed stops hiding what you watch"
                              }
                              className={cn(
                                "h-8 shrink-0 rounded-xl border-zinc-700",
                                histPaused
                                  ? "border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15"
                                  : "text-zinc-400 hover:border-amber-500/40 hover:text-amber-300",
                              )}
                            >
                              {histPaused ? (
                                <CirclePlay aria-hidden className="size-3.5" />
                              ) : (
                                <CirclePause aria-hidden className="size-3.5" />
                              )}
                              {histPaused ? "Resume" : "Pause"}
                            </Button>
                            {(histEntries?.length ?? 0) > 0 ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={clearHistory}
                                aria-label="Clear watch history"
                                className="h-8 shrink-0 rounded-xl border-zinc-700 text-zinc-400 hover:border-rose-500/40 hover:text-rose-300"
                              >
                                <Trash2 aria-hidden className="size-3.5" /> Clear
                              </Button>
                            ) : null}
                          </>
                        }
                      />
                      {histEntries === null ? (
                        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                          <CardSkeletons n={8} />
                        </div>
                      ) : histEntries.length === 0 ? (
                        <FeedEmptyState
                          message="nothing watched yet — videos and shorts you open land here, kept on this device only"
                          onRetry={() => setHistEntries(readHistory())}
                          retryLabel="Refresh"
                        />
                      ) : (
                        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                          {histEntries.slice(0, histShown).map((h, i) => (
                            <div key={`${h.card.id}-${h.at}`} className="group/hist relative">
                              <VideoCard
                                card={h.card}
                                index={i}
                                onWatch={(id, card) => watch(id, card)}
                                onChannel={openChannel}
                                dimWatched={false}
                              />
                              <button
                                type="button"
                                aria-label={`Remove ${h.card.title} from history`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeHistory(h.card.id);
                                  setFeedbackNote({
                                    text: "Removed from watch history",
                                    sub: h.card.title,
                                    undo: () => restoreHistory(h),
                                  });
                                }}
                                className="absolute right-2.5 top-2.5 z-10 flex size-7 items-center justify-center rounded-full bg-black/75 text-zinc-300 opacity-0 backdrop-blur-sm transition hover:bg-rose-500 hover:text-rose-950 focus-visible:opacity-100 group-hover/hist:opacity-100"
                              >
                                <X aria-hidden className="size-3.5" />
                              </button>
                            </div>
                          ))}
                          {/* the incremental-reveal sentinel — auto-loads the
                              next page of history as it scrolls into view */}
                          {histShown < histEntries.length && (
                            <HistorySentinel
                              shown={Math.min(histShown, histEntries.length)}
                              total={histEntries.length}
                              onVisible={() => setHistShown((n) => n + HIST_PAGE)}
                            />
                          )}
                        </div>
                      )}
                    </section>
                  ) : (
                    /* ── Popular page ── */
                    <section aria-label="Popular feed">
                      <PageHeader
                        icon={Flame}
                        tone="popular"
                        title="Popular"
                        badge={popular && popular.length > 0 ? `${popular.length} videos` : undefined}
                        onReload={loadPopular}
                        reloading={popularLoading}
                      />
                      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                        {popularLoading && !popularError ? (
                          <CardSkeletons n={8} />
                        ) : popularError ? (
                          <div className="col-span-full">
                            <FeedEmptyState message={popularError} onRetry={loadPopular} retryLabel="Reload popular" />
                          </div>
                        ) : (popular ?? []).length > 0 ? (
                          (popular ?? []).map((c, i) => (
                            <VideoCard key={`${c.id}-${i}`} card={c} index={i} onWatch={(id, card) => watch(id, card)} onChannel={openChannel} />
                          ))
                        ) : (
                          <div className="col-span-full">
                            <FeedEmptyState message="the popular shelf came back empty — try a reload" onRetry={loadPopular} retryLabel="Reload popular" />
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                </motion.div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── shorts viewer — vertical, one short per screen, scroll to move ── */}
      <AnimatePresence>
        {shortsView && (
          <ShortsViewer
            list={shortsView.list}
            startId={shortsView.startId}
            label={shortsView.label}
            onClose={() => setShortsView(null)}
            onChannel={(id, name) => {
              setShortsView(null);
              openChannel(id, name);
            }}
            onOpenVideo={(card) => {
              setShortsView(null);
              watch(card.id, card);
            }}
            onWatched={pushHistory}
            onNeedMore={shortsView.infinite ? needMoreShorts : undefined}
          />
        )}
      </AnimatePresence>

      {/* negative-feedback snackbar — "Video removed · Undo" */}
      <FeedbackSnackbar note={feedbackNote} onDismiss={() => setFeedbackNote(null)} />
    </div>
    </CardFeedbackCtx.Provider>
  );
}
