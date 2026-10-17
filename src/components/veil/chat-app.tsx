"use client"

/**
 * Veil Chat — Discord-style chat app for the Veil start page.
 *
 * Real-time messaging over socket.io (port 3004 via the gateway), persistent
 * messages/coins/blackjack/shop via the Next.js API routes, and a host of
 * auxiliary features (shop, profile, extensions, mod panel, mini-games,
 * music bar, player list, pinned messages, search, notifications, DMs).
 *
 * The backdrop is the applied Veil wallpaper with a plain dim scrim —
 * no blur (user-specified). See ChatWallpaperBackdrop.
 *
 * The "Veil" operator account (username == "Veil") is automatically
 * granted super-admin powers (ip_ban, add_mod, remove_mod, create_mod).
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react"
import { io, type Socket } from "socket.io-client"
import { AnimatePresence, motion } from "framer-motion"
import { purgeFatCookies } from "@/lib/veil/cookie-hygiene"
import {
  ArrowLeft,
  Hash,
  Send,
  Users,
  Plus,
  Settings,
  MessageCircle,
  Loader2,
  Shield,
  ShieldCheck,
  Ban,
  MicOff,
  Trash2,
  X,
  UserPlus,
  LogOut,
  Search,
  Circle,
  Camera,
  Paperclip,
  File as FileIcon,
  Download,
  Power,
  Pin,
  Bell,
  Smile,
  Clock,
  Gift,
  Reply,
  Coins,
  Music,
  ShoppingBag,
  User,
  Puzzle,
  Siren,
  EyeOff,
  ShieldOff,
  Moon,
  SpellCheck,
  KeyRound,
  QrCode,
  Type,
  Volume2,
  Languages,
  Eye,
  ChevronDown,
  ChevronUp,
  History,
  DatabaseBackup,
  Copy,
  Check,
  ExternalLink,
  RotateCcw,
  CloudOff,
  Pencil,
  SmilePlus,
  Heart,
  UsersRound,
  Dices,
} from "lucide-react"

import { BackdropVideo } from "@/components/veil/backdrop-video"
import {
  THEME_GRADIENTS,
  loadWallpaperSelection,
  type WallpaperSelection,
} from "@/lib/veil/wallpapers"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatRole = "member" | "moderator" | "admin"

type ChatAccount = {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  bio: string
  role: ChatRole
  muted: boolean
  banned: boolean
  banReason: string | null
  ipBanned: boolean
  coins: number
  tag: string | null
  tagColor: string | null
  pfpAccessory: string | null
  /** restored-from-backup placeholder — name is free to re-register */
  legacy?: boolean
  createdAt: string
}

type ChatMessageAccount = {
  id: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
  role: ChatRole
  coins: number
  tag: string | null
  tagColor: string | null
  pfpAccessory: string | null
  legacy?: boolean
}

type ChatMessage = {
  id: string
  channelId: string
  content: string
  replyTo: string | null
  replyToContent: string | null
  replyToUsername: string | null
  createdAt: string
  /** set when the author edited the message (the live room carries it;
   * rendered as a small "(edited)" next to the content) */
  editedAt?: string | null
  /** emoji reaction chips — { emoji, usernames } aggregated server-side */
  reactions?: ReactionSummary[]
  account: ChatMessageAccount
}

type ReactionSummary = {
  emoji: string
  /** account ids of everyone who used this emoji — drives counts + "mine" */
  usernames: string[]
}

type PresenceUser = {
  accountId: string
  username: string
  displayName: string
  avatarColor: string
  avatarImage: string | null
}

type DM = {
  id: string
  name: string | null
  isGroup: boolean
  /* Who created the room — drives “delete it” (owner) vs “remove it
   * from your sight” (everyone else) in the Groups panel. */
  ownerId?: string | null
  createdAt: string
  members: ChatAccount[]
}

/* A pending friend request — incoming (they asked us) or outgoing (we
 * asked them). Friendships only form when the recipient accepts. */
type FriendRequestRow = {
  id: string
  user: ChatAccount
  createdAt: string
}

type ShopItem =
  | {
      id: string
      type: "tag"
      label: string
      tagText: string
      tagColor: string
      price: number
    }
  | {
      id: string
      type: "accessory"
      label: string
      accessory: string
      price: number
    }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "veil:chat-account"
const EXTENSIONS_KEY = "veil:chat-extensions"
/** Cookie mirror of the session — survives the rare environments where
 * localStorage is blocked/partitioned (sandboxed iframes, some private
 * modes), which otherwise made every reload "insta-log-out" the chat. */
const SESSION_COOKIE = "veil_chat_session"
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 // 30d — matches the token TTL

const SUPER_ADMIN_USERNAME = "Veil"

// Only #general for now — more channels can be added back later by
// extending this list (and PUBLIC_CHANNELS in api/chat-data).
const CHANNELS = [
  { id: "main", name: "general", label: "#general", desc: "General chat — say hi!", modOnly: false },
  { id: "sharelinks", name: "sharelinks", label: "#sharelinks", desc: "Drop links, sites, finds", modOnly: false },
  { id: "suggestions", name: "suggestions", label: "#suggestions", desc: "Suggest sites, features & ideas", modOnly: false },
  { id: "links", name: "links", label: "#links", desc: "Curated links — mods & owner", modOnly: true },
  { id: "announcements", name: "announcements", label: "#announcements", desc: "Official news — mods & owner", modOnly: true },
] as const

// Map of PFP accessory IDs → emoji + position. Supports both the task spec
// (crown, halo, fire, star, hat, diamond, lightning, heart) and the actual
// shop catalog (horns, glasses, headphones, partyhat, witchhat, flower).
const ACCESSORY_EMOJI: Record<
  string,
  { emoji: string; top: string; left?: string; right?: string; size: string }
> = {
  crown: { emoji: "👑", top: "-10px", left: "-4px", size: "0.9rem" },
  halo: { emoji: "😇", top: "-12px", left: "50%", size: "0.9rem" },
  fire: { emoji: "🔥", top: "-10px", right: "-4px", size: "0.9rem" },
  star: { emoji: "⭐", top: "-8px", right: "-6px", size: "0.9rem" },
  hat: { emoji: "🎩", top: "-14px", left: "0", size: "0.9rem" },
  diamond: { emoji: "💎", top: "-8px", right: "-8px", size: "0.85rem" },
  lightning: { emoji: "⚡", top: "-8px", right: "-6px", size: "0.9rem" },
  heart: { emoji: "💖", top: "-6px", right: "-4px", size: "0.85rem" },
  horns: { emoji: "😈", top: "-10px", left: "0", size: "0.9rem" },
  glasses: { emoji: "🕶️", top: "8px", left: "50%", size: "0.85rem" },
  headphones: { emoji: "🎧", top: "-10px", left: "50%", size: "0.9rem" },
  partyhat: { emoji: "🎉", top: "-10px", left: "0", size: "0.85rem" },
  witchhat: { emoji: "🧙", top: "-14px", left: "0", size: "0.9rem" },
  flower: { emoji: "🌸", top: "-6px", left: "-4px", size: "0.85rem" },
}

const EMOJI_SET = [
  "😀", "😂", "🥰", "😎", "🤔", "😴", "🤯", "🥳",
  "😭", "😡", "👍", "👎", "🙏", "👏", "🙌", "💪",
  "🔥", "✨", "💯", "🎉", "🚀", "💜", "💛", "💚",
  "🪙", "🎮", "🎲", "🎰", "🃏", "♠️", "♥️", "♦️",
  "♣️", "👑", "💎", "⚡",
]

/* The quick-reaction bar — the SAME set the server accepts (chat-reactions
 * route whitelists these, so a tampered client can't store arbitrary
 * strings). Keep both lists in sync. */
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉", "👎"]

const SPOTIFY_ARTIST_ID = "2e53aHBQdCMKWqHDuyJsjC"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVeilOperator(account: ChatAccount | null | undefined): boolean {
  return !!account && account.username.toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase()
}

function isMod(account: ChatAccount | null | undefined): boolean {
  if (!account) return false
  if (isVeilOperator(account)) return true
  return account.role === "moderator" || account.role === "admin"
}

/** Badges: the Veil operator wears "OWNER" (amber); every other account
 * with mod powers wears "MOD" (emerald). */
function roleLabel(account: { role: ChatRole; username: string }): string | null {
  if (isVeilOperator(account)) return "OWNER"
  if (isMod(account)) return "MOD"
  return null
}

function roleColor(account: { role: ChatRole; username: string }): string {
  if (isVeilOperator(account)) return "#f59e0b"
  if (isMod(account)) return "#10b981"
  return "#e5e7eb"
}

function displayName(account: { displayName: string; username: string }): string {
  return account.displayName?.trim() || account.username
}

/** RegExp.escape for the mention matcher. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Does this message text @-mention the given username (or @everyone)? */
function mentionsUser(content: string, username: string): boolean {
  if (!content) return false
  if (/(^|[^\w@])@everyone([^\w]|$)/i.test(content)) return true
  try {
    return new RegExp(
      `(^|[^\\w@])@${escapeRegExp(username)}([^\\w]|$)`,
      "i",
    ).test(content)
  } catch {
    return false
  }
}

/** Pure reaction-delta applier — shared by the optimistic toggle and the
 * live socket handler so both compute identical state shapes. */
function applyReactionDelta(
  msg: ChatMessage,
  emoji: string,
  add: boolean,
  accountId: string,
): ChatMessage {
  const list: ReactionSummary[] = (msg.reactions || []).map((r) => ({
    emoji: r.emoji,
    usernames: [...r.usernames],
  }))
  const idx = list.findIndex((r) => r.emoji === emoji)
  if (add) {
    if (idx === -1) list.push({ emoji, usernames: [accountId] })
    else if (!list[idx].usernames.includes(accountId))
      list[idx].usernames.push(accountId)
  } else if (idx !== -1) {
    list[idx].usernames = list[idx].usernames.filter((u) => u !== accountId)
    if (list[idx].usernames.length === 0) list.splice(idx, 1)
  }
  return { ...msg, reactions: list }
}

function formatTime(iso: string | number | Date): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** Local-time YYYY-MM-DD for a timestamp — day buckets for the chat dividers. */
function dayKeyOf(iso: string | number | Date): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`
}

/** Human label for a day bucket: Today / Yesterday / weekday + date. */
function dayLabelOf(iso: string | number | Date): string {
  const d = new Date(iso)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(
    [],
    sameYear
      ? { weekday: "long", month: "long", day: "numeric" }
      : { weekday: "long", year: "numeric", month: "long", day: "numeric" }
  )
}

/** Discord-style day divider with the day's message count — the rules
 * grow outward from the label, which drops in right after. */
function DayDivider({ label, count }: { label: string; count: number }) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-3 px-3" role="separator" aria-label={label}>
      <motion.div
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="h-px flex-1 origin-right bg-gradient-to-l from-white/15 to-transparent"
      />
      <motion.span
        initial={{ opacity: 0, y: -5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, delay: 0.1, ease: "easeOut" }}
        className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/45"
      >
        {label}
        <span className="font-normal normal-case tracking-normal text-white/25">({count})</span>
      </motion.span>
      <motion.div
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="h-px flex-1 origin-left bg-gradient-to-r from-white/15 to-transparent"
      />
    </div>
  )
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/** Isolated ticking clock — owns its own 1-second interval so the main
 * ChatApp tree does NOT re-render every second (a top-level setNow used
 * to re-render this whole 5000-line component 60×/minute). */
function LiveClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="hidden items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-xs text-white/70 sm:flex">
      <Clock className="h-3 w-3" />
      {formatClock(now)}
    </span>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/* ------------------------------------------------------------------ */
/* Chat motion language — the spring + pop vocabulary every animated  */
/* element in the chat shares, plus the typing-dots glyph.            */
/* ------------------------------------------------------------------ */

/** Snappy overshoot for chips, badges, buttons. */
const CHAT_POP = { type: "spring", stiffness: 520, damping: 22 } as const

/** Softer landing for panels and previews. */
const CHAT_SOFT = { type: "spring", stiffness: 380, damping: 30 } as const

/** Three lazy-wave dots — the "someone is typing" glyph. */
function TypingDots({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-end gap-[3px] ${className}`} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="veil-typing-dot h-1.5 w-1.5 rounded-full bg-emerald-300"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  )
}

/** Fold a message id into the fresh-set (module scope so it is never a
 * reactive dependency). Sets iterate in insertion order, so pruning is
 * just "drop the oldest" once the set grows past 30. */
function freshWith(
  prev: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  if (prev.has(id)) return prev
  const next = new Set(prev)
  next.add(id)
  while (next.size > 30) {
    const oldest = next.values().next().value
    if (oldest === undefined) break
    next.delete(oldest)
  }
  return next
}

function isGifContent(content: string): boolean {
  const t = content.trim()
  // Local library GIFs (sourced like the wallpapers, served same-origin).
  if (/^\/gifs\/[a-z0-9-]+\.gif$/i.test(t)) return true
  // Same-origin proxy GIFs ("gifs sourced like the wallpapers") — the bytes
  // come from our own /api/gif-file/<id> route, so a blocked giphy.com can
  // never break them.
  if (/^\/api\/gif-file\/[A-Za-z0-9_-]{4,32}(\?|$)/.test(t)) return true
  return /^https:\/\/media\d*\.giphy\.com\/media\//i.test(t)
}

/** Rewrite a raw giphy CDN URL to the same-origin proxy, so OLD messages
 *  (sent before the proxy existed) also heal and load from our origin.
 *  Handles both URL shapes giphy has shipped:
 *    /media/<id>/giphy.gif            (classic)
 *    /media/v1.<base64>/<id>/giphy.gif (2024+ embed links) */
function gifSrc(content: string): string {
  const t = content.trim()
  const m = t.match(
    /^https:\/\/media\d*\.giphy\.com\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9_-]{4,32})\//i,
  )
  if (m) return `/api/gif-file/${m[1]}`
  return t
}

/** Route any external http(s) URL through the site's own proxy. Message
 *  media (shared images, YouTube / Spotify embeds) and posted links must
 *  NEVER make the viewer's browser connect straight to a third-party host —
 *  that hands the viewer's real IP to the target and shows the local
 *  network a direct third-party connection (the chat leak). Relative URLs
 *  and non-http(s) schemes pass through untouched. */
function viaProxy(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol !== "https:" && u.protocol !== "http:") return url
    return `/api/p/${u.protocol.replace(":", "")}/${u.host}${u.pathname}${u.search}${u.hash}`
  } catch {
    return url
  }
}

function isImageUrl(content: string): boolean {
  return /^https?:\/\/.+\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(content.trim())
}

/* ── File attachments (up to 300 MB, /api/chat-file) ────────────── */

interface ChatFile {
  url: string
  id: string
  name: string
  size: number
  type: string
}

/** A file attachment message — the whole content is the link
 *  (relative in the app; the single-file build stamps its origin on
 *  it when sending). */
function parseChatFileUrl(content: string): ChatFile | null {
  const t = content.trim()
  const m = /^(?:https?:[\/][\/][^\s]+)?[\/]api[\/]chat-file\?(\S+)$/i.exec(t)
  if (!m) return null
  try {
    const p = new URLSearchParams(m[1])
    const id = p.get("id") || ""
    if (!id) return null
    return {
      url: t,
      id,
      name: p.get("n") || "file",
      size: Number(p.get("s") || 0) || 0,
      type: p.get("t") || "application/octet-stream",
    }
  } catch {
    return null
  }
}

function fmtBytes(n: number): string {
  if (!n) return ""
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " GB"
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " MB"
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB"
  return n + " B"
}

/** The bubble for a file attachment: media plays inline, everything
 *  else is a download card. */
function FileBubble({ f }: { f: ChatFile }) {
  const type = f.type.toLowerCase()
  const dl = f.url + (f.url.includes("?") ? "&" : "?") + "download=1"
  if (type.startsWith("image/")) {
    return (
      <a href={f.url} target="_blank" rel="noopener noreferrer" title={f.name}>
        <img
          src={f.url}
          alt={f.name}
          loading="lazy"
          className="mt-1 max-h-80 max-w-sm rounded-lg border border-white/10 object-contain"
        />
      </a>
    )
  }
  if (type.startsWith("video/")) {
    return (
      <video
        src={f.url}
        controls
        preload="metadata"
        className="mt-1 max-h-96 w-full max-w-md rounded-lg border border-white/10"
      />
    )
  }
  if (type.startsWith("audio/")) {
    return <audio src={f.url} controls preload="metadata" className="mt-1 w-full max-w-xs" />
  }
  return (
    <a
      href={dl}
      target="_blank"
      rel="noopener noreferrer"
      className="veil-hover-lift mt-1 flex max-w-sm items-center gap-3 rounded-lg border border-white/10 bg-black/30 p-3 transition hover:border-orange-400/40"
      title={`Download ${f.name}`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-orange-400/15 text-orange-300">
        <FileIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-white/90">{f.name}</span>
        <span className="block text-xs text-white/50">{fmtBytes(f.size)} · click to download</span>
      </span>
      <Download className="h-4 w-4 shrink-0 text-orange-300" />
    </a>
  )
}

function isSpotifyUrl(content: string): boolean {
  return /open\.spotify\.com\/(track|album|artist|playlist|episode|show)\//i.test(content)
}

/** URLs that point at THIS repo's jsDelivr CDN fronts — the mirror stub
 * copies of Veil itself (root index, site/, cdn/, m1..m10/ and every
 * .html/.xhtml page inside them). These render as plain text in chat
 * instead of open-in-new-tab anchors (2026-10-10 user ask: the m10
 * jsDelivr link should not be a new-tab link anymore). */
function isVeilCdnFrontLink(url: string): boolean {
  try {
    const u = new URL(url)
    if (!/(^|\.)jsdelivr\.net$/i.test(u.hostname)) return false
    // /gh/<owner>/<repo>@<ref>/<path…>
    const m = u.pathname.match(
      /^\/gh\/ok5678765s\/veil-os@(?:main|[\d.]+|[0-9a-f]{7,40})(\/.*)?$/i,
    )
    if (!m) return false
    const path = (m[1] ?? "/").split("?")[0]!.split("#")[0]!
    return /^\/(?:index\.x?html|(?:m(?:[1-9]|10)|site|cdn)\/[^/?#]*\.x?html)$/i.test(
      path,
    )
  } catch {
    return false
  }
}

function extractSpotifyEmbed(content: string): string | null {
  const m = content.match(
    /open\.spotify\.com\/(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]+)/i,
  )
  if (!m) return null
  return `https://open.spotify.com/embed/${m[1]}/${m[2]}`
}

function isYouTubeUrl(content: string): boolean {
  return /(youtube\.com\/watch|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)/i.test(
    content,
  )
}

function extractYouTubeEmbed(content: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  ]
  for (const re of patterns) {
    const m = content.match(re)
    if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`
  }
  return null
}

async function apiFetch<T = unknown>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const go = () =>
    fetch(url, {
      ...options,
      // Hard timeout: a hung request (dev server cold-compiling) must fail
      // fast so callers can retry or surface an error instead of spinning.
      signal: (options as { signal?: AbortSignal })?.signal ?? AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  /* Aborts (caller cancel or the 30s hard timeout) must PROPAGATE, never
   * retry — the request may already have executed server-side, so a
   * second attempt could double-fire a send. */
  const isAbort = (e: unknown) => {
    const n = (e as DOMException | null)?.name
    return n === "AbortError" || n === "TimeoutError"
  }
  /* Transient-outage retry loop. The dev server restarts under memory
   * pressure (watchdog) and the gateway answers 502/503/504 while the
   * backend boots; a refused connection throws at the network layer. In
   * BOTH states the request never reached app code, so retrying is safe
   * even for POSTs (no double-send risk). Six attempts with linear
   * backoff cover a ~15s restart window; the 30s refresh ticks and the
   * socket-reconnect backfill cover anything longer. Without this, every
   * restart surfaced "Request failed (502)" errors that popped the dev
   * overlay open over the chat. */
  let res!: Response
  for (let attempt = 0; ; attempt++) {
    try {
      res = await go()
    } catch (e) {
      if (isAbort(e) || attempt >= 5) throw e
      await sleep(700 * (attempt + 1))
      continue
    }
    if (res.status === 431) {
      /* 431 = "request header fields too large" — almost always a bloated
       * Cookie jar (the legacy fat session mirror, or cookies proxied
       * pages used to drop on this origin). Node rejects the whole app at
       * 16KB of headers. Sweep the debris and retry ONCE before failing —
       * this is what un-breaks a browser that already carries the damage. */
      purgeFatCookies()
      res = await go()
    }
    if (
      (res.status === 502 || res.status === 503 || res.status === 504) &&
      attempt < 5
    ) {
      await sleep(700 * (attempt + 1))
      continue
    }
    break
  }
  const data = (await res.json().catch(() => ({}))) as T & {
    ok?: boolean
    error?: string
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    ;(err as unknown as { status: number }).status = res.status
    throw err
  }
  return data
}

function loadStoredAccount(): { account: ChatAccount; token: string } | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.account && parsed.token) return parsed
    }
  } catch {
    /* ignore */
  }
  /* localStorage missed (blocked, partitioned, or cleared) — try the
   * cookie mirror before giving up and showing the login screen. The
   * mirror is SLIM now (token + identity only, see saveStoredAccount),
   * so the account may be partial — neutral defaults fill the gaps and
   * refreshMembers rehydrates the real profile from the server within
   * moments of the app opening. */
  try {
    const m = document.cookie
      .split("; ")
      .find((c) => c.startsWith(SESSION_COOKIE + "="))
    if (m) {
      const parsed = JSON.parse(
        decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)),
      ) as { account?: Partial<ChatAccount>; token?: string }
      const a = parsed?.account
      if (a?.id && parsed.token) {
        const account: ChatAccount = {
          id: a.id,
          username: a.username ?? "",
          displayName: a.displayName ?? a.username ?? "",
          avatarColor: a.avatarColor ?? "#f97316",
          avatarImage: a.avatarImage ?? null,
          bio: a.bio ?? "",
          role: a.role ?? "member",
          muted: a.muted ?? false,
          banned: a.banned ?? false,
          banReason: a.banReason ?? null,
          ipBanned: a.ipBanned ?? false,
          coins: a.coins ?? 0,
          tag: a.tag ?? null,
          tagColor: a.tagColor ?? null,
          pfpAccessory: a.pfpAccessory ?? null,
          createdAt: a.createdAt ?? new Date(0).toISOString(),
        }
        return { account, token: parsed.token }
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function saveStoredAccount(account: ChatAccount, token: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ account, token }))
  } catch {
    /* ignore */
  }
  /* Cookie mirror — SLIM BY DESIGN. The old mirror serialized the whole
   * account (bio, coins, and the base64 PFP — tens of KB), and since the
   * Cookie header rides on EVERY same-origin request, one fat profile
   * pushed the app past Node's 16KB header limit: every API call came
   * back 431 (that is the bug that ate the chat, the replies, and the
   * dev requests). The mirror only needs to re-open the session — the
   * full profile rehydrates from /api/chat-members right after load
   * (see refreshMembers). */
  try {
    let mirror: { token: string; account: Partial<ChatAccount> } = {
      token,
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        avatarColor: account.avatarColor,
        role: account.role,
      },
    }
    let encoded = encodeURIComponent(JSON.stringify(mirror))
    if (encoded.length > 3000) {
      /* absurdly long names — strip to the bare identity */
      mirror = { token, account: { id: account.id, username: account.username } }
      encoded = encodeURIComponent(JSON.stringify(mirror))
    }
    document.cookie =
      `${SESSION_COOKIE}=${encoded}` +
      `; path=/; max-age=${SESSION_COOKIE_MAX_AGE}; SameSite=Lax`
  } catch {
    /* ignore */
  }
}

function clearStoredAccount() {
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
  try {
    document.cookie = `${SESSION_COOKIE}=; path=/; max-age=0; SameSite=Lax`
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// PFP accessory + tag rendering
// ---------------------------------------------------------------------------

export function AvatarWithAccessory({
  account,
  size = 40,
  className = "",
}: {
  account: {
    avatarColor: string
    avatarImage: string | null
    pfpAccessory: string | null
    displayName?: string
    username?: string
  }
  size?: number
  className?: string
}) {
  const acc = ACCESSORY_EMOJI[account.pfpAccessory || ""]
  const name =
    (account.displayName && account.displayName.trim()) ||
    account.username ||
    "?"
  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {account.avatarImage ? (
         
        <img
          src={account.avatarImage}
          alt={name}
          className="h-full w-full rounded-full object-cover"
          style={{ backgroundColor: account.avatarColor }}
        />
      ) : (
        <div
          className="grid h-full w-full place-items-center rounded-full font-semibold text-white"
          style={{ backgroundColor: account.avatarColor, fontSize: size * 0.4 }}
        >
          {initials(name)}
        </div>
      )}
      {acc && (
        <span
          aria-hidden
          className="pointer-events-none absolute select-none"
          style={{
            top: acc.top,
            left: acc.left,
            right: acc.right,
            fontSize: acc.size,
            transform: acc.left === "50%" ? "translateX(-50%)" : undefined,
            lineHeight: 1,
          }}
        >
          {acc.emoji}
        </span>
      )}
    </div>
  )
}

export function TagBadge({
  tag,
  color,
  className = "",
}: {
  tag: string | null
  color: string | null
  className?: string
}) {
  if (!tag) return null
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ${className}`}
      style={{ backgroundColor: color || "#6b7280" }}
    >
      {tag}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Blurred-wallpaper backdrop — the iOS "app over your wallpaper" look.
// The applied Veil wallpaper (video / image / animated theme) is pushed
// past the frame edges and heavily blurred, with a readability scrim on
// top. Re-syncs live when the user picks a different wallpaper.
// ---------------------------------------------------------------------------

function ChatWallpaperBackdrop() {
  const [wallpaper, setWallpaper] = useState<WallpaperSelection | null>(null)

  useEffect(() => {
    const sync = () => setWallpaper(loadWallpaperSelection())
    sync()
    window.addEventListener("veil:wallpaper-changed", sync)
    return () => window.removeEventListener("veil:wallpaper-changed", sync)
  }, [])

  const kind = wallpaper?.kind ?? "animated"
  const src = wallpaper?.src ?? ""
  const poster = wallpaper?.thumb ?? undefined
  const theme = wallpaper?.theme ?? "emerald"

  /* Memoized: ChatApp re-renders on every keystroke / socket event —
   * without memo the wallpaper subtree (and its <video>) re-diffs each
   * time, which measured as a visible chunk of the chat's input lag. */
  return useMemo(() => (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* the wallpaper, rendered normally (no blur) — just a dim scrim
       * on top so the chat's glass panels stay readable */}
      <div className="absolute inset-0">
        {kind === "video" && src ? (
          <BackdropVideo src={src} poster={poster} />
        ) : kind === "image" && src ? (
          <img src={src} alt="" className="size-full object-cover" />
        ) : (
          // Procedural animated theme — the start page's breathing gradient.
          <div
            className={`absolute inset-0 bg-gradient-to-br ${
              THEME_GRADIENTS[theme] ?? THEME_GRADIENTS.emerald
            }`}
          >
            <div className="absolute -top-40 left-[25%] h-[26rem] w-[40rem] rounded-full bg-white/10 blur-3xl" />
            <div className="absolute -bottom-32 right-[8%] h-80 w-80 rounded-full bg-black/10 blur-3xl" />
          </div>
        )}
      </div>
      {/* readability scrim over the plain wallpaper */}
      <div className="absolute inset-0 bg-black/45" />
    </div>
  ), [kind, src, poster, theme])
}

// ---------------------------------------------------------------------------
// Auth screen (login + register)
// ---------------------------------------------------------------------------

function AuthScreen({
  onAuthed,
  onBack,
}: {
  onAuthed: (account: ChatAccount, token: string) => void
  onBack?: () => void
}) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = useCallback(async () => {
    setError(null)
    setLoading(true)
    const attempt = async (): Promise<{ account: ChatAccount; token: string }> => {
      const endpoint = mode === "login" ? "/api/chat-auth/login" : "/api/chat-auth/register"
      const body =
        mode === "login"
          ? { username, password }
          : { username, password, displayName: username }
      try {
        return await apiFetch<{ account: ChatAccount; token: string }>(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        })
      } catch (e) {
        const status = (e as { status?: number }).status
        // Server answered with a real rejection — surface it, no retry.
        if (status) throw e
        // Network-level failure (cold compile / restart mid-request):
        // one retry after a pause — this is what made login look broken
        // right after a dev-server restart.
        await new Promise((r) => setTimeout(r, 1500))
        return apiFetch<{ account: ChatAccount; token: string }>(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        })
      }
    }
    try {
      const data = await attempt()
      saveStoredAccount(data.account, data.token)
      /* Claimed a backup-restored account straight from the login form —
       * celebrate it so the member KNOWS their history came back. */
      if ((data as { reclaimed?: boolean }).reclaimed) {
        try {
          const s = await import("sonner")
          s.toast.success("Welcome back! Your account was reclaimed from the backup — messages, coins and role are intact.")
        } catch {
          /* sonner not loaded — non-fatal */
        }
      }
      onAuthed(data.account, data.token)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Authentication failed."
      setError(
        /fetch|network|timeout|Failed to fetch/i.test(msg)
          ? "Connection hiccup — the server may be waking up. Try again in a moment."
          : msg
      )
    } finally {
      setLoading(false)
    }
  }, [mode, username, password, displayName, onAuthed])

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-y-auto bg-black/30 px-4 py-10 text-white">
      <ChatWallpaperBackdrop />
      {onBack && (
        <motion.button
          onClick={onBack}
          whileHover={{ x: -3 }}
          whileTap={{ scale: 0.95 }}
          transition={CHAT_POP}
          className="fixed left-4 top-4 z-30 flex h-9 items-center gap-1.5 rounded-xl border border-white/15 bg-black/45 px-3 text-[13px] font-medium text-zinc-200 backdrop-blur-md transition hover:border-white/30 hover:text-white"
          title="Back to Veil"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Veil</span>
        </motion.button>
      )}
      {/* veil-drop-bounce wrapper — the card lands with a squash-stretch
          bounce (mega tier); the inner framer entrance composes on top. */}
      <div className="veil-drop-bounce w-full max-w-md">
        <motion.div
          initial={{ opacity: 0, y: 26, scale: 0.955, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
          className="relative w-full max-w-md rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl"
        >
        <div className="mb-6 flex flex-col items-center text-center">
          <motion.div
            animate={{ y: [0, -5, 0] }}
            transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
            className="veil-pulse-glow mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-orange-400 to-orange-600 shadow-lg shadow-orange-500/30"
          >
            <MessageCircle className="h-7 w-7 text-white" />
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18, duration: 0.35, ease: "easeOut" }}
            className="veil-text-shine text-2xl font-semibold tracking-tight"
          >
            Veil Chat
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.26, duration: 0.35, ease: "easeOut" }}
            className="veil-text-breathe mt-1 text-sm text-white/60"
          >
            {mode === "login"
              ? "Welcome back"
              : "Create a new account to join the chat."}
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.32, duration: 0.3, ease: "easeOut" }}
          className="mb-5 flex rounded-xl bg-black/30 p-1 text-sm"
        >
          <button
            type="button"
            onClick={() => setMode("login")}
            className={`veil-hover-lift veil-press relative flex-1 rounded-lg px-3 py-1.5 transition-colors ${
              mode === "login" ? "text-white" : "text-white/60 hover:text-white"
            }`}
          >
            {mode === "login" && (
              <motion.span
                layoutId="veil-auth-pill"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-lg bg-white/15"
              />
            )}
            <span className="relative z-10">Login</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("register")}
            className={`veil-hover-lift veil-press relative flex-1 rounded-lg px-3 py-1.5 transition-colors ${
              mode === "register" ? "text-white" : "text-white/60 hover:text-white"
            }`}
          >
            {mode === "register" && (
              <motion.span
                layoutId="veil-auth-pill"
                transition={{ type: "spring", stiffness: 420, damping: 32 }}
                className="absolute inset-0 rounded-lg bg-white/15"
              />
            )}
            <span className="relative z-10">Register</span>
          </button>
        </motion.div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className="space-y-3"
        >
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.3, ease: "easeOut" }}
          >
            <label className="mb-1 block text-xs font-medium text-white/70">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3+ chars"
              autoCapitalize="none"
              autoCorrect="off"
              className="veil-focus-bloom w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-300 placeholder:text-white/30 focus:border-orange-400/50 focus:shadow-[0_0_0_3px_rgba(251,146,60,0.12)]"
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.48, duration: 0.3, ease: "easeOut" }}
          >
            <label className="mb-1 block text-xs font-medium text-white/70">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6+ characters"
              className="veil-focus-bloom w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] duration-300 placeholder:text-white/30 focus:border-orange-400/50 focus:shadow-[0_0_0_3px_rgba(251,146,60,0.12)]"
            />
          </motion.div>

          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0, x: [0, -7, 7, -4, 4, 0] }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
                className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-200"
              >
                {/* jelly wobble re-triggers per distinct error via key */}
                <span key={error} className="veil-jelly inline-block">{error}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* border-dance wrapper + press — the framer tap lives on the
              button, the conic border and squeeze live here so the
              transforms compose instead of fighting. */}
          <div className="veil-border-dance veil-press rounded-lg">
            <motion.button
              type="submit"
              disabled={loading || !username || !password}
              whileHover={{ scale: 1.02, y: -1 }}
              whileTap={{ scale: 0.97 }}
              transition={CHAT_POP}
              className="veil-hover-glow flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-orange-400 via-orange-500 to-orange-600 bg-[length:200%_100%] bg-left px-4 py-2.5 text-sm font-semibold text-white transition-[background-position,opacity] duration-500 hover:bg-right disabled:opacity-50 disabled:hover:bg-left"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "login" ? "Log In" : "Create account"}
            </motion.button>
          </div>
        </form>
        </motion.div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GIF picker
// ---------------------------------------------------------------------------

/* One-tap searches — the picker always shows something to browse. */
const SUGGESTIONS = [
  "Trending",
  "cat",
  "funny",
  "anime",
  "gaming",
  "meme",
  "love",
  "reaction",
  "dance",
  "happy",
] as const

function GifPicker({
  onPick,
  onClose,
}: {
  onPick: (gifUrl: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [gifs, setGifs] = useState<
    { id: string; title: string; preview: string; url: string }[]
  >([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  // Infinite sourcing: giphy.com paginates forever — keep pulling pages.
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [source, setSource] = useState<"giphy" | "local" | "trending">("giphy")

  // The active query in the API sense ("" → trending feed).
  const activeQueryRef = useRef("trending")

  const fetchPage = useCallback(async (q: string, p: number) => {
    const data = await apiFetch<{
      gifs: { id: string; title: string; preview: string; url: string }[]
      source?: "giphy" | "local" | "trending"
      hasMore?: boolean
    }>(`/api/gif-search?q=${encodeURIComponent(q)}&page=${p}`)
    return {
      gifs: data.gifs || [],
      source:
        data.source === "local"
          ? ("local" as const)
          : data.source === "trending"
            ? ("trending" as const)
            : ("giphy" as const),
      hasMore: !!data.hasMore,
    }
  }, [])

  const search = useCallback(
    async (q: string) => {
      setLoading(true)
      setSearched(true)
      activeQueryRef.current = q
      try {
        const r = await fetchPage(q, 1)
        setGifs(r.gifs)
        setSource(r.source)
        setHasMore(r.hasMore)
        setPage(1)
      } catch {
        setGifs([])
        setHasMore(false)
      } finally {
        setLoading(false)
      }
    },
    [fetchPage],
  )

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const next = page + 1
    try {
      const r = await fetchPage(activeQueryRef.current, next)
      // Skip any gifs already on screen (dedupe by id).
      setGifs((prev) => {
        const seen = new Set(prev.map((g) => g.id))
        return [...prev, ...r.gifs.filter((g) => !seen.has(g.id))]
      })
      setHasMore(r.hasMore)
      setPage(next)
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [fetchPage, hasMore, loadingMore, page])

  // Default trending query on mount.
  useEffect(() => {
    void search("trending")
  }, [search])

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="absolute bottom-16 left-2 z-40 w-[min(440px,calc(100vw-1rem))] rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-3 shadow-2xl"
    >
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setQuery(s === "Trending" ? "" : s)
              void search(s === "Trending" ? "trending" : s)
            }}
            className="veil-hover-bounce veil-press rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-white/70 transition-colors hover:border-emerald-400/40 hover:bg-emerald-400/10 hover:text-emerald-200"
          >
            {s}
          </button>
        ))}
      </div>
      <div className="mb-2 flex items-center gap-2">
        <Search className="h-4 w-4 text-white/50" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) void search(query.trim())
          }}
          placeholder="Search infinite GIFs…"
          className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
        />
        <button
          onClick={() => query.trim() && void search(query.trim())}
          className="veil-press rounded-md bg-white/10 px-2 py-1 text-xs text-white hover:bg-white/20"
        >
          Search
        </button>
        <button onClick={onClose} className="veil-hover-wobble text-white/50 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        className="max-h-72 overflow-y-auto rounded-lg bg-black/30 p-2"
        style={{ scrollbarWidth: "thin" }}
        onScroll={(e) => {
          // Infinite scroll: near the bottom → pull the next page.
          const el = e.currentTarget
          if (
            hasMore &&
            !loadingMore &&
            !loading &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 120
          ) {
            void loadMore()
          }
        }}
      >
        {loading ? (
          <div className="grid h-32 place-items-center text-white/50">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : gifs.length === 0 ? (
          <div className="grid h-24 place-items-center text-xs text-white/40">
            {searched ? "No GIFs found." : "Search for a GIF."}
          </div>
        ) : (
          <div className="veil-slide-up-pop grid grid-cols-3 gap-2">
            {gifs.map((g) => (
              <button
                key={g.id}
                onClick={() => onPick(g.url)}
                title={g.title || undefined}
                className="veil-hover-glow group relative aspect-square overflow-hidden rounded-md bg-black/40 transition-transform hover:scale-105"
              >
                { }
                <img
                  src={g.preview}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </button>
            ))}
            {loadingMore && (
              <div className="col-span-3 grid place-items-center py-2 text-white/50">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
          </div>
        )}
        {hasMore && !loading && gifs.length > 0 && !loadingMore && (
          <button
            onClick={() => void loadMore()}
            className="veil-hover-bounce mt-2 w-full rounded-md border border-white/10 bg-white/5 py-1.5 text-[11px] font-medium text-white/70 hover:bg-white/10 hover:text-white"
          >
            More GIFs ↓
          </button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-white/30">
        {source === "giphy"
          ? "∞ search anything — served from Veil, giphy outages can't touch it"
          : source === "trending"
            ? "no matches for that — showing what's trending instead"
            : "offline pack — curated local library, zero external calls"}
      </p>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Emoji picker
// ---------------------------------------------------------------------------

function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void
  onClose: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="absolute bottom-16 left-2 z-40 w-[min(360px,calc(100vw-1rem))] rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-white/70">Emoji</span>
        <button onClick={onClose} className="veil-hover-wobble text-white/50 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="veil-slide-up-pop grid max-h-60 grid-cols-8 gap-1 overflow-y-auto rounded-lg bg-black/30 p-2">
        {EMOJI_SET.map((e) => (
          <button
            key={e}
            onClick={() => onPick(e)}
            className="veil-hover-bounce veil-press grid h-8 w-8 place-items-center rounded-md text-lg transition-colors hover:bg-white/10"
          >
            {e}
          </button>
        ))}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

function ModalShell({
  title,
  icon,
  onClose,
  children,
  maxWidth = "max-w-lg",
}: {
  title: string
  icon?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
  maxWidth?: string
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.96, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 12 }}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] w-full ${maxWidth} flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2 text-white">
            {icon}
            <h3 className="veil-text-shine text-sm font-semibold">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="veil-hover-wobble rounded-md p-1 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 text-white">{children}</div>
      </motion.div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Shop modal
// ---------------------------------------------------------------------------

function ShopModal({
  account,
  token,
  onAccount,
  onProfileUpdated,
  onClose,
  toast,
}: {
  account: ChatAccount
  token: string
  onAccount: (a: ChatAccount) => void
  onProfileUpdated?: () => void
  onClose: () => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [items, setItems] = useState<ShopItem[]>([])
  const [loading, setLoading] = useState(true)
  const [buying, setBuying] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<{ items: ShopItem[] }>("/api/chat-shop")
      setItems(data.items || [])
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const buy = async (item: ShopItem) => {
    setBuying(item.id)
    try {
      const data = await apiFetch<{ account: ChatAccount }>(
        "/api/chat-shop",
        {
          method: "POST",
          body: JSON.stringify({ token, itemId: item.id }),
        },
      )
      onAccount(data.account)
      // Refresh members so the new accessory shows in the players tab right away.
      onProfileUpdated?.()
      toast(`Purchased ${item.label}!`, "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Purchase failed.", "err")
    } finally {
      setBuying(null)
    }
  }

  const tags = items.filter((i) => i.type === "tag")
  const accessories = items.filter((i) => i.type === "accessory")
  const equippedTag = account.tag
  const equippedAccessory = account.pfpAccessory

  return (
    <ModalShell
      title="Veil Shop"
      icon={<ShoppingBag className="h-4 w-4 text-orange-400" />}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      {/* key={coins} — the balance pill flashes (level-flash) and the
          coin emoji 720°-flips every time the balance changes. */}
      <div key={account.coins} className="veil-level-flash mb-4 flex items-center justify-between rounded-xl border border-white/10 bg-black/30 px-4 py-3">
        <span className="text-sm text-white/70">Your balance</span>
        <span key={account.coins} className="veil-coin-flip flex items-center gap-1.5 font-semibold text-orange-300">
          🪙 {account.coins} <span className="text-xs text-white/50">Veil Coins</span>
        </span>
      </div>

      {loading ? (
        <div className="grid h-32 place-items-center text-white/50">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          <section>
            <h4 className="veil-text-shine mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
              Name Tags
            </h4>
            <div className="grid gap-2 sm:grid-cols-2">
              {tags.map((t) => {
                const equipped = equippedTag === t.tagText
                const afford = account.coins >= t.price
                return (
                  <div
                    key={t.id}
                    className="veil-hover-lift veil-hover-tilt veil-border-dance flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-3"
                  >
                    <div className="flex flex-col gap-1">
                      <TagBadge tag={t.tagText} color={t.tagColor} />
                      <span className="text-xs text-white/50">
                        🪙 {t.price.toLocaleString()}
                      </span>
                    </div>
                    {equipped ? (
                      <span className="rounded-md bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">
                        Equipped
                      </span>
                    ) : (
                      <button
                        disabled={!afford || buying === t.id}
                        onClick={() => void buy(t)}
                        className="veil-press veil-hover-glow rounded-md bg-orange-400 px-3 py-1 text-xs font-semibold text-black disabled:opacity-40"
                      >
                        {buying === t.id ? "…" : "Buy"}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <h4 className="veil-text-shine mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
              PFP Accessories
            </h4>
            <div className="grid gap-2 sm:grid-cols-2">
              {accessories.map((a) => {
                const equipped = equippedAccessory === a.accessory
                const afford = account.coins >= a.price
                const meta = ACCESSORY_EMOJI[a.accessory]
                return (
                  <div
                    key={a.id}
                    className="veil-hover-lift veil-hover-tilt veil-border-dance flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-lg">
                        {meta?.emoji || "✨"}
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{a.label}</span>
                        <span className="text-xs text-white/50">
                          🪙 {a.price.toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {equipped ? (
                      <span className="rounded-md bg-emerald-500/20 px-2 py-1 text-xs text-emerald-300">
                        Equipped
                      </span>
                    ) : (
                      <button
                        disabled={!afford || buying === a.id}
                        onClick={() => void buy(a)}
                        className="veil-press veil-hover-glow rounded-md bg-orange-400 px-3 py-1 text-xs font-semibold text-black disabled:opacity-40"
                      >
                        {buying === a.id ? "…" : "Buy"}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      )}
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Profile modal
// ---------------------------------------------------------------------------

function ProfileModal({
  account,
  token,
  onAccount,
  onProfileUpdated,
  onClose,
  toast,
}: {
  account: ChatAccount
  token: string
  onAccount: (a: ChatAccount) => void
  onProfileUpdated?: () => void
  onClose: () => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [displayNameInput, setDisplayNameInput] = useState(account.displayName)
  const [bio, setBio] = useState(account.bio || "")
  const [avatarImage, setAvatarImage] = useState<string | null>(account.avatarImage)
  const [saving, setSaving] = useState(false)
  const [processing, setProcessing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /* Downscale any picked image to a ≤256×256 center-cropped avatar that
   * fits the 500 KB server limit. Real photos from a phone camera are
   * multiple MB — without this the upload is always rejected, which is
   * exactly the "can't upload a pfp" bug. */
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-picking the same file
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast("That file isn't an image.", "err")
      return
    }
    setProcessing(true)
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const SIZE = 256
        const canvas = document.createElement("canvas")
        canvas.width = SIZE
        canvas.height = SIZE
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("Canvas is unavailable in this browser.")
        // Fill with the account color so transparent PNGs don't turn black.
        ctx.fillStyle = account.avatarColor || "#f97316"
        ctx.fillRect(0, 0, SIZE, SIZE)
        // Center-crop to a square, cover-style.
        const side = Math.min(img.naturalWidth, img.naturalHeight)
        const sx = (img.naturalWidth - side) / 2
        const sy = (img.naturalHeight - side) / 2
        ctx.imageSmoothingQuality = "high"
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE)
        // JPEG keeps it small; step quality down until under 400 KB.
        let dataUrl = canvas.toDataURL("image/jpeg", 0.92)
        for (let q = 0.85; dataUrl.length > 400_000 / 0.75 && q >= 0.5; q -= 0.1) {
          dataUrl = canvas.toDataURL("image/jpeg", q)
        }
        setAvatarImage(dataUrl)
      } catch {
        toast("Couldn't process that image — try a different one.", "err")
      } finally {
        URL.revokeObjectURL(url)
        setProcessing(false)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      setProcessing(false)
      toast("Couldn't read that image — it may be an unsupported format (e.g. HEIC).", "err")
    }
    img.src = url
  }

  const save = async () => {
    setSaving(true)
    try {
      const data = await apiFetch<{ account: ChatAccount }>("/api/chat-profile", {
        method: "POST",
        body: JSON.stringify({ token, displayName: displayNameInput, bio, avatarImage }),
      })
      onAccount(data.account)
      // Refresh the members list so the new PFP shows in the players tab
      // immediately (otherwise it waits up to 30s for the periodic refresh).
      onProfileUpdated?.()
      toast("Profile updated.", "ok")
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed.", "err")
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title="Your profile"
      icon={<User className="h-4 w-4 text-orange-400" />}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-4">
          <div className="relative">
            {/* mega tier: spinning dashed halo around the avatar */}
            <span
              aria-hidden
              className="veil-ring-spin pointer-events-none absolute -inset-1 rounded-full border-2 border-dashed border-orange-400/50"
            />
            <AvatarWithAccessory
              account={{
                avatarColor: account.avatarColor,
                avatarImage,
                pfpAccessory: account.pfpAccessory,
                displayName: displayNameInput,
                username: account.username,
              }}
              size={72}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={processing}
              className="veil-hover-bounce absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border-2 border-black/60 bg-orange-400 text-black disabled:opacity-60"
              title="Upload new picture (auto-resized to 256×256)"
            >
              {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onFile}
              className="hidden"
            />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="veil-text-shine text-lg font-semibold">{displayName({ displayName: displayNameInput, username: account.username })}</span>
              {roleLabel(account) && (
                <span
                  className="veil-pop-in veil-stagger-2 veil-hover-wobble rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase text-white"
                  style={{ backgroundColor: roleColor(account) }}
                >
                  {roleLabel(account)}
                </span>
              )}
            </div>
            <span className="text-xs text-white/50">@{account.username}</span>
            {account.tag && <div className="mt-1"><TagBadge tag={account.tag} color={account.tagColor} className="veil-pop-in veil-stagger-3 veil-hover-wobble" /></div>}
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-white/70">Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            placeholder="Tell others about yourself…"
            className="veil-focus-bloom w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
          />
          <div className="mt-1 text-right text-[10px] text-white/40">{bio.length}/500</div>
        </div>

        <div key={account.coins} className="veil-level-flash flex items-center justify-between rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm">
          <span className="text-white/70">Veil Coin balance</span>
          <span key={account.coins} className="veil-coin-flip font-semibold text-orange-300">🪙 {account.coins}</span>
        </div>

        <button
          disabled={saving}
          onClick={() => void save()}
          className="veil-press veil-hover-glow flex items-center justify-center gap-2 rounded-lg bg-orange-400 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save changes
        </button>
      </div>
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// User profile viewer — read-only card shown when you click someone's
// avatar / name (message list or Players sidebar). Their bio is the star.
// ---------------------------------------------------------------------------

function UserProfileModal({
  who,
  online,
  isMe,
  onEdit,
  onClose,
}: {
  who: ChatAccount
  online: boolean
  isMe: boolean
  onEdit: () => void
  onClose: () => void
}) {
  const joined = (() => {
    const d = new Date(who.createdAt)
    if (Number.isNaN(d.getTime())) return "—"
    return d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })
  })()

  return (
    <ModalShell
      title={displayName(who)}
      icon={<User className="h-4 w-4 text-orange-400" />}
      onClose={onClose}
      maxWidth="max-w-md"
    >
      <div className="flex flex-col gap-5">
        {/* Header: big avatar + identity */}
        <div className="flex items-center gap-4">
          <div className="relative">
            <AvatarWithAccessory
              account={who}
              size={88}
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full border-[2.5px] border-zinc-950 ${
                online ? "bg-emerald-400" : "bg-white/30"
              }`}
              title={online ? "Online" : "Offline"}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="veil-text-shine truncate text-lg font-semibold">{displayName(who)}</span>
              {roleLabel(who) && (
                <span
                  className="veil-pop-in veil-stagger-2 veil-hover-wobble rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase text-white"
                  style={{ backgroundColor: roleColor(who) }}
                >
                  {roleLabel(who)}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-white/50">@{who.username}</div>
            {who.tag && (
              <div className="mt-1.5">
                <TagBadge tag={who.tag} color={who.tagColor} className="veil-pop-in veil-stagger-3 veil-hover-wobble" />
              </div>
            )}
          </div>
        </div>

        {/* Bio — the point of the card */}
        <div className="veil-slide-up-pop veil-stagger-1 rounded-xl border border-white/10 bg-black/30 p-3.5">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">
            Bio
          </p>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/85">
            {who.bio?.trim() ? who.bio : (
              <span className="italic text-white/35">
                {isMe ? "You haven't written a bio yet — edit your profile to add one." : "No bio yet."}
              </span>
            )}
          </p>
        </div>

        {who.legacy && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-300/25 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-100/80">
            <History className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <p>
              Restored from a chat backup — messages, coins and role are
              intact. The owner just logs in as{" "}
              <span className="font-semibold">@{who.username}</span> with any
              password of 6+ characters to reclaim it.
            </p>
          </div>
        )}

        {/* Facts strip */}
        <div className="grid grid-cols-3 gap-2">
          <div className="veil-slide-up-pop veil-stagger-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Coins</p>
            <p className="mt-0.5 text-sm font-semibold text-orange-300">🪙 {who.coins}</p>
          </div>
          <div className="veil-slide-up-pop veil-stagger-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Status</p>
            <p className={`mt-0.5 text-sm font-semibold ${online ? "text-emerald-300" : "text-white/50"}`}>
              {online ? "Online" : "Offline"}
            </p>
          </div>
          <div className="veil-slide-up-pop veil-stagger-4 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-center">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Joined</p>
            <p className="mt-0.5 text-sm font-semibold text-white/80">{joined}</p>
          </div>
        </div>

        {isMe && (
          <button
            onClick={onEdit}
            className="veil-press veil-hover-glow flex items-center justify-center gap-2 rounded-lg border border-orange-400/40 bg-orange-400/10 px-4 py-2 text-sm font-semibold text-orange-300 transition hover:bg-orange-400/20"
          >
            <Camera className="h-4 w-4" /> Edit your profile
          </button>
        )}
      </div>
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Extensions modal
// ---------------------------------------------------------------------------

type ExtensionId =
  | "ad_blocker"
  | "dark_reader"
  | "grammar_check"
  | "screenshot"
  | "password_gen"
  | "qr_code"
  | "text_size"
  | "notification_sound"
  | "auto_translate"
  | "reading_mode"

type ExtensionState = Record<ExtensionId, boolean>

const EXTENSION_DEFS: {
  id: ExtensionId
  label: string
  desc: string
  icon: React.ReactNode
}[] = [
  { id: "ad_blocker", label: "Ad Blocker", desc: "Block intrusive ads network-wide", icon: <ShieldOff className="h-4 w-4" /> },
  { id: "dark_reader", label: "Dark Reader", desc: "Force dark mode on every site", icon: <Moon className="h-4 w-4" /> },
  { id: "grammar_check", label: "Grammar Check", desc: "Spellcheck messages as you type", icon: <SpellCheck className="h-4 w-4" /> },
  { id: "screenshot", label: "Screenshot", desc: "Capture the visible window", icon: <Camera className="h-4 w-4" /> },
  { id: "password_gen", label: "Password Generator", desc: "Strong passwords on demand", icon: <KeyRound className="h-4 w-4" /> },
  { id: "qr_code", label: "QR Code", desc: "Generate QR codes from URLs", icon: <QrCode className="h-4 w-4" /> },
  { id: "text_size", label: "Text Size", desc: "Adjust font size globally", icon: <Type className="h-4 w-4" /> },
  { id: "notification_sound", label: "Notification Sound", desc: "Play a sound on new messages", icon: <Volume2 className="h-4 w-4" /> },
  { id: "auto_translate", label: "Auto-Translate", desc: "Translate incoming messages", icon: <Languages className="h-4 w-4" /> },
  { id: "reading_mode", label: "Reading Mode", desc: "Distraction-free reading view", icon: <Eye className="h-4 w-4" /> },
]

const DEFAULT_EXTENSIONS: ExtensionState = {
  ad_blocker: true,
  dark_reader: false,
  grammar_check: false,
  screenshot: false,
  password_gen: false,
  qr_code: false,
  text_size: false,
  notification_sound: true,
  auto_translate: false,
  reading_mode: false,
}

function loadExtensions(): ExtensionState {
  if (typeof window === "undefined") return DEFAULT_EXTENSIONS
  try {
    const raw = window.localStorage.getItem(EXTENSIONS_KEY)
    if (!raw) return DEFAULT_EXTENSIONS
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_EXTENSIONS, ...(parsed || {}) }
  } catch {
    return DEFAULT_EXTENSIONS
  }
}

function saveExtensions(state: ExtensionState) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

function ExtensionsModal({
  state,
  onToggle,
  blockedCount,
  onClose,
}: {
  state: ExtensionState
  onToggle: (id: ExtensionId, value: boolean) => void
  blockedCount: number
  onClose: () => void
}) {
  return (
    <ModalShell
      title="Extensions"
      icon={<Puzzle className="h-4 w-4 text-orange-400" />}
      onClose={onClose}
      maxWidth="max-w-xl"
    >
      <div className="space-y-2">
        {EXTENSION_DEFS.map((ext, ei) => {
          const enabled = state[ext.id]
          return (
            <div
              key={ext.id}
              className={`veil-slide-left-pop veil-stagger-${(ei % 8) + 1} veil-hover-lift flex items-center justify-between rounded-xl border border-white/10 bg-black/20 p-3`}
            >
              <div className="flex items-center gap-3">
                <div className="veil-hover-spin grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-orange-300">
                  {ext.icon}
                </div>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{ext.label}</span>
                  <span className="text-xs text-white/50">
                    {ext.desc}
                    {ext.id === "ad_blocker" && enabled && (
                      <span className="ml-1 text-emerald-300">
                        · {blockedCount.toLocaleString()} blocked
                      </span>
                    )}
                  </span>
                </div>
              </div>
              <button
                role="switch"
                aria-checked={enabled}
                onClick={() => onToggle(ext.id, !enabled)}
                className={`veil-press relative h-6 w-11 rounded-full transition-colors ${
                  enabled ? "bg-orange-400" : "bg-white/15"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                    enabled ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          )
        })}
      </div>
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Coin transfer modal
// ---------------------------------------------------------------------------

function TransferModal({
  account,
  token,
  onAccount,
  members,
  onClose,
  toast,
}: {
  account: ChatAccount
  token: string
  onAccount: (a: ChatAccount) => void
  members: ChatAccount[]
  onClose: () => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [toUsername, setToUsername] = useState("")
  const [amount, setAmount] = useState<number>(10)
  const [sending, setSending] = useState(false)

  const otherMembers = members.filter((m) => m.id !== account.id)

  const send = async () => {
    if (!toUsername.trim()) {
      toast("Pick a recipient first.", "err")
      return
    }
    if (amount < 1) {
      toast("Amount must be at least 1.", "err")
      return
    }
    setSending(true)
    try {
      const data = await apiFetch<{ account: ChatAccount }>("/api/chat-coins", {
        method: "POST",
        body: JSON.stringify({
          token,
          action: "transfer",
          toUsername: toUsername.trim(),
          amount,
        }),
      })
      onAccount(data.account)
      toast(`Sent 🪙 ${amount} to @${toUsername}.`, "ok")
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Transfer failed.", "err")
    } finally {
      setSending(false)
    }
  }

  return (
    <ModalShell
      title="Send Veil Coins"
      icon={<Coins className="h-4 w-4 text-orange-400" />}
      onClose={onClose}
    >
      <div className="space-y-4">
        <div key={account.coins} className="veil-level-flash rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-white/70">Your balance</span>
            <span key={account.coins} className="veil-coin-flip font-semibold text-orange-300">🪙 {account.coins}</span>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-white/70">Recipient</label>
          <input
            value={toUsername}
            onChange={(e) => setToUsername(e.target.value)}
            placeholder="@username"
            autoCapitalize="none"
            autoCorrect="off"
            list="member-usernames"
            className="veil-focus-bloom w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
          />
          <datalist id="member-usernames">
            {otherMembers.map((m) => (
              <option key={m.id} value={m.username}>
                {displayName(m)}
              </option>
            ))}
          </datalist>
          {otherMembers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {otherMembers.slice(0, 8).map((m, mi) => (
                <button
                  key={m.id}
                  onClick={() => setToUsername(m.username)}
                  className={`veil-pop-in veil-stagger-${(mi % 8) + 1} flex items-center gap-1 rounded-full bg-white/5 px-2 py-1 text-xs hover:bg-white/10`}
                >
                  <AvatarWithAccessory
                    account={m}
                    size={16}
                  />
                  <span>{displayName(m)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-white/70">Amount</label>
          <input
            type="number"
            min={1}
            max={account.coins}
            value={amount}
            onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="veil-focus-bloom w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
          />
          <div className="mt-2 flex gap-1.5">
            {[10, 50, 100, 500].map((n) => (
              <button
                key={n}
                onClick={() => setAmount(n)}
                className="veil-hover-bounce veil-press rounded-md bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
              >
                🪙 {n}
              </button>
            ))}
          </div>
        </div>

        <button
          disabled={sending || amount < 1 || !toUsername.trim()}
          onClick={() => void send()}
          className="veil-press veil-hover-glow flex w-full items-center justify-center gap-2 rounded-lg bg-orange-400 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {sending && <Loader2 className="h-4 w-4 animate-spin" />}
          Send 🪙 {amount || 0}
        </button>
      </div>
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Invite people to a group chat — pick friends by checkbox and/or type
// @usernames. Current members are shown as chips so it's obvious who's
// already in (and that inviting a 3rd person into a plain DM turns it
// into a group automatically).
// ---------------------------------------------------------------------------

function InviteModal({
  dm,
  friends,
  me,
  onInvite,
  onClose,
}: {
  dm: DM
  friends: ChatAccount[]
  me: ChatAccount
  onInvite: (dm: DM, targets: string[], done: () => void) => Promise<void>
  onClose: () => void
}) {
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [userInput, setUserInput] = useState("")
  const [busy, setBusy] = useState(false)

  const memberNames = new Set(
    dm.members.map((m) => m.username.toLowerCase()),
  )
  const candidates = friends.filter(
    (f) => !memberNames.has(f.username.toLowerCase()),
  )
  const typed = userInput
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^@/, ""))
    .filter(Boolean)
    .filter((s) => !memberNames.has(s.toLowerCase()))
  const pickedNames = Object.keys(picked).filter((u) => picked[u])
  const targets = [...new Set([...pickedNames, ...typed])]
  const label =
    dm.name ||
    dm.members
      .filter((m) => m.id !== me.id)
      .map(displayName)
      .join(", ") ||
    "this conversation"

  const invite = async () => {
    if (targets.length === 0 || busy) return
    setBusy(true)
    await onInvite(dm, targets, () => {
      setPicked({})
      setUserInput("")
    })
    setBusy(false)
  }

  return (
    <ModalShell
      title={dm.isGroup ? `Invite to ${label}` : "Invite — make it a group"}
      onClose={onClose}
    >
      <div className="space-y-3">
        {/* Current members */}
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
            In here now — {dm.members.length}
          </p>
          <div className="flex flex-wrap gap-1">
            {dm.members.map((m, mi) => (
              <span
                key={m.id}
                className={`veil-pop-in veil-stagger-${(mi % 8) + 1} flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] ${
                  m.id === me.id
                    ? "border-orange-400/40 bg-orange-400/10 text-orange-200"
                    : "border-white/10 bg-white/[0.04] text-white/70"
                }`}
              >
                <span
                  className="grid h-4 w-4 place-items-center rounded-full text-[8px] font-bold text-white"
                  style={{ backgroundColor: m.avatarColor }}
                >
                  {m.username[0]?.toUpperCase()}
                </span>
                {m.id === me.id ? "you" : displayName(m)}
              </span>
            ))}
          </div>
        </div>

        {/* Friends picker */}
        {candidates.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
              Your friends
            </p>
            <div className="veil-scroll-slim max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-white/10">
              {candidates.map((f, fi) => (
                <label
                  key={f.id}
                  className={`veil-slide-right-pop veil-stagger-${(fi % 8) + 1} flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-white/5`}
                >
                  <input
                    type="checkbox"
                    checked={!!picked[f.username]}
                    onChange={(e) =>
                      setPicked((prev) => ({
                        ...prev,
                        [f.username]: e.target.checked,
                      }))
                    }
                    className="accent-orange-400"
                  />
                  <span
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white"
                    style={{ backgroundColor: f.avatarColor }}
                  >
                    {f.username[0]?.toUpperCase()}
                  </span>
                  <span className="flex-1 truncate text-white/80">
                    {displayName(f)}
                  </span>
                  <span className="text-[10px] text-white/30">@{f.username}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* @username entry */}
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">
            Or add by username
          </p>
          <input
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void invite()
              }
            }}
            placeholder="@username, @username…"
            autoCapitalize="none"
            className="veil-focus-bloom w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
          />
        </div>

        {targets.length > 0 && (
          <p className="text-[11px] text-emerald-300/80">
            {targets.length} person{targets.length === 1 ? "" : "s"} selected
            {dm.isGroup ? "" : " — this DM becomes a group automatically"}.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={() => void invite()}
            disabled={busy || targets.length === 0}
            className="veil-press veil-hover-glow flex items-center gap-1.5 rounded-lg bg-orange-400 px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserPlus className="h-3.5 w-3.5" />
            )}
            Invite {targets.length > 0 ? `(${targets.length})` : ""}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Pinned messages + Notifications panels (right side)
// ---------------------------------------------------------------------------

function PinnedPanel({
  messages,
  onClose,
}: {
  messages: ChatMessage[]
  onClose: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute right-2 top-14 z-30 w-80 rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Pin className="h-3.5 w-3.5 text-orange-400" /> Pinned messages
        </span>
        <button onClick={onClose} className="veil-hover-wobble text-white/50 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="py-6 text-center text-xs text-white/40">
            No pinned messages in this channel yet.
          </p>
        ) : (
          messages.slice(0, 12).map((m, pi) => (
            <div key={m.id} className={`veil-slide-right-pop veil-stagger-${(pi % 8) + 1} rounded-lg border border-white/5 bg-black/30 p-2 text-xs`}>
              <div className="flex items-center gap-1.5">
                <AvatarWithAccessory
                  account={{
                    avatarColor: m.account.avatarColor,
                    avatarImage: m.account.avatarImage,
                    pfpAccessory: m.account.pfpAccessory,
                    displayName: m.account.displayName,
                    username: m.account.username,
                  }}
                  size={18}
                />
                <span className="font-medium text-white" style={{ color: roleColor(m.account) }}>
                  {displayName(m.account)}
                </span>
                <span className="text-white/40">{formatTime(m.createdAt)}</span>
              </div>
              <p className="mt-1 text-white/80">{m.content}</p>
            </div>
          ))
        )}
      </div>
    </motion.div>
  )
}

type ChatNotification = {
  id: string
  kind: "message" | "mention" | "coin" | "system" | "friend_request" | "friend_accepted"
  title: string
  body: string
  ts: number
  read?: boolean
  /** friend_request notifications carry the request id so the panel can
   *  render live Accept/Decline buttons right inside the bell dropdown. */
  requestId?: string
}

function NotificationsPanel({
  notifications,
  onClear,
  onClose,
  onFriendAccept,
  onFriendDecline,
}: {
  notifications: ChatNotification[]
  onClear: () => void
  onClose: () => void
  onFriendAccept?: (requestId: string) => void
  onFriendDecline?: (requestId: string) => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute right-2 top-14 z-30 w-80 rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Bell className="h-3.5 w-3.5 text-orange-400" /> Notifications
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onClear}
            className="veil-hover-wobble rounded-md px-2 py-0.5 text-xs text-white/60 hover:bg-white/10"
          >
            Clear
          </button>
          <button onClick={onClose} className="veil-hover-wobble text-white/50 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="max-h-96 space-y-1.5 overflow-y-auto">
        {notifications.length === 0 ? (
          <p className="py-6 text-center text-xs text-white/40">All caught up.</p>
        ) : (
          notifications.map((n, ni) => (
            <div
              key={n.id}
              className={`veil-slide-right-pop veil-stagger-${(ni % 8) + 1} rounded-lg border p-2 text-xs ${
                n.read
                  ? "border-white/5 bg-black/20"
                  : n.kind === "friend_request"
                    ? "border-emerald-400/25 bg-emerald-400/5"
                    : "border-orange-400/20 bg-orange-400/5"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 font-medium text-white">
                  {n.kind === "friend_request" && (
                    <UserPlus className="veil-bounce-soft h-3 w-3 text-emerald-300" />
                  )}
                  {n.kind === "friend_accepted" && (
                    <Check className="h-3 w-3 text-emerald-300" />
                  )}
                  {n.title}
                </span>
                <span className="text-white/40">{formatTime(n.ts)}</span>
              </div>
              <p className="mt-0.5 text-white/70">{n.body}</p>
              {n.kind === "friend_request" && n.requestId && !n.read && (
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    onClick={() => onFriendAccept?.(n.requestId!)}
                    className="veil-hover-bounce veil-press flex flex-1 items-center justify-center gap-1 rounded-md bg-emerald-500/90 px-2 py-1 text-[11px] font-semibold text-black hover:bg-emerald-400"
                  >
                    <Check className="h-3 w-3" /> Accept
                  </button>
                  <button
                    onClick={() => onFriendDecline?.(n.requestId!)}
                    className="veil-hover-wobble veil-press flex-1 rounded-md border border-white/10 px-2 py-1 text-[11px] font-medium text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    Decline
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Backup panel (owner/mods) — the "jsDelivr links" safety net
// ---------------------------------------------------------------------------

type BackupStatus = {
  ok: boolean
  repo: string
  jsdelivr: string
  purge: string
  lastBackupAt: string | null
  lastCounts: { accounts: number; messages: number; dms: number } | null
  lastPushOk: boolean | null
  lastPushError: string | null
  lastPushAt: string | null
  autoBackupLive: boolean
  dbCounts: { accounts: number; messages: number; dms: number }
  historyCount: number
  seeds: string[]
}

function relTime(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return "never"
  if (ms < 45_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`
  return `${Math.round(ms / 86_400_000)} d ago`
}

function BackupPanel({
  token,
  toast,
  onClose,
  onRestored,
}: {
  token: string
  toast: (msg: string, kind?: "ok" | "err") => void
  onClose: () => void
  onRestored: () => void
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"none" | "backup" | "restore">("none")
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<BackupStatus>(`/api/chat-backup?token=${encodeURIComponent(token)}`)
      setStatus(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load backup status.")
    }
  }, [token])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const backupNow = async () => {
    setBusy("backup")
    try {
      await apiFetch("/api/chat-backup", {
        method: "POST",
        body: JSON.stringify({ token, action: "backup-now" }),
      })
      // The pipeline runs detached — give it a beat, then show the result.
      await new Promise((r) => setTimeout(r, 2200))
      await refresh()
      toast("Backup snapshot taken — committed and queued for publish.")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Backup failed.", "err")
    } finally {
      setBusy("none")
    }
  }

  const restoreNow = async () => {
    setBusy("restore")
    try {
      const data = await apiFetch<{
        messagesImported: number
        messagesSkipped: number
        accountsCreated: number
      }>("/api/chat-backup", {
        method: "POST",
        body: JSON.stringify({ token, action: "restore", source: "jsdelivr" }),
      })
      toast(
        `Restore done — ${data.messagesImported} message(s) imported, ${data.messagesSkipped} already present.`,
      )
      onRestored()
      await refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Restore failed.", "err")
    } finally {
      setConfirming(false)
      setBusy("none")
    }
  }

  const copyLink = async () => {
    if (!status) return
    try {
      await navigator.clipboard.writeText(status.jsdelivr)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast("Could not copy — long-press the link instead.", "err")
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute right-2 top-14 z-30 w-[22rem] rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <DatabaseBackup className="h-3.5 w-3.5 text-emerald-400" /> Chat backups
        </span>
        <button onClick={onClose} className="veil-hover-wobble text-white/50 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-400/20 bg-red-500/10 p-2 text-xs text-red-200">
          {error}
        </p>
      )}
      {!status && !error && (
        <p className="py-6 text-center text-xs text-white/40">Loading backup status…</p>
      )}

      {status && (
        <div className="space-y-2 text-xs">
          {/* Auto-backup loop state */}
          <div className="flex items-center justify-between rounded-lg border border-white/5 bg-black/30 px-2.5 py-2">
            <span className="text-white/60">Auto-backup</span>
            {status.autoBackupLive ? (
              <span className="flex items-center gap-1.5 font-medium text-emerald-300">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                Live · every 30s
              </span>
            ) : (
              <span className="font-medium text-amber-300">Loop not running</span>
            )}
          </div>

          {/* Snapshot facts */}
          <div className="grid grid-cols-3 gap-2">
            <div className="veil-slide-up-pop veil-stagger-1 rounded-lg border border-white/5 bg-black/20 px-2 py-1.5 text-center">
              <p className="text-[9px] uppercase tracking-wide text-white/40">Messages</p>
              <p className="text-sm font-semibold text-white/90">{status.lastCounts?.messages ?? status.dbCounts.messages}</p>
            </div>
            <div className="veil-slide-up-pop veil-stagger-2 rounded-lg border border-white/5 bg-black/20 px-2 py-1.5 text-center">
              <p className="text-[9px] uppercase tracking-wide text-white/40">Accounts</p>
              <p className="text-sm font-semibold text-white/90">{status.lastCounts?.accounts ?? status.dbCounts.accounts}</p>
            </div>
            <div className="veil-slide-up-pop veil-stagger-3 rounded-lg border border-white/5 bg-black/20 px-2 py-1.5 text-center">
              <p className="text-[9px] uppercase tracking-wide text-white/40">Snapshots</p>
              <p className="text-sm font-semibold text-white/90">{status.historyCount}</p>
            </div>
          </div>

          <p className="px-1 text-[11px] text-white/45">
            Last snapshot {relTime(status.lastBackupAt)}
            {status.lastCounts ? ` — ${status.lastCounts.messages} messages` : ""}
          </p>

          {/* Publish state */}
          <div
            className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
              status.lastPushOk
                ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-100/80"
                : "border-amber-300/20 bg-amber-400/5 text-amber-100/80"
            }`}
          >
            {status.lastPushOk ? (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
            ) : (
              <CloudOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            )}
            <p className="leading-relaxed">
              {status.lastPushOk ? (
                <>Published to GitHub — the jsDelivr link below is live and purged fresh.</>
              ) : (
                <>
                  Snapshots are committed locally and will publish to GitHub the
                  moment the repo token gets write access (one toggle — everything
                  is queued). Nothing is lost either way: the local snapshots roll
                  every 30 seconds.
                </>
              )}
            </p>
          </div>

          {/* jsDelivr link */}
          <div className="rounded-lg border border-white/5 bg-black/30 p-2">
            <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-white/40">
              Permanent CDN link (jsDelivr)
            </p>
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 text-[10px] text-orange-200/90">
                {status.jsdelivr}
              </code>
              <button
                onClick={() => void copyLink()}
                className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
                title="Copy link"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <a
                href={status.jsdelivr}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
                title="Open backup JSON"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-0.5">
            <button
              onClick={() => void backupNow()}
              disabled={busy !== "none"}
              className="veil-press veil-hover-glow flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-orange-400 px-3 py-2 text-xs font-semibold text-black transition hover:bg-orange-300 disabled:opacity-50"
            >
              {busy === "backup" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DatabaseBackup className="h-3.5 w-3.5" />}
              Back up now
            </button>
            {!confirming ? (
              <button
                onClick={() => setConfirming(true)}
                disabled={busy !== "none"}
                className="veil-press flex items-center justify-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-white/80 transition hover:border-white/30 hover:text-white disabled:opacity-50"
                title="Pull the latest snapshot back from the jsDelivr CDN"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Restore
              </button>
            ) : (
              <button
                onClick={() => void restoreNow()}
                disabled={busy !== "none"}
                className="veil-press veil-hover-glow flex items-center justify-center gap-1.5 rounded-lg border border-red-400/40 bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-500/25 disabled:opacity-50"
              >
                {busy === "restore" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Sure?
              </button>
            )}
          </div>
          {confirming && busy === "none" && (
            <p className="text-[10px] leading-relaxed text-white/45">
              Fetches the latest JSON from jsDelivr and imports anything missing
              (safe to run anytime — existing messages are skipped, and accounts
              come back as re-registerable placeholders).{" "}
              <button className="underline hover:text-white/70" onClick={() => setConfirming(false)}>
                cancel
              </button>
            </p>
          )}
        </div>
      )}
    </motion.div>
  )
}

function SearchPanel({
  messages,
  query,
  onQuery,
  onClose,
  onJump,
}: {
  messages: ChatMessage[]
  query: string
  onQuery: (q: string) => void
  onClose: () => void
  onJump: (msgId: string) => void
}) {
  const q = query.trim().toLowerCase()
  const matches = q
    ? messages.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          displayName(m.account).toLowerCase().includes(q) ||
          m.account.username.toLowerCase().includes(q),
      )
    : []
  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="absolute right-2 top-14 z-30 w-80 rounded-2xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center gap-2">
        <Search className="h-3.5 w-3.5 text-white/50" />
        <input
          autoFocus
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search messages…"
          className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
        />
        <button onClick={onClose} className="text-white/50 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-96 space-y-1.5 overflow-y-auto">
        {q && matches.length === 0 ? (
          <p className="py-6 text-center text-xs text-white/40">No matches.</p>
        ) : (
          matches.slice(0, 30).map((m) => (
            <button
              key={m.id}
              onClick={() => onJump(m.id)}
              className="veil-hover-glow block w-full rounded-lg border border-white/5 bg-black/30 p-2 text-left text-xs hover:bg-black/40"
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium" style={{ color: roleColor(m.account) }}>
                  {displayName(m.account)}
                </span>
                <span className="text-white/40">{formatTime(m.createdAt)}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-white/80">{m.content}</p>
            </button>
          ))
        )}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Mod panel
// ---------------------------------------------------------------------------

export function ModPanel({
  account,
  token,
  members,
  onMembers,
  onMessageDeleted,
  onClose,
  toast,
}: {
  account: ChatAccount
  token: string
  members: ChatAccount[]
  onMembers: (m: ChatAccount[]) => void
  onMessageDeleted: (messageId: string) => void
  onClose: () => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [target, setTarget] = useState("")
  const [reason, setReason] = useState("")
  const [messageId, setMessageId] = useState("")
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const operator = isVeilOperator(account)

  const filtered = members.filter(
    (m) =>
      m.username.toLowerCase().includes(query.toLowerCase()) ||
      displayName(m).toLowerCase().includes(query.toLowerCase()),
  )

  const call = async (
    action:
      | "ban"
      | "unban"
      | "mute"
      | "unmute"
      | "ip_ban"
      | "delete_message"
      | "add_mod"
      | "remove_mod",
    targetUsername?: string,
    msgId?: string,
  ) => {
    setBusy(true)
    try {
      const data = await apiFetch<{
        account?: ChatAccount
        deletedId?: string
        purgedMessages?: number
      }>("/api/chat-mod", {
        method: "POST",
        body: JSON.stringify({
          token,
          action,
          targetUsername: targetUsername?.trim(),
          reason,
          messageId: msgId,
        }),
      })
      if (data.deletedId) {
        onMessageDeleted(data.deletedId)
        toast("Message deleted.", "ok")
      } else if (data.account) {
        /* Live-room (git version) targets return a PARTIAL account —
         * never splice that over the full roster entry; the live poll
         * refreshes its flags within seconds. DB targets carry the full
         * row and update in place. */
        const isLive = data.account.id?.startsWith("live:")
        if (!isLive) {
          onMembers(
            members.map((m) => (m.id === data.account!.id ? data.account! : m)),
          )
        }
        const purged =
          (action === "ban" || action === "ip_ban") && data.purgedMessages
            ? ` · ${data.purgedMessages} message${data.purgedMessages === 1 ? "" : "s"} removed`
            : ""
        toast(`Action "${action}" applied to @${data.account.username}.${purged}`, "ok")
      } else {
        toast("Done.", "ok")
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Mod action failed.", "err")
    } finally {
      setBusy(false)
    }
  }

  const actions: {
    id: string
    label: string
    icon: React.ReactNode
    color: string
    operatorOnly?: boolean
    onClick: () => void
  }[] = [
    { id: "ban", label: "Ban", icon: <Ban className="h-3.5 w-3.5" />, color: "#ef4444", onClick: () => void call("ban", target) },
    { id: "unban", label: "Unban", icon: <Shield className="h-3.5 w-3.5" />, color: "#10b981", onClick: () => void call("unban", target) },
    { id: "mute", label: "Mute", icon: <MicOff className="h-3.5 w-3.5" />, color: "#f59e0b", onClick: () => void call("mute", target) },
    { id: "unmute", label: "Unmute", icon: <MessageCircle className="h-3.5 w-3.5" />, color: "#22d3ee", onClick: () => void call("unmute", target) },
    { id: "ip_ban", label: "IP Ban", icon: <ShieldOff className="h-3.5 w-3.5" />, color: "#dc2626", operatorOnly: true, onClick: () => void call("ip_ban", target) },
    { id: "add_mod", label: "Add Mod", icon: <ShieldCheck className="h-3.5 w-3.5" />, color: "#16a34a", operatorOnly: true, onClick: () => void call("add_mod", target) },
    { id: "remove_mod", label: "Remove Mod", icon: <User className="h-3.5 w-3.5" />, color: "#9ca3af", operatorOnly: true, onClick: () => void call("remove_mod", target) },
  ]

  return (
    <ModalShell
      title={`Moderation Panel ${operator ? "· Veil" : ""}`}
      icon={<Siren className="h-4 w-4 text-red-400" />}
      onClose={onClose}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-5">
        <div className="rounded-xl border border-red-400/20 bg-red-500/5 p-3 text-xs text-red-200">
          {operator
            ? "You have full super-admin powers — including IP bans and mod management."
            : "You have standard moderator powers. IP ban and mod management are reserved for the Veil operator."}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Target username
            </label>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="@username"
              autoCapitalize="none"
              list="member-mod-usernames"
              className="veil-focus-bloom w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
            />
            <datalist id="member-mod-usernames">
              {members.map((m) => (
                <option key={m.id} value={m.username} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-white/70">
              Reason (optional)
            </label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Rule violation, spam, etc."
              className="veil-focus-bloom w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {actions.map((a) => {
            const disabled = !operator && a.operatorOnly
            return (
              <button
                key={a.id}
                disabled={busy || disabled || !target.trim()}
                onClick={a.onClick}
                className="veil-press veil-hover-glow flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                style={{ backgroundColor: a.color + "33", border: `1px solid ${a.color}` }}
              >
                {a.icon}
                {a.label}
                {a.operatorOnly && (
                  <span className="ml-1 text-[9px] uppercase text-orange-300">Owner</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="rounded-xl border border-white/10 bg-black/30 p-3">
          <label className="mb-1 block text-xs font-medium text-white/70">
            Delete a message (by ID)
          </label>
          <div className="flex gap-2">
            <input
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
              placeholder="Message ID"
              className="veil-focus-bloom flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
            />
            <button
              disabled={busy || !messageId.trim()}
              onClick={() => void call("delete_message", undefined, messageId)}
              className="veil-press veil-hover-glow flex items-center gap-1.5 rounded-lg bg-red-500/80 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter members…"
              className="veil-focus-bloom flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
            />
            <span className="text-xs text-white/50">{filtered.length} shown</span>
          </div>
          <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-2">
            {filtered.map((m, mi) => (
              <div
                key={m.id}
                className={`veil-slide-left-pop veil-stagger-${(mi % 8) + 1} flex items-center justify-between rounded-md px-2 py-1.5 text-xs ${
                  m.banned || m.ipBanned
                    ? "bg-red-500/10 opacity-70"
                    : m.muted
                      ? "bg-orange-500/10"
                      : "hover:bg-white/5"
                }`}
              >
                <div className="flex items-center gap-2">
                  <AvatarWithAccessory
                    account={m}
                    size={20}
                  />
                  <span style={{ color: roleColor(m) }} className="font-medium">
                    {displayName(m)}
                  </span>
                  <span className="text-white/40">@{m.username}</span>
                  {roleLabel(m) && (
                    <span
                      className="rounded px-1 py-0.5 text-[9px] uppercase text-white"
                      style={{ backgroundColor: roleColor(m) }}
                    >
                      {roleLabel(m)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {m.muted && <span className="text-[9px] text-orange-300">MUTED</span>}
                  {m.banned && <span className="text-[9px] text-red-300">BANNED</span>}
                  {m.ipBanned && <span className="text-[9px] text-red-400">IP-BAN</span>}
                  <button
                    onClick={() => setTarget(m.username)}
                    className="veil-hover-bounce rounded bg-white/10 px-1.5 py-0.5 text-[10px] hover:bg-white/20"
                  >
                    select
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Player list sidebar
// ---------------------------------------------------------------------------

function PlayerList({
  account,
  members,
  presence,
  onOpenProfile,
  onClose,
}: {
  account: ChatAccount
  members: ChatAccount[]
  presence: PresenceUser[]
  onOpenProfile: (accountId: string) => void
  onClose: () => void
}) {
  const onlineIds = useMemo(
    () => new Set(presence.map((p) => p.accountId)),
    [presence],
  )

  const buckets = useMemo(() => {
    // EVERYONE shows up in Online/Offline — mods and the owner included.
    // Rows keep their inline OWNER/MOD badge + role color, and the list
    // sorts owner first, then mods, then members, alphabetical within
    // each rank.
    const notBanned = members.filter((m) => !m.banned)
    const rank = (m: ChatAccount) => (isVeilOperator(m) ? 0 : isMod(m) ? 1 : 2)
    const byRank = (a: ChatAccount, b: ChatAccount) =>
      rank(a) - rank(b) ||
      displayName(a).localeCompare(displayName(b))
    const online = notBanned.filter((m) => onlineIds.has(m.id)).sort(byRank)
    const offline = notBanned.filter((m) => !onlineIds.has(m.id)).sort(byRank)
    return { online, offline }
  }, [members, onlineIds])

  const renderRow = (m: ChatAccount, online: boolean, idx: number) => {
    const isMe = m.id === account.id
    return (
      <motion.button
        type="button"
        key={m.id}
        initial={{ opacity: 0, x: 10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: Math.min(idx * 0.03, 0.3), duration: 0.2, ease: "easeOut" }}
        whileHover={{ x: 3 }}
        onClick={() => onOpenProfile(m.id)}
        title={`${displayName(m)} — view profile`}
        className={`veil-hover-glow flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none ring-orange-400/60 transition focus-visible:ring-2 ${
          isMe ? "bg-orange-400/10" : "hover:bg-white/5"
        }`}
      >
        <div className={`veil-swirl-in veil-stagger-${(idx % 8) + 1} relative`}>
          <AvatarWithAccessory account={m} size={28} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-black/60 ${
              online ? "veil-online-pulse bg-emerald-400" : "bg-white/30"
            }`}
          />
        </div>
        <div className={`veil-slide-left-pop veil-stagger-${(idx % 8) + 1} min-w-0 flex-1`}>
          <div className="flex items-center gap-1.5">
            <span
              className="truncate text-sm font-medium"
              style={{ color: roleColor(m) }}
            >
              {displayName(m)}
            </span>
            {m.tag && <TagBadge tag={m.tag} color={m.tagColor} />}
          </div>
          <div className="truncate text-[10px] text-white/40">@{m.username}</div>
        </div>
        {roleLabel(m) && (
          <span
            className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase text-white"
            style={{ backgroundColor: roleColor(m) }}
          >
            {roleLabel(m)}
          </span>
        )}
      </motion.button>
    )
  }

  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      className="flex w-48 flex-col border-l border-white/10 bg-[#101022] text-white"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <Users className="h-3.5 w-3.5 text-orange-400" />
          Players
        </span>
        <button
          onClick={onClose}
          className="veil-hover-wobble rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="flex-1 space-y-3 overflow-y-auto p-2"
        style={{ scrollbarWidth: "thin" }}
      >
        <section>
          <h4 className="veil-text-shine mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
            Online — {buckets.online.length}
          </h4>
          <div className="space-y-0.5">
            {buckets.online.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-white/30">
                No one online right now.
              </p>
            ) : (
              buckets.online.map((m, i) => renderRow(m, true, i))
            )}
          </div>
        </section>
        <section>
          <h4 className="veil-text-shine mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
            Offline — {buckets.offline.length}
          </h4>
          <div className="space-y-0.5">
            {/* Everyone shows — the panel scrolls. The old 30-row cap hid
                real players ("Lone_Wolf isn't there"). */}
            {buckets.offline.map((m, i) => renderRow(m, false, i))}
          </div>
        </section>
      </div>
    </motion.aside>
  )
}

// ---------------------------------------------------------------------------
// Music bar (Spotify embed)
// ---------------------------------------------------------------------------

function MusicBar({ onClose }: { onClose: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <motion.div
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 80, opacity: 0 }}
      className="border-t border-white/10 bg-[#0d0d1f] text-white"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="veil-pulse-glow grid h-9 w-9 place-items-center rounded-md bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
          <Music className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium">Veil Radio</div>
          <div className="truncate text-[11px] text-white/50">
            Now playing: featured artist
          </div>
        </div>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="veil-hover-wobble rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        <button
          onClick={onClose}
          className="veil-hover-wobble rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
          title="Hide player"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <iframe
              src={viaProxy(
                `https://open.spotify.com/embed/artist/${SPOTIFY_ARTIST_ID}?theme=0`,
              )}
              width="100%"
              height="232"
              frameBorder={0}
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              title="Veil Radio"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Slash-commands engine (the new chat engine) — /roll /flip /8ball /me
// /shrug /tableflip /unflip /lenny /help. Runs at send time, emits normal
// messages (with /fx or /me markers) so every client renders them.
// ---------------------------------------------------------------------------

const EIGHT_BALL_ANSWERS = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes — definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
]

interface SlashResult {
  /** "send" — ship this content as a message. "local" — show a hint, send nothing. */
  kind: "send" | "local"
  content: string
}

function rollDice(count: number, sides: number): number[] {
  const rolls: number[] = []
  const n = Math.max(1, Math.min(20, count))
  const s = Math.max(2, Math.min(1000, sides))
  for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * s))
  return rolls
}

function runSlashCommand(raw: string): SlashResult | null {
  const input = raw.trim()
  if (!input.startsWith("/")) return null
  const spaceIdx = input.indexOf(" ")
  const cmd = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? "" : input.slice(spaceIdx + 1).trim()

  switch (cmd) {
    case "/me":
      if (!rest) return { kind: "local", content: "Usage: /me <action> — e.g. /me slides into the chat" }
      return { kind: "send", content: `/me ${rest}` }
    case "/roll": {
      const m = /^(\d{0,3})d(\d{1,4})$/i.exec(rest.replace(/\s+/g, ""))
      let count = 1
      let sides = 6
      if (m) {
        count = Math.max(1, Math.min(20, parseInt(m[1] || "1", 10)))
        sides = Math.max(2, Math.min(1000, parseInt(m[2], 10)))
      } else if (/^\d{1,4}$/.test(rest)) {
        sides = Math.max(2, Math.min(1000, parseInt(rest, 10)))
      }
      const rolls = rollDice(count, sides)
      const total = rolls.reduce((a, b) => a + b, 0)
      const detail = count > 1 ? ` (${rolls.join(" + ")})` : ""
      return {
        kind: "send",
        content: `/fx 🎲 rolled ${count}d${sides} → ${total}${detail}`,
      }
    }
    case "/flip": {
      const heads = Math.random() < 0.5
      return { kind: "send", content: `/fx 🪙 flipped a coin → ${heads ? "HEADS" : "TAILS"}` }
    }
    case "/8ball":
    case "/eightball": {
      const q = rest ? ` “${rest.slice(0, 120)}” — ` : " "
      const answer = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)]
      return { kind: "send", content: `/fx 🔮 8-ball:${q}${answer}` }
    }
    case "/shrug":
      return { kind: "send", content: `/fx ¯\\_(ツ)_/¯` }
    case "/tableflip":
      return { kind: "send", content: `/fx (╯°□°)╯︵ ┻━┻` }
    case "/unflip":
      return { kind: "send", content: `/fx ┳━┳ ノ( ゜ー゜ノ)` }
    case "/lenny":
      return { kind: "send", content: `/fx ( ͡° ͜ʖ ͡°)` }
    case "/help":
      return {
        kind: "local",
        content:
          "commands — /roll 2d20 · /flip · /8ball <question> · /me <action> · /shrug · /tableflip · /unflip · /lenny",
      }
    default:
      return {
        kind: "local",
        content: `unknown command ${cmd} — try /help`,
      }
  }
}

// ---------------------------------------------------------------------------
// Single message rendering
// ---------------------------------------------------------------------------

function MessageContent({ content }: { content: string }) {
  const trimmed = content.trim()
  // ── Effects engine (/fx) ──────────────────────────────────────────
  // Slash-command results are stored as "/fx <text>" so every client
  // renders them as a centered effect chip, and "/me <text>" renders as
  // an italic action line (IRC-style). Both stay readable as plain text
  // anywhere that hasn't upgraded yet.
  if (/^\/fx\s+/.test(trimmed)) {
    const text = trimmed.replace(/^\/fx\s+/, "")
    return (
      <div className="my-1 flex justify-center">
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={CHAT_POP}
          className="rounded-full border border-orange-400/25 bg-orange-400/10 px-3.5 py-1 text-[12.5px] font-medium tracking-wide text-orange-200 shadow-[0_0_18px_-4px_rgba(251,146,60,0.35)]"
        >
          {text}
        </motion.span>
      </div>
    )
  }
  if (/^\/me\s+/.test(trimmed)) {
    return (
      <motion.p
        initial={{ opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="text-sm italic text-white/70"
      >
        {trimmed.replace(/^\/me\s+/, "")}
      </motion.p>
    )
  }
  const file = parseChatFileUrl(trimmed)
  if (file) {
    return <FileBubble f={file} />
  }
  if (isGifContent(trimmed) || isImageUrl(trimmed)) {
    return <MediaImage src={viaProxy(gifSrc(trimmed))} alt="shared gif" />
  }
  const spotifyEmbed = extractSpotifyEmbed(trimmed)
  if (spotifyEmbed) {
    return (
      <iframe
        src={viaProxy(spotifyEmbed)}
        width="100%"
        height="152"
        frameBorder={0}
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
        className="mt-1 max-w-sm rounded-lg border border-white/10"
        title="Spotify embed"
      />
    )
  }
  const ytEmbed = extractYouTubeEmbed(trimmed)
  if (ytEmbed) {
    return (
      <iframe
        src={viaProxy(ytEmbed)}
        width="100%"
        height="200"
        frameBorder={0}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        loading="lazy"
        className="mt-1 max-w-sm rounded-lg border border-white/10"
        title="YouTube embed"
      />
    )
  }
  // Plain text. Render with simple URL detection.
  const parts = trimmed.split(/(https?:\/\/[^\s]+)/g)
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-white/90">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          /* 2026-10-10: links to THIS repo's jsDelivr CDN fronts (m1..m10,
           * site/, cdn/ — the "open in a new tab" mirror copies of Veil)
           * render as PLAIN TEXT, not new-tab anchors. The user asked for
           * the m10 jsDelivr link to stop opening in a new tab; the whole
           * front family gets the same treatment so the chat stays
           * consistent (they all point at the same live app anyway). */
          isVeilCdnFrontLink(p) ? (
            <span key={i} className="break-all text-white/55">
              {p}
            </span>
          ) : (
            <a
              key={i}
              href={p}
              target="_blank"
              rel="noopener noreferrer"
              className="veil-msg-link text-orange-300"
            >
              {p}
            </a>
          )
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </p>
  )
}

/** Shared image/GIF — fades + settles in once the bytes actually land
 * (lazy images used to pop in harshly mid-scroll), with a gentle zoom
 * on hover. */
function MediaImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <motion.img
      src={src}
      alt={alt}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      initial={false}
      animate={loaded ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ scale: 1.025 }}
      className="mt-1 max-h-64 max-w-xs rounded-lg border border-white/10 object-cover"
    />
  )
}

const MessageRow = memo(function MessageRow({
  msg,
  prev,
  isMe,
  canEdit,
  editing,
  editDraft,
  editBusy,
  fresh,
  myId,
  onReply,
  onPin,
  onDelete,
  onEditStart,
  onEditDraft,
  onEditSave,
  onEditCancel,
  onOpenProfile,
  onReact,
}: {
  msg: ChatMessage
  prev?: ChatMessage
  isMe: boolean
  canEdit: boolean
  editing: boolean
  editDraft: string
  editBusy: boolean
  /** Just arrived live (socket or own send) — plays the landing
   * animation + the orange glow that burns off. History loads as false. */
  fresh: boolean
  myId: string
  onReply: (msg: ChatMessage) => void
  onPin: (msg: ChatMessage) => void
  onDelete: (msg: ChatMessage) => void
  onEditStart: (msg: ChatMessage) => void
  onEditDraft: (text: string) => void
  onEditSave: () => void
  onEditCancel: () => void
  onOpenProfile: (accountId: string) => void
  onReact: (msg: ChatMessage, emoji: string) => void
}) {
  const editRef = useRef<HTMLTextAreaElement | null>(null)
  const [showReactBar, setShowReactBar] = useState(false)
  // Group with previous message if same author within 5 minutes (and the
  // same day — the divider always starts a fresh group).
  const grouped =
    prev &&
    prev.account.id === msg.account.id &&
    dayKeyOf(prev.createdAt) === dayKeyOf(msg.createdAt) &&
    new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() <
      5 * 60 * 1000

  return (
    <div
      className={`veil-msg-row group relative flex gap-3 px-3 py-1 transition-colors hover:bg-white/[0.03] ${
        grouped ? "py-0.5" : "mt-2"
      } ${fresh ? "veil-msg-in veil-msg-fresh" : ""} ${
        /* mega tier: directional entrance — others slide in from the left,
         * own messages from the right (fancy-gated classes; they take the
         * transform slot from veil-msg-in only while the setting is ON). */
        isMe ? "veil-slide-right-pop" : "veil-slide-left-pop"
      }`}
    >
      <div className="w-10 shrink-0">
        {!grouped && (
          <motion.button
            type="button"
            onClick={() => onOpenProfile(msg.account.id)}
            whileHover={{ scale: 1.12 }}
            whileTap={{ scale: 0.92 }}
            transition={CHAT_POP}
            className="rounded-full outline-none ring-orange-400/60 transition-colors focus-visible:ring-2"
            title={`${displayName(msg.account)} — view profile`}
          >
            <AvatarWithAccessory
              account={{
                avatarColor: msg.account.avatarColor,
                avatarImage: msg.account.avatarImage,
                pfpAccessory: msg.account.pfpAccessory,
                displayName: msg.account.displayName,
                username: msg.account.username,
              }}
              size={40}
            />
          </motion.button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={() => onOpenProfile(msg.account.id)}
              className="veil-hover-glow rounded text-left text-sm font-semibold outline-none ring-orange-400/60 transition hover:underline focus-visible:ring-2"
              style={{ color: roleColor(msg.account) }}
            >
              {displayName(msg.account)}
            </button>
            {msg.account.tag && (
              <TagBadge tag={msg.account.tag} color={msg.account.tagColor} />
            )}
            {roleLabel(msg.account) && (
              <span
                className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase text-white"
                style={{ backgroundColor: roleColor(msg.account) }}
              >
                {roleLabel(msg.account)}
              </span>
            )}
            <span className="veil-hover-glow text-[10px] text-white/40">
              {formatTime(msg.createdAt)}
            </span>
          </div>
        )}
        {msg.replyTo && (
          <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="mb-1 flex items-center gap-1.5 rounded-md border-l-2 border-orange-400/50 bg-white/[0.03] px-2 py-0.5 text-[11px] text-white/50"
          >
            <Reply className="h-3 w-3" />
            <span className="font-medium text-white/70">
              @{msg.replyToUsername || "unknown"}
            </span>
            <span className="truncate">
              {msg.replyToContent?.slice(0, 80) || "(message)"}
            </span>
          </motion.div>
        )}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          {editing ? (
            <div className="mt-1 w-full">
              <textarea
                ref={(el) => {
                  editRef.current = el
                  if (el && document.activeElement !== el) {
                    el.focus()
                    const pos = Math.min(editDraft.length, el.value.length)
                    try {
                      el.setSelectionRange(pos, pos)
                    } catch {
                      /* detached */
                    }
                  }
                }}
                value={editDraft}
                disabled={editBusy}
                onChange={(e) => onEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    onEditSave()
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    onEditCancel()
                  }
                }}
                rows={3}
                className="veil-focus-bloom w-full resize-none rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none focus:border-orange-400/50 disabled:opacity-60"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <span className="mr-auto text-[10px] text-white/35">
                  Enter to save · Esc to cancel
                </span>
                <button
                  type="button"
                  onClick={onEditCancel}
                  disabled={editBusy}
                  className="veil-hover-wobble rounded-md px-2.5 py-1 text-xs font-medium text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onEditSave}
                  disabled={editBusy || !editDraft.trim()}
                  className="veil-press veil-hover-glow flex items-center gap-1 rounded-md bg-orange-400 px-2.5 py-1 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-40"
                >
                  {editBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <MessageContent content={msg.content} />
              {msg.editedAt && (
                <span
                  className="select-none align-baseline text-[9.5px] italic text-white/30"
                  title={`edited ${formatTime(msg.editedAt)}`}
                >
                  (edited)
                </span>
              )}
            </>
          )}
        </div>
        {/* Reaction chips — click to toggle, orange ring when it's yours. */}
        {(msg.reactions?.length ?? 0) > 0 && !editing && (
          <div className="mt-1 flex flex-wrap gap-1">
            {msg.reactions!.map((r) => {
              const mine = r.usernames.includes(myId)
              return (
                <motion.button
                  key={r.emoji}
                  type="button"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={CHAT_POP}
                  whileHover={{ scale: 1.14, y: -1 }}
                  whileTap={{ scale: 0.82 }}
                  onClick={() => onReact(msg, r.emoji)}
                  title={
                    mine
                      ? `You reacted ${r.emoji} — click to remove`
                      : `React ${r.emoji}`
                  }
                  aria-label={`${r.emoji} ${r.usernames.length} reaction${r.usernames.length === 1 ? "" : "s"}${mine ? ", including you" : ""}`}
                  className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors ${
                    mine
                      ? "border-orange-400/60 bg-orange-400/15 text-orange-200"
                      : "border-white/10 bg-white/[0.05] text-white/60 hover:border-white/20 hover:bg-white/10"
                  }`}
                >
                  <span className="veil-hover-bounce text-[12px] leading-none">{r.emoji}</span>
                  <span
                    key={r.usernames.length}
                    className="veil-count-bump veil-hover-wobble font-semibold tabular-nums"
                  >
                    {r.usernames.length}
                  </span>
                </motion.button>
              )
            })}
          </div>
        )}
      </div>
      {/* Hover toolbar — glides down + fades in on row hover (the old
          hidden/flex pair popped with no transition at all). focus-within
          keeps it reachable for keyboard users (Tab into the actions). */}
      <div className="absolute right-2 top-0 z-10 flex -translate-y-1 scale-95 items-center gap-0.5 rounded-md border border-white/10 bg-[#1c1c34] px-1 py-0.5 text-white/70 opacity-0 shadow-lg transition-all duration-150 ease-out pointer-events-none group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 group-hover:pointer-events-auto focus-within:translate-y-0 focus-within:scale-100 focus-within:opacity-100 focus-within:pointer-events-auto">
        <div className="relative">
          <motion.button
            onClick={() => setShowReactBar((s) => !s)}
            whileHover={{ scale: 1.2 }}
            whileTap={{ scale: 0.85 }}
            transition={CHAT_POP}
            className="rounded p-1 hover:bg-white/10"
            title="Add reaction"
            aria-label="Add reaction"
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </motion.button>
          <AnimatePresence>
            {showReactBar && (
              <motion.div
                initial={{ opacity: 0, scale: 0.75, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: -6 }}
                transition={CHAT_POP}
                style={{ transformOrigin: "top right" }}
                className="absolute right-0 top-8 z-30 flex gap-0.5 rounded-lg border border-white/10 bg-[#1c1c34] p-1 shadow-xl"
              >
                {QUICK_REACTIONS.map((e) => (
                  <motion.button
                    key={e}
                    type="button"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ ...CHAT_POP, delay: 0.03 * QUICK_REACTIONS.indexOf(e) }}
                    whileHover={{ scale: 1.4, rotate: 8 }}
                    whileTap={{ scale: 0.75 }}
                    onClick={() => {
                      onReact(msg, e)
                      setShowReactBar(false)
                    }}
                    className="grid h-7 w-7 place-items-center rounded-md text-base leading-none"
                    title={`React ${e}`}
                    aria-label={`React ${e}`}
                  >
                    {e}
                  </motion.button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <motion.button
          onClick={() => onReply(msg)}
          whileHover={{ scale: 1.2, y: -1 }}
          whileTap={{ scale: 0.85 }}
          transition={CHAT_POP}
          className="rounded p-1 hover:bg-white/10"
          title="Reply"
        >
          <Reply className="h-3.5 w-3.5" />
        </motion.button>
        <motion.button
          onClick={() => onPin(msg)}
          whileHover={{ scale: 1.2, y: -1 }}
          whileTap={{ scale: 0.85 }}
          transition={CHAT_POP}
          className="rounded p-1 hover:bg-white/10"
          title="Pin"
        >
          <Pin className="h-3.5 w-3.5" />
        </motion.button>
        {canEdit && !editing && (
          <motion.button
            onClick={() => onEditStart(msg)}
            whileHover={{ scale: 1.2, y: -1 }}
            whileTap={{ scale: 0.85 }}
            transition={CHAT_POP}
            className="rounded p-1 hover:bg-white/10"
            title="Edit"
          >
            <Pencil className="h-3.5 w-3.5" />
          </motion.button>
        )}
        {isMe && (
          <motion.button
            onClick={() => onDelete(msg)}
            whileHover={{ scale: 1.2, y: -1 }}
            whileTap={{ scale: 0.85 }}
            transition={CHAT_POP}
            className="rounded p-1 hover:bg-red-500/20 hover:text-red-300"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </motion.button>
        )}
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Main ChatApp
// ---------------------------------------------------------------------------

export function ChatApp({ url, onBack }: { url?: string; onBack?: () => void }) {
  const [account, setAccount] = useState<ChatAccount | null>(null)
  const [token, setToken] = useState<string>("")
  const [bootstrapped, setBootstrapped] = useState(false)

  const [channelId, setChannelId] = useState<string>("main")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [members, setMembers] = useState<ChatAccount[]>([])
  const [presence, setPresence] = useState<PresenceUser[]>([])
  const [dms, setDms] = useState<DM[]>([])
  const [input, setInput] = useState("")
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [typingUsers, setTypingUsers] = useState<
    Record<string, { username: string; displayName: string; ts: number }[]>
  >({})
  /* Fresh message ids — rows that just arrived (socket or own send) play
   * the entrance spring + the landing glow. History loads render as false
   * (no mass animation on channel switch), and the set is pruned to the
   * newest 30 so it never grows unbounded. */
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pinned, setPinned] = useState<ChatMessage[]>([])
  const [notifications, setNotifications] = useState<ChatNotification[]>([])

  /* ---- live-room bridge: the git version's shared chat (written by the
   * CDN copies through the GitHub API) merges into #general so both
   * worlds are ONE room. Bridged users render like any other member —
   * no special tag, same avatars; their ids are "live:<name>" so mod
   * actions on them route through /api/chat-mod's live branch. */
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([])
  const [liveMembers, setLiveMembers] = useState<
    (PresenceUser & {
      online: boolean
      muted?: boolean
      banned?: boolean
      banReason?: string | null
    })[]
  >([])
  useEffect(() => {
    if (!account) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    /* Change signature — the room is usually quiet, and re-setting the
     * arrays every 6s re-rendered the ENTIRE message list (mergedMessages
     * identity churn) even when nothing changed. Compare first, set only
     * on a real difference. */
    let lastMsgSig = ""
    let lastUserSig = ""
    const tick = async () => {
      try {
        const res = await fetch("/api/chat-live", { cache: "no-store" })
        if (res.ok) {
          const data = (await res.json()) as {
            ok: boolean
            messages?: ChatMessage[]
            users?: (PresenceUser & {
              online: boolean
              muted?: boolean
              banned?: boolean
              banReason?: string | null
            })[]
          }
          if (!stopped && data.ok) {
            const msgs = Array.isArray(data.messages) ? data.messages : []
            const users = Array.isArray(data.users) ? data.users : []
            const msgSig = msgs.map((m) => `${m.id}:${m.content.length}`).join("|")
            const userSig = users.map((u) => `${u.accountId}:${u.online ? 1 : 0}:${u.muted ? 1 : 0}:${u.banned ? 1 : 0}`).join("|")
            if (msgSig !== lastMsgSig) {
              lastMsgSig = msgSig
              setLiveMessages(msgs)
            }
            if (userSig !== lastUserSig) {
              lastUserSig = userSig
              setLiveMembers(users)
            }
          }
        }
      } catch {
        /* next tick retries — the room is best-effort */
      }
      /* next tick — git users' messages land on the shared file within
       * seconds of their send (the writer purges the CDN), so a tight
       * poll keeps the website's #general as live as the git copies'
       * without any reload */
      if (!stopped) timer = setTimeout(tick, 6_000)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [account?.id])

  /* Silent channel backfill — git users can POST into every public
   * channel through the app's API (no socket on their side), so a quiet
   * id-union refetch of the ACTIVE channel every 15s surfaces those
   * without a reload. Edits/deletes are reconciled too (row content is
   * replaced when the refetched copy differs). */
  useEffect(() => {
    if (!account) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const cid = channelIdRef.current
        const data = await apiFetch<{ messages: ChatMessage[] }>(
          `/api/chat-data?channel=${encodeURIComponent(cid)}${
            !CHANNELS.some((c) => c.id === cid)
              ? `&token=${encodeURIComponent(token)}`
              : ""
          }`,
        )
        if (!stopped && data.messages) {
          const fresh = data.messages
          setMessages((prev) => {
            /* EMPTY-RESPONSE GUARD: an API hiccup (restart window, DB
             * rehydrate, proxy error page parsed as an empty list) must
             * never wipe the visible chat — that was the "messages blink
             * out of existence" bug. Only reconcile when the server sent
             * a real, non-empty page. */
            if (fresh.length === 0 && prev.length > 0) return prev
            const byId = new Map(prev.map((m) => [m.id, m]))
            let changed = false
            for (const m of fresh) {
              const cur = byId.get(m.id)
              if (!cur) {
                byId.set(m.id, m)
                changed = true
              } else if (
                cur.content !== m.content ||
                cur.editedAt !== m.editedAt
              ) {
                byId.set(m.id, m)
                changed = true
              }
            }
            /* rows that vanished (deleted elsewhere) drop out too — EXCEPT
             * rows older than the fetch window (a "load older" prepend):
             * they're simply beyond the latest-100 page the refetch saw,
             * not deleted. */
            const keep = new Set(fresh.map((m) => m.id))
            const freshOldest =
              fresh.length > 0
                ? new Date(fresh[0].createdAt).getTime()
                : Number.POSITIVE_INFINITY
            const merged = [...byId.values()].filter(
              (m) =>
                keep.has(m.id) ||
                m.id.startsWith("lv-") ||
                new Date(m.createdAt).getTime() < freshOldest,
            )
            if (!changed && merged.length === prev.length) return prev
            merged.sort(
              (a, b) =>
                new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
            )
            return merged
          })
        }
      } catch {
        /* silent — the socket + manual refetches still cover us */
      }
      if (!stopped) timer = setTimeout(tick, 15_000)
    }
    timer = setTimeout(tick, 15_000)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [account?.id])

  /* The #general render list: DB messages + live-room messages, deduped
   * by id (live rows carry "lv-" ids), interleaved by time. */
  const mergedMessages = useMemo(() => {
    if (channelId !== "main" || liveMessages.length === 0) return messages
    const seen = new Set(messages.map((m) => m.id))
    const extra = liveMessages.filter((m) => m.id && m.content && !seen.has(m.id))
    if (extra.length === 0) return messages
    const all = [...messages, ...extra]
    all.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    return all
  }, [messages, liveMessages, channelId])

  /* Live-room users as PlayerList members (merged below the DB members,
   * same rank bucket as everyone else) + their online presence. Muted /
   * banned flags ride along so the MOD PANEL can act on git users (and
   * lift bans — banned live users are included in the list on purpose). */
  const liveAccounts = useMemo(
    () =>
      liveMembers.map((u) => ({
        id: u.accountId,
        username: u.username,
        displayName: u.displayName,
        avatarColor: u.avatarColor,
        avatarImage: u.avatarImage ?? null,
        bio: "",
        role: "member" as const,
        muted: !!u.muted,
        banned: !!u.banned,
        banReason: u.banReason ?? null,
        ipBanned: false,
        coins: 0,
        tag: null,
        tagColor: null,
        pfpAccessory: null,
        createdAt: new Date(0).toISOString(),
      })),
    [liveMembers],
  )
  const playersMembers = useMemo(() => {
    if (liveAccounts.length === 0) return members
    const known = new Set(members.map((m) => m.id))
    return [...members, ...liveAccounts.filter((a) => !known.has(a.id))]
  }, [members, liveAccounts])
  const playersPresence = useMemo(() => {
    if (liveMembers.length === 0) return presence
    const known = new Set(presence.map((p) => p.accountId))
    const extra = liveMembers
      .filter((u) => u.online && !known.has(u.accountId))
      .map(({ online: _online, ...p }) => p)
    return extra.length > 0 ? [...presence, ...extra] : presence
  }, [presence, liveMembers])

  /* Channel continuity across dev-server restarts: the watchdog restart
   * triggers a page reload (HMR reconnect) which reopens the chat via
   * sessionStorage in page.tsx — but the channel itself used to reset to
   * #general. Restored in an effect (NOT a state initializer): this
   * component server-renders, and sessionStorage doesn't exist during SSR
   * (an initializer would also risk a hydration mismatch). DM ids are
   * never restored — only public CHANNELS ids. */
  const channelInit = useRef(true)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("veil:chat-channel")
      if (saved && saved !== "main" && CHANNELS.some((c) => c.id === saved)) {
        setChannelId(saved)
      }
    } catch {
      /* private mode */
    }
  }, [])
  useEffect(() => {
    if (channelInit.current) {
      channelInit.current = false
      return
    }
    try {
      if (CHANNELS.some((c) => c.id === channelId))
        sessionStorage.setItem("veil:chat-channel", channelId)
    } catch {
      /* private mode — best effort */
    }
  }, [channelId])

  // File attachment upload (up to 300 MB) — XHR for real progress.
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null)

  // UI panels
  const [showMembers, setShowMembers] = useState(true)
  /* Which social side panel is open (its OWN header button, next to the
   * players toggle — owner ask). null → the player list shows instead. */
  const [socialPanel, setSocialPanel] = useState<null | "friends" | "dms" | "groups">(null)
  const [showMusic, setShowMusic] = useState(false)
  /* Games modal — Coin Flip + Blackjack betting real Veil Coins. */
  const [showGames, setShowGames] = useState(false)
  const [channelSwitcher, setChannelSwitcher] = useState(false)
  const [showGif, setShowGif] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showShop, setShowShop] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  /* Viewing another player's profile (read-only card with their bio).
   * Falls back to the latest known snapshot (message author or member
   * row) if the account isn't in the members list anymore. */
  const [viewingProfile, setViewingProfile] = useState<ChatAccount | null>(null)
  const [showExtensions, setShowExtensions] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [showMod, setShowMod] = useState(false)
  const [showPinned, setShowPinned] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showBackup, setShowBackup] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [showDmMenu, setShowDmMenu] = useState(false)
  const [friends, setFriends] = useState<ChatAccount[]>([])
  const [showFriendMenu, setShowFriendMenu] = useState(false)
  const [friendTarget, setFriendTarget] = useState("")
  /* Friend requests: incoming (waiting on US) + outgoing (waiting on
   * THEM) + a busy flag so double-clicks can't double-send. */
  const [friendRequestsIn, setFriendRequestsIn] = useState<FriendRequestRow[]>([])
  const [friendRequestsOut, setFriendRequestsOut] = useState<FriendRequestRow[]>([])
  const [friendBusy, setFriendBusy] = useState(false)
  const [dmTarget, setDmTarget] = useState("")
  /* True while a channel switch's first fetch is in flight — drives the
   * slim loading bar instead of wiping the message list to empty. */
  const [channelLoading, setChannelLoading] = useState(false)

  /* ---- Group chats: creation form (channel switcher), invite modal,
   * rename modal + leave confirm (header). ---- */
  const [showGroupMenu, setShowGroupMenu] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [groupPicked, setGroupPicked] = useState<Record<string, boolean>>({})
  const [groupUserInput, setGroupUserInput] = useState("")
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [renameDraft, setRenameDraft] = useState("")
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  /* ---- Unread badges per channel/DM + mention pings. Keys are channel
   * ids; cleared when the channel is opened. ---- */
  const [unread, setUnread] = useState<Record<string, number>>({})

  /* ---- "Load older" pagination state. ---- */
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // Extensions
  const [extensions, setExtensions] = useState<ExtensionState>(DEFAULT_EXTENSIONS)
  const [blockedAds, setBlockedAds] = useState(0)

  // Socket ref + active channel ref (so we can resubscribe on channel change).
  const socketRef = useRef<Socket | null>(null)
  const channelIdRef = useRef<string>(channelId)
  channelIdRef.current = channelId
  const accountRef = useRef<ChatAccount | null>(account)
  accountRef.current = account
  const messagesRef = useRef<ChatMessage[]>(messages)
  messagesRef.current = messages
  /* Live DM list mirror — the socket handlers (unread badges, mention
   * labels, dm_removed) need the CURRENT dms without re-subscribing. */
  const dmsRef = useRef<DM[]>(dms)
  dmsRef.current = dms
  /* Rooms silently watched (unread badges) — replayed after a socket
   * reconnect so cross-channel updates resume without a reload. */
  const watchedRoomsRef = useRef<Set<string>>(new Set())
  /* Late-bound refreshDms (defined below the socket effect) — dm_added /
   * dm_updated handlers call it through this ref. */
  const refreshDmsRef = useRef<() => void>(() => {})
  /* Late-bound refreshFriends — the friend_request / friend_accepted
   * socket handlers (defined above refreshFriends) call it via this ref. */
  const refreshFriendsRef = useRef<() => void>(() => {})

  // Live mirror of the members list — socket messages resolve the author's
  // real role/tag from here (the relay payload carries no role).
  const membersRef = useRef<ChatAccount[]>(members)
  membersRef.current = members

  // Members list updater that also re-syncs the role/tag snapshots embedded
  // in already-loaded messages, so a freshly promoted mod's tag shows up on
  // their existing messages immediately (no reload needed).
  const updateMembers = useCallback((next: ChatAccount[]) => {
    setMembers(next)
    setMessages((prev) =>
      prev.map((m) => {
        const fresh = next.find((x) => x.id === m.account.id)
        if (!fresh) return m
        if (
          fresh.role === m.account.role &&
          fresh.tag === m.account.tag &&
          fresh.tagColor === m.account.tagColor
        )
          return m
        return {
          ...m,
          account: {
            ...m.account,
            role: fresh.role,
            tag: fresh.tag,
            tagColor: fresh.tagColor,
          },
        }
      }),
    )
  }, [])
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---------------------------------------------------------------------------
  // Toast helper
  const toast = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    const id = Math.random().toString(36).slice(2)
    const note: ChatNotification = {
      id,
      kind: kind === "err" ? "system" : "system",
      title: kind === "err" ? "Error" : "Success",
      body: msg,
      ts: Date.now(),
      read: false,
    }
    setNotifications((prev) => [note, ...prev].slice(0, 30))
    // Show ephemeral toast via sonner if available.
    try {
      import("sonner").then((s) => {
        if (kind === "err") s.toast.error(msg)
        else s.toast.success(msg)
      })
    } catch {
      /* ignore */
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Bootstrap: hydrate account from localStorage on mount, then verify token.
  useEffect(() => {
    const stored = loadStoredAccount()
    if (stored) {
      setAccount(stored.account)
      setToken(stored.token)
      // Verify the token is still valid by making a lightweight API call.
      // IMPORTANT: only an explicit 401/403 from the server means the session
      // is really gone. A transient failure (dev server cold-compiling,
      // restarting mid-request, network blip, gateway hiccup) must NEVER log
      // the user out — that made accounts look "deleted" after every server
      // hiccup (and looked like an instant logout through flaky proxies).
      const verify = async (attempt: number): Promise<void> => {
        try {
          const data = await apiFetch<{ ok: boolean; account?: ChatAccount }>(
            "/api/chat-coins?token=" + encodeURIComponent(stored.token)
          )
          // Token is valid — adopt the FRESH account from the server so role
          // changes (promotions to mod, tag changes) show up without a
          // manual log-out / log-in cycle.
          if (data.account) {
            setAccount(data.account)
            saveStoredAccount(data.account, stored.token)
          }
        } catch (e) {
          const status = (e as { status?: number }).status
          if (status === 401 || status === 403) {
            // Server explicitly rejected the token — real logout.
            clearStoredAccount()
            setAccount(null)
            setToken("")
            return
          }
          // 5 attempts over ~45s — a cold dev-server compile can genuinely
          // take that long, and bouncing to the login screen while the
          // server wakes up is exactly the "insta log out" users saw.
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
            return verify(attempt + 1)
          }
          // Retries exhausted but no server rejection — KEEP the session.
          // The chat data loads will surface real errors; a network blip
          // must not throw the user back to the login screen.
        }
      }
      void verify(0)
      // Periodic silent re-verify (10 min): keeps the stored account
      // snapshot fresh and self-heals after role/coin changes — without
      // ever showing the login screen.
      const interval = setInterval(() => {
        void (async () => {
          try {
            const data = await apiFetch<{ ok: boolean; account?: ChatAccount }>(
              "/api/chat-coins?token=" + encodeURIComponent(stored.token)
            )
            if (data.account) {
              setAccount(data.account)
              saveStoredAccount(data.account, stored.token)
            }
          } catch {
            /* silent — the next tick retries */
          }
        })()
      }, 10 * 60 * 1000)
      /* the session hydrates INSTANTLY from storage — never hold the
       * bootstrap spinner hostage to the verify round-trip (the early
       * return below used to skip setBootstrapped entirely, which froze
       * the chat on its loader forever). */
      setBootstrapped(true)
      setExtensions(loadExtensions())
      return () => clearInterval(interval)
    }
    setBootstrapped(true)
    setExtensions(loadExtensions())
  }, [])

  // A profile restore done in Settings → Data (chat Takeout) dispatches
  // "veil:chat-account-updated" with the fresh server account — adopt it
  // immediately so name/avatar/bio change without a reload.
  useEffect(() => {
    const sync = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && typeof detail === "object" && "username" in detail) {
        setAccount((prev) => (prev ? { ...prev, ...detail } : prev))
      }
    }
    window.addEventListener("veil:chat-account-updated", sync)
    return () => window.removeEventListener("veil:chat-account-updated", sync)
  }, [])

  // Increment blocked-ads counter periodically when ad blocker is enabled.
  useEffect(() => {
    if (!extensions.ad_blocker) return
    const t = setInterval(() => {
      setBlockedAds((n) => n + Math.floor(Math.random() * 3))
    }, 4000)
    return () => clearInterval(t)
  }, [extensions.ad_blocker])

  // Persist extensions.
  useEffect(() => {
    saveExtensions(extensions)
  }, [extensions])

  // ---------------------------------------------------------------------------
  // URL hash handling (auto-open modals via the `url` prop).
  useEffect(() => {
    if (!url) return
    const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : ""
    if (!hash) return
    if (hash === "profile") setShowProfile(true)
    if (hash === "extensions") setShowExtensions(true)
    if (hash === "shop") setShowShop(true)
    if (hash === "music") setShowMusic(true)
  }, [url])

  // ---------------------------------------------------------------------------
  // (clock moved into <LiveClock /> — see component above)

  // ---------------------------------------------------------------------------
  // Socket connection (after auth).
  useEffect(() => {
    if (!account || !token) return
    const socket = io("/?XTransformPort=3004", {
      // Path MUST be "/" (the gateway convention) — the default
      // /socket.io path can be intercepted by intermediate proxies.
      path: "/",
      transports: ["websocket", "polling"],
      reconnection: true,
      // Reconnect FOREVER: if the chat service restarts (dev recompile,
      // keeper revival, box hiccup) the socket must come back, otherwise
      // the client silently stops receiving live messages and only a full
      // page reload shows what's new.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    })
    socketRef.current = socket

    let connectedOnce = false
    socket.on("connect", () => {
      // Signed session token — the relay derives identity from it and
      // IGNORES the client-claimed fields (anti-impersonation).
      socket.emit("identify", { token })
      socket.emit("subscribe", { channelId: channelIdRef.current })
      // Replay the silent watches (every channel + DM) — a reconnect drops
      // room membership, and unread badges + live DM rows depend on them.
      for (const room of watchedRoomsRef.current) {
        socket.emit("watch", { channelId: room })
      }
      // Backfill after a RE-connect: anything sent while the socket was
      // down arrives via a silent refetch + id-union merge, so the live
      // feed never shows gaps (previously needed a page reload).
      if (connectedOnce) {
        const cid = channelIdRef.current
        void apiFetch<{ messages: ChatMessage[] }>(
          `/api/chat-data?channel=${encodeURIComponent(cid)}${
            !CHANNELS.some((c) => c.id === cid)
              ? `&token=${encodeURIComponent(token)}`
              : ""
          }`,
        )
          .then((data) => {
            const fresh = data.messages || []
            setMessages((prev) => {
              const seen = new Set(prev.map((m) => m.id))
              const merged = [...prev]
              for (const m of fresh) if (!seen.has(m.id)) merged.push(m)
              merged.sort(
                (a, b) =>
                  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
              )
              return merged
            })
          })
          .catch(() => {})
      }
      connectedOnce = true
    })

    socket.on("message", (data: {
      channelId: string
      id: string | null
      content: string
      replyTo?: string | null
      replyToContent?: string | null
      replyToUsername?: string | null
      account: {
        accountId: string
        username: string
        displayName: string
        avatarColor: string
        avatarImage: string | null
      } | null
      ts: number
    }) => {
      if (!data.id || !data.account) return
      /* Not the active channel → unread badge (+ mention ping if the text
       * @-mentions us). The row itself isn't loaded here — it appears when
       * the channel is opened (the fetch runs then). */
      if (data.channelId !== channelIdRef.current) {
        if (data.account.accountId === accountRef.current?.id) return
        setUnread((prev) => ({
          ...prev,
          [data.channelId!]: (prev[data.channelId!] || 0) + 1,
        }))
        const me = accountRef.current
        if (me && mentionsUser(data.content || "", me.username)) {
          const dm = dmsRef.current.find((d) => d.id === data.channelId)
          const where =
            dm?.name ||
            dm?.members
              .filter((m) => m.id !== me.id)
              .map(displayName)
              .join(", ") ||
            `#${data.channelId}`
          setNotifications((prev) =>
            [
              {
                id: Math.random().toString(36).slice(2),
                kind: "mention",
                title: `${displayName(data.account!)} mentioned you`,
                body: `in ${where}: ${(data.content || "").slice(0, 80)}`,
                ts: Date.now(),
                read: false,
              } as ChatNotification,
              ...prev,
            ].slice(0, 30),
          )
          toast(`${displayName(data.account!)} mentioned you in ${where}`, "ok")
          if (extensions.notification_sound) {
            try {
              const audio = new Audio(
                "data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
              )
              void audio.play().catch(() => {})
            } catch {
              /* ignore */
            }
          }
        }
        return
      }
      // Skip if already present (we add optimistically on send).
      if (messagesRef.current.some((m) => m.id === data.id)) return
      // Resolve the author's live role/tag from the members list — the relay
      // payload carries none, so otherwise every live message would render as
      // a plain member and mods/owner would lose their badge until reload.
      const known = membersRef.current.find(
        (x) => x.id === data.account!.accountId,
      )
      const msg: ChatMessage = {
        id: data.id,
        channelId: data.channelId,
        content: data.content,
        replyTo: data.replyTo ?? null,
        replyToContent: data.replyToContent ?? null,
        replyToUsername: data.replyToUsername ?? null,
        createdAt: new Date(data.ts).toISOString(),
        account: {
          id: data.account.accountId,
          username: data.account.username,
          displayName: data.account.displayName,
          avatarColor: data.account.avatarColor,
          avatarImage: data.account.avatarImage,
          role: known?.role ?? "member",
          coins: known?.coins ?? 0,
          tag: known?.tag ?? null,
          tagColor: known?.tagColor ?? null,
          pfpAccessory: known?.pfpAccessory ?? null,
        },
      }
      setMessages((prev) =>
        // Dedup inside the updater too: messagesRef updates in an effect, so
        // a poll merge that already landed this id can race the socket echo
        // (observed as duplicate React keys in the message list).
        prev.some((m) => m.id === msg.id) ? prev : [...prev, msg],
      )
      setFreshIds((prev) => freshWith(prev, msg.id))
      // Notification + sound.
      if (extensions.notification_sound) {
        try {
          const audio = new Audio(
            "data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
          )
          void audio.play().catch(() => {})
        } catch {
          /* ignore */
        }
      }
      // Push notification if not from us.
      if (data.account.accountId !== accountRef.current?.id) {
        const n: ChatNotification = {
          id: Math.random().toString(36).slice(2),
          kind: "message",
          title: displayName(data.account),
          body: data.content.slice(0, 80),
          ts: Date.now(),
        }
        setNotifications((prev) => [n, ...prev].slice(0, 30))
      }
    })

    socket.on("typing", (data: {
      channelId: string
      account: { accountId: string; username: string; displayName: string } | null
    }) => {
      if (!data.account) return
      if (data.account.accountId === accountRef.current?.id) return
      /* Store per-channel (not just the active one) — the DM/channel rows
       * in the switcher show a live "typing…" hint too. */
      const acc = data.account
      setTypingUsers((prev) => {
        const list = prev[data.channelId] || []
        const filtered = list.filter(
          (u) => u.username !== acc.username,
        )
        return {
          ...prev,
          [data.channelId]: [
            ...filtered,
            {
              username: acc.username,
              displayName: acc.displayName,
              ts: Date.now(),
            },
          ],
        }
      })
    })

    socket.on("stop_typing", (data: {
      channelId: string
      account: { username: string } | null
    }) => {
      if (!data.account) return
      setTypingUsers((prev) => {
        const list = prev[data.channelId] || []
        return {
          ...prev,
          [data.channelId]: list.filter((u) => u.username !== data.account!.username),
        }
      })
    })

    socket.on("message_deleted", (data: { channelId: string; messageId: string }) => {
      if (data.channelId !== channelIdRef.current) return
      setMessages((prev) => prev.filter((m) => m.id !== data.messageId))
      setPinned((prev) => prev.filter((m) => m.id !== data.messageId))
    })

    socket.on("message_edited", (data: {
      channelId: string
      messageId: string
      content: string
      editedAt?: string
    }) => {
      if (data.channelId !== channelIdRef.current) return
      const stamp = data.editedAt ?? new Date().toISOString()
      setMessages((prev) =>
        prev.map((m) =>
          m.id === data.messageId
            ? { ...m, content: data.content, editedAt: stamp }
            : m,
        ),
      )
      setPinned((prev) =>
        prev.map((m) =>
          m.id === data.messageId
            ? { ...m, content: data.content, editedAt: stamp }
            : m,
        ),
      )
    })

    socket.on("presence", (data: { channelId: string; users: PresenceUser[] }) => {
      if (data.channelId !== channelIdRef.current) return
      setPresence(data.users || [])
    })

    /* Emoji reactions from other viewers — patch the loaded copy (active
     * channel rows + pinned copies) with the same pure delta the local
     * toggle uses, so chips land live without a refetch. */
    socket.on("reaction", (data: {
      channelId: string
      messageId: string
      emoji: string
      added: boolean
      account: { accountId: string; username: string; displayName: string }
    }) => {
      if (!data.messageId || !data.emoji || !data.account) return
      if (data.account.accountId === accountRef.current?.id) return // own echo
      const patch = (m: ChatMessage) =>
        m.id === data.messageId
          ? applyReactionDelta(m, data.emoji, data.added, data.account!.accountId)
          : m
      setMessages((prev) =>
        prev.some((m) => m.id === data.messageId)
          ? prev.map(patch)
          : prev,
      )
      setPinned((prev) =>
        prev.some((m) => m.id === data.messageId) ? prev.map(patch) : prev,
      )
    })

    /* Group lifecycle — driven by the API layer through the relay's
     * per-user rooms / group rooms. */
    socket.on("dm_added", (data: {
      dmId: string
      name: string | null
      invitedBy: string
      members: number
    }) => {
      refreshDmsRef.current()
      const label = data.name || `a group chat (${data.members} members)`
      setNotifications((prev) =>
        [
          {
            id: Math.random().toString(36).slice(2),
            kind: "system" as const,
            title: "Added to a group",
            body: `@${data.invitedBy} added you to ${label}.`,
            ts: Date.now(),
            read: false,
          },
          ...prev,
        ].slice(0, 30),
      )
      toast(`@${data.invitedBy} added you to ${label}!`, "ok")
    })

    socket.on("dm_updated", (data: {
      dmId: string
      reason: "invite" | "leave" | "rename"
      invited?: string[]
      invitedBy?: string
      left?: string
      name?: string
      by?: string
    }) => {
      refreshDmsRef.current()
      if (data.reason === "invite" && data.invited?.length) {
        toast(`@${data.invited.join(", @")} joined the group.`, "ok")
      } else if (data.reason === "leave" && data.left) {
        toast(`@${data.left} left the group.`, "ok")
      } else if (data.reason === "rename" && data.name) {
        toast(`Group renamed to "${data.name}".`, "ok")
      }
    })

    socket.on("dm_removed", (data: { dmId: string; reason: string }) => {
      setDms((prev) => prev.filter((d) => d.id !== data.dmId))
      if (channelIdRef.current === data.dmId) {
        setChannelId("main")
        toast("That conversation is gone — back to #general.", "ok")
      }
    })

    /* Friend requests — someone wants to be our friend. Refresh the
     * pending list, ring the bell (with live Accept/Decline buttons in
     * the notification itself) and play the notification sound. */
    socket.on(
      "friend_request",
      (data: {
        requestId: string
        from: {
          id: string
          username: string
          displayName: string
          avatarColor: string
          avatarImage: string | null
        }
      }) => {
        refreshFriendsRef.current()
        const who = data.from?.displayName || data.from?.username || "Someone"
        setNotifications((prev) =>
          [
            {
              id: Math.random().toString(36).slice(2),
              kind: "friend_request" as const,
              title: "Friend request",
              body: `@${data.from?.username || who} wants to be your friend.`,
              ts: Date.now(),
              read: false,
              requestId: data.requestId,
            } as ChatNotification,
            ...prev,
          ].slice(0, 30),
        )
        toast(`@${data.from?.username || who} sent you a friend request!`, "ok")
        if (extensions.notification_sound) {
          try {
            const audio = new Audio(
              "data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
            )
            void audio.play().catch(() => {})
          } catch {
            /* ignore */
          }
        }
      },
    )

    /* Our request was accepted (or the mutual handshake fired) — we're
     * friends now. Refresh the list so they appear instantly. */
    socket.on(
      "friend_accepted",
      (data: {
        by: string
        friend: { id: string; username: string; displayName: string }
        mutual?: boolean
      }) => {
        refreshFriendsRef.current()
        const who = data.by || data.friend?.username || "someone"
        setNotifications((prev) =>
          [
            {
              id: Math.random().toString(36).slice(2),
              kind: "friend_accepted" as const,
              title: "You're friends now",
              body: `@${who} accepted — you're friends.`,
              ts: Date.now(),
              read: false,
            } as ChatNotification,
            ...prev,
          ].slice(0, 30),
        )
        toast(`You're now friends with @${who}!`, "ok")
        if (extensions.notification_sound) {
          try {
            const audio = new Audio(
              "data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
            )
            void audio.play().catch(() => {})
          } catch {
            /* ignore */
          }
        }
      },
    )

    // The relay rejected our session token — NEVER a blind logout. A
    // reconnecting socket, a restarted relay, or a proxy that reordered
    // packets can surface "identify failed" / "not identified" even with
    // a perfectly valid token; nuking the stored session there was the
    // "chat insta logs out" bug. Instead: self-heal by re-identifying
    // (and re-subscribing), and only sign out if the HTTP API ALSO says
    // the token is dead (a real 401).
    const reidentify = () => {
      socket.emit("identify", { token })
      socket.emit("subscribe", { channelId: channelIdRef.current })
    }
    socket.on("error", (data: { message?: string }) => {
      const msg = typeof data?.message === "string" ? data.message : ""
      if (msg.includes("not identified")) {
        // Race: an event landed before this socket's identify was
        // processed (fresh connect or reconnect replay). Just re-run
        // the handshake — the session stays untouched.
        reidentify()
        return
      }
      if (msg.includes("identify failed")) {
        // The relay claims the token is bad — double-check with the
        // API before believing it. Only a confirmed 401 logs out.
        void (async () => {
          try {
            await apiFetch<{ ok: boolean; account?: ChatAccount }>(
              "/api/chat-coins?token=" + encodeURIComponent(token),
            )
            // API accepted the token — the relay was wrong (restart,
            // stale state). Re-identify on a short delay.
            setTimeout(reidentify, 500)
          } catch (e) {
            const status = (e as { status?: number }).status
            if (status === 401 || status === 403) {
              clearStoredAccount()
              socket.disconnect()
              setAccount(null)
              setToken("")
            } else {
              // Network-level failure while double-checking — assume
              // the relay hiccuped and self-heal anyway.
              setTimeout(reidentify, 1000)
            }
          }
        })()
      }
    })

    // Polling fallback for socketless hosts (Vercel import of the repo):
    // there is no /?XTransformPort=3004 chat relay there, so the socket
    // never connects. While it's down, poll the REST channel every 5s and
    // id-union merge — same shape as the reconnect backfill above, so the
    // live feed still updates (just without typing/presency niceties).
    // On the dev box the socket connects and these polls are no-ops.
    const pollFallback = setInterval(() => {
      if (socket.connected) return
      const cid = channelIdRef.current
      void apiFetch<{ messages: ChatMessage[] }>(
        `/api/chat-data?channel=${encodeURIComponent(cid)}${
          !CHANNELS.some((c) => c.id === cid)
            ? `&token=${encodeURIComponent(token)}`
            : ""
        }`,
      )
        .then((data) => {
          const fresh = data.messages || []
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.id))
            const merged = [...prev]
            for (const m of fresh) if (!seen.has(m.id)) merged.push(m)
            merged.sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime(),
            )
            return merged
          })
        })
        .catch(() => {})
    }, 5000)

    return () => {
      clearInterval(pollFallback)
      socket.disconnect()
      socketRef.current = null
    }

  }, [account?.id, token])

  /* Presence self-heal poll — the socket's "presence" events are the
   * fast path, but a blipped/dropped socket froze the online dots
   * FOREVER ("player tab no update": friends chatting while showing
   * offline). Poll the chat service's presence endpoint (gateway port
   * 3006) for the CURRENT channel every 25s; the server truth replaces
   * the local set, so any missed event corrects itself within half a
   * minute — and the offline single-file build reads the same endpoint. */
  useEffect(() => {
    if (!account || !token) return
    let stopped = false
    const poll = async () => {
      const cid = channelIdRef.current
      if (!cid) return
      try {
        const res = await fetch(
          `/presence?XTransformPort=3006&channel=${encodeURIComponent(cid)}`,
          { cache: "no-store" },
        )
        if (!res.ok) return
        const data = (await res.json()) as { ok: boolean; users?: PresenceUser[] }
        if (stopped || !data.ok || !Array.isArray(data.users)) return
        if (channelIdRef.current !== cid) return // stale tick — channel moved
        setPresence(data.users)
      } catch {
        /* gateway blip — next tick retries */
      }
    }
    void poll()
    const t = setInterval(() => void poll(), 25000)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [account, token])

  // Garbage-collect typing indicators every 4s.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 5000
      setTypingUsers((prev) => {
        let changed = false
        const next: typeof prev = {}
        for (const [cid, list] of Object.entries(prev)) {
          const fresh = list.filter((u) => u.ts > cutoff)
          if (fresh.length > 0) next[cid] = fresh
          if (fresh.length !== list.length) changed = true
        }
        // Identity-stable no-op when nothing expired — avoids re-rendering
        // the whole app every 4s for nothing.
        return changed ? next : prev
      })
    }, 4000)
    return () => clearInterval(t)
  }, [])

  // ---------------------------------------------------------------------------
  // Subscribe to channel whenever channelId changes.
  // Generation token for channel loads — a slow/stale fetch for a PREVIOUS
  // channel must never paint its messages under the new channel's header
  // (the "#general messages appearing in #links" bug: the old channel's
  // list stayed rendered while the new fetch was in flight or failed).
  const channelLoadGenRef = useRef(0)
  /* Pins survive a channel round-trip within the session (they used to be
   * wiped on every switch — and worse, auto-populated with the channel's
   * 3 OLDEST messages, which nobody ever asked for). pinnedForRef guards
   * the sync effect: pins belong to the channel they were made in, so a
   * switch must not smear the old channel's pins onto the new one. */
  const pinnedByChannelRef = useRef<Map<string, ChatMessage[]>>(new Map())
  const pinnedForRef = useRef<string>(channelId)
  useEffect(() => {
    if (pinnedForRef.current === channelId) {
      pinnedByChannelRef.current.set(channelId, pinned)
    }
  }, [pinned, channelId])
  useEffect(() => {
    if (!socketRef.current || !account) return
    const socket = socketRef.current
    socket.emit("subscribe", { channelId })
    /* Opening a channel clears its unread badge. */
    setUnread((prev) =>
      prev[channelId] ? { ...prev, [channelId]: 0 } : prev,
    )
    setPresence([])
    setTypingUsers({})
    /* Restore this channel's pins from the session map. */
    pinnedForRef.current = channelId
    setPinned(pinnedByChannelRef.current.get(channelId) ?? [])
    /* NO eager setMessages([]) — wiping the list on every switch made the
     * whole chat "blink out of existence" for the fetch's duration. The
     * old rows simply stay visible under a slim loading bar until the new
     * channel's fetch lands (generation-guarded, with retries) and swaps
     * them in one atomic replace. */
    setChannelLoading(true)
    setHasMoreOlder(false)
    const gen = ++channelLoadGenRef.current
    // Fetch recent messages for this channel. Transient failures (dev
    // recompile, gateway blip, mobile network switch) RETRY a few times
    // before giving up — a single failed fetch used to blank the channel
    // to "No messages here yet" until the next poll recovered it.
    const load = async (attempt: number): Promise<void> => {
      try {
        const data = await apiFetch<{ messages: ChatMessage[]; hasMore?: boolean }>(
          `/api/chat-data?channel=${encodeURIComponent(channelId)}${
            !CHANNELS.some((c) => c.id === channelId) ? `&token=${encodeURIComponent(token)}` : ""
          }`,
        )
        if (gen !== channelLoadGenRef.current) return // stale — a newer switch won
        setMessages(data.messages || [])
        setHasMoreOlder(!!data.hasMore)
        setChannelLoading(false)
      } catch (e) {
        if (gen !== channelLoadGenRef.current) return // stale — ignore
        if (attempt < 3) {
          setTimeout(() => void load(attempt + 1), 1200 * (attempt + 1))
          return
        }
        setMessages([])
        setChannelLoading(false)
        console.error("Failed to load channel messages", e)
      }
    }
    void load(0)
    return () => {
      /* Presence off, watching stays: unsubscribe drops the socket from
       * the room (and the presence map), then `watch` silently rejoins so
       * unread badges + live DM rows keep working for this channel. */
      socket.emit("unsubscribe", { channelId })
      socket.emit("watch", { channelId })
    }
     
  }, [channelId, account?.id, token])

  // ---------------------------------------------------------------------------
  // Fetch members + DMs.
  const refreshMembers = useCallback(async () => {
    if (!token) return
    try {
      const data = await apiFetch<{ members: ChatAccount[] }>(
        `/api/chat-members?token=${encodeURIComponent(token)}`,
      )
      /* updateMembers (not raw setMembers) — it also re-syncs the
       * role/tag snapshots embedded in already-rendered messages, so a
       * freshly promoted mod's badge appears without a reload. */
      updateMembers(data.members || [])
      /* rehydrate the local account snapshot — the session cookie mirror
       * is slim (identity only), so PFP/bio/coins/tag refresh here from
       * the authoritative row on every load; it also picks up profile
       * edits made from another device or an older session. */
      const me = (data.members || []).find((m) => m.id === account?.id)
      if (me) {
        setAccount((prev) => (prev && prev.id === me.id ? { ...prev, ...me } : prev))
      }
    } catch {
      /* Silent: transient failures (dev-server restart window, gateway
       * hiccup) self-heal on the 30s tick + socket-reconnect backfill.
       * console.error here used to pop the Next dev overlay open over the
       * chat — a backdrop the user couldn't click through. */
    }
  }, [token, account?.id, updateMembers])

  /* Re-fetch the CURRENT channel's messages (used after a backup restore
   * imports history behind the UI's back). Same generation guard as the
   * channel-switch effect — a channel switch during the fetch wins. */
  const reloadCurrentChannel = useCallback(async () => {
    const gen = ++channelLoadGenRef.current
    try {
      const data = await apiFetch<{ messages: ChatMessage[] }>(
        `/api/chat-data?channel=${encodeURIComponent(channelIdRef.current)}${
          !CHANNELS.some((c) => c.id === channelIdRef.current) ? `&token=${encodeURIComponent(token)}` : ""
        }`,
      )
      if (gen !== channelLoadGenRef.current) return
      const fresh = data.messages || []
      setMessages((prev) =>
        /* Same empty-response guard — a hiccup must not blank the chat. */
        fresh.length === 0 && prev.length > 0 ? prev : fresh,
      )
    } catch {
      /* next channel switch / reconnect will re-sync */
    }
    void refreshMembers()
  }, [token, refreshMembers])

  /* Open someone's profile card. Prefers the fresh members-list row
   * (role/tag/bio up to date); falls back to the account snapshot
   * embedded in a message so the card still works for departed
   * members. Self-view offers the "Edit your profile" hand-off.
   *
   * Refs, not closure state: a stable identity here is what lets the
   * memoized MessageRow skip re-renders (it used to change on every
   * message/member update, re-rendering the whole list). */
  const openProfile = useCallback(
    (accountId: string) => {
      const fromMembers = membersRef.current.find((m) => m.id === accountId)
      if (fromMembers) {
        setViewingProfile(fromMembers)
        return
      }
      const me = accountRef.current
      if (accountId === me?.id && me) {
        setViewingProfile(me)
        return
      }
      const fromMessage = messagesRef.current.find((m) => m.account.id === accountId)
      if (fromMessage) {
        setViewingProfile({
          id: fromMessage.account.id,
          username: fromMessage.account.username,
          displayName: fromMessage.account.displayName,
          avatarColor: fromMessage.account.avatarColor,
          avatarImage: fromMessage.account.avatarImage,
          bio: "",
          role: fromMessage.account.role,
          muted: false,
          banned: false,
          banReason: null,
          ipBanned: false,
          coins: fromMessage.account.coins ?? 0,
          tag: fromMessage.account.tag,
          tagColor: fromMessage.account.tagColor,
          pfpAccessory: fromMessage.account.pfpAccessory,
          createdAt: new Date().toISOString(),
        })
      }
    },
    [],
  )

  const refreshDms = useCallback(async () => {
    if (!token) return
    try {
      const data = await apiFetch<{ dms: DM[] }>(
        `/api/chat-dm?token=${encodeURIComponent(token)}`,
      )
      setDms(data.dms || [])
    } catch {
      /* Silent — same policy as refreshMembers: self-heals on the next
       * tick; surfacing it just opens the dev overlay and blocks clicks. */
    }
  }, [token])
  /* Late binding for the socket effect's dm_added / dm_updated handlers
   * (defined above, run later — the ref always holds the fresh callback). */
  refreshDmsRef.current = refreshDms

  const refreshFriends = useCallback(async () => {
    if (!token) return
    try {
      const data = await apiFetch<{
        friends: ChatAccount[]
        incoming: FriendRequestRow[]
        outgoing: FriendRequestRow[]
      }>("/api/chat-friends?token=" + encodeURIComponent(token))
      const rows = data.incoming || []
      setFriends(data.friends || [])
      setFriendRequestsIn(rows)
      setFriendRequestsOut(data.outgoing || [])
      /* Mirror any incoming request the bell doesn't know about yet into a
       * notification — so the Accept/Decline buttons stay reachable after
       * a reload (notifications are in-memory; requests are server-side).
       * Deduped by requestId, so this is idempotent per refresh. */
      for (const r of rows) {
        setNotifications((prev) =>
          prev.some((n) => n.requestId === r.id)
            ? prev
            : [
                {
                  id: "freq-" + r.id,
                  kind: "friend_request" as const,
                  title: "Friend request",
                  body: `@${r.user.username} wants to be your friend.`,
                  ts: new Date(r.createdAt).getTime() || Date.now(),
                  read: false,
                  requestId: r.id,
                } as ChatNotification,
                ...prev,
              ].slice(0, 30),
        )
      }
    } catch {
      /* Silent — same policy as refreshMembers/refreshDms: self-heals on
       * the next tick; surfacing it just opens the dev overlay. */
    }
  }, [token])
  refreshFriendsRef.current = () => void refreshFriends()

  useEffect(() => {
    if (!account || !token) return
    void refreshMembers()
    void refreshDms()
    void refreshFriends()
  }, [account, token, refreshMembers, refreshDms, refreshFriends])

  /* Silently watch EVERY public channel + every DM/group — the socket
   * relay keeps us in those rooms without presence, so unread badges,
   * mention pings and live DM rows work even for channels we're not
   * looking at. Re-runs when the DM list changes (new groups/invites);
   * `watch` is idempotent server-side (a Set). */
  useEffect(() => {
    if (!account || !token) return
    const socket = socketRef.current
    const rooms = [...CHANNELS.map((c) => c.id), ...dms.map((d) => d.id)]
    for (const r of rooms) watchedRoomsRef.current.add(r)
    if (socket && socket.connected) {
      for (const r of rooms) socket.emit("watch", { channelId: r })
    }
  }, [account?.id, token, dms])

  // Re-fetch members + DMs + friend requests every 30s (DMs: catches
  // anything a dropped socket event missed — new DMs, group membership
  // changes; friends: pending requests / accepted friendships that a
  // socketless host or a dropped event would otherwise miss).
  useEffect(() => {
    if (!account) return
    const t = setInterval(() => {
      void refreshMembers()
      void refreshDms()
      void refreshFriends()
    }, 30000)
    return () => clearInterval(t)
  }, [account, refreshMembers, refreshDms, refreshFriends])

  // Auto-scroll to bottom on new messages — only if user is already near the bottom.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const isAtBottomRef = useRef(true)
  const checkScrollPosition = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  useEffect(() => {
    if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages])

  // ---------------------------------------------------------------------------
  // Send a message.
  const sendMessage = useCallback(async () => {
    const raw = input.trim()
    if (!raw || !account || !token) return
    setInput("")
    // Slash-commands engine — intercept before the normal send path.
    const slash = runSlashCommand(raw)
    if (slash) {
      if (slash.kind === "local") {
        toast(slash.content, "ok")
        return
      }
      setReplyTo(null)
      try {
        const data = await apiFetch<{
          message: ChatMessage
          account: ChatAccount | null
        }>("/api/chat-data", {
          method: "POST",
          body: JSON.stringify({ token, channelId, content: slash.content }),
        })
        setMessages((prev) =>
          prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]
        )
        setFreshIds((prev) => freshWith(prev, data.message.id))
        if (data.account) setAccount(data.account)
        socketRef.current?.emit("message", {
          channelId,
          id: data.message.id,
          content: data.message.content,
        })
      } catch (e) {
        toast(e instanceof Error ? e.message : "Failed to send message.", "err")
      }
      return
    }
    const content = raw
    const replyToId = replyTo?.id || null
    const replyToContent = replyTo?.content?.slice(0, 200) || null
    const replyToUsername = replyTo?.account.username || null
    setReplyTo(null)
    try {
      const data = await apiFetch<{
        message: ChatMessage
        account: ChatAccount | null
      }>("/api/chat-data", {
        method: "POST",
        body: JSON.stringify({
          token,
          channelId,
          content,
          replyTo: replyToId,
          replyToContent,
          replyToUsername,
        }),
      })
      setMessages((prev) =>
          prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]
        )
      setFreshIds((prev) => freshWith(prev, data.message.id))
      if (data.account) setAccount(data.account)
      // Relay via socket.
      socketRef.current?.emit("message", {
        channelId,
        id: data.message.id,
        content: data.message.content,
        replyTo: data.message.replyTo,
        replyToContent: data.message.replyToContent,
        replyToUsername: data.message.replyToUsername,
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to send message.", "err")
    }
  }, [input, account, token, channelId, replyTo, toast])

  // Send a GIF directly (without putting URL in the input field)
  const sendMessageDirect = useCallback(async (content: string) => {
    if (!content.trim() || !account || !token) return
    try {
      const data = await apiFetch<{
        message: ChatMessage
        account: ChatAccount | null
      }>("/api/chat-data", {
        method: "POST",
        body: JSON.stringify({ token, channelId, content }),
      })
      setMessages((prev) =>
          prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]
        )
      setFreshIds((prev) => freshWith(prev, data.message.id))
      if (data.account) setAccount(data.account)
      socketRef.current?.emit("message", {
        channelId,
        id: data.message.id,
        content: data.message.content,
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to send message.", "err")
    }
  }, [account, token, channelId, toast])

  // File attachment upload — up to 300 MB, streamed to the server with
  // real progress (XHR), sent as a message link when it lands.
  //
  // Files are uploaded in 512 KB SLICES (sid + chunk + final params on
  // /api/chat-file): some fronting proxies cap request bodies at ~1 MB,
  // which made every file bigger than a screenshot die mid-upload. Each
  // slice is well under any cap, so uploads survive any layer. Small
  // files still go in a single request.
  const uploadFile = useCallback(
    (file: File) => {
      if (!token || !account) return
      if (file.size > 300 * 1024 * 1024) {
        toast("That file is over the 300 MB limit.", "err")
        return
      }
      setUpload({ name: file.name, pct: 0 })

      const query =
        "/api/chat-file?token=" +
        encodeURIComponent(token) +
        "&name=" +
        encodeURIComponent(file.name.slice(0, 120)) +
        "&type=" +
        encodeURIComponent(file.type || "")

      const finish = (f: { id: string; name: string; type: string; size: number }) => {
        setUpload(null)
        const link =
          "/api/chat-file?id=" +
          encodeURIComponent(f.id) +
          "&n=" +
          encodeURIComponent(f.name) +
          "&s=" +
          f.size +
          "&t=" +
          encodeURIComponent(f.type)
        void sendMessageDirect(link)
      }
      const fail = (msg: string) => {
        setUpload(null)
        toast(msg, "err")
      }
      const readError = (d: { error?: string } | null): string =>
        d?.error || "Upload failed — try again."

      const sendSlice = (body: Blob | File, extra: string, onDone: (d: unknown, ok: boolean) => void) => {
        const xhr = new XMLHttpRequest()
        xhr.open("POST", query + extra)
        xhr.setRequestHeader("Content-Type", "application/octet-stream")
        xhr.onload = () => {
          let d: unknown = null
          try {
            d = JSON.parse(xhr.responseText)
          } catch {
            /* handled below with ok=false */
          }
          onDone(d, xhr.status >= 200 && xhr.status < 300)
        }
        xhr.onerror = () => onDone(null, false)
        return xhr
      }

      const CHUNK = 512 * 1024 // 512 KB — under every known body cap
      if (file.size <= CHUNK) {
        // Single-shot path (small files — one request, exactly like before).
        const xhr = sendSlice(file, "", (d, ok) => {
          if (ok && d && typeof d === "object" && "file" in d) {
            finish((d as { file: { id: string; name: string; type: string; size: number } }).file)
          } else {
            fail(readError(d as { error?: string } | null))
          }
        })
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUpload({ name: file.name, pct: Math.min(99, Math.round((e.loaded / e.total) * 100)) })
          }
        }
        xhr.send(file)
        return
      }

      // Chunked path: slice the file, append server-side, finalize at the end.
      const sid =
        (crypto.randomUUID?.() || Math.random().toString(36).slice(2)) +
        Date.now().toString(36)
      const total = Math.ceil(file.size / CHUNK)
      const sendChunk = (i: number) => {
        const from = i * CHUNK
        const blob = file.slice(from, Math.min(from + CHUNK, file.size))
        const isFinal = i === total - 1
        const extra =
          "&sid=" + encodeURIComponent(sid) +
          "&chunk=" + i +
          "&chunks=" + total +
          "&size=" + file.size +
          (isFinal ? "&final=1" : "")
        const xhr = sendSlice(blob, extra, (d, ok) => {
          if (!ok || !d || typeof d !== "object") {
            fail(readError(d as { error?: string } | null))
            return
          }
          if ("file" in d) {
            finish((d as { file: { id: string; name: string; type: string; size: number } }).file)
            return
          }
          sendChunk(i + 1)
        })
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // (chunks done + this chunk's fraction) / total
            const overall = ((i + e.loaded / e.total) / total) * 100
            setUpload({ name: file.name, pct: Math.min(99, Math.round(overall)) })
          }
        }
        xhr.send(blob)
      }
      sendChunk(0)
    },
    [token, account, toast, sendMessageDirect],
  )

  // Typing indicator.
  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value)
    if (!socketRef.current || !account) return
    socketRef.current.emit("typing", { channelId })
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => {
      socketRef.current?.emit("stop_typing", { channelId })
    }, 1500)
  }

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  // Day message counts — computed once per messages change. The render
  // below used to run a nested filter PER message (O(n²) on every render).
  const dayCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const m of messages) {
      const k = dayKeyOf(m.createdAt)
      c[k] = (c[k] || 0) + 1
    }
    return c
  }, [messages])

  // Stable handlers for the memoized MessageRow — new function identities
  // here would defeat the memo on every parent render.
  const handleReply = useCallback((msg: ChatMessage) => setReplyTo(msg), [])

  // Pin / unpin.
  const togglePin = useCallback((msg: ChatMessage) => {
    setPinned((prev) => {
      const exists = prev.some((m) => m.id === msg.id)
      if (exists) return prev.filter((m) => m.id !== msg.id)
      return [msg, ...prev].slice(0, 12)
    })
    setShowPinned(true)
  }, [])

  // Delete message — your own, or (as a mod) anyone's. Deletes directly
  // instead of opening the mod panel.
  const deleteMessage = useCallback(async (msg: ChatMessage) => {
    const isMine = msg.account.id === account?.id
    if (!isMine && !isMod(account)) return
    try {
      await apiFetch("/api/chat-mod", {
        method: "POST",
        body: JSON.stringify({
          token,
          action: "delete_message",
          messageId: msg.id,
        }),
      })
      setMessages((prev) => prev.filter((m) => m.id !== msg.id))
      socketRef.current?.emit("message_deleted", { channelId, messageId: msg.id })
      toast("Message deleted.", "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed.", "err")
    }
  }, [account, token, channelId])

  /* ---- inline message editing (the pencil next to Reply on your own
   * messages). The draft lives here, in ChatApp, so live-room polls and
   * socket updates re-rendering the list never destroy an in-progress
   * edit — exactly like the git version's chat. */ 
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const [editBusy, setEditBusy] = useState(false)
  const startEdit = useCallback((msg: ChatMessage) => {
    setEditingId(msg.id)
    setEditDraft(msg.content)
  }, [])
  const saveEdit = useCallback(async () => {
    const id = editingId
    const text = editDraft.trim()
    if (!id || !text || editBusy) return
    setEditBusy(true)
    try {
      const data = await apiFetch<{
        message: { id: string; content: string; editedAt: string | null }
      }>("/api/chat-data", {
        method: "PATCH",
        body: JSON.stringify({ token, messageId: id, content: text }),
      })
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, content: data.message.content, editedAt: data.message.editedAt }
            : m,
        ),
      )
      setPinned((prev) =>
        prev.map((m) =>
          m.id === id
            ? { ...m, content: data.message.content, editedAt: data.message.editedAt }
            : m,
        ),
      )
      socketRef.current?.emit("message_edited", {
        channelId,
        messageId: id,
        content: data.message.content,
        editedAt: data.message.editedAt ?? new Date().toISOString(),
      })
      setEditingId(null)
      setEditDraft("")
      toast("Message edited.", "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Edit failed.", "err")
    } finally {
      setEditBusy(false)
    }
  }, [editingId, editDraft, editBusy, token, channelId, toast])
  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setEditDraft("")
  }, [])
  /* Stable wrapper — passing an inline arrow as onEditSave gave EVERY
   * MessageRow a brand-new prop on every keystroke, defeating the memo
   * and re-rendering the entire list while typing (the "chat is so
   * laggy" report). */
  const handleEditSave = useCallback(() => {
    void saveEdit()
  }, [saveEdit])

  /* Own-message edit rights: a DB message you authored, OR a live-room
   * (git version) message sent under your username — the PATCH routes
   * both by ownership. */
  const canEditMessage = useCallback(
    (msg: ChatMessage) => {
      if (!account) return false
      if (msg.account.id === account.id) return true
      if (msg.id.startsWith("lv-")) {
        return (
          (msg.account.username || "").toLowerCase() === account.username.toLowerCase()
        )
      }
      return false
    },
    [account],
  )

  // Create a DM.
  const createDm = async () => {
    const target = dmTarget.trim()
    if (!target) return
    try {
      const data = await apiFetch<{ dm: DM }>("/api/chat-dm", {
        method: "POST",
        body: JSON.stringify({ token, targetUsername: target }),
      })
      setDms((prev) => {
        if (prev.some((d) => d.id === data.dm.id)) return prev
        return [data.dm, ...prev]
      })
      setChannelId(data.dm.id)
      setDmTarget("")
      setShowDmMenu(false)
      toast(`DM opened with @${target}.`, "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create DM.", "err")
    }
  }

  // Open a DM with someone (friends panel / profiles) — reuses the
  // existing conversation when there is one instead of minting a new id.
  const openDmWith = async (username: string) => {
    const who = username.trim().replace(/^@/, "")
    if (!who || !account) return
    const existing = dms.find(
      (d) =>
        !d.isGroup &&
        d.members.some(
          (m) => m.id !== account.id && m.username.toLowerCase() === who.toLowerCase(),
        ),
    )
    if (existing) {
      setChannelId(existing.id)
      return
    }
    setDmTarget(who)
    try {
      const data = await apiFetch<{ dm: DM }>("/api/chat-dm", {
        method: "POST",
        body: JSON.stringify({ token, targetUsername: who }),
      })
      setDms((prev) => {
        if (prev.some((d) => d.id === data.dm.id)) return prev
        return [data.dm, ...prev]
      })
      setChannelId(data.dm.id)
      toast(`DM opened with @${who}.`, "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to open the DM.", "err")
    }
  }

  // -------------------------------------------------------------------------
  // Group chats — create / invite / rename / leave.
  // -------------------------------------------------------------------------
  const createGroup = async () => {
    if (creatingGroup) return
    const name = groupName.trim()
    const picked = Object.keys(groupPicked).filter((u) => groupPicked[u])
    const typed = groupUserInput
      .split(/[\s,]+/)
      .map((s) => s.trim().replace(/^@/, ""))
      .filter(Boolean)
    const targets = [...new Set([...picked, ...typed])]
    if (targets.length === 0) {
      toast("Pick at least one person — friends or @usernames.", "err")
      return
    }
    setCreatingGroup(true)
    try {
      const data = await apiFetch<{ dm: DM }>("/api/chat-dm", {
        method: "POST",
        body: JSON.stringify({
          token,
          targetUsernames: targets,
          name: name || undefined,
          makeGroup: true,
        }),
      })
      setDms((prev) => {
        if (prev.some((d) => d.id === data.dm.id))
          return prev.map((d) => (d.id === data.dm.id ? data.dm : d))
        return [data.dm, ...prev]
      })
      setChannelId(data.dm.id)
      setChannelSwitcher(false)
      setGroupName("")
      setGroupPicked({})
      setGroupUserInput("")
      setShowGroupMenu(false)
      toast(
        `Group ${name ? `"${name}"` : ""} created — you + ${targets.length} member${targets.length === 1 ? "" : "s"}.`,
        "ok",
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create the group.", "err")
    } finally {
      setCreatingGroup(false)
    }
  }

  const inviteToGroup = async (
    dm: DM,
    targets: string[],
    done: () => void,
  ) => {
    if (targets.length === 0) {
      toast("Pick at least one person to invite.", "err")
      return
    }
    try {
      const data = await apiFetch<{
        dm: DM
        invited: string[]
        becameGroup: boolean
      }>("/api/chat-dm/invite", {
        method: "POST",
        body: JSON.stringify({ token, dmId: dm.id, targetUsernames: targets }),
      })
      setDms((prev) =>
        prev.map((d) => (d.id === data.dm.id ? data.dm : d)),
      )
      done()
      setShowInvite(false)
      toast(
        `Invited @${data.invited.join(", @")} — ${data.dm.members.length} members now.`,
        "ok",
      )
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to invite.", "err")
    }
  }

  const renameGroup = async () => {
    const dm = dms.find((d) => d.id === channelId)
    if (!dm || !dm.isGroup) return
    const name = renameDraft.trim()
    if (!name) {
      toast("A group needs a name.", "err")
      return
    }
    try {
      await apiFetch("/api/chat-dm", {
        method: "PATCH",
        body: JSON.stringify({ token, dmId: dm.id, name }),
      })
      setDms((prev) =>
        prev.map((d) => (d.id === dm.id ? { ...d, name } : d)),
      )
      setShowRename(false)
      toast(`Group renamed to "${name}".`, "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Rename failed.", "err")
    }
  }

  // Drop a conversation from local state + unwatch its live room.
  const dropConversation = (dmId: string) => {
    watchedRoomsRef.current.delete(dmId)
    socketRef.current?.emit("unwatch", { channelId: dmId })
    setDms((prev) => prev.filter((d) => d.id !== dmId))
    if (channelIdRef.current === dmId) setChannelId("main")
  }

  // Close a DM / leave a group — YOUR sight only; the room lives on for
  // everyone else (owner ask: “remove it from your sight if you didn't
  // make it — same for DMs”).
  const closeDmById = async (dmId: string, isGroup: boolean) => {
    try {
      await apiFetch("/api/chat-dm/leave", {
        method: "POST",
        body: JSON.stringify({ token, dmId }),
      })
      dropConversation(dmId)
      setShowLeaveConfirm(false)
      toast(
        isGroup ? "Group left — it's off your sight." : "DM closed.",
        "ok",
      )
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed — try again.", "err")
      return false
    }
  }

  // Delete a group you MADE — gone for every member, messages included.
  const deleteGroupById = async (dmId: string) => {
    try {
      await apiFetch("/api/chat-dm/delete", {
        method: "POST",
        body: JSON.stringify({ token, dmId }),
      })
      dropConversation(dmId)
      toast("Group deleted — gone for everyone.", "ok")
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed.", "err")
      return false
    }
  }

  const leaveGroup = async () => {
    const dm = dms.find((d) => d.id === channelId)
    if (!dm) return
    await closeDmById(dm.id, dm.isGroup)
  }

  // -------------------------------------------------------------------------
  // Reactions — optimistic toggle, server truth, relay broadcast.
  // -------------------------------------------------------------------------
  const toggleReaction = useCallback(
    async (msg: ChatMessage, emoji: string) => {
      const me = accountRef.current
      if (!me || !token) return
      if (msg.id.startsWith("lv-")) {
        toast(
          "Reactions work on the website's messages — live-room (git version) messages can't have them yet.",
          "err",
        )
        return
      }
      const has = (msg.reactions || []).some(
        (r) => r.emoji === emoji && r.usernames.includes(me.id),
      )
      const patch = (m: ChatMessage) =>
        m.id === msg.id ? applyReactionDelta(m, emoji, !has, me.id) : m
      // Optimistic.
      setMessages((prev) => prev.map(patch))
      setPinned((prev) => prev.map(patch))
      try {
        const data = await apiFetch<{
          removed: boolean
          reactions: ReactionSummary[]
        }>("/api/chat-reactions", {
          method: "POST",
          body: JSON.stringify({ token, messageId: msg.id, emoji }),
        })
        // Server truth wins.
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, reactions: data.reactions } : m)),
        )
        socketRef.current?.emit("reaction", {
          channelId: msg.channelId,
          messageId: msg.id,
          emoji,
          added: !data.removed,
        })
      } catch (e) {
        // Revert the optimistic chip.
        const revert = (m: ChatMessage) =>
          m.id === msg.id ? applyReactionDelta(m, emoji, has, me.id) : m
        setMessages((prev) => prev.map(revert))
        setPinned((prev) => prev.map(revert))
        toast(e instanceof Error ? e.message : "Reaction failed.", "err")
      }
    },
    [token, toast],
  )

  // -------------------------------------------------------------------------
  // "Load older" — cursor pagination prepends the previous 100-message page.
  // -------------------------------------------------------------------------
  const loadOlder = useCallback(async () => {
    if (loadingOlder) return
    const oldest = messagesRef.current.find(() => true)
    if (!oldest) return
    setLoadingOlder(true)
    try {
      const cid = channelIdRef.current
      const data = await apiFetch<{ messages: ChatMessage[]; hasMore?: boolean }>(
        `/api/chat-data?channel=${encodeURIComponent(cid)}&before=${encodeURIComponent(
          new Date(oldest.createdAt).toISOString(),
        )}${
          !CHANNELS.some((c) => c.id === cid) ? `&token=${encodeURIComponent(token)}` : ""
        }`,
      )
      const fresh = data.messages || []
      if (fresh.length > 0) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id))
          const merged = [...fresh.filter((m) => !seen.has(m.id)), ...prev]
          merged.sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )
          return merged
        })
      }
      setHasMoreOlder(!!data.hasMore && fresh.length > 0)
    } catch {
      /* keep the button — next click retries */
    } finally {
      setLoadingOlder(false)
    }
  }, [token, loadingOlder])

  // Send a friend REQUEST — they get a notification, and only when THEY
  // accept does the friendship form. Every outcome gets a friendly toast,
  // never a raw error dump.
  const addFriend = async () => {
    const target = friendTarget.trim().replace(/^@/, "")
    if (!target) {
      toast("Type someone's @username first.", "err")
      return
    }
    if (friendBusy) return
    setFriendBusy(true)
    try {
      const data = await apiFetch<{
        sent?: boolean
        accepted?: boolean
        already?: "friends" | "pending"
        friend?: { username: string }
      }>("/api/chat-friends", {
        method: "POST",
        body: JSON.stringify({ token, action: "request", targetUsername: target }),
      })
      const name = data.friend?.username || target
      if (data.accepted) {
        toast(`You're now friends with @${name}!`, "ok")
      } else if (data.already === "friends") {
        toast(`You and @${name} are already friends.`, "ok")
      } else if (data.already === "pending") {
        toast(`Request already sent — just waiting for @${name} to accept.`, "ok")
      } else {
        toast(`Request sent to @${name} — they'll appear in Friends once they accept.`, "ok")
      }
      setFriendTarget("")
      setShowFriendMenu(false)
      void refreshFriends()
    } catch (e) {
      toast(
        e instanceof Error ? e.message : "Couldn't send that — try again in a moment.",
        "err",
      )
    } finally {
      setFriendBusy(false)
    }
  }

  // Accept / decline an INCOMING request (from the sidebar or the bell).
  const respondFriend = async (requestId: string, action: "accept" | "decline") => {
    try {
      const data = await apiFetch<{ friend?: ChatAccount }>("/api/chat-friends", {
        method: "POST",
        body: JSON.stringify({ token, action, requestId }),
      })
      setFriendRequestsIn((prev) => prev.filter((r) => r.id !== requestId))
      // Mark the matching bell notification handled (hides its buttons).
      setNotifications((prev) =>
        prev.map((n) => (n.requestId === requestId ? { ...n, read: true } : n)),
      )
      if (action === "accept") {
        if (data.friend) {
          const newFriend = data.friend
          setFriends((prev) =>
            prev.some((f) => f.id === newFriend.id) ? prev : [newFriend, ...prev],
          )
          toast(`You're now friends with @${newFriend.username}!`, "ok")
        } else {
          toast("Made friends!", "ok")
          void refreshFriends()
        }
      } else {
        toast("Request declined — no hard feelings.", "ok")
      }
    } catch {
      toast(
        action === "accept"
          ? "Couldn't accept just now — try again in a moment."
          : "Couldn't decline just now — try again in a moment.",
        "err",
      )
    }
  }

  // Take back an OUTGOING pending request.
  const cancelFriendRequest = async (requestId: string) => {
    try {
      await apiFetch("/api/chat-friends", {
        method: "POST",
        body: JSON.stringify({ token, action: "cancel", requestId }),
      })
      setFriendRequestsOut((prev) => prev.filter((r) => r.id !== requestId))
      toast("Request cancelled.", "ok")
    } catch {
      toast("Couldn't cancel just now — try again in a moment.", "err")
    }
  }

  // Remove a friend (both directions — the API keeps friendship mutual).
  const removeFriend = async (username: string) => {
    try {
      await apiFetch("/api/chat-friends", {
        method: "POST",
        body: JSON.stringify({ token, action: "remove", targetUsername: username }),
      })
      setFriends((prev) => prev.filter((f) => f.username !== username))
      toast(`Removed @${username}.`, "ok")
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove that friend — try again in a moment.", "err")
    }
  }

  // Logout.
  const logout = () => {
    clearStoredAccount()
    setAccount(null)
    setToken("")
    setMessages([])
    setMembers([])
    setDms([])
    setFriends([])
    setFriendRequestsIn([])
    setFriendRequestsOut([])
    setNotifications([])
    setUnread({})
    setChannelId("main")
    socketRef.current?.disconnect()
    socketRef.current = null
  }

  // Update account + propagate.
  const updateAccount = useCallback((a: ChatAccount) => {
    setAccount(a)
    if (token) saveStoredAccount(a, token)
  }, [token])

  // Active channel metadata.
  const channelMeta = CHANNELS.find((c) => c.id === channelId)
  /** Mod-only channels (#links, #announcements) are read-only for regular members. */
  const channelLocked =
    channelMeta?.modOnly === true && !isMod(account)
  const isDm = !channelMeta
  const dmMeta = dms.find((d) => d.id === channelId)
  const channelLabel = isDm
    ? dmMeta
      ? dmMeta.name || dmMeta.members.filter((m) => m.id !== account?.id).map(displayName).join(", ")
      : "DM"
    : channelMeta?.label || "#general"

  // Filtered typing indicators for the current channel.
  const activeTyping = typingUsers[channelId] || []

  /* Total unread across every channel + DM — the little orange pill on
   * the closed channel-switcher button. */
  const totalUnread = useMemo(
    () => Object.values(unread).reduce((sum, n) => sum + (n || 0), 0),
    [unread],
  )

  /* Unread across DMs only — the DMs header button's badge. */
  const dmUnread = useMemo(
    () => dms.reduce((sum, d) => sum + (unread[d.id] || 0), 0),
    [dms, unread],
  )

  /* Online account ids — shared by the friends panel's live dots. */
  const onlineIdSet = useMemo(
    () => new Set(presence.map((p) => p.accountId)),
    [presence],
  )

  /* The right-side player list is scoped to the conversation: public
   * channels show every member + live-room users; DMs/groups show just
   * the conversation's members. */
  const dmPresence = useMemo(
    () =>
      dmMeta
        ? presence.filter((p) => dmMeta.members.some((m) => m.id === p.accountId))
        : [],
    [dmMeta, presence],
  )

  // ---------------------------------------------------------------------------
  // Auth gate.
  if (!bootstrapped) {
    return (
      <div className="grid min-h-screen place-items-center bg-black/30 text-white">
        <Loader2 className="h-6 w-6 animate-spin text-orange-400" />
      </div>
    )
  }

  if (!account || !token) {
    return <AuthScreen onBack={onBack} onAuthed={(a, t) => { setAccount(a); setToken(t) }} />
  }

  // ---------------------------------------------------------------------------
  // Render chat UI.
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-black/30 text-white">
      <ChatWallpaperBackdrop />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* Header bar — relative+z-40: the channel switcher popover lives in
            here, and the header's backdrop-blur creates a stacking context.
            Without a positive z-index the header (non-positioned) painted
            UNDER the positioned message rows, so tall GIFs in chat covered
            the open switcher — #general/#sharelinks/#announcements, the DM
            list and Add Friends all vanished behind the image. */}
        <header className="relative z-40 flex items-center gap-2 border-b border-white/10 bg-black/50 px-3 py-2 backdrop-blur-xl">
          {/* Back to Veil */}
          {onBack && (
            <motion.button
              onClick={onBack}
              whileHover={{ x: -3 }}
              whileTap={{ scale: 0.94 }}
              transition={CHAT_POP}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-white/70 hover:bg-white/10 hover:text-white"
              title="Back to Veil (Esc)"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden text-xs font-medium sm:inline">Veil</span>
            </motion.button>
          )}
          {/* Channel name + switcher */}
          <div className="relative">
            <motion.button
              onClick={() => setChannelSwitcher((s) => !s)}
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              transition={CHAT_POP}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-white/10"
            >
              {isDm ? (
                dmMeta?.isGroup ? (
                  <Users className="h-4 w-4 text-orange-400" />
                ) : (
                  <MessageCircle className="h-4 w-4 text-orange-400" />
                )
              ) : (
                <Hash className="h-4 w-4 text-orange-400" />
              )}
              <span className="max-w-[10rem] truncate text-sm font-semibold sm:max-w-[16rem]">
                {channelLabel}
              </span>
              {totalUnread > 0 && (
                <span
                  key={totalUnread}
                  className="veil-badge-pop veil-bounce-soft grid h-4 min-w-4 place-items-center rounded-full bg-orange-400 px-1 text-[9px] font-bold text-black"
                >
                  {totalUnread > 99 ? "99+" : totalUnread}
                </span>
              )}
              <ChevronDown
                className={`h-3.5 w-3.5 text-white/50 transition-transform duration-300 ${
                  channelSwitcher ? "rotate-180" : ""
                }`}
              />
            </motion.button>
            <AnimatePresence>
              {channelSwitcher && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="veil-scroll-slim absolute left-0 top-9 z-30 max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-white/10 bg-zinc-950/92 backdrop-blur-xl p-1 shadow-2xl"
                >
                  <div className="veil-text-shine px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    Channels
                  </div>
                  {CHANNELS.map((c, ci) => {
                    const typingHere = (typingUsers[c.id] || []).length
                    return (
                      <motion.button
                        key={c.id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: Math.min(ci * 0.03, 0.24), duration: 0.2, ease: "easeOut" }}
                        whileHover={{ x: 2 }}
                        onClick={() => {
                          setChannelId(c.id)
                          setChannelSwitcher(false)
                        }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                          channelId === c.id
                            ? "veil-pulse-glow bg-white/10"
                            : "veil-hover-glow hover:bg-white/5"
                        }`}
                      >
                        <Hash className="h-3.5 w-3.5 text-white/40" />
                        <span className="flex-1 text-left">{c.name}</span>
                        {typingHere > 0 ? (
                          <TypingDots className="scale-90" />
                        ) : unread[c.id] > 0 ? (
                          <span
                            key={unread[c.id]}
                            className="veil-badge-pop veil-bounce-soft grid h-4 min-w-4 place-items-center rounded-full bg-orange-400 px-1 text-[9px] font-bold text-black"
                          >
                            {unread[c.id] > 99 ? "99+" : unread[c.id]}
                          </span>
                        ) : (
                          <span className="text-[10px] text-white/30">{c.desc}</span>
                        )}
                      </motion.button>
                    )
                  })}
                  <div className="mt-1 flex items-center justify-between px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    <span>Messages</span>
                    <span className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setShowGroupMenu((s) => !s)
                          setShowDmMenu(false)
                        }}
                        className={`rounded p-0.5 hover:bg-white/10 ${showGroupMenu ? "text-orange-300" : ""}`}
                        title="New group chat — invite friends in"
                      >
                        <Users className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => {
                          setShowDmMenu((s) => !s)
                          setShowGroupMenu(false)
                        }}
                        className={`rounded p-0.5 hover:bg-white/10 ${showDmMenu ? "text-orange-300" : ""}`}
                        title="New DM"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                  {showGroupMenu && (
                    <div className="mx-1 mb-1 rounded-lg border border-white/10 bg-black/30 p-2">
                      <input
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        placeholder="Group name (e.g. Squad)"
                        maxLength={64}
                        className="veil-focus-bloom mb-1.5 w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:border-orange-400/50"
                      />
                      {friends.length > 0 && (
                        <div className="veil-scroll-slim mb-1.5 max-h-28 overflow-y-auto rounded-md border border-white/10">
                          {friends.map((f) => (
                            <label
                              key={f.id}
                              className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px] hover:bg-white/5"
                            >
                              <input
                                type="checkbox"
                                checked={!!groupPicked[f.username]}
                                onChange={(e) =>
                                  setGroupPicked((prev) => ({
                                    ...prev,
                                    [f.username]: e.target.checked,
                                  }))
                                }
                                className="accent-orange-400"
                              />
                              <span
                                className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[8px] font-bold text-white"
                                style={{ backgroundColor: f.avatarColor }}
                              >
                                {f.username[0]?.toUpperCase()}
                              </span>
                              <span className="flex-1 truncate text-white/75">
                                {displayName(f)}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1">
                        <input
                          value={groupUserInput}
                          onChange={(e) => setGroupUserInput(e.target.value)}
                          placeholder="@username, @username…"
                          autoCapitalize="none"
                          className="flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none"
                        />
                        <button
                          onClick={() => void createGroup()}
                          disabled={creatingGroup}
                          className="veil-press flex items-center gap-1 rounded-md bg-orange-400 px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
                        >
                          {creatingGroup ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Users className="h-3 w-3" />
                          )}
                          Create
                        </button>
                      </div>
                      <p className="mt-1 text-[9.5px] leading-tight text-white/35">
                        Tick friends and/or type @usernames — everyone gets in
                        at once and can invite more later.
                      </p>
                    </div>
                  )}
                  {showDmMenu && (
                    <div className="flex items-center gap-1 px-1 pb-1">
                      <input
                        value={dmTarget}
                        onChange={(e) => setDmTarget(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && void createDm()}
                        placeholder="@username"
                        autoCapitalize="none"
                        className="veil-focus-bloom flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none"
                      />
                      <button
                        onClick={() => void createDm()}
                        className="veil-press rounded-md bg-orange-400 px-2 py-1 text-xs font-semibold text-black"
                      >
                        Open
                      </button>
                    </div>
                  )}
                  {dms.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] text-white/30">
                      No messages yet — start a DM or a group with the buttons
                      above.
                    </p>
                  ) : (
                    dms.map((d, di) => {
                      const label =
                        d.name ||
                        d.members
                          .filter((m) => m.id !== account.id)
                          .map(displayName)
                          .join(", ") ||
                        "DM"
                      const typingHere = (typingUsers[d.id] || []).length
                      return (
                        <motion.button
                          key={d.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: Math.min(di * 0.03, 0.24), duration: 0.2, ease: "easeOut" }}
                          whileHover={{ x: 2 }}
                          onClick={() => {
                            setChannelId(d.id)
                            setChannelSwitcher(false)
                          }}
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                            channelId === d.id
                              ? "veil-pulse-glow bg-white/10"
                              : "veil-hover-glow hover:bg-white/5"
                          }`}
                        >
                          {d.isGroup ? (
                            <Users className="h-3.5 w-3.5 shrink-0 text-orange-300/70" />
                          ) : (
                            <MessageCircle className="h-3.5 w-3.5 shrink-0 text-white/40" />
                          )}
                          <span className="flex-1 truncate text-left">{label}</span>
                          {typingHere > 0 ? (
                            <TypingDots className="scale-90" />
                          ) : d.isGroup ? (
                            <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-white/50">
                              {d.members.length}
                            </span>
                          ) : null}
                          {unread[d.id] > 0 && (
                            <span
                              key={unread[d.id]}
                              className="veil-badge-pop veil-bounce-soft grid h-4 min-w-4 place-items-center rounded-full bg-orange-400 px-1 text-[9px] font-bold text-black"
                            >
                              {unread[d.id] > 99 ? "99+" : unread[d.id]}
                            </span>
                          )}
                        </motion.button>
                      )
                    })
                  )}
                  {/* Friends section */}
                  <div className="mt-1 flex items-center justify-between border-t border-white/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    <span>Friends — {friends.length}</span>
                    <div className="flex items-center gap-1.5">
                      {friendRequestsIn.length > 0 && (
                        <button
                          onClick={() => setShowFriendMenu(false)}
                          className="veil-bounce-soft grid h-4 min-w-4 place-items-center rounded-full bg-orange-400 px-1 text-[9px] font-bold text-black"
                          title={`${friendRequestsIn.length} friend request${friendRequestsIn.length === 1 ? "" : "s"} waiting`}
                        >
                          {friendRequestsIn.length}
                        </button>
                      )}
                      <button
                        onClick={() => setShowFriendMenu((s) => !s)}
                        className="rounded p-0.5 hover:bg-white/10"
                        title="Send a friend request"
                      >
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  {showFriendMenu && (
                    <div className="px-1 pb-1">
                      <div className="flex items-center gap-1">
                        <input
                          value={friendTarget}
                          onChange={(e) => setFriendTarget(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && void addFriend()}
                          placeholder="@username"
                          autoCapitalize="none"
                          className="veil-focus-bloom flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none"
                        />
                        <button
                          onClick={() => void addFriend()}
                          disabled={friendBusy}
                          className="veil-press veil-hover-glow flex items-center gap-1 rounded-md bg-orange-400 px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
                        >
                          {friendBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <UserPlus className="h-3 w-3" />
                          )}
                          Send
                        </button>
                      </div>
                      <p className="mt-1 text-[9.5px] leading-tight text-white/35">
                        They get a notification — you become friends when they
                        accept.
                      </p>
                    </div>
                  )}
                  {/* Incoming friend requests — accept / decline inline */}
                  {friendRequestsIn.length > 0 && (
                    <div className="mb-1 space-y-1 px-1">
                      {friendRequestsIn.map((r, ri) => (
                        <div
                          key={r.id}
                          className={`veil-slide-right-pop veil-stagger-${(ri % 8) + 1} flex items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-400/5 px-2 py-1.5`}
                        >
                          <span
                            className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white"
                            style={{ backgroundColor: r.user.avatarColor || "#f97316" }}
                          >
                            {r.user.username?.[0]?.toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-white/85">
                              {displayName(r.user)}
                            </span>
                            <span className="block text-[9.5px] text-emerald-300/70">
                              wants to be your friend
                            </span>
                          </span>
                          <button
                            onClick={() => void respondFriend(r.id, "accept")}
                            className="veil-hover-bounce veil-press grid h-6 w-6 shrink-0 place-items-center rounded-md bg-emerald-500/90 text-black hover:bg-emerald-400"
                            title={`Accept @${r.user.username}`}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => void respondFriend(r.id, "decline")}
                            className="veil-hover-wobble veil-press grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/10 text-white/50 hover:bg-red-500/10 hover:text-red-300"
                            title={`Decline @${r.user.username}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {friends.length === 0 && friendRequestsIn.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] text-white/30">
                      No friends yet. Click + to send a request.
                    </p>
                  ) : (
                    friends.map((f, fi) => (
                      <div
                        key={f.id}
                        className={`veil-slide-right-pop veil-stagger-${(fi % 8) + 1} veil-hover-glow group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5`}
                      >
                        <span
                          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white"
                          style={{ backgroundColor: f.avatarColor }}
                        >
                          {f.username[0]?.toUpperCase()}
                        </span>
                        <span className="flex-1 truncate text-left text-white/80">{displayName(f)}</span>
                        <button
                          onClick={() => {
                            setDmTarget(f.username)
                            void createDm()
                          }}
                          className="veil-hover-bounce hidden rounded p-1 text-white/40 hover:bg-white/10 hover:text-white group-hover:block"
                          title="DM"
                        >
                          <MessageCircle className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => void removeFriend(f.username)}
                          className="veil-hover-wobble hidden rounded p-1 text-white/40 hover:bg-red-500/10 hover:text-red-300 group-hover:block"
                          title="Remove friend"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                  {/* Outgoing requests — pending, cancellable */}
                  {friendRequestsOut.length > 0 && (
                    <div className="mt-0.5 space-y-0.5 px-1">
                      {friendRequestsOut.map((r, roi) => (
                        <div
                          key={r.id}
                          className={`veil-slide-right-pop veil-stagger-${(roi % 8) + 1} group flex w-full items-center gap-2 rounded-md px-2 py-1 text-[11px] hover:bg-white/5`}
                        >
                          <Clock className="h-3 w-3 shrink-0 text-white/25" />
                          <span className="flex-1 truncate text-left text-white/40">
                            {displayName(r.user)}
                          </span>
                          <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] text-white/35">
                            waiting
                          </span>
                          <button
                            onClick={() => void cancelFriendRequest(r.id)}
                            className="hidden rounded p-1 text-white/35 hover:bg-red-500/10 hover:text-red-300 group-hover:block"
                            title="Cancel request"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Channel description + group actions */}
          {isDm && dmMeta ? (
            <div className="hidden items-center gap-1.5 sm:flex">
              <span className="text-xs text-white/40">
                {dmMeta.isGroup
                  ? `Group — ${dmMeta.members.length} member${dmMeta.members.length === 1 ? "" : "s"}`
                  : "Direct message"}
              </span>
              <button
                onClick={() => setShowInvite(true)}
                className="flex items-center gap-1 rounded-md bg-orange-400/10 px-2 py-0.5 text-[11px] font-semibold text-orange-300 hover:bg-orange-400/20"
                title="Invite people to this conversation"
              >
                <UserPlus className="h-3 w-3" />
                <span className="hidden md:inline">Invite</span>
              </button>
              {dmMeta.isGroup && (
                <button
                  onClick={() => {
                    setRenameDraft(dmMeta.name || "")
                    setShowRename(true)
                  }}
                  className="rounded-md p-1 text-white/40 hover:bg-white/10 hover:text-white"
                  title="Rename group"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              <button
                onClick={() => setShowLeaveConfirm(true)}
                className="rounded-md p-1 text-white/40 hover:bg-red-500/15 hover:text-red-300"
                title={dmMeta.isGroup ? "Leave group" : "Close DM"}
              >
                <LogOut className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <span className="hidden text-xs text-white/40 sm:inline">
              {channelMeta?.desc}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {/* Clock — isolated so its 1s tick never re-renders the app */}
            <LiveClock />

            {/* Coins */}
            <motion.button
              onClick={() => setShowTransfer(true)}
              whileHover={{ scale: 1.06, y: -1 }}
              whileTap={{ scale: 0.94 }}
              transition={CHAT_POP}
              className="flex items-center gap-1 rounded-md bg-orange-400/10 px-2 py-1 text-xs font-semibold text-orange-300 hover:bg-orange-400/20"
              title="Send coins"
            >
              {/* keyed span — flips 720° whenever the balance changes */}
              <span key={account.coins} className="veil-coin-flip">🪙 {account.coins.toLocaleString()}</span>
            </motion.button>

            {/* Daily reward */}
            <DailyRewardButton
              token={token}
              onAccount={updateAccount}
              toast={toast}
            />

            {/* Games — Coin Flip + Blackjack, betting real coins */}
            <motion.button
              onClick={() => setShowGames(true)}
              whileHover={{ scale: 1.16, y: -1, rotate: -14 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className="veil-hover-glow rounded-md p-1.5 text-amber-300 hover:bg-amber-400/10"
              title="Games — flip the coin or play blackjack with your coins"
            >
              <Dices className="h-4 w-4" />
            </motion.button>

            {/* Online count */}
            <span className="veil-hover-glow hidden items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-xs text-white/60 md:flex">
              <Circle className="veil-twinkle h-2 w-2 fill-emerald-400 text-emerald-400" />
              {presence.length} online
            </span>

            {/* Pinned */}
            <motion.button
              onClick={() => {
                setShowPinned((s) => !s)
                setShowNotifications(false)
                setShowSearch(false)
                setShowBackup(false)
              }}
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className={`rounded-md p-1.5 hover:bg-white/10 ${
                showPinned ? "bg-white/10 text-orange-300" : "text-white/60"
              }`}
              title="Pinned messages"
            >
              <Pin className="h-4 w-4" />
            </motion.button>

            {/* Notifications */}
            <motion.button
              onClick={() => {
                setShowNotifications((s) => !s)
                setShowPinned(false)
                setShowSearch(false)
                setShowBackup(false)
              }}
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86, rotate: -12 }}
              transition={CHAT_POP}
              className={`relative rounded-md p-1.5 hover:bg-white/10 ${
                showNotifications ? "bg-white/10 text-orange-300" : "text-white/60"
              }`}
              title="Notifications"
            >
              <Bell className="h-4 w-4" />
              {notifications.filter((n) => !n.read).length > 0 && (
                <motion.span
                  key={notifications.filter((n) => !n.read).length}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={CHAT_POP}
                  className="veil-badge-pop absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-red-500 text-[8px] font-bold text-white"
                >
                  {notifications.filter((n) => !n.read).length}
                </motion.span>
              )}
            </motion.button>

            {/* Search */}
            <motion.button
              onClick={() => {
                setShowSearch((s) => !s)
                setShowPinned(false)
                setShowNotifications(false)
                setShowBackup(false)
              }}
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className={`rounded-md p-1.5 hover:bg-white/10 ${
                showSearch ? "bg-white/10 text-orange-300" : "text-white/60"
              }`}
              title="Search messages"
            >
              <Search className="h-4 w-4" />
            </motion.button>

            {/* Member list toggle (the Players tab) */}
            <motion.button
              onClick={() => {
                /* From a social panel, Players takes the slot (never
                 * closes it — that felt like the button ate the panel). */
                const wasSocial = socialPanel !== null
                setSocialPanel(null)
                setShowMembers((s) => (wasSocial ? true : !s))
              }}
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className={`rounded-md p-1.5 hover:bg-white/10 ${
                showMembers && !socialPanel ? "bg-white/10 text-orange-300" : "text-white/60"
              }`}
              title="Toggle player list"
            >
              <Users className="h-4 w-4" />
            </motion.button>

            {/* Friends — its own button next to the players tab (owner
                ask). Badge = pending incoming requests. */}
            <motion.button
              onClick={() =>
                setSocialPanel((cur) => (cur === "friends" ? null : "friends"))
              }
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className={`relative rounded-md p-1.5 hover:bg-white/10 ${
                socialPanel === "friends" ? "bg-white/10 text-rose-300" : "text-white/60"
              }`}
              title="Friends"
            >
              <Heart className="h-4 w-4" />
              {friendRequestsIn.length > 0 && (
                <motion.span
                  key={friendRequestsIn.length}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={CHAT_POP}
                  className="veil-badge-pop absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-rose-500 text-[8px] font-bold text-white"
                >
                  {friendRequestsIn.length}
                </motion.span>
              )}
            </motion.button>

            {/* DMs — its own button next to the players tab. Badge =
                unread DMs. */}
            <motion.button
              onClick={() => setSocialPanel((cur) => (cur === "dms" ? null : "dms"))}
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className={`relative rounded-md p-1.5 hover:bg-white/10 ${
                socialPanel === "dms" ? "bg-white/10 text-orange-300" : "text-white/60"
              }`}
              title="Direct messages"
            >
              <MessageCircle className="h-4 w-4" />
              {dmUnread > 0 && (
                <motion.span
                  key={dmUnread}
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={CHAT_POP}
                  className="veil-badge-pop absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-orange-400 text-[8px] font-bold text-black"
                >
                  {dmUnread > 99 ? "99+" : dmUnread}
                </motion.span>
              )}
            </motion.button>

            {/* Groups — its own button next to the players tab. */}
            <motion.button
              onClick={() =>
                setSocialPanel((cur) => (cur === "groups" ? null : "groups"))
              }
              whileHover={{ scale: 1.16, y: -1 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className={`relative rounded-md p-1.5 hover:bg-white/10 ${
                socialPanel === "groups" ? "bg-white/10 text-cyan-300" : "text-white/60"
              }`}
              title="Group chats"
            >
              <UsersRound className="h-4 w-4" />
              {dms.filter((d) => d.isGroup).length > 0 && socialPanel !== "groups" && (
                <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-cyan-500/80 text-[8px] font-bold text-black">
                  {dms.filter((d) => d.isGroup).length}
                </span>
              )}
            </motion.button>

            {/* Chat backup (mods/owner) — jsDelivr safety net */}
            {isMod(account) && (
              <motion.button
                onClick={() => {
                  setShowBackup((s) => !s)
                  setShowPinned(false)
                  setShowNotifications(false)
                  setShowSearch(false)
                }}
                whileHover={{ scale: 1.16, y: -1 }}
                whileTap={{ scale: 0.86 }}
                transition={CHAT_POP}
                className={`rounded-md p-1.5 hover:bg-white/10 ${
                  showBackup ? "bg-white/10 text-emerald-300" : "text-white/60"
                }`}
                title="Chat backups (auto every 30s, published to jsDelivr)"
              >
                <DatabaseBackup className="h-4 w-4" />
              </motion.button>
            )}

            {/* Mod panel */}
            {isMod(account) && (
              <motion.button
                onClick={() => setShowMod(true)}
                whileHover={{ scale: 1.16, y: -1 }}
                whileTap={{ scale: 0.86 }}
                transition={CHAT_POP}
                className="rounded-md bg-red-500/15 p-1.5 text-red-300 hover:bg-red-500/25"
                title="Moderation panel"
              >
                <Shield className="h-4 w-4" />
              </motion.button>
            )}

            {/* Avatar with camera */}
            <div className="veil-pulse-glow relative">
              <motion.button
                onClick={() => setShowProfile(true)}
                whileHover={{ scale: 1.12 }}
                whileTap={{ scale: 0.92 }}
                transition={CHAT_POP}
                className="rounded-full ring-2 ring-white/10 hover:ring-orange-400/50"
                title="Your profile"
              >
                <AvatarWithAccessory account={account} size={28} />
              </motion.button>
              <motion.button
                onClick={() => setShowProfile(true)}
                whileHover={{ scale: 1.25, rotate: 90 }}
                whileTap={{ scale: 0.85 }}
                transition={CHAT_POP}
                className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full border border-black/60 bg-orange-400 text-black"
                title="Change profile picture"
              >
                <Camera className="h-2.5 w-2.5" />
              </motion.button>
            </div>

            {/* Logout */}
            <motion.button
              onClick={logout}
              whileHover={{ scale: 1.16, rotate: 10 }}
              whileTap={{ scale: 0.86 }}
              transition={CHAT_POP}
              className="rounded-md p-1.5 text-white/60 hover:bg-red-500/20 hover:text-red-300"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </motion.button>
          </div>
        </header>

        {/* Floating right-side panels */}
        <div className="relative flex min-h-0 flex-1">
          {/* Main chat area */}
          <main className="relative flex min-w-0 flex-1 flex-col">
            {/* Messages scroll area */}
            <div
              ref={scrollContainerRef}
              onScroll={checkScrollPosition}
              className="relative min-h-0 flex-1 overflow-y-auto"
              style={{ scrollbarWidth: "thin" }}
            >
              {/* Slim loading bar while a channel switch's fetch is in
               * flight — the previous list stays visible underneath. */}
              {channelLoading && (
                <div className="pointer-events-none sticky top-0 z-20 h-0.5 w-full overflow-hidden">
                  <div className="h-full w-1/3 animate-[veil-slide_1.1s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-transparent via-orange-400 to-transparent" />
                </div>
              )}
              <div className="py-2">
                {hasMoreOlder && (
                  <div className="grid place-items-center py-1.5">
                    <button
                      onClick={() => void loadOlder()}
                      disabled={loadingOlder}
                      className="veil-hover-lift flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white/60 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white disabled:opacity-50"
                      title="Load the previous 100 messages"
                    >
                      {loadingOlder ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ChevronUp className="h-3 w-3" />
                      )}
                      {loadingOlder ? "Loading…" : "Load older messages"}
                    </button>
                  </div>
                )}
                {mergedMessages.length === 0 ? (
                  <div className="veil-rise grid place-items-center py-20 text-center text-white/40">
                    <Hash className="veil-empty-bob mb-2 h-8 w-8 opacity-50" />
                    <p className="text-sm">No messages here yet.</p>
                    <p className="veil-text-breathe mt-1 text-xs">Be the first to say something!</p>
                  </div>
                ) : (
                  /* Keyed by channel — every switch re-plays a soft rise for
                   * the whole stack while individual rows stay calm (their
                   * entrance spring only fires for live arrivals). */
                  <div key={channelId} className="veil-rise">
                  {mergedMessages.map((m, i) => {
                    const prev = mergedMessages[i - 1]
                    const newDay =
                      i === 0 || dayKeyOf(m.createdAt) !== dayKeyOf(prev.createdAt)
                    return (
                      <div key={m.id}>
                        {newDay && (
                          <DayDivider
                            label={dayLabelOf(m.createdAt)}
                            count={dayCounts[dayKeyOf(m.createdAt)] || 0}
                          />
                        )}
                        <MessageRow
                          msg={m}
                          prev={prev}
                          isMe={m.account.id === account.id || isMod(account)}
                          canEdit={canEditMessage(m)}
                          editing={editingId === m.id}
                          editDraft={editingId === m.id ? editDraft : ""}
                          editBusy={editBusy}
                          fresh={freshIds.has(m.id)}
                          myId={account.id}
                          onReply={handleReply}
                          onPin={togglePin}
                          onDelete={deleteMessage}
                          onEditStart={startEdit}
                          onEditDraft={setEditDraft}
                          onEditSave={handleEditSave}
                          onEditCancel={cancelEdit}
                          onOpenProfile={openProfile}
                          onReact={toggleReaction}
                        />
                      </div>
                    )
                  })}
                  </div>
                )}
                <div ref={messagesEndRef} />

                {/* Typing indicator — a soft bubble that floats up when
                    someone starts typing and sinks away when they stop. */}
                <AnimatePresence>
                  {activeTyping.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      transition={{ duration: 0.24, ease: "easeOut" }}
                      className="px-4 py-1.5"
                    >
                      <span className="veil-pulse-glow inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-2.5 pr-3 text-xs text-white/50 shadow-lg backdrop-blur-sm">
                        <TypingDots />
                        <span className="italic">
                          {activeTyping
                            .slice(0, 3)
                            .map((u) => displayName(u))
                            .join(", ")}{" "}
                          {activeTyping.length === 1 ? "is" : "are"} typing…
                        </span>
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* Reply preview bar */}
            <AnimatePresence>
              {replyTo && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  className="flex items-center gap-2 border-t border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs"
                >
                  <Reply className="h-3 w-3 text-orange-400" />
                  <span className="text-white/60">Replying to</span>
                  <span className="font-medium text-white">
                    @{replyTo.account.username}
                  </span>
                  <span className="truncate text-white/50">
                    {replyTo.content.slice(0, 60)}
                  </span>
                  <button
                    onClick={() => setReplyTo(null)}
                    className="veil-hover-wobble ml-auto rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Input bar */}
            <div className="relative border-t border-white/10 bg-black/50 p-2 backdrop-blur">
              <AnimatePresence>
                {showGif && (
                  <GifPicker
                    onPick={(gifUrl) => {
                      void sendMessageDirect(gifUrl)
                      setShowGif(false)
                    }}
                    onClose={() => setShowGif(false)}
                  />
                )}
                {showEmoji && (
                  <EmojiPicker
                    onPick={(e) => {
                      setInput((prev) => prev + e)
                    }}
                    onClose={() => setShowEmoji(false)}
                  />
                )}
              </AnimatePresence>

              {/* Upload progress — a big file streams for a while. The
                  panel springs in and the bar wears candy stripes. */}
              <AnimatePresence>
                {upload && (
                  <motion.div
                    initial={{ opacity: 0, y: 10, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={CHAT_SOFT}
                    className="mb-2 origin-bottom rounded-xl border border-orange-400/30 bg-orange-400/5 px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11.5px] text-white/70">
                      <span className="min-w-0 flex-1 truncate">
                        <Paperclip className="mr-1 inline h-3 w-3 text-orange-300" />
                        {upload.name}
                      </span>
                      <span className="tabular-nums font-semibold text-orange-300">{upload.pct}%</span>
                    </div>
                    <div
                      className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"
                      role="progressbar"
                      aria-label={`Uploading ${upload.name}`}
                      aria-valuenow={upload.pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className="veil-upload-stripes h-full rounded-full bg-orange-400 transition-[width] duration-150"
                        style={{ width: `${upload.pct}%` }}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* The composer — on focus a warm gradient edge sweeps the
                  border while the glow ring holds (veil-composer-focus).
                  Mega tier adds the veil-pulse-glow breathing halo. */}
              <div className="veil-composer-focus veil-pulse-glow relative flex items-center gap-1.5 rounded-xl border border-white/10 bg-black/30 px-2 py-1.5 transition-[border-color,box-shadow] duration-300">
                <motion.button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!upload}
                  whileHover={{ scale: 1.18, rotate: -10 }}
                  whileTap={{ scale: 0.85 }}
                  transition={CHAT_POP}
                  className="rounded-md p-1.5 text-white/60 hover:bg-white/10 disabled:opacity-40"
                  title="Attach a file (up to 300 MB) — images, videos and audio play inline"
                  aria-label="Attach a file"
                >
                  <Paperclip className="veil-hover-spin h-4 w-4" />
                </motion.button>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ""
                    if (f) uploadFile(f)
                  }}
                  className="hidden"
                  aria-hidden
                  tabIndex={-1}
                />
                <motion.button
                  onClick={() => {
                    setShowGif((s) => !s)
                    setShowEmoji(false)
                  }}
                  whileHover={{ scale: 1.08, y: -1 }}
                  whileTap={{ scale: 0.88 }}
                  transition={CHAT_POP}
                  className={`veil-hover-glow rounded-md px-1.5 py-1 text-[10px] font-bold hover:bg-white/10 ${
                    showGif ? "text-orange-300" : "text-white/60"
                  }`}
                  title="Search GIFs"
                >
                  GIF
                </motion.button>
                <motion.button
                  onClick={() => {
                    setShowEmoji((s) => !s)
                    setShowGif(false)
                  }}
                  whileHover={{ scale: 1.2, rotate: 14 }}
                  whileTap={{ scale: 0.85 }}
                  transition={CHAT_POP}
                  className={`rounded-md p-1.5 hover:bg-white/10 ${
                    showEmoji ? "text-orange-300" : "text-white/60"
                  }`}
                  title="Emoji"
                >
                  <Smile className="veil-hover-wobble h-4 w-4" />
                </motion.button>
                <motion.button
                  onClick={() => setShowTransfer(true)}
                  whileHover={{ scale: 1.15, rotate: [0, -9, 9, 0] }}
                  whileTap={{ scale: 0.85 }}
                  transition={CHAT_POP}
                  className="veil-hover-glow rounded-md p-1.5 text-white/60 hover:bg-white/10"
                  title="Send coins"
                >
                  <Gift className="veil-hover-bounce h-4 w-4" />
                </motion.button>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={onInputChange}
                  onKeyDown={onKey}
                  placeholder={
                    channelLocked
                      ? `${channelLabel} — read-only (mods & owner post here)`
                      : `Message ${channelLabel} — try /help`
                  }
                  disabled={channelLocked}
                  className="flex-1 bg-transparent px-2 py-1 text-sm text-white outline-none placeholder:text-white/30 disabled:opacity-50"
                />
                {/* Send — swells with a breathing glow ring the moment
                    there is text to send, pops its icon ready, and squeezes
                    on tap as the message flies. Mega tier: the wrapper owns
                    press + hover-bounce so it composes with framer's
                    whileHover/whileTap transforms on the button itself. */}
                <div className={`veil-press ${input.trim() ? "veil-hover-bounce" : ""}`}>
                  <motion.button
                    onClick={() => void sendMessage()}
                    disabled={!input.trim()}
                    whileHover={input.trim() ? { scale: 1.14, rotate: -8 } : undefined}
                    whileTap={{ scale: 0.82 }}
                    transition={CHAT_POP}
                    className={`grid h-8 w-8 place-items-center rounded-md bg-orange-400 text-black transition-[opacity,box-shadow] duration-300 ${
                      input.trim() ? "veil-send-glow" : "opacity-40"
                    }`}
                    title="Send"
                  >
                    <motion.span
                      key={input.trim() ? "armed" : "idle"}
                      initial={{ scale: 0.55, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={CHAT_POP}
                      className="grid place-items-center"
                    >
                      <Send className="h-4 w-4" />
                    </motion.span>
                  </motion.button>
                </div>
              </div>
            </div>
          </main>

          {/* Floating side panels — z-50: one above the z-40 header so the
              pinned/notifications panels still overlay the header's buttons
              (they are anchored at the top-right corner). */}
          <div className="pointer-events-none absolute right-2 top-2 z-50 flex flex-col items-end gap-2">
            <AnimatePresence>
              {showPinned && (
                <motion.div
                  initial={{ opacity: 0, x: 28, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 28, scale: 0.97 }}
                  transition={CHAT_SOFT}
                  className="pointer-events-auto"
                >
                  <PinnedPanel messages={pinned} onClose={() => setShowPinned(false)} />
                </motion.div>
              )}
              {showNotifications && (
                <motion.div
                  initial={{ opacity: 0, x: 28, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 28, scale: 0.97 }}
                  transition={CHAT_SOFT}
                  className="pointer-events-auto"
                >
                  <NotificationsPanel
                    notifications={notifications}
                    onClear={() => setNotifications([])}
                    onClose={() => setShowNotifications(false)}
                    onFriendAccept={(requestId) => void respondFriend(requestId, "accept")}
                    onFriendDecline={(requestId) => void respondFriend(requestId, "decline")}
                  />
                </motion.div>
              )}
              {showSearch && (
                <motion.div
                  initial={{ opacity: 0, x: 28, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 28, scale: 0.97 }}
                  transition={CHAT_SOFT}
                  className="pointer-events-auto"
                >
                  <SearchPanel
                    messages={messages}
                    query={searchQuery}
                    onQuery={setSearchQuery}
                    onClose={() => setShowSearch(false)}
                    onJump={() => setShowSearch(false)}
                  />
                </motion.div>
              )}
              {showBackup && (
                <motion.div
                  initial={{ opacity: 0, x: 28, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 28, scale: 0.97 }}
                  transition={CHAT_SOFT}
                  className="pointer-events-auto"
                >
                  <BackupPanel
                    token={token}
                    toast={toast}
                    onClose={() => setShowBackup(false)}
                    onRestored={() => void reloadCurrentChannel()}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Member list + social panels — the player list is scoped to
              the conversation for DMs/groups; Friends / DMs / Groups each
              get their OWN panel in the same slot (owner ask). */}
          <AnimatePresence>
            {socialPanel === "friends" ? (
              <FriendsPanel
                friends={friends}
                requestsIn={friendRequestsIn}
                requestsOut={friendRequestsOut}
                onlineIds={onlineIdSet}
                busy={friendBusy}
                target={friendTarget}
                onTarget={setFriendTarget}
                onAdd={() => void addFriend()}
                onRespond={(id, action) => void respondFriend(id, action)}
                onCancel={(id) => void cancelFriendRequest(id)}
                onOpenProfile={openProfile}
                onDm={(username) => void openDmWith(username)}
                onClose={() => setSocialPanel(null)}
              />
            ) : socialPanel === "dms" ? (
              <DmsPanel
                account={account}
                dms={dms}
                unread={unread}
                activeId={channelId}
                friends={friends}
                target={dmTarget}
                onTarget={setDmTarget}
                onDm={(username) => void openDmWith(username)}
                onOpen={(id) => setChannelId(id)}
                onCloseDm={(id, isGroup) => void closeDmById(id, isGroup)}
                onClose={() => setSocialPanel(null)}
              />
            ) : socialPanel === "groups" ? (
              <GroupsPanel
                dms={dms}
                activeId={channelId}
                friends={friends}
                meId={account.id}
                name={groupName}
                picked={groupPicked}
                users={groupUserInput}
                creating={creatingGroup}
                onName={setGroupName}
                onPicked={(u, on) =>
                  setGroupPicked((prev) => ({ ...prev, [u]: on }))
                }
                onUsers={setGroupUserInput}
                onCreate={() => void createGroup()}
                onOpen={(id) => setChannelId(id)}
                onLeaveGroup={(id) => void closeDmById(id, true)}
                onDeleteGroup={(id) => void deleteGroupById(id)}
                onClose={() => setSocialPanel(null)}
              />
            ) : showMembers ? (
              <PlayerList
                account={account}
                members={isDm && dmMeta ? dmMeta.members : playersMembers}
                presence={isDm && dmMeta ? dmPresence : playersPresence}
                onOpenProfile={openProfile}
                onClose={() => setShowMembers(false)}
              />
            ) : null}
          </AnimatePresence>
        </div>

        {/* Music bar */}
        <AnimatePresence>
          {showMusic && <MusicBar onClose={() => setShowMusic(false)} />}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showShop && (
          <ShopModal
            account={account}
            token={token}
            onAccount={updateAccount}
            onProfileUpdated={() => void refreshMembers()}
            onClose={() => setShowShop(false)}
            toast={toast}
          />
        )}
        {showProfile && (
          <ProfileModal
            account={account}
            token={token}
            onAccount={updateAccount}
            onProfileUpdated={() => void refreshMembers()}
            onClose={() => setShowProfile(false)}
            toast={toast}
          />
        )}
        {viewingProfile && (
          <UserProfileModal
            who={viewingProfile}
            online={presence.some((p) => p.accountId === viewingProfile.id)}
            isMe={viewingProfile.id === account.id}
            onEdit={() => {
              setViewingProfile(null)
              setShowProfile(true)
            }}
            onClose={() => setViewingProfile(null)}
          />
        )}
        {showExtensions && (
          <ExtensionsModal
            state={extensions}
            onToggle={(id, value) =>
              setExtensions((prev) => ({ ...prev, [id]: value }))
            }
            blockedCount={blockedAds}
            onClose={() => setShowExtensions(false)}
          />
        )}
        {showTransfer && (
          <TransferModal
            account={account}
            token={token}
            onAccount={updateAccount}
            members={members}
            onClose={() => setShowTransfer(false)}
            toast={toast}
          />
        )}
        {/* Games — Coin Flip + Blackjack against the real coin balance */}
        {showGames && (
          <GamesModal
            account={account}
            token={token}
            onAccount={updateAccount}
            onClose={() => setShowGames(false)}
            toast={toast}
          />
        )}
        {showMod && isMod(account) && (
          <ModPanel
            account={account}
            token={token}
            members={playersMembers}
            onMembers={updateMembers}
            onMessageDeleted={(id) => {
              setMessages((prev) => prev.filter((m) => m.id !== id))
              socketRef.current?.emit("message_deleted", { channelId, messageId: id })
            }}
            onClose={() => setShowMod(false)}
            toast={toast}
          />
        )}
        {/* Invite people to a group chat */}
        {showInvite && dmMeta && (
          <InviteModal
            dm={dmMeta}
            friends={friends}
            me={account}
            onInvite={inviteToGroup}
            onClose={() => setShowInvite(false)}
          />
        )}
        {/* Rename group */}
        {showRename && dmMeta?.isGroup && (
          <ModalShell title="Rename group" onClose={() => setShowRename(false)}>
            <div className="space-y-3">
              <input
                autoFocus
                value={renameDraft}
                maxLength={64}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void renameGroup()}
                placeholder="New group name"
                className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-orange-400/50"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowRename(false)}
                  className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/10"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void renameGroup()}
                  disabled={!renameDraft.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-orange-400 px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Save name
                </button>
              </div>
            </div>
          </ModalShell>
        )}
        {/* Leave group / close DM confirm */}
        {showLeaveConfirm && dmMeta && (
          <ModalShell
            title={dmMeta.isGroup ? "Leave group?" : "Close this DM?"}
            onClose={() => setShowLeaveConfirm(false)}
          >
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-white/70">
                {dmMeta.isGroup
                  ? `You'll stop receiving messages from "${dmMeta.name || channelLabel}". Other members keep the group — someone can invite you back anytime.`
                  : "The DM disappears from your list. The other person keeps their copy — you can always start it again."}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowLeaveConfirm(false)}
                  className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/10"
                >
                  Stay
                </button>
                <button
                  onClick={() => void leaveGroup()}
                  className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-400"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {dmMeta.isGroup ? "Leave group" : "Close DM"}
                </button>
              </div>
            </div>
          </ModalShell>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Friends / DMs / Groups side panels — their OWN header buttons, right
// next to the players toggle (owner ask). Same slide-in slot + styling
// family as the player list.
// ---------------------------------------------------------------------------

/** Label for a DM/group row — group name, or the other members' names. */
function dmLabel(d: DM, meId: string): string {
  return (
    d.name ||
    d.members.filter((m) => m.id !== meId).map(displayName).join(", ") ||
    (d.isGroup ? "Group" : "DM")
  )
}

function SocialPanelShell({
  icon,
  title,
  count,
  onClose,
  children,
}: {
  icon: ReactNode
  title: string
  count?: number
  onClose: () => void
  children: ReactNode
}) {
  return (
    <motion.aside
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      className="flex w-60 flex-col border-l border-white/10 bg-[#101022] text-white"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {icon}
          <span className="truncate">{title}</span>
          {typeof count === "number" && (
            <span className="rounded-full bg-white/10 px-1.5 text-[10px] font-semibold tabular-nums text-white/60">
              {count}
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          className="veil-hover-wobble shrink-0 rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
          title="Close panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="veil-scroll-slim flex-1 space-y-3 overflow-y-auto p-2"
        style={{ scrollbarWidth: "thin" }}
      >
        {children}
      </div>
    </motion.aside>
  )
}

function FriendsPanel({
  friends,
  requestsIn,
  requestsOut,
  onlineIds,
  busy,
  target,
  onTarget,
  onAdd,
  onRespond,
  onCancel,
  onOpenProfile,
  onDm,
  onClose,
}: {
  friends: ChatAccount[]
  requestsIn: FriendRequestRow[]
  requestsOut: FriendRequestRow[]
  onlineIds: Set<string>
  busy: boolean
  target: string
  onTarget: (v: string) => void
  onAdd: () => void
  onRespond: (requestId: string, action: "accept" | "decline") => void
  onCancel: (requestId: string) => void
  onOpenProfile: (accountId: string) => void
  onDm: (username: string) => void
  onClose: () => void
}) {
  /* Online friends float to the top, alphabetical within each bucket. */
  const sorted = useMemo(() => {
    const rank = (f: ChatAccount) => (onlineIds.has(f.id) ? 0 : 1)
    return [...friends].sort(
      (a, b) => rank(a) - rank(b) || displayName(a).localeCompare(displayName(b)),
    )
  }, [friends, onlineIds])
  return (
    <SocialPanelShell
      icon={<Heart className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
      title="Friends"
      count={friends.length}
      onClose={onClose}
    >
      {/* Add a friend */}
      <div className="flex items-center gap-1">
        <input
          value={target}
          onChange={(e) => onTarget(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
          placeholder="@username"
          autoCapitalize="none"
          className="veil-focus-bloom min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none"
        />
        <button
          onClick={onAdd}
          disabled={busy}
          className="veil-press veil-hover-glow flex shrink-0 items-center gap-1 rounded-md bg-orange-400 px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
          title="Send a friend request"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
          Add
        </button>
      </div>
      <p className="px-1 text-[9.5px] leading-tight text-white/35">
        They get a notification — you become friends when they accept.
      </p>

      {/* Incoming requests */}
      {requestsIn.length > 0 && (
        <section>
          <h4 className="veil-text-shine mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
            Requests — {requestsIn.length}
          </h4>
          <div className="space-y-1">
            {requestsIn.map((r, ri) => (
              <div
                key={r.id}
                className={`veil-slide-right-pop veil-stagger-${(ri % 8) + 1} flex items-center gap-2 rounded-md border border-emerald-400/20 bg-emerald-400/5 px-2 py-1.5`}
              >
                <button
                  onClick={() => onOpenProfile(r.user.id)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
                  style={{ backgroundColor: r.user.avatarColor || "#f97316" }}
                  title={`View @${r.user.username}`}
                >
                  {r.user.username?.[0]?.toUpperCase()}
                </button>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-white/85">
                    {displayName(r.user)}
                  </span>
                  <span className="block text-[9.5px] text-emerald-300/70">
                    wants to be your friend
                  </span>
                </span>
                <button
                  onClick={() => onRespond(r.id, "accept")}
                  className="veil-hover-bounce veil-press grid h-6 w-6 shrink-0 place-items-center rounded-md bg-emerald-500/90 text-black hover:bg-emerald-400"
                  title={`Accept @${r.user.username}`}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onRespond(r.id, "decline")}
                  className="veil-hover-bounce veil-press grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/10 text-white/60 hover:bg-red-500/30 hover:text-red-300"
                  title={`Decline @${r.user.username}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Outgoing requests */}
      {requestsOut.length > 0 && (
        <section>
          <h4 className="veil-text-shine mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
            Waiting on them
          </h4>
          <div className="space-y-0.5">
            {requestsOut.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-white/5">
                <span
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-bold text-white/70"
                  style={{ backgroundColor: r.user.avatarColor || "#71717a" }}
                >
                  {r.user.username?.[0]?.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-white/60">
                  @{r.user.username}
                </span>
                <button
                  onClick={() => onCancel(r.id)}
                  className="rounded p-0.5 text-white/30 hover:text-red-300"
                  title="Cancel request"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* The friend list */}
      <section>
        <h4 className="veil-text-shine mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">
          {sorted.length === 0 ? "No friends yet" : "Your friends"}
        </h4>
        {sorted.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-white/30">
            Add someone with the box above — friends show live online dots.
          </p>
        ) : (
          <div className="space-y-0.5">
            {sorted.map((f, i) => (
              <motion.div
                key={f.id}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.2, ease: "easeOut" }}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-white/5"
              >
                <button
                  onClick={() => onOpenProfile(f.id)}
                  className="relative shrink-0"
                  title={`${displayName(f)} — view profile`}
                >
                  <AvatarWithAccessory account={f} size={26} />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-black/60 ${
                      onlineIds.has(f.id) ? "veil-online-pulse bg-emerald-400" : "bg-white/30"
                    }`}
                  />
                </button>
                <button
                  onClick={() => onOpenProfile(f.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span
                    className="block truncate text-sm font-medium"
                    style={{ color: roleColor(f) }}
                  >
                    {displayName(f)}
                  </span>
                  <span className="block truncate text-[10px] text-white/40">@{f.username}</span>
                </button>
                <button
                  onClick={() => onDm(f.username)}
                  className="veil-hover-bounce rounded bg-white/10 p-1 text-white/60 opacity-0 transition hover:bg-orange-400/30 hover:text-orange-200 focus-visible:opacity-100 group-hover:opacity-100"
                  title={`DM @${f.username}`}
                >
                  <MessageCircle className="h-3 w-3" />
                </button>
              </motion.div>
            ))}
          </div>
        )}
      </section>
    </SocialPanelShell>
  )
}

function DmsPanel({
  account,
  dms,
  unread,
  activeId,
  friends,
  target,
  onTarget,
  onDm,
  onOpen,
  onCloseDm,
  onClose,
}: {
  account: ChatAccount
  dms: DM[]
  unread: Record<string, number>
  activeId: string
  friends: ChatAccount[]
  target: string
  onTarget: (v: string) => void
  onDm: (username: string) => void
  onOpen: (id: string) => void
  onCloseDm: (id: string, isGroup: boolean) => void
  onClose: () => void
}) {
  const solo = dms.filter((d) => !d.isGroup)
  /* DMs are friends-only (owner ask) — the picker searches your FRIENDS,
   * not strangers; the server enforces the same rule on the wire. */
  const q = target.trim().replace(/^@/, "").toLowerCase()
  const pickable = q
    ? friends.filter(
        (f) =>
          f.username.toLowerCase().includes(q) ||
          displayName(f).toLowerCase().includes(q),
      )
    : friends
  /* Two-tap close: the first tap arms the X into a red “Sure?”, the
   * second (within 2.8s) closes the DM off your sight. */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  useEffect(() => {
    if (!confirmId) return
    const t = setTimeout(() => setConfirmId(null), 2800)
    return () => clearTimeout(t)
  }, [confirmId])
  return (
    <SocialPanelShell
      icon={<MessageCircle className="h-3.5 w-3.5 shrink-0 text-orange-400" />}
      title="DMs"
      count={solo.length}
      onClose={onClose}
    >
      {/* Start a new DM — friends only */}
      <div className="flex items-center gap-1">
        <input
          value={target}
          onChange={(e) => onTarget(e.target.value)}
          placeholder="Find a friend…"
          autoCapitalize="none"
          className="veil-focus-bloom min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none"
        />
        {target && (
          <button
            onClick={() => onTarget("")}
            className="shrink-0 rounded p-1 text-white/40 hover:bg-white/10 hover:text-white"
            title="Clear the search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {friends.length === 0 ? (
        <p className="px-1 py-2 text-[11px] leading-relaxed text-white/30">
          DMs are friends-only — add someone in the Friends tab first.
        </p>
      ) : pickable.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-white/30">
          No friend matches “{target.trim()}”.
        </p>
      ) : (
        <div className="space-y-0.5">
          {pickable.slice(0, 6).map((f) => (
            <button
              key={f.id}
              onClick={() => onDm(f.username)}
              className="veil-hover-glow flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/5"
              title={`DM @${f.username}`}
            >
              <AvatarWithAccessory account={f} size={22} />
              <span
                className="min-w-0 flex-1 truncate text-xs"
                style={{ color: roleColor(f) }}
              >
                {displayName(f)}
              </span>
              <span className="shrink-0 text-[9px] font-semibold text-white/25">
                @{f.username}
              </span>
              <MessageCircle className="h-3 w-3 shrink-0 text-orange-300/70" />
            </button>
          ))}
          {pickable.length > 6 && (
            <p className="px-1 pt-0.5 text-[10px] text-white/35">
              +{pickable.length - 6} more — keep typing to narrow it down.
            </p>
          )}
        </div>
      )}

      {/* The DM list — every row can be closed off your sight */}
      {solo.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-white/30">
          No direct messages yet — start one with a friend above.
        </p>
      ) : (
        <div className="space-y-0.5">
          {solo.map((d, di) => {
            const label = dmLabel(d, account.id)
            const other = d.members.find((m) => m.id !== account.id)
            const armed = confirmId === d.id
            return (
              <motion.div
                key={d.id}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(di * 0.03, 0.3), duration: 0.2, ease: "easeOut" }}
                className={`group flex w-full items-center gap-1 rounded-md py-1.5 pl-1.5 pr-1 ${
                  activeId === d.id ? "veil-pulse-glow bg-white/10" : "hover:bg-white/5"
                }`}
              >
                <button
                  onClick={() => onOpen(d.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="relative shrink-0">
                    {other ? (
                      <AvatarWithAccessory account={other} size={26} />
                    ) : (
                      <span className="grid h-[26px] w-[26px] place-items-center rounded-full bg-white/10 text-[10px] font-bold text-white/60">
                        ?
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm font-medium"
                      style={{ color: other ? roleColor(other) : undefined }}
                    >
                      {label}
                    </span>
                    <span className="block truncate text-[10px] text-white/40">
                      @{other?.username || "?"}
                    </span>
                  </span>
                </button>
                {unread[d.id] > 0 && (
                  <span
                    key={unread[d.id]}
                    className="veil-badge-pop veil-bounce-soft grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-orange-400 px-1 text-[9px] font-bold text-black"
                  >
                    {unread[d.id] > 99 ? "99+" : unread[d.id]}
                  </span>
                )}
                <button
                  onClick={() => (armed ? onCloseDm(d.id, false) : setConfirmId(d.id))}
                  className={`veil-press grid h-6 shrink-0 place-items-center rounded-md text-[9px] font-bold transition ${
                    armed
                      ? "min-w-9 bg-red-500/80 px-1 text-white"
                      : "w-6 text-white/40 opacity-0 hover:bg-red-500/25 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
                  }`}
                  title="Close DM — remove it from your sight"
                >
                  {armed ? "Sure?" : <X className="h-3 w-3" />}
                </button>
              </motion.div>
            )
          })}
        </div>
      )}
    </SocialPanelShell>
  )
}

function GroupsPanel({
  dms,
  activeId,
  friends,
  meId,
  name,
  picked,
  users,
  creating,
  onName,
  onPicked,
  onUsers,
  onCreate,
  onOpen,
  onLeaveGroup,
  onDeleteGroup,
  onClose,
}: {
  dms: DM[]
  activeId: string
  friends: ChatAccount[]
  meId: string
  name: string
  picked: Record<string, boolean>
  users: string
  creating: boolean
  onName: (v: string) => void
  onPicked: (username: string, on: boolean) => void
  onUsers: (v: string) => void
  onCreate: () => void
  onOpen: (id: string) => void
  onLeaveGroup: (id: string) => void
  onDeleteGroup: (id: string) => void
  onClose: () => void
}) {
  const groups = dms.filter((d) => d.isGroup)
  /* Two-tap confirm — arming shows a red “Sure?” before the real tap
   * (delete is forever; leave just hides it from your sight). */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  useEffect(() => {
    if (!confirmId) return
    const t = setTimeout(() => setConfirmId(null), 2800)
    return () => clearTimeout(t)
  }, [confirmId])
  return (
    <SocialPanelShell
      icon={<UsersRound className="h-3.5 w-3.5 shrink-0 text-cyan-300" />}
      title="Groups"
      count={groups.length}
      onClose={onClose}
    >
      {/* Create a group */}
      <div className="space-y-1.5 rounded-lg border border-white/10 bg-black/30 p-2">
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Group name (e.g. Squad)"
          maxLength={64}
          className="veil-focus-bloom w-full rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none focus:border-cyan-400/50"
        />
        {friends.length > 0 && (
          <div className="veil-scroll-slim max-h-28 overflow-y-auto rounded-md border border-white/10">
            {friends.map((f) => (
              <label
                key={f.id}
                className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[11px] text-white/75 hover:bg-white/5"
              >
                <input
                  type="checkbox"
                  checked={!!picked[f.username]}
                  onChange={(e) => onPicked(f.username, e.target.checked)}
                  className="accent-cyan-400"
                />
                <span
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[8px] font-bold text-white"
                  style={{ backgroundColor: f.avatarColor }}
                >
                  {f.username[0]?.toUpperCase()}
                </span>
                <span className="flex-1 truncate">{displayName(f)}</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1">
          <input
            value={users}
            onChange={(e) => onUsers(e.target.value)}
            placeholder="@username, @username…"
            autoCapitalize="none"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white outline-none"
          />
          <button
            onClick={onCreate}
            disabled={creating}
            className="veil-press flex shrink-0 items-center gap-1 rounded-md bg-cyan-500 px-2 py-1 text-xs font-semibold text-black disabled:opacity-50"
            title="Create the group"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <UsersRound className="h-3 w-3" />}
            Create
          </button>
        </div>
        <p className="text-[9.5px] leading-tight text-white/35">
          Tick friends and/or type @usernames — everyone gets in at once and
          can invite more later.
        </p>
      </div>

      {/* Group list — delete the ones you made, hide the rest */}
      {groups.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-white/30">
          No groups yet — make one with the box above.
        </p>
      ) : (
        <div className="space-y-0.5">
          {groups.map((d, di) => {
            const mine = d.ownerId === meId
            const armed = confirmId === d.id
            return (
              <motion.div
                key={d.id}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(di * 0.03, 0.3), duration: 0.2, ease: "easeOut" }}
                className={`group flex w-full items-center gap-1 rounded-md py-1.5 pl-1.5 pr-1 ${
                  activeId === d.id ? "veil-pulse-glow bg-white/10" : "hover:bg-white/5"
                }`}
              >
                <button
                  onClick={() => onOpen(d.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md bg-cyan-400/15 text-cyan-300">
                    <UsersRound className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {d.name || "Group"}
                      {mine && (
                        <span
                          className="ml-1.5 rounded bg-cyan-400/15 px-1 py-px align-middle text-[8px] font-bold uppercase tracking-wide text-cyan-300"
                          title="You made this group"
                        >
                          yours
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[10px] text-white/40">
                      {d.members.map((m) => displayName(m)).join(", ")}
                    </span>
                  </span>
                </button>
                <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-white/50">
                  {d.members.length}
                </span>
                {mine ? (
                  <button
                    onClick={() => (armed ? onDeleteGroup(d.id) : setConfirmId(d.id))}
                    className={`veil-press grid h-6 shrink-0 place-items-center rounded-md text-[9px] font-bold transition ${
                      armed
                        ? "min-w-9 bg-red-500/80 px-1 text-white"
                        : "w-6 text-white/40 opacity-0 hover:bg-red-500/25 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
                    }`}
                    title="Delete group — gone for EVERY member (you made it)"
                  >
                    {armed ? "Sure?" : <Trash2 className="h-3 w-3" />}
                  </button>
                ) : (
                  <button
                    onClick={() => (armed ? onLeaveGroup(d.id) : setConfirmId(d.id))}
                    className={`veil-press grid h-6 shrink-0 place-items-center rounded-md text-[9px] font-bold transition ${
                      armed
                        ? "min-w-9 bg-red-500/80 px-1 text-white"
                        : "w-6 text-white/40 opacity-0 hover:bg-red-500/25 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
                    }`}
                    title="Leave — remove it from your sight"
                  >
                    {armed ? "Sure?" : <LogOut className="h-3 w-3" />}
                  </button>
                )}
              </motion.div>
            )
          })}
        </div>
      )}
    </SocialPanelShell>
  )
}

// ---------------------------------------------------------------------------
// Games — Coin Flip + Blackjack with real Veil Coins. The golden 3D coin
// and the felt-table look come from the owner's own game files, rewired
// to the server-side coin economy (the server owns every shuffle and
// flip, so the results are the truth).
// ---------------------------------------------------------------------------

type GameCardT = {
  suit: "hearts" | "diamonds" | "clubs" | "spades"
  rank: string
}

type BlackjackState = {
  id: string
  bet: number
  playerHand: GameCardT[]
  dealerHand: GameCardT[]
  holeHidden: boolean
  status: "playing" | "done"
  result: "win" | "lose" | "push" | "blackjack" | null
  payout: number
}

const SUIT_GLYPH: Record<GameCardT["suit"], string> = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
}

function handTotal(hand: GameCardT[]): number {
  let total = 0
  let aces = 0
  for (const c of hand) {
    if (c.rank === "A") {
      aces++
      total += 11
    } else if (c.rank === "K" || c.rank === "Q" || c.rank === "J" || c.rank === "10") {
      total += 10
    } else {
      total += Number(c.rank) || 0
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  return total
}

/** One playing card (or a face-down back) with the deal-in animation. */
function PlayCard({
  card,
  hidden,
  overlap,
  delay = 0,
}: {
  card?: GameCardT
  hidden?: boolean
  overlap?: boolean
  delay?: number
}) {
  if (hidden || !card) {
    return (
      <motion.div
        initial={{ y: -14, scale: 0.92, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        transition={{ delay, duration: 0.26, ease: [0.22, 1.1, 0.36, 1] }}
        className={`h-[64px] w-[46px] shrink-0 rounded-lg sm:h-[80px] sm:w-[58px] ${overlap ? "-ml-6 sm:-ml-8" : ""}`}
        style={{
          background:
            "repeating-linear-gradient(45deg, #221a0d 0px, #221a0d 6px, #2e2412 6px, #2e2412 12px)",
          boxShadow:
            "inset 0 0 0 3px #171208, inset 0 0 0 4px rgba(245,197,66,.35), 0 8px 20px -8px rgba(0,0,0,.7)",
        }}
        aria-label="Face-down card"
      />
    )
  }
  const red = card.suit === "hearts" || card.suit === "diamonds"
  return (
    <motion.div
      initial={{ y: -14, scale: 0.92, opacity: 0 }}
      animate={{ y: 0, scale: 1, opacity: 1 }}
      transition={{ delay, duration: 0.26, ease: [0.22, 1.1, 0.36, 1] }}
      className={`relative flex h-[64px] w-[46px] shrink-0 flex-col justify-between rounded-lg p-1.5 sm:h-[80px] sm:w-[58px] sm:p-2 ${overlap ? "-ml-6 sm:-ml-8" : ""}`}
      style={{
        background: "linear-gradient(#ffffff, #e4e4e7)",
        boxShadow: "0 8px 20px -8px rgba(0,0,0,.7)",
        color: red ? "#e11d48" : "#18181b",
      }}
    >
      <span className="text-[11px] font-extrabold leading-none sm:text-[13px]">{card.rank}</span>
      <span className="self-center text-xl leading-none sm:text-2xl">{SUIT_GLYPH[card.suit]}</span>
      <span
        className="self-end text-[11px] font-extrabold leading-none sm:text-[13px]"
        style={{ transform: "rotate(180deg)" }}
      >
        {card.rank}
      </span>
    </motion.div>
  )
}

/** The golden 3D coin — bet chips, pick a side, the server flips. */
function CoinFlipGame({
  account,
  token,
  onAccount,
  toast,
}: {
  account: ChatAccount
  token: string
  onAccount: (a: ChatAccount) => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [bet, setBet] = useState(10)
  const [side, setSide] = useState<"heads" | "tails" | null>(null)
  const [spinning, setSpinning] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [outcome, setOutcome] = useState<{
    landed: "heads" | "tails"
    won: boolean
    bet: number
  } | null>(null)

  /* The coin's 36-segment rim — built once. */
  const edges = useMemo(() => {
    const EDGE = 36
    const R = 78
    const T = 12
    const CH = 2 * R * Math.sin(Math.PI / EDGE) + 1.5
    return Array.from({ length: EDGE }, (_, i) => (
      <div
        key={i}
        className="absolute left-1/2 top-1/2"
        style={{
          width: T,
          height: CH,
          marginLeft: -T / 2,
          marginTop: -CH / 2,
          background:
            "repeating-linear-gradient(90deg, #8a6215 0px, #e0bc55 1.4px, #8a6215 2.8px, #b98f2a 3.4px)",
          transform: `rotateZ(${(i * 360) / EDGE}deg) translateX(${R - 0.5}px) rotateY(90deg)`,
        }}
      />
    ))
  }, [])

  const flip = async () => {
    if (spinning) return
    if (!side) {
      toast("Pick heads or tails first.", "err")
      return
    }
    if (bet < 1) {
      toast("Bet at least 1 coin.", "err")
      return
    }
    if (bet > account.coins) {
      toast("Not enough coins for that bet.", "err")
      return
    }
    setSpinning(true)
    setOutcome(null)
    try {
      const data = await apiFetch<{
        landed: "heads" | "tails"
        won: boolean
        payout: number
        account: ChatAccount
      }>("/api/chat-coinflip", {
        method: "POST",
        body: JSON.stringify({ token, bet, side }),
      })
      /* Spin the coin to wherever the SERVER says it landed. */
      const mod = data.landed === "heads" ? 0 : 180
      const cur = ((rotation % 360) + 360) % 360
      const delta = (mod - cur + 360) % 360
      const spins = 3 + Math.floor(Math.random() * 3)
      setRotation(rotation + 360 * spins + delta)
      setTimeout(() => {
        setOutcome({ landed: data.landed, won: data.won, bet })
        onAccount(data.account)
        setSpinning(false)
        toast(
          data.won
            ? `${data.landed.toUpperCase()} — you win +${bet} 🪙`
            : `${data.landed.toUpperCase()} — you lose ${bet} 🪙`,
          data.won ? "ok" : "err",
        )
      }, 1750)
    } catch (e) {
      setSpinning(false)
      toast(e instanceof Error ? e.message : "The flip didn't land.", "err")
    }
  }

  const coinFace =
    "absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-full"
  const coinFaceStyle: React.CSSProperties = {
    background:
      "radial-gradient(circle at 35% 28%, #ffefad 0%, #f8d264 32%, #e3a92c 62%, #b97e12 88%, #8f5c0a 100%)",
    boxShadow:
      "inset 0 0 0 5px rgba(146,96,16,.4), inset 0 0 0 7px rgba(255,236,170,.45), inset 0 -12px 24px rgba(118,68,5,.5), inset 0 10px 20px rgba(255,246,205,.35)",
    backfaceVisibility: "hidden",
    WebkitBackfaceVisibility: "hidden",
  }

  return (
    <div className="space-y-5">
      {/* The coin */}
      <div className="grid place-items-center py-1" style={{ perspective: 1050 }}>
        <button
          onClick={() => void flip()}
          disabled={spinning || !side}
          className="relative block h-[150px] w-[150px] rounded-full outline-none ring-amber-300/40 transition-transform focus-visible:ring-4 enabled:active:scale-95 disabled:cursor-default"
          style={{ transformStyle: "preserve-3d" }}
          title={side ? `Flip for ${bet} 🪙 — you called ${side}` : "Pick heads or tails first"}
          aria-label="Flip the coin"
        >
          <div
            className="absolute inset-0"
            style={{
              transformStyle: "preserve-3d",
              transform: `rotateX(${rotation}deg)`,
              transition: "transform 1.7s cubic-bezier(0.2, 0.6, 0.2, 1)",
            }}
          >
            {edges}
            <div className={coinFace} style={{ ...coinFaceStyle, transform: "translateZ(6px)" }}>
              <span className="text-4xl" style={{ color: "#7a5207", textShadow: "0 2px 0 rgba(255,240,190,.55)" }}>♛</span>
              <span className="text-[11px] font-extrabold" style={{ color: "#7a5207", letterSpacing: "0.3em", textIndent: "0.3em" }}>HEADS</span>
            </div>
            <div className={coinFace} style={{ ...coinFaceStyle, transform: "rotateX(180deg) translateZ(6px)" }}>
              <span className="text-4xl" style={{ color: "#7a5207", textShadow: "0 2px 0 rgba(255,240,190,.55)" }}>★</span>
              <span className="text-[11px] font-extrabold" style={{ color: "#7a5207", letterSpacing: "0.3em", textIndent: "0.3em" }}>TAILS</span>
            </div>
          </div>
        </button>
      </div>

      {/* Result */}
      <div className="grid h-8 place-items-center" aria-live="polite">
        {outcome && (
          <motion.span
            key={`${outcome.landed}-${outcome.won}-${outcome.bet}-${Date.now()}`}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 520, damping: 20 }}
            className={`rounded-full border px-3.5 py-1 text-sm font-extrabold tracking-widest ${
              outcome.won
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border-rose-400/30 bg-rose-400/10 text-rose-300"
            }`}
          >
            {outcome.landed.toUpperCase()} · {outcome.won ? `WIN +${outcome.bet}` : `LOSE −${outcome.bet}`}
          </motion.span>
        )}
        {spinning && !outcome && (
          <span className="text-xs font-semibold uppercase tracking-[0.3em] text-amber-200/50">
            flipping…
          </span>
        )}
      </div>

      {/* Side pick */}
      <div className="flex justify-center gap-2">
        {(["heads", "tails"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            disabled={spinning}
            className={`veil-press flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm font-bold transition disabled:opacity-50 ${
              side === s
                ? "border-amber-300/60 bg-amber-400/15 text-amber-200"
                : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
            }`}
          >
            <span>{s === "heads" ? "♛" : "★"}</span>
            {s === "heads" ? "Heads" : "Tails"}
            <span className="text-[10px] font-semibold text-white/35">pays 2×</span>
          </button>
        ))}
      </div>

      {/* Bet */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {[10, 25, 50, 100].map((v) => (
            <button
              key={v}
              onClick={() => setBet((b) => b + v)}
              disabled={spinning || account.coins < bet + v}
              className="veil-press h-9 w-9 rounded-full border-2 border-amber-300/40 bg-white/5 text-xs font-extrabold text-amber-200 transition hover:scale-105 hover:bg-white/10 disabled:opacity-30"
              title={`Add ${v} coins to the bet`}
            >
              {v}
            </button>
          ))}
          <button
            onClick={() => setBet(Math.max(0, account.coins))}
            disabled={spinning || account.coins < 1}
            className="veil-press h-9 rounded-full border-2 border-emerald-300/40 bg-emerald-400/10 px-3 text-[11px] font-extrabold text-emerald-300 transition hover:scale-105 hover:bg-emerald-400/20 disabled:opacity-30"
            title="Bet everything"
          >
            MAX
          </button>
        </div>
        <div className="flex items-center justify-center gap-2 text-sm">
          <span className="text-white/45">Bet</span>
          <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-0.5 font-bold tabular-nums text-amber-200">
            🪙 {bet.toLocaleString()}
          </span>
          {bet > 0 && (
            <button
              onClick={() => setBet(0)}
              disabled={spinning}
              className="text-xs text-white/40 underline-offset-2 hover:text-white/70 hover:underline"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Flip */}
      <button
        onClick={() => void flip()}
        disabled={spinning || !side || bet < 1 || bet > account.coins}
        className="veil-press veil-hover-glow flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-sm font-extrabold text-[#451a03] disabled:opacity-40"
        style={{
          background: "linear-gradient(#fcd34d, #d97706)",
          boxShadow: "0 12px 32px -10px rgba(245,197,66,.55), inset 0 1px 0 rgba(255,255,255,.5)",
        }}
      >
        {spinning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Dices className="h-4 w-4" />}
        {spinning ? "Flipping…" : side ? `Flip for ${bet.toLocaleString()} 🪙` : "Pick a side to flip"}
      </button>
      <p className="text-center text-[10px] leading-relaxed text-white/35">
        Correct call doubles your bet — the server flips, so what you see is what really landed.
      </p>
    </div>
  )
}

/** Blackjack — the felt table, betting real coins, deck shuffled server-side. */
function BlackjackGame({
  account,
  token,
  onAccount,
  toast,
}: {
  account: ChatAccount
  token: string
  onAccount: (a: ChatAccount) => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [game, setGame] = useState<BlackjackState | null>(null)
  const [bet, setBet] = useState(10)
  const [busy, setBusy] = useState(false)

  /* Resume an in-flight hand when the modal opens. */
  useEffect(() => {
    let stopped = false
    apiFetch<{ game: BlackjackState | null }>("/api/chat-blackjack", {
      method: "POST",
      body: JSON.stringify({ token, action: "status" }),
    })
      .then((d) => {
        if (!stopped && d.game) setGame(d.game)
      })
      .catch(() => {
        /* first open just starts fresh */
      })
    return () => {
      stopped = true
    }
  }, [token])

  const act = async (
    action: "start" | "hit" | "stand" | "double",
    amount?: number,
  ) => {
    if (busy) return
    setBusy(true)
    try {
      const data = await apiFetch<{
        game: BlackjackState
        account: ChatAccount
      }>("/api/chat-blackjack", {
        method: "POST",
        body: JSON.stringify({ token, action, bet: amount }),
      })
      setGame(data.game)
      onAccount(data.account)
    } catch (e) {
      toast(e instanceof Error ? e.message : "The table hiccuped.", "err")
    } finally {
      setBusy(false)
    }
  }

  const phase =
    game == null ? "betting" : game.status === "playing" ? "player" : "done"
  const dealerTotal =
    game && game.dealerHand.length
      ? phase === "player"
        ? `${handTotal(game.dealerHand.slice(0, 1))} + ?`
        : handTotal(game.dealerHand)
      : ""
  const playerTotal = game?.playerHand.length ? handTotal(game.playerHand) : ""
  const bust = !!game && handTotal(game.playerHand) > 21

  return (
    <div className="space-y-4">
      {/* The table */}
      <div
        className="space-y-3 rounded-2xl border border-amber-200/10 p-3.5 sm:p-4"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(245,197,66,.06), transparent 60%), rgba(255,255,255,.02)",
        }}
      >
        {/* Dealer */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-200/45">Dealer</span>
            {dealerTotal !== "" && (
              <span className="rounded-full border border-amber-200/15 bg-amber-50/5 px-2 py-0.5 text-[11px] font-extrabold tabular-nums text-amber-100/85">
                {dealerTotal}
              </span>
            )}
          </div>
          <div className="flex min-h-[64px] items-center sm:min-h-[80px]">
            {game?.dealerHand.length ? (
              <>
                {game.dealerHand.map((c, i) => (
                  <PlayCard key={`d-${i}`} card={c} overlap={i > 0} delay={i * 0.09} />
                ))}
                {game.holeHidden && <PlayCard hidden overlap delay={0.09} />}
              </>
            ) : (
              <>
                <div className="h-[64px] w-[46px] rounded-lg border-[1.5px] border-dashed border-amber-200/15 sm:h-[80px] sm:w-[58px]" />
                <div className="ml-2 h-[64px] w-[46px] rounded-lg border-[1.5px] border-dashed border-amber-200/15 sm:h-[80px] sm:w-[58px] sm:ml-3" />
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-200/20 to-transparent" />
          <span className="whitespace-nowrap text-[9px] font-bold uppercase tracking-[0.3em] text-amber-200/30">
            blackjack pays 3 to 2
          </span>
          <span className="h-px flex-1 bg-gradient-to-r from-transparent via-amber-200/20 to-transparent" />
        </div>

        {/* Player */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-200/45">You</span>
            {playerTotal !== "" && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-extrabold tabular-nums ${
                  bust
                    ? "border-rose-400/30 bg-rose-400/10 text-rose-300"
                    : "border-amber-200/15 bg-amber-50/5 text-amber-100/85"
                }`}
              >
                {playerTotal}
              </span>
            )}
          </div>
          <div className="flex min-h-[64px] items-center sm:min-h-[80px]">
            {game?.playerHand.length ? (
              game.playerHand.map((c, i) => (
                <PlayCard key={`p-${i}`} card={c} overlap={i > 0} delay={i * 0.09} />
              ))
            ) : (
              <>
                <div className="h-[64px] w-[46px] rounded-lg border-[1.5px] border-dashed border-amber-200/15 sm:h-[80px] sm:w-[58px]" />
                <div className="ml-2 h-[64px] w-[46px] rounded-lg border-[1.5px] border-dashed border-amber-200/15 sm:h-[80px] sm:w-[58px] sm:ml-3" />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Result */}
      <div className="grid h-8 place-items-center" aria-live="polite">
        {game?.status === "done" && game.result && (
          <motion.span
            key={`${game.id}-${game.result}-${game.payout}`}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 520, damping: 20 }}
            className={`rounded-full border px-3.5 py-1 text-sm font-extrabold ${
              game.result === "win" || game.result === "blackjack"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : game.result === "push"
                  ? "border-zinc-400/30 bg-zinc-400/10 text-zinc-300"
                  : "border-rose-400/30 bg-rose-400/10 text-rose-300"
            }`}
          >
            {game.result === "blackjack"
              ? `BLACKJACK! +${game.payout - game.bet} 🪙`
              : game.result === "win"
                ? `You win +${game.payout - game.bet} 🪙`
                : game.result === "push"
                  ? "Push — bet returned"
                  : bust
                    ? `Bust! −${game.bet} 🪙`
                    : `Dealer wins −${game.bet} 🪙`}
          </motion.span>
        )}
      </div>

      {/* Controls */}
      {phase === "betting" && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {[10, 25, 50, 100].map((v) => (
              <button
                key={v}
                onClick={() => setBet((b) => b + v)}
                disabled={account.coins < bet + v}
                className="veil-press h-9 w-9 rounded-full border-2 border-amber-300/40 bg-white/5 text-xs font-extrabold text-amber-200 transition hover:scale-105 hover:bg-white/10 disabled:opacity-30"
                title={`Add ${v} coins to the bet`}
              >
                {v}
              </button>
            ))}
            <button
              onClick={() => setBet(Math.max(0, account.coins))}
              disabled={account.coins < 1}
              className="veil-press h-9 rounded-full border-2 border-emerald-300/40 bg-emerald-400/10 px-3 text-[11px] font-extrabold text-emerald-300 transition hover:scale-105 hover:bg-emerald-400/20 disabled:opacity-30"
              title="Bet everything"
            >
              MAX
            </button>
          </div>
          <div className="flex items-center justify-center gap-2 text-sm">
            <span className="text-white/45">Bet</span>
            <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-0.5 font-bold tabular-nums text-amber-200">
              🪙 {bet.toLocaleString()}
            </span>
            {bet > 0 && (
              <button
                onClick={() => setBet(0)}
                className="text-xs text-white/40 underline-offset-2 hover:text-white/70 hover:underline"
              >
                clear
              </button>
            )}
          </div>
          <button
            onClick={() => void act("start", bet)}
            disabled={busy || bet < 1 || bet > account.coins}
            className="veil-press veil-hover-glow flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-sm font-extrabold text-[#451a03] disabled:opacity-40"
            style={{
              background: "linear-gradient(#fcd34d, #d97706)",
              boxShadow: "0 12px 32px -10px rgba(245,197,66,.55), inset 0 1px 0 rgba(255,255,255,.5)",
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Deal
          </button>
        </div>
      )}

      {phase === "player" && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => void act("hit")}
            disabled={busy}
            className="veil-press veil-hover-glow flex items-center gap-1.5 rounded-full px-6 py-2 text-sm font-extrabold text-[#451a03] disabled:opacity-40"
            style={{
              background: "linear-gradient(#fcd34d, #d97706)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,.5)",
            }}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Hit
          </button>
          <button
            onClick={() => void act("stand")}
            disabled={busy}
            className="veil-press rounded-full border border-amber-200/20 bg-white/5 px-6 py-2 text-sm font-bold text-amber-100/80 hover:bg-white/10 disabled:opacity-40"
          >
            Stand
          </button>
          <button
            onClick={() => void act("double")}
            disabled={busy || (game?.playerHand.length ?? 0) !== 2 || account.coins < (game?.bet ?? 0)}
            className="veil-press rounded-full border border-amber-200/20 bg-white/5 px-5 py-2 text-sm font-bold text-amber-100/80 hover:bg-white/10 disabled:opacity-40"
            title="Double your bet, take one card, and stand"
          >
            Double
          </button>
        </div>
      )}

      {phase === "done" && (
        <button
          onClick={() => setGame(null)}
          className="veil-press veil-hover-glow flex w-full items-center justify-center gap-2 rounded-full py-2.5 text-sm font-extrabold text-[#451a03]"
          style={{
            background: "linear-gradient(#fcd34d, #d97706)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,.5)",
          }}
        >
          New round
        </button>
      )}
      <p className="text-center text-[10px] leading-relaxed text-white/35">
        Dealer stands on 17 · double on your first two cards · the deck shuffles server-side.
      </p>
    </div>
  )
}

/** The Games modal — one header dice button, two tables, one coin balance. */
function GamesModal({
  account,
  token,
  onAccount,
  onClose,
  toast,
}: {
  account: ChatAccount
  token: string
  onAccount: (a: ChatAccount) => void
  onClose: () => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [tab, setTab] = useState<"flip" | "blackjack">("flip")
  return (
    <ModalShell
      title="Games"
      icon={<Dices className="h-4 w-4 text-amber-300" />}
      onClose={onClose}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full bg-white/5 p-0.5">
          {(["flip", "blackjack"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`veil-press rounded-full px-3 py-1 text-xs font-bold transition ${
                tab === t ? "bg-amber-400/15 text-amber-200" : "text-white/55 hover:text-white"
              }`}
            >
              {t === "flip" ? "🪙 Coin Flip" : "♠ Blackjack"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <span
          key={account.coins}
          className="veil-coin-flip rounded-full border border-amber-300/20 bg-amber-400/10 px-3 py-1 text-xs font-bold tabular-nums text-amber-200"
        >
          🪙 {account.coins.toLocaleString()}
        </span>
      </div>
      {tab === "flip" ? (
        <CoinFlipGame account={account} token={token} onAccount={onAccount} toast={toast} />
      ) : (
        <BlackjackGame account={account} token={token} onAccount={onAccount} toast={toast} />
      )}
    </ModalShell>
  )
}

// ---------------------------------------------------------------------------
// Daily reward button (with streak + one claim per calendar day)
// ---------------------------------------------------------------------------

function DailyRewardButton({
  token,
  onAccount,
  toast,
}: {
  token: string
  onAccount: (a: ChatAccount) => void
  toast: (msg: string, kind?: "ok" | "err") => void
}) {
  const [status, setStatus] = useState<{
    eligible: boolean
    streak: number
    nextClaimAt: string | null
  } | null>(null)
  const [claiming, setClaiming] = useState(false)

  /* The claimer's timezone (minutes west of UTC, the JS convention) —
   * the server slices days at the player's LOCAL midnight, so "one claim
   * per day" means what players expect. */
  const tz = useMemo(() => {
    try {
      return new Date().getTimezoneOffset()
    } catch {
      return 0
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{
        eligible: boolean
        streak: number
        nextClaimAt: string | null
      }>("/api/chat-coins", {
        method: "POST",
        body: JSON.stringify({ token, action: "daily_reward_status", tz }),
      })
      setStatus(data)
    } catch {
      /* ignore */
    }
  }, [token, tz])

  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 30000)
    return () => clearInterval(t)
  }, [refresh])

  const claim = async () => {
    setClaiming(true)
    try {
      const data = await apiFetch<{
        reward: number
        streak: number
        account: ChatAccount
      }>("/api/chat-coins", {
        method: "POST",
        body: JSON.stringify({ token, action: "daily_reward", tz }),
      })
      onAccount(data.account)
      toast(`Daily reward: +🪙 ${data.reward} — day ${data.streak} streak 🔥`, "ok")
      void refresh()
    } catch (e) {
      toast(e instanceof Error ? e.message : "Daily claim failed.", "err")
    } finally {
      setClaiming(false)
    }
  }

  const streak = status?.streak || 0
  return (
    <button
      onClick={() => void claim()}
      disabled={!status?.eligible || claiming}
      className={`relative flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
        status?.eligible
          ? "veil-bounce-soft bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
          : "bg-white/5 text-white/40"
      }`}
      title={
        status?.eligible
          ? `Claim today's reward — keeps your ${streak}-day streak going`
          : status?.nextClaimAt
            ? `Claimed today — streak ${streak}🔥. Next claim ${new Date(status.nextClaimAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : "Loading…"
      }
    >
      <Gift className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">
        {status?.eligible ? "Daily" : `${streak}🔥`}
      </span>
      {streak > 0 && (
        <span className="veil-pop-in absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-orange-400 text-[8px] font-bold text-black">
          {streak}
        </span>
      )}
    </button>
  )
}

export default ChatApp
