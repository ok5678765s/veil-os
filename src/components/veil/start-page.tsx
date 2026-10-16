"use client";

/**
 * Veil — the start page (the home screen ported from the Veil single-file
 * browser's newtab design: wallpaper backdrop + clock + weather chip +
 * command bar with suggestions + the section dock + recently viewed).
 *
 * The page.tsx mounts this in home mode and owns the section overlays; this
 * component renders the start surface itself and reports dock clicks.
 */

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useFancyMotion } from "@/lib/veil/motion";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  Clock as ClockIcon,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSun,
  Download,
  Eye,
  EyeOff,
  Globe,
  GripVertical,
  History as HistoryIcon,
  Image as ImageIcon,
  Joystick,
  LayoutGrid,
  Lock,
  Loader2,
  MapPin,
  MessageCircle,
  MonitorPlay,
  Moon,
  Music,
  NotebookPen,
  Package,
  RotateCcw,
  Search,
  Settings,
  Snowflake,
  Sparkles,
  Sun,
  WifiOff,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VeilMark } from "@/components/veil/veil-logo";
import { BackdropVideo } from "@/components/veil/backdrop-video";
import {
  faviconUrls,
  normalizeInput,
  QUICK_LINKS,
  searchEngineId,
  searchUrlFor,
  timeAgo,
  viewerHeaders,
  type HistoryResponse,
  type Visit,
} from "@/lib/veil/shared";
import {
  THEME_GRADIENTS,
  loadWallpaperSelection,
  type WallpaperSelection,
} from "@/lib/veil/wallpapers";
import { cn } from "@/lib/utils";
import { usePresence } from "@/lib/veil/presence-store";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type SectionId =
  | "ai"
  | "arcade"
  | "stream"
  | "chat"
  | "wallpapers"
  | "music"
  | "links"
  | "history"
  | "notes"
  | "settings";

interface StartPageProps {
  onNavigate: (url: string) => void;
  history: HistoryResponse | null;
  onHistoryChanged: () => void;
  /** Currently open section (null = none) — Esc + hint wiring. */
  section: SectionId | null;
  onOpenSection: (id: SectionId) => void;
  /** A query the start page should run immediately on mount — set when a
   *  veiled page (e.g. the bot-wall page's “search this site” button)
   *  asked the shell to search. Consumed once. */
  autoSearch?: string;
  onAutoSearchConsumed?: () => void;
}

interface WeatherState {
  tempC: number;
  feelsC: number;
  desc: string;
  humidity: number | null;
  place: string;
  /** Sun up at the forecast point? (null = provider didn't say — the
   *  glyph then falls back to the description's wording.) */
  isDay: boolean | null;
}

/* ------------------------------------------------------------------ */
/* Settings-readers (live; re-read on veil:settings-changed)            */
/* ------------------------------------------------------------------ */

function ls(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/* WMO weather code → lucide icon component (module-level map). */
const WX_ICON_BY_CODE: Record<number, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  0: Sun,
  1: CloudSun,
  2: CloudSun,
  3: Cloud,
  45: CloudFog,
  48: CloudFog,
  51: CloudDrizzle, 53: CloudDrizzle, 55: CloudDrizzle, 56: CloudDrizzle, 57: CloudDrizzle,
  61: CloudRain, 63: CloudRain, 65: CloudRain, 66: CloudRain, 67: CloudRain,
  71: Snowflake, 73: Snowflake, 75: Snowflake, 77: Snowflake,
  80: CloudRain, 81: CloudRain, 82: CloudRain,
  85: Snowflake, 86: Snowflake,
  95: CloudLightning, 96: CloudLightning, 99: CloudLightning,
};

/* Fallback-provider (wttr.in / met.no) descriptions carry no WMO code —
 * pick the icon from the wording instead of always showing a plain cloud.
 * Key → static icon record (no component identity is created during
 * render). The night variants live in WxGlyph: "moon"/"sun"/"partly"
 * swap to Moon/CloudMoon after the sun goes down. */
const WX_ICON_BY_DESC_KEY: Record<string, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  storm: CloudLightning,
  snow: Snowflake,
  rain: CloudRain,
  fog: CloudFog,
  overcast: Cloud,
  partly: CloudSun,
  sun: Sun,
  moon: Moon,
};

function descIconKey(desc: string): string | null {
  const d = desc.toLowerCase();
  if (!d) return null;
  if (/(thunder|storm|lightning)/.test(d)) return "storm";
  if (/(snow|blizzard|sleet|ice)/.test(d)) return "snow";
  if (/(drizzle|shower|rain|wet)/.test(d)) return "rain";
  if (/(mist|fog|haze)/.test(d)) return "fog";
  if (/overcast|cloudy/.test(d)) return "overcast";
  if (/partly|cloud/.test(d)) return "partly";
  if (/night/.test(d)) return "moon"; // "Clear night" — already sun-down text
  if (/(clear|sunny|fair|fine)/.test(d)) return "sun";
  return null;
}

/* Night-aware glyph: WMO 0/1/2 draw a sun by day — at night they draw
 * the moon shapes ("its 9 PM and it says its sunny" can't happen again).
 * `isDay` comes from the API (Open-Meteo answers it for the resolved/
 * pinned point, so a faraway pin reads ITS OWN sky); null falls back to
 * whatever the description wording implies. */
const WX_ICON_BY_CODE_NIGHT: Record<number, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  0: Moon,
  1: CloudMoon,
  2: CloudMoon,
};

function WxGlyph({
  code,
  desc,
  isDay,
  className,
}: {
  code?: number;
  desc?: string;
  isDay?: boolean | null;
  className?: string;
}) {
  const key = descIconKey(desc ?? "");
  const night = isDay === false;
  const byCode =
    night && code != null && WX_ICON_BY_CODE_NIGHT[code]
      ? WX_ICON_BY_CODE_NIGHT[code]
      : code != null
        ? WX_ICON_BY_CODE[code]
        : undefined;
  const byDesc =
    key && key in WX_ICON_BY_DESC_KEY ? WX_ICON_BY_DESC_KEY[key] : undefined;
  const Icon =
    byCode ??
    (night && (key === "sun" || key === "moon")
      ? Moon
      : night && key === "partly"
        ? CloudMoon
        : byDesc) ??
    Cloud;
  return <Icon aria-hidden className={className} />;
}

function greetingFor(h: number, name: string): string {
  /* Evening begins at 17:00 (5 PM) and night at 21:00 — matches the
     offline file's boundaries so both surfaces agree; `now` ticks every
     second, so the greeting can never go stale the way a render-once
     label did (afternoon shown at night). */
  const g =
    h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 21 ? "Good evening" : "Good night";
  return name ? `${g}, ${name}` : g;
}

interface WxPin {
  place: string;
  lat: number;
  lon: number;
}

/* Manual location override — geocode a typed city through Open-Meteo's
 * public geocoder, then drive every forecast from those exact coords.
 * IP geolocation (ipwho.is) can be off by a metro or land in the wrong
 * state; the pin wins forever once saved. */
async function geocodeCity(q: string): Promise<WxPin | null> {
  const one = async (name: string) => {
    try {
      const r = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
        { cache: "no-store" }
      );
      if (!r.ok) return null;
      return (await r.json()) as {
        results?: { name?: string; admin1?: string; country_code?: string; latitude?: number; longitude?: number }[];
      };
    } catch {
      return null;
    }
  };
  /* the geocoder's name field has no region syntax — “Austin, TX”
   * answers with zero rows (the placeholder's own format!), so a comma
   * query retries on the bare city before giving up. */
  const full = await one(q);
  const j = full?.results?.length
    ? full
    : q.includes(",")
      ? await one(q.split(",")[0].trim())
      : null;
  const hit = j?.results?.[0];
  if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return null;
  const place = [hit.name, hit.admin1 && hit.admin1 !== hit.name ? hit.admin1 : null, hit.country_code]
    .filter(Boolean)
    .join(", ");
  return { place, lat: hit.latitude as number, lon: hit.longitude as number };
}

/* ------------------------------------------------------------------ */
/* Suggestion model                                                    */
/* ------------------------------------------------------------------ */

interface Suggestion {
  kind: "search" | "link" | "visit";
  title: string;
  sub: string;
  url: string;
  host: string;
}

/* ------------------------------------------------------------------ */
/* Start page                                                          */
/* ------------------------------------------------------------------ */

/** The canonical hero tagline. */
const TAGLINE = "The whole web, through the veil.";

/** Splash texts — 75% of loads, one of these replaces the tagline
 *  in the hero instead (picked at random, the user's exact words). */
const SPLASH_LINES = [
  "Your Back",
  "I know its the best",
  "happy?",
  "1+1=11",
  "woah",
  "better than the rest",
  "CHIKEN JOCKEY!!!",
  "battle royale",
  "If your enemy's know your next move dont move",
  "fire hurts- Trust me",
  "Why did I pick the name veil IDK",
  "WORDS",
  "gravity hurts",
  "verified by me",
] as const;

/** Chance a load swaps the tagline for a splash line. */
const SPLASH_CHANCE = 0.75;

/** The rare one — 1% of loads, the secret password line.
 *  Renders GOLD instead of emerald so it feels like a rare drop. */
const SPLASH_SPECIAL = "passwords 5rew21";
const SPLASH_SPECIAL_CHANCE = 0.01;

function randomSplashLine(): string {
  return SPLASH_LINES[Math.floor(Math.random() * SPLASH_LINES.length)];
}

/* ------------------------------------------------------------------ */
/* Start-page layout — the move-only editor                            */
/* ------------------------------------------------------------------ */

/** Every arrangeable block of the start page. */
type WidgetId =
  | "clock"
  | "weather"
  | "presence"
  | "brand"
  | "search"
  | "hints"
  | "dock"
  | "suggestions"
  | "recent"
  | "stats";

/** The ONLY thing the layout editor controls: the order the apps render
 * in. No resizing, no hiding, no redesign — the page keeps its classic
 * column look no matter how things are arranged. */
interface StartLayout {
  order: WidgetId[];
  customized: boolean;
}

const DEFAULT_ORDER: WidgetId[] = [
  "clock",
  "weather",
  "presence",
  "brand",
  "search",
  "hints",
  "dock",
  "suggestions",
  "recent",
  "stats",
];
const LAYOUT_KEY = "veil.start.layout.v1";

const WIDGET_LABELS: Record<WidgetId, string> = {
  clock: "Clock",
  weather: "Weather",
  presence: "Who's online",
  brand: "Brand + tagline",
  search: "Search bar",
  hints: "Keyboard hints",
  dock: "Section dock",
  suggestions: "Suggestions",
  recent: "Recently viewed",
  stats: "Stats line",
};

/** How each block sits in the classic column: its top margin (the
 * hand-tuned default rhythm) and whether it centers or runs wide.
 * Reordering never changes these — the editor is move-only. */
const COLUMN_ITEM: Record<WidgetId, string> = {
  clock: "flex w-full justify-center",
  weather: "mt-3.5 flex w-full justify-center",
  presence: "mt-3.5 flex w-full justify-center",
  brand: "mt-9 w-full",
  search: "mt-7 w-full",
  hints: "mt-3.5 flex w-full justify-center",
  dock: "mt-8 flex w-full justify-center",
  suggestions: "mt-10 w-full",
  recent: "mt-10 w-full",
  stats: "mt-10 w-full",
};

function readStartLayout(): StartLayout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { order: DEFAULT_ORDER, customized: false };
    const p = JSON.parse(raw) as Partial<StartLayout>;
    /* keep known ids in their saved order, append anything missing (a
     * new widget added in a later version always shows up somewhere).
     * Old payloads also carried `hidden`/`sizes` — deliberately dropped:
     * the editor is move-only now. */
    const known = (Array.isArray(p.order) ? p.order : []).filter((id): id is WidgetId =>
      (DEFAULT_ORDER as string[]).includes(id),
    );
    const finalOrder = [...new Set([...known, ...DEFAULT_ORDER])];
    return {
      order: finalOrder.length > 0 ? finalOrder : DEFAULT_ORDER,
      customized: Boolean(p.customized),
    };
  } catch {
    return { order: DEFAULT_ORDER, customized: false };
  }
}

function saveStartLayout(l: StartLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new Event("veil:layout-changed"));
}

/* ------------------------------------------------------------------ */
/* Who's online — a live count of everyone on the site                 */
/* ------------------------------------------------------------------ */

function presenceLabel(total: number): string {
  if (total <= 0) return "connecting…";
  return `${total} online`;
}

/* Mega-motion ambient stars for the procedural wallpaper — tiny twinkling
   dots with staggered rhythm (only animate under data-veil-fancy="on"). */
const TWINKLE_STARS: { pos: string; delay: string; dur: string }[] = [
  { pos: "left-[12%] top-[18%]", delay: "0.3s", dur: "3.4s" },
  { pos: "left-[76%] top-[14%]", delay: "1.1s", dur: "4.2s" },
  { pos: "left-[64%] top-[66%]", delay: "1.9s", dur: "3.0s" },
  { pos: "left-[22%] top-[74%]", delay: "2.6s", dur: "4.6s" },
  { pos: "left-[46%] top-[40%]", delay: "0.8s", dur: "3.8s" },
];

/** Owns the 1-second tick so StartPage's whole tree does NOT re-render
 * every second (the old top-level setNow re-rendered the entire home
 * screen — every widget, every card — 60×/minute: a silent CPU tax that
 * made the site feel laggy on modest hardware). Renders the big clock +
 * the date line; geometry-stable placeholders paint until the first
 * client tick (no hydration mismatch, no layout shift). */
function StartClock({ clock24 }: { clock24: boolean }) {
  const [now, setNow] = React.useState<Date | null>(null);
  /* More animations — the big time breathes a soft emerald halo. */
  const fancy = useFancyMotion();
  React.useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const timeLabel = !now
    ? clock24
      ? "--:--"
      : "--:-- --"
    : clock24
      ? `${now.getHours().toString().padStart(2, "0")}:${now
          .getMinutes()
          .toString()
          .padStart(2, "0")}`
      : `${(now.getHours() % 12) || 12}:${now
          .getMinutes()
          .toString()
          .padStart(2, "0")} ${now.getHours() < 12 ? "AM" : "PM"}`;
  return (
    <div aria-hidden className="select-none text-center">
      <p className={`veil-rise text-5xl font-light tabular-nums tracking-tight text-zinc-50 [text-shadow:0_2px_18px_rgba(0,0,0,0.55)] sm:text-6xl ${fancy ? "veil-clock-glow" : ""}`}>
        {timeLabel}
      </p>
      <p className="veil-rise veil-type-reveal mt-1.5 text-[11px] font-semibold uppercase tracking-[0.3em] text-zinc-300 [text-shadow:0_1px_12px_rgba(0,0,0,0.6)]">
        {now
          ? now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
          : "\u00A0"}
      </p>
    </div>
  );
}

/** Greeting only changes on the hour — a 60s tick is plenty, and it
 * lives here instead of StartPage so the home screen never re-renders
 * for the clock's sake. */
function GreetingLabel({ name }: { name: string }) {
  const [hour, setHour] = React.useState<number | null>(null);
  React.useEffect(() => {
    setHour(new Date().getHours());
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);
  return <span className="veil-text-shine shrink-0 truncate text-zinc-400">{hour === null ? "Hello" : greetingFor(hour, name)}</span>;
}

export function StartPage({
  onNavigate,
  history,
  onHistoryChanged,
  section,
  onOpenSection,
  autoSearch,
  onAutoSearchConsumed,
}: StartPageProps) {
  const reduceMotion = useReducedMotion();
  /* Settings › Appearance — "More animations" (default ON): amplified
     rises, springy dock, card staggers across the whole start page. */
  const fancy = useFancyMotion();

  // ----- pending search handed over from a veiled page -----
  // The bot-wall page's “Search this site's content” button asks the shell
  // to run a search; consumed once on mount so it never loops.
  const autoSearchRef = React.useRef(autoSearch);
  React.useEffect(() => {
    const q = autoSearchRef.current;
    if (!q) return;
    autoSearchRef.current = undefined;
    onAutoSearchConsumed?.();
    const url = searchUrlFor(q);
    if (url) onNavigate(url);
  }, []);

  // ----- who's online (live-tracked from the page-level heartbeat) -----
  const presence = usePresence();

  // ----- hero tagline: 75% of loads swap in a splash line -----
  // Decided once per mount, AFTER hydration (the server always
  // renders the canonical tagline so SSR HTML never mismatches).
  // 1% of loads get the special gold "passwords" line instead.
  // ?splash or ?splash=<line> forces one (same text, case-insensitive;
  // "5rew21" / "passwords" force the special). A non-matching value
  // picks a random line — deterministic for testing / showing off.
  const [tagline, setTagline] = React.useState<string>(TAGLINE);
  const [special, setSpecial] = React.useState(false);
  React.useEffect(() => {
    let forced: string | null = null;
    let forcedSpecial = false;
    try {
      /* raw extraction, NOT URLSearchParams: it decodes "+" as a space,
         so the "1+1=11" line could never match its own override */
      const m = /[?&]splash=([^&]*)/i.exec(window.location.search);
      if (m) {
        let q = m[1];
        try {
          q = decodeURIComponent(m[1]);
        } catch {
          /* bad % sequence — use the raw value */
        }
        const needle = q.trim().toLowerCase();
        if (needle === "5rew21" || needle === "passwords" || needle === SPLASH_SPECIAL) {
          forced = SPLASH_SPECIAL;
          forcedSpecial = true;
        } else {
          forced = SPLASH_LINES.find((l) => l.toLowerCase() === needle) ?? randomSplashLine();
        }
      }
    } catch {
      /* bad query — fall through to the dice roll */
    }
    if (forced) {
      setTagline(forced);
      setSpecial(forcedSpecial);
      return;
    }
    const roll = Math.random();
    if (roll < SPLASH_SPECIAL_CHANCE) {
      setTagline(SPLASH_SPECIAL);
      setSpecial(true);
    } else if (roll < SPLASH_SPECIAL_CHANCE + SPLASH_CHANCE) {
      setTagline(randomSplashLine());
    }
  }, []);
  const isSplashLine = tagline !== TAGLINE;


  // ----- applied wallpaper (live-tracked) -----
  const [wallpaper, setWallpaper] = React.useState<WallpaperSelection | null>(null);
  React.useEffect(() => {
    const sync = () => setWallpaper(loadWallpaperSelection());
    sync();
    window.addEventListener("veil:wallpaper-changed", sync);
    return () => window.removeEventListener("veil:wallpaper-changed", sync);
  }, []);

  // ----- appearance settings (live-tracked) -----
  const [clock24, setClock24] = React.useState(false);
  const [unit, setUnit] = React.useState<"C" | "F">("C");
  const [dim, setDim] = React.useState<"0" | "25" | "55">("0");
  const [greetName, setGreetName] = React.useState("");
  React.useEffect(() => {
    const sync = () => {
      setClock24(ls("veil:clock-24h") === "1");
      const u = ls("veil:temp-unit");
      setUnit(u === "F" || u === "C" ? u : "C");
      const d = ls("veil:backdrop-dim");
      setDim(d === "25" || d === "55" ? d : "0");
      setGreetName((ls("veil:greeting-name") ?? "").slice(0, 24));
    };
    sync();
    window.addEventListener("veil:settings-changed", sync);
    return () => window.removeEventListener("veil:settings-changed", sync);
  }, []);

  // ----- start-page layout (the bento editor) -----
  // SSR renders the DEFAULT column; the saved layout applies after mount
  // (same pattern as the clock — no hydration mismatch, one frame of the
  // classic look for customized users).
  const [layout, setLayout] = React.useState<StartLayout>({
    order: DEFAULT_ORDER,
    customized: false,
  });
  const [editing, setEditing] = React.useState(false);
  const [dragId, setDragId] = React.useState<WidgetId | null>(null);
  const [dropTarget, setDropTarget] = React.useState<WidgetId | null>(null);
  React.useEffect(() => {
    setLayout(readStartLayout());
  }, []);
  const mutateLayout = (next: StartLayout) => {
    setLayout(next);
    saveStartLayout(next);
  };
  const moveWidget = (id: WidgetId, dir: -1 | 1) => {
    const i = layout.order.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= layout.order.length) return;
    const order = [...layout.order];
    [order[i], order[j]] = [order[j], order[i]];
    mutateLayout({ ...layout, order, customized: true });
  };
  const dropWidgetOn = (target: WidgetId) => {
    if (!dragId || dragId === target) return;
    const order = [...layout.order];
    order.splice(order.indexOf(dragId), 1);
    order.splice(order.indexOf(target), 0, dragId);
    mutateLayout({ ...layout, order, customized: true });
    setDragId(null);
    setDropTarget(null);
  };
  const resetWidgetLayout = () => {
    mutateLayout({ order: DEFAULT_ORDER, customized: false });
  };
  const finishEditing = () => {
    setEditing(false);
    setDragId(null);
    setDropTarget(null);
  };

  // ----- clock -----
  // The ticking clock + greeting live in isolated components (StartClock /
  // GreetingLabel) so the secondly tick re-renders only those tiny trees,
  // never the whole StartPage.

  // ----- weather -----
  const [wx, setWx] = React.useState<WeatherState | null>(null);
  const [wxCode, setWxCode] = React.useState<number | undefined>(undefined);

  // Pinned location: user-set city that beats every auto detection.
  const [pin, setPin] = React.useState<WxPin | null>(null);
  const [pinOpen, setPinOpen] = React.useState(false);
  const [pinInput, setPinInput] = React.useState("");
  const [pinBusy, setPinBusy] = React.useState(false);
  const [pinMsg, setPinMsg] = React.useState("");
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem("veil:wx-pin");
      if (raw) {
        const p = JSON.parse(raw) as WxPin;
        if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) setPin(p);
      }
    } catch {
      /* ignore a corrupted pin */
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    // The geolocation is resolved ONCE (the visitor does not move between
    // refreshes); the weather itself re-reads every minute. A pinned city
    // replaces the whole auto path — the pin is the forecast location.
    let geoQuery: string | null = null;

    const apply = (data: Record<string, unknown> | null) => {
      if (cancelled) return;
      if (!data || typeof data.tempC !== "number") {
        // A failed refresh keeps the last good reading on screen — a
        // blip should not blank the chip; it only hides before the first
        // successful load.
        return;
      }
      setWx({
        tempC: data.tempC as number,
        feelsC: typeof data.feelsC === "number" ? (data.feelsC as number) : (data.tempC as number),
        desc: typeof data.desc === "string" ? data.desc : "",
        humidity: typeof data.humidity === "number" ? (data.humidity as number) : null,
        place: typeof data.place === "string" ? data.place : "",
        isDay: typeof data.isDay === "boolean" ? (data.isDay as boolean) : null,
      });
      const code = typeof data.code === "number" ? data.code : -1;
      setWxCode(code >= 0 ? code : undefined);
    };

    const load = () => {
      const url =
        pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lon)
          ? `/api/weather?lat=${pin.lat}&lon=${pin.lon}&place=${encodeURIComponent(pin.place)}&tz=${encodeURIComponent(tz)}`
          : (geoQuery ?? `/api/weather?tz=${encodeURIComponent(tz)}`);
      fetch(url, { cache: "no-store", headers: viewerHeaders() })
        .then(async (r) => {
          if (r.status === 204) return null;
          if (!r.ok) throw new Error("wx");
          return (await r.json()) as Record<string, unknown>;
        })
        .then(apply)
        .catch(() => {
          /* keep the last good reading */
        });
    };

    // The chip refreshes itself every minute — the server cache is 60s, so
    // each poll returns genuinely fresh readings (temp / feels / humidity
    // drift with the model, and the sunrise/sunset row stays current).
    const timer = setInterval(load, 60_000);

    // First reading RIGHT NOW: don't let the geo lookup gate the chip —
    // the server resolves the browser timezone's reference city instantly,
    // and the precise point forecast takes over the moment geo lands.
    // A pinned city skips the ipwho.is path entirely.
    load();

    if (pin) return () => {
      cancelled = true;
      clearInterval(timer);
    };

    // whatismyip.com-style: the browser's own ipwho.is hit carries this
    // machine's real public IP; the exact coordinates then drive our API's
    // Open-Meteo point forecast. Server-side fallback (tz reference city)
    // covers a failed direct lookup. A HARD TIMEOUT matters: a hanging
    // (never-erroring) ipwho.is request would otherwise stall the chip
    // forever — with the abort, the tz-based reading above stays and the
    // chip keeps refreshing on its own.
    const geoAbort = new AbortController();
    const geoTimer = setTimeout(() => geoAbort.abort(), 6000);
    fetch("https://ipwho.is/", { cache: "no-store", signal: geoAbort.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("geo"))))
      .then(
        (g: {
          success?: boolean;
          latitude?: number;
          longitude?: number;
          city?: string;
          country_code?: string;
        }) => {
          if (!g || !g.success || !Number.isFinite(g.latitude)) throw new Error("geo");
          const place = [g.city, g.country_code].filter(Boolean).join(", ");
          geoQuery = `/api/weather?lat=${g.latitude}&lon=${g.longitude}&place=${encodeURIComponent(
            place
          )}&tz=${encodeURIComponent(tz)}`;
          load();
        }
      )
      .catch(() => {
        /* the tz-based reading above already covers this */
      })
      .finally(() => clearTimeout(geoTimer));

    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(geoTimer);
      geoAbort.abort();
    };
  }, [pin]);

  const applyPin = React.useCallback(
    async (raw?: string) => {
      const q = (raw ?? pinInput).trim();
      if (!q || pinBusy) return;
      setPinBusy(true);
      setPinMsg("");
      const hit = await geocodeCity(q);
      setPinBusy(false);
      if (!hit) {
        setPinMsg(`Couldn't find “${q.slice(0, 40)}” — try “City, State/Country”.`);
        return;
      }
      setPin(hit);
      setPinMsg("");
      setPinOpen(false);
      try {
        window.localStorage.setItem("veil:wx-pin", JSON.stringify(hit));
      } catch {
        /* this session only */
      }
    },
    [pinBusy, pinInput]
  );

  const clearPin = React.useCallback(() => {
    setPin(null);
    setPinMsg("");
    try {
      window.localStorage.removeItem("veil:wx-pin");
    } catch {
      /* ignore */
    }
  }, []);

  // ----- hide UI (wallpaper-only zen view) -----
  const [uiHidden, setUiHidden] = React.useState(false);
  React.useEffect(() => {
    if (!uiHidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUiHidden(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [uiHidden]);
  const tempLabel = wx ? Math.round(unit === "F" ? wx.tempC * 1.8 + 32 : wx.tempC) : "–";
  const unitWx = unit === "F" ? "°F" : "°C";

  // ----- command bar -----
  const [input, setInput] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const suggestions = React.useMemo<Suggestion[]>(() => {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const out: Suggestion[] = [];
    // Direct URL/domain intent → single "launch" row.
    // (Video search through the command bar was removed at the owner's
    // request — YouTube queries only ever hit gated public instances and
    // showed "no results". Plain queries now search the web; URL intents
    // open the site through the veil like any other.)
    const direct = normalizeInput(input.trim());
    const rawIn = input.trim();
    const urlIntent =
      direct != null &&
      /^https?:\/\//i.test(direct) &&
      !rawIn.includes(" ") &&
      (/^https?:\/\//i.test(rawIn) ||
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(rawIn));
    if (urlIntent) {
      try {
        const u = new URL(direct);
        out.push({ kind: "search", title: u.hostname, sub: "Open this site", url: direct, host: u.hostname });
      } catch {
        /* not parseable — fall through */
      }
    }
    for (const l of QUICK_LINKS) {
      if (out.length >= 6) break;
      const aliasHit = l.aliases ? l.aliases.toLowerCase().includes(q) : false;
      if (
        l.name.toLowerCase().includes(q) ||
        l.host.toLowerCase().includes(q) ||
        l.desc.toLowerCase().includes(q) ||
        aliasHit
      ) {
        out.push({ kind: "link", title: l.name, sub: l.desc, url: l.url, host: l.host });
      }
    }
    for (const v of history?.visits ?? []) {
      if (out.length >= 6) break;
      if (v.host.toLowerCase().includes(q) || (v.title ?? "").toLowerCase().includes(q)) {
        out.push({ kind: "visit", title: (v.title || v.host).slice(0, 60), sub: v.host, url: v.url, host: v.host });
      }
    }
    // Always offer the web search row. For plain queries it sits at the TOP
    // (index 0) so pressing Enter searches the web — the expected default.
    // It only sinks to the end when a URL intent or quick link owns slot 0.
    const engineLabel = { bing: "Bing", duckduckgo: "DuckDuckGo", brave: "Brave", google: "Google", ecosia: "Ecosia" }[searchEngineId()] ?? "the web";
    const webRow: Suggestion = {
      kind: "search",
      title: `Search ${engineLabel} for “${input.trim().slice(0, 40)}”`,
      sub: "",
      url: "",
      host: "",
    };
    if (urlIntent) {
      out.push(webRow);
    } else {
      out.unshift(webRow);
    }
    return out;
  }, [input, history]);

  React.useEffect(() => setSel(0), [input]);

  const launch = (url: string) => {
    if (!url) return;
    setInput("");
    setFocused(false);
    inputRef.current?.blur();
    onNavigate(url);
  };

  const submit = () => {
    const raw = input.trim();
    const target = normalizeInput(raw);
    if (!target) return;
    // URL intent always wins over suggestion rows: a typed/pasted http(s)
    // URL or bare domain must never be routed to a search row.
    const isUrlIntent =
      /^https?:\/\//i.test(raw) ||
      (!raw.includes(" ") &&
        /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?([/?#].*)?$/i.test(raw));
    if (isUrlIntent && target && /^https?:\/\//i.test(target)) {
      launch(target);
      return;
    }
    const chosen = suggestions[sel];
    if (chosen && chosen.url && chosen.kind !== "search") {
      launch(chosen.url);
      return;
    }
    if (chosen && chosen.kind === "search" && chosen.url) {
      launch(chosen.url);
      return;
    }
    launch(target);
  };

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setSel((s) => (s + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setSel((s) => (s - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Escape") {
      setInput("");
      setFocused(false);
      inputRef.current?.blur();
    }
  };

  // "/" focuses the bar (page-level listener is in page.tsx via aria-label).
  const typingGuard = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  };
  React.useEffect(() => {
    if (section) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !typingGuard(e)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section]);

  // ----- recently viewed -----
  const recent = (history?.visits ?? []).slice(0, 8);

  // ----- dock -----
  const dock: { id: SectionId; label: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }[] = [
    { id: "ai", label: "Veil AI", icon: Bot },
    { id: "arcade", label: "Arcade", icon: Joystick },
    { id: "stream", label: "Stream", icon: MonitorPlay },
    { id: "chat", label: "Chat", icon: MessageCircle },
    { id: "wallpapers", label: "Wallpapers", icon: ImageIcon },
    { id: "music", label: "Music", icon: Music },
    { id: "links", label: "Links", icon: Globe },
    { id: "history", label: "History", icon: HistoryIcon },
    { id: "notes", label: "Notes", icon: NotebookPen },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  // Per the reference screenshot: ONLY the icons carry color, the labels
  // stay white and every pill stays the same dark glass — no tinted
  // backgrounds, borders or text. Music is purple (user pick), Settings
  // is gray. Class strings stay literal so Tailwind's scanner picks them up.
  const DOCK_ICON_COLORS: Record<SectionId, string> = {
    ai: "text-violet-400", // light purple / lavender
    arcade: "text-amber-300", // golden yellow
    stream: "text-rose-400", // rose — Veil's own YouTube theater
    chat: "text-orange-400", // orange — Veil Chat (user-specified)
    wallpapers: "text-cyan-300", // teal / cyan
    music: "text-purple-400", // purple (user-specified)
    links: "text-green-400", // mint green
    history: "text-sky-300", // light blue
    notes: "text-emerald-300", // emerald — quick thoughts
    settings: "text-zinc-400", // gray (user-specified)
  };

  // Every dock pill keeps the same neutral dark-glass look — per the user,
  // only the Chat ICON is orange; the pill itself matches the rest.

  // ----- wallpaper backdrop pieces -----
  const wpKind = wallpaper?.kind ?? "animated";
  const wpTheme = wallpaper?.theme ?? "emerald";
  const wpSrc = wallpaper?.src ?? "";
  const wpThumb = wallpaper?.thumb ?? undefined;
  const dimClass = dim === "55" ? "bg-black/55" : dim === "25" ? "bg-black/25" : "";
  const rise = (d = 0) =>
    reduceMotion
      ? {}
      : {
          style: { animationDelay: `${d}s` },
          className: fancy ? "veil-rise-fancy" : "veil-rise",
        };

  /* ---- the arrangeable widget bodies ----
   * The classic column renders them in the saved order — the layout
   * editor only reorders; margins live on the wrappers (COLUMN_ITEM). */
  const widgetNodes: Record<WidgetId, React.ReactNode> = {
    clock: (
      <StartClock clock24={clock24} />
    ),
    weather: (
      <div {...rise(0.06)} className={`${fancy ? "veil-rise-fancy" : "veil-rise"} flex justify-center`}>
        <div className="veil-hover-lift flex max-w-full items-center gap-2 overflow-visible rounded-full border border-white/10 bg-black/40 px-3.5 py-1.5 text-[12.5px] text-zinc-300 backdrop-blur-md">
          {wx ? (
            <>
              <WxGlyph code={wxCode} desc={wx.desc} isDay={wx.isDay} className="size-3.5 shrink-0 text-emerald-300" />
              <button
                key={`${tempLabel}-${wx.desc}`}
                type="button"
                onClick={() => {
                  const next = unit === "F" ? "C" : "F";
                  setUnit(next);
                  try {
                    window.localStorage.setItem("veil:temp-unit", next);
                  } catch {
                    /* ignore */
                  }
                }}
                title={wx.place ? `${wx.place} · refreshes every minute` : "refreshes every minute"}
                aria-label={`Temperature ${Math.round(wx.tempC)} degrees Celsius. Click to switch units.`}
                className="veil-wx-fresh rounded-full px-1.5 font-medium tabular-nums text-zinc-100 transition hover:bg-white/10 hover:text-white"
              >
                {tempLabel}
                {unitWx}
              </button>
              {wx.desc ? (
                <>
                  <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-zinc-500" />
                  <span className="veil-text-breathe truncate">{wx.desc}</span>
                </>
              ) : null}
              <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-zinc-500" />
            </>
          ) : (
            <ClockIcon aria-hidden className="size-3.5 shrink-0 text-zinc-500" />
          )}
          <GreetingLabel name={greetName} />

          {/* pin — set the weather's city by hand (fixes a wrong
              IP-geolocated location) */}
          <Popover open={pinOpen} onOpenChange={(o) => { setPinOpen(o); if (o) setPinMsg(""); }}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Set the weather location"
                title={pin ? `Pinned: ${pin.place} — click to change` : "Weather not right? Set your city"}
                className={cn(
                  "ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-full transition hover:bg-white/10",
                  pin ? "text-emerald-300" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                <MapPin aria-hidden className="veil-hover-spin size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-72 rounded-2xl border-zinc-800 bg-zinc-950/95 p-3.5 backdrop-blur-xl">
              <p className="text-[12.5px] font-semibold text-zinc-100">Weather location</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-zinc-500">
                {pin ? (
                  <>
                    Pinned to <span className="text-emerald-300">{pin.place}</span>
                  </>
                ) : wx?.place ? (
                  <>
                    Auto-detected · <span className="text-zinc-300">{wx.place}</span>
                  </>
                ) : (
                  "Detecting your location…"
                )}
              </p>
              <form
                className="mt-2.5 flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void applyPin();
                }}
              >
                <input
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="City — e.g. Austin, TX"
                  aria-label="City for the weather"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-[12.5px] text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-500/50"
                />
                <button
                  type="submit"
                  disabled={pinBusy || !pinInput.trim()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500 text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
                  aria-label="Set the location"
                >
                  {pinBusy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Check aria-hidden className="size-3.5" />}
                </button>
              </form>
              {pinMsg && <p className="mt-2 text-[11.5px] leading-snug text-amber-300/90">{pinMsg}</p>}
              {pin && (
                <button
                  type="button"
                  onClick={clearPin}
                  className="mt-2 w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-[11.5px] font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200"
                >
                  Use auto location instead
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    ),
    presence: (
      <div {...rise(0.08)} className={`${fancy ? "veil-rise-fancy" : "veil-rise"} flex justify-center`}>
        <div
          role="status"
          aria-live="polite"
          aria-label={`Who's online — ${presence.total} ${presence.total === 1 ? "person" : "people"} on the site`}
          title="How many people are on the website right now"
          className="veil-pulse-glow flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3.5 py-1.5 text-[12.5px] text-zinc-300 backdrop-blur-md transition hover:border-emerald-400/25"
        >
          {/* the live dot — a soft ping behind a solid emerald core */}
          <span aria-hidden className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 [animation-duration:2.2s]" />
            <span className="veil-ripple absolute inline-flex size-full rounded-full bg-teal-300/60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
          </span>
          <span className="shrink-0 font-medium tabular-nums text-zinc-100">
            {presenceLabel(presence.total)}
          </span>
        </div>
      </div>
    ),
    brand: (
      <div {...rise(0.12)} className={`${fancy ? "veil-rise-fancy" : "veil-rise"} flex flex-col items-center`}>
        <div className="flex items-center gap-3">
          <VeilMark className="veil-bounce-soft size-8 text-emerald-300 drop-shadow-[0_4px_14px_rgba(16,185,129,0.45)]" />
          <span className="veil-text-shine text-xl font-semibold tracking-tight text-zinc-50">Veil</span>
        </div>
        <h2
          key={tagline}
          style={{
            ...(reduceMotion ? {} : { animationDelay: "0.12s" }),
            /* splash lines: inline gradient so it never depends on
               Tailwind generating an arbitrary-value class — a missing
               class + bg-clip-text leaves invisible glyphs (that was
               the "square" bug). drop-shadow (not text-shadow) respects
               the clipped glyph alpha. */
            ...(isSplashLine
              ? {
                  /* the 1% "passwords" line drops in gold; the rest
                     stay white→emerald */
                  backgroundImage: special
                    ? "linear-gradient(180deg,#fde68a 45%,#f59e0b)"
                    : "linear-gradient(180deg,#f4f4f5 55%,#6ee7b7)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                  filter: special
                    ? "drop-shadow(0 2px 16px rgba(245,158,11,0.45))"
                    : "drop-shadow(0 2px 16px rgba(52,211,153,0.35))",
                }
              : {}),
          }}
          className={
            (reduceMotion ? "" : fancy ? "veil-rise-fancy " : "veil-rise ") +
            "mt-3 max-w-xl text-center text-2xl font-semibold tracking-tight sm:text-3xl " +
            (isSplashLine ? "" : "text-zinc-50 [text-shadow:0_2px_20px_rgba(0,0,0,0.6)]")
          }
        >
          {tagline}
        </h2>
      </div>
    ),
    search: (
      <form
        {...rise(0.18)}
        role="search"
        className={`${fancy ? "veil-rise-fancy" : "veil-rise"} relative flex w-full max-w-[42rem] items-stretch gap-2`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="veil-border-dance relative min-w-0 flex-1 rounded-2xl">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-zinc-500 transition-colors peer-focus:text-emerald-300"
          />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onKeyDown={onInputKey}
            type="text"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            aria-label="Search or enter a web address"
            placeholder="Search the web…"
            className="peer h-[52px] w-full rounded-2xl border border-white/10 bg-black/45 py-4 pl-11 pr-12 text-[15px] text-zinc-100 shadow-[0_24px_48px_rgba(0,0,0,0.5)] backdrop-blur-md outline-none transition placeholder:text-zinc-600 focus:border-emerald-500/50 focus:shadow-[0_24px_48px_rgba(0,0,0,0.5),0_0_0_3px_rgba(16,185,129,0.15)]"
          />
          {!input && (
            <kbd
              aria-hidden
              className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 sm:block"
            >
              /
            </kbd>
          )}
          {/* suggestions */}
          {focused && suggestions.length > 0 && (
            <motion.div
              role="listbox"
              aria-label="Suggestions"
              initial={fancy ? { opacity: 0, y: -8, scale: 0.985 } : false}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
              className="absolute left-0 right-0 top-[calc(100%+8px)] z-40 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950/95 p-1.5 shadow-[0_32px_64px_rgba(0,0,0,0.6)] backdrop-blur-xl veil-scroll-slim"
              style={{ maxHeight: "18.5rem" }}
            >
              {suggestions.map((s, i) => (
                <button
                  key={`${s.kind}-${s.url}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => (s.url ? launch(s.url) : submit())}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    i === sel ? "bg-emerald-500/10" : "hover:bg-zinc-900"
                  }`}
                >
                  <span
                    aria-hidden
                    className={`veil-hover-wobble flex size-8 shrink-0 items-center justify-center rounded-lg ${
                      s.kind === "visit"
                        ? "bg-zinc-800 text-zinc-400"
                        : s.kind === "link"
                          ? "bg-emerald-500/15 text-emerald-300 [box-shadow:inset_0_0_0_1px_rgba(16,185,129,0.25)]"
                          : "bg-zinc-800 text-amber-300"
                    }`}
                  >
                    {s.kind === "visit" ? (
                      <SuggestionFavicon host={s.host} />
                    ) : s.kind === "link" ? (
                      <Globe className="size-4" />
                    ) : (
                      <Search className="size-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-zinc-100">{s.title}</span>
                    {s.sub ? (
                      <span className="block truncate text-[11.5px] text-zinc-500">{s.sub}</span>
                    ) : null}
                  </span>
                  {i === sel ? <ArrowRight aria-hidden className="mr-1 size-3.5 shrink-0 text-emerald-400" /> : null}
                </button>
              ))}
            </motion.div>
          )}
        </div>
        <motion.button
          type="submit"
          whileHover={fancy ? { scale: 1.04, boxShadow: "0 16px 40px rgba(16,185,129,0.4)" } : undefined}
          whileTap={{ scale: 0.97 }}
          transition={{ type: "spring", stiffness: 460, damping: 24 }}
          className="flex h-[52px] shrink-0 items-center gap-2 rounded-2xl bg-emerald-500 px-5 text-[15px] font-semibold text-emerald-950 shadow-[0_12px_24px_rgba(16,185,129,0.25)] transition hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
        >
          <span className="hidden sm:inline">Launch</span>
          <ArrowRight aria-hidden className="veil-hover-bounce size-4" />
        </motion.button>
      </form>
    ),
    hints: (
      <div {...rise(0.18)} className={fancy ? "veil-rise-fancy" : "veil-rise"}>
        <p className="veil-scanline flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border border-white/10 bg-black/40 px-3.5 py-1.5 text-[11.5px] text-zinc-400 backdrop-blur-md">
          <HintKbd>Enter</HintKbd> launches ·
          <HintKbd>↑↓</HintKbd> picks ·
          <HintKbd>F</HintKbd> fullscreen ·
          <HintKbd>Esc</HintKbd> returns here
        </p>
      </div>
    ),
    dock: (
      <nav {...rise(0.24)} aria-label="Veil pages" className={`${fancy ? "veil-rise-fancy" : "veil-rise"} flex max-w-[36rem] flex-wrap items-center justify-center gap-2`}>
        {dock.map((d, i) => {
          const Icon = d.icon;
          const active = section === d.id;
          return (
            <motion.button
              key={d.id}
              type="button"
              onClick={() => onOpenSection(d.id)}
              aria-label={d.label}
              aria-pressed={active}
              whileHover={fancy ? { y: -3, scale: 1.05 } : undefined}
              whileTap={fancy ? { scale: 0.93 } : undefined}
              transition={{ type: "spring", stiffness: 480, damping: 21 }}
              className={`flex h-9 items-center gap-2 rounded-xl border px-3.5 text-[13px] font-medium backdrop-blur-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 ${
                active
                  ? "border-white/30 bg-white/12 text-white shadow-[0_0_22px_-6px_rgba(255,255,255,0.4)]"
                  : "border-white/10 bg-black/45 text-zinc-100 hover:border-white/25 hover:bg-black/60 hover:text-white"
              } ${fancy ? "veil-dock-sheen" : ""}`}
            >
              <Icon aria-hidden className={`veil-pop-in veil-stagger-${(i % 8) + 1} size-4 shrink-0 ${DOCK_ICON_COLORS[d.id]}`} />
              <span className={i % 2 === 0 ? "veil-hover-bounce" : "veil-hover-wobble"}>{d.label}</span>
            </motion.button>
          );
        })}
      </nav>
    ),
    suggestions: (
      <section {...rise(0.27)} aria-label="Suggestions" className={`${fancy ? "veil-rise-fancy" : "veil-rise"} w-full`}>
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
          <Sparkles aria-hidden className="size-3.5 text-emerald-300/80" />
          Suggestions
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {QUICK_LINKS.map((s, i) => (
            <SuggestionCard key={s.url} link={s} index={i} onNavigate={onNavigate} />
          ))}
        </div>
        <p className="mt-2.5 text-[11px] text-zinc-600">Picked to read well through the veil.</p>
      </section>
    ),
    recent:
      recent.length > 0 ? (
        <section {...rise(0.3)} aria-label="Recently viewed" className={`${fancy ? "veil-rise-fancy" : "veil-rise"} w-full`}>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            <HistoryIcon aria-hidden className="size-3.5" />
            Recently viewed
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
            {recent.map((v, i) => (
              <RecentCard key={v.id} visit={v} index={i} onNavigate={onNavigate} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => onOpenSection("history")}
            className="mt-3 text-[12px] text-zinc-500 underline-offset-4 transition hover:text-emerald-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
          >
            See all history →
          </button>
        </section>
      ) : null,
    stats: (
      <p {...rise(0.3)} className={`${fancy ? "veil-rise-fancy" : "veil-rise"} text-center text-[11.5px] text-zinc-500`}>
        {history
          ? `${history.stats.sites} site${history.stats.sites === 1 ? "" : "s"} visited · ${history.stats.pageVisits} page load${history.stats.pageVisits === 1 ? "" : "s"}`
          : "Your visits appear here as you browse."}
        <span aria-hidden className="mx-2">·</span>
        <button
          type="button"
          onClick={() => onOpenSection("settings")}
          className="underline-offset-4 transition hover:text-emerald-300 hover:underline"
        >
          Settings
        </button>
      </p>
    ),
  };

  return (
    <div className="fixed inset-0 overflow-y-auto veil-scroll-slim bg-zinc-950 text-zinc-100">
      {/* hide UI — small corner button; the wallpaper stays, everything
          else fades away. Click again (or Esc) to bring the UI back. */}
      <button
        type="button"
        aria-pressed={uiHidden}
        title={uiHidden ? "Show the interface (Esc)" : "Hide the interface — just the wallpaper (Esc brings it back)"}
        onClick={() => setUiHidden((v) => !v)}
        className="fixed left-4 top-4 z-[70] flex h-7 items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-2.5 text-[11px] font-medium tracking-wide text-zinc-300/70 backdrop-blur-md transition hover:border-white/25 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      >
        {uiHidden ? <Eye aria-hidden className="veil-hover-wobble size-3" /> : <EyeOff aria-hidden className="veil-hover-wobble size-3" />}
        <span>{uiHidden ? "show UI" : "hide UI"}</span>
      </button>
      {/* layout — open the start page's bento editor */}
      <button
        type="button"
        aria-pressed={editing}
        title={editing ? "Finish arranging the layout" : "Arrange the start page — drag the apps to move them"}
        onClick={() => (editing ? finishEditing() : setEditing(true))}
        className="fixed left-4 top-14 z-[70] flex h-7 items-center gap-1.5 rounded-full border border-white/10 bg-black/35 px-2.5 text-[11px] font-medium tracking-wide text-zinc-300/70 backdrop-blur-md transition hover:border-white/25 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      >
        <LayoutGrid aria-hidden className={cn("veil-hover-wobble size-3", editing && "text-emerald-300")} />
        <span>{editing ? "done" : "layout"}</span>
      </button>
      {/* ── wallpaper backdrop ── */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        {wpKind === "video" && wpSrc ? (
          <BackdropVideo src={wpSrc} poster={wpThumb} />
        ) : wpKind === "image" && wpSrc ? (
          <img src={wpSrc} alt="" className="size-full object-cover" />
        ) : (
          // Procedural animated theme (or the default look before anything
          // is applied): breathing gradient + floating orbs.
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
        {dimClass ? <div className={`absolute inset-0 ${dimClass}`} /> : null}
        <div className="veil-vignette absolute inset-x-0 bottom-0 h-64 bg-gradient-to-t from-black/45 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/35" />
      </div>

      {/* ── start content ── */}
      <div
        className={cn(
          "relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center px-4 py-10 transition-opacity duration-500 sm:px-6 sm:py-16",
          editing && "pb-24",
          uiHidden && "pointer-events-none opacity-0",
        )}
      >
        {/* ── the classic column, rendered from the saved order — the
            layout editor only moves these blocks around, the page's look
            never changes (no grid redesign: move-only, that's the deal) ── */}
        <div className="flex w-full flex-col items-center">
          {layout.order
            .filter((w) => widgetNodes[w] != null)
            .map((w) => (
              <section
                key={w}
                {...(editing ? { "aria-label": WIDGET_LABELS[w] } : {})}
                draggable={editing}
                onDragStart={editing ? () => setDragId(w) : undefined}
                onDragEnd={editing ? () => { setDragId(null); setDropTarget(null); } : undefined}
                onDragOver={
                  editing && dragId && dragId !== w
                    ? (e: React.DragEvent) => {
                        e.preventDefault();
                        setDropTarget(w);
                      }
                    : undefined
                }
                onDragLeave={editing ? () => setDropTarget((t) => (t === w ? null : t)) : undefined}
                onDrop={editing ? () => dropWidgetOn(w) : undefined}
                className={cn(
                  COLUMN_ITEM[w],
                  editing &&
                    "relative rounded-2xl px-3 py-2.5 outline-dashed outline-2 outline-white/25",
                  editing && dragId === w && "opacity-40",
                  editing && dropTarget === w && dragId !== w && "outline-2 outline-emerald-300/80",
                )}
              >
                {editing && (
                  <div className="absolute -top-3.5 left-3 right-3 z-20 flex items-center justify-between gap-1 rounded-full border border-white/15 bg-zinc-950/90 py-1 pl-2.5 pr-1.5 text-zinc-300 shadow-lg backdrop-blur-md">
                    <span className="flex min-w-0 items-center gap-1 text-[10px] font-semibold">
                      <GripVertical aria-hidden className="size-3 shrink-0 text-zinc-500" />
                      <span className="truncate">{WIDGET_LABELS[w]}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => moveWidget(w, -1)}
                        aria-label={`Move ${WIDGET_LABELS[w]} earlier`}
                        className="flex size-5.5 items-center justify-center rounded-full transition hover:bg-white/10 hover:text-white"
                      >
                        <ChevronUp aria-hidden className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveWidget(w, 1)}
                        aria-label={`Move ${WIDGET_LABELS[w]} later`}
                        className="flex size-5.5 items-center justify-center rounded-full transition hover:bg-white/10 hover:text-white"
                      >
                        <ChevronDown aria-hidden className="size-3" />
                      </button>
                    </span>
                  </div>
                )}
                {widgetNodes[w]}
              </section>
            ))}
        </div>
      </div>

      {/* ── the layout editor's action bar ── */}
      {editing && (
        <div className="fixed inset-x-0 bottom-0 z-[70] border-t border-white/10 bg-zinc-950/90 backdrop-blur-xl">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
            <span className="flex items-center gap-2 text-[12.5px] font-semibold text-zinc-100">
              <LayoutGrid aria-hidden className="size-4 text-emerald-300" /> Arrange the start page
            </span>
            <span className="hidden text-[11px] text-zinc-500 sm:inline">drag a block (or the arrows) to move it — that's all the editor does</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={resetWidgetLayout}
              className="flex h-7.5 items-center gap-1.5 rounded-full border border-white/15 px-3 text-[11.5px] font-medium text-zinc-400 transition hover:border-white/30 hover:text-zinc-100"
            >
              <RotateCcw aria-hidden className="size-3" /> Reset
            </button>
            <button
              type="button"
              onClick={finishEditing}
              className="flex h-7.5 items-center gap-1.5 rounded-full bg-emerald-500 px-3.5 text-[11.5px] font-semibold text-emerald-950 transition hover:bg-emerald-400"
            >
              <Check aria-hidden className="size-3" /> Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function HintKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
      {children}
    </kbd>
  );
}

function SuggestionFavicon({ host }: { host: string }) {
  const urls = React.useMemo(() => faviconUrls(host), [host]);
  const [idx, setIdx] = React.useState(0);
  if (idx < urls.length) {
    return (
      <img
        src={urls[idx]}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        onError={() => setIdx((i) => i + 1)}
        className="size-4 rounded-sm bg-zinc-800 object-contain"
      />
    );
  }
  return <Globe aria-hidden className="size-4 text-zinc-400" />;
}

/* A suggested site — the Suggestions block's card. Mirrors RecentCard's
 * glass look so the two grids read as siblings. */
function SuggestionCard({
  link,
  index = 0,
  onNavigate,
}: {
  link: (typeof QUICK_LINKS)[number];
  index?: number;
  onNavigate: (url: string) => void;
}) {
  const urls = React.useMemo(() => faviconUrls(link.host), [link.host]);
  const [idx, setIdx] = React.useState(0);
  /* More animations — cards cascade in and lift on hover. */
  const fancy = useFancyMotion();
  return (
    <motion.button
      type="button"
      onClick={() => onNavigate(link.url)}
      aria-label={`Open ${link.name}`}
      initial={fancy ? { opacity: 0, y: 16, scale: 0.96 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        fancy
          ? { type: "spring", stiffness: 320, damping: 24, delay: 0.3 + index * 0.05 }
          : { duration: 0 }
      }
      whileHover={fancy ? { y: -4, scale: 1.03 } : undefined}
      whileTap={fancy ? { scale: 0.97 } : undefined}
      className={cn(
        "group flex items-center gap-2.5 rounded-2xl border bg-black/35 p-3 text-left backdrop-blur-md transition-colors hover:bg-black/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300",
        link.featured
          ? "border-emerald-500/30 hover:border-emerald-400/50"
          : "border-white/10 hover:border-emerald-500/40",
      )}
    >
      <span className={`veil-pop-in veil-stagger-${(index % 8) + 1} flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800`}>
        {idx < urls.length ? (
          <img
            src={urls[idx]}
            alt=""
            width={18}
            height={18}
            loading="lazy"
            onError={() => setIdx((i) => i + 1)}
            className="size-[18px] rounded-sm object-contain"
          />
        ) : (
          <Globe aria-hidden className="size-4 text-zinc-500" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium text-zinc-200 group-hover:text-zinc-100">{link.name}</span>
          {link.tag ? (
            <span className="veil-bounce-soft shrink-0 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
              {link.tag}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[10.5px] text-zinc-500">{link.desc}</span>
      </span>
      <ArrowRight aria-hidden className="size-3.5 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-emerald-300" />
    </motion.button>
  );
}

function RecentCard({
  visit,
  index = 0,
  onNavigate,
}: {
  visit: Visit;
  index?: number;
  onNavigate: (url: string) => void;
}) {
  const urls = React.useMemo(() => faviconUrls(visit.host), [visit.host]);
  const [idx, setIdx] = React.useState(0);
  const label = (visit.title || visit.host).slice(0, 42);
  /* More animations — same cascade language as the Suggestions grid. */
  const fancy = useFancyMotion();
  return (
    <motion.button
      type="button"
      onClick={() => onNavigate(visit.url)}
      aria-label={`Revisit ${visit.host}`}
      initial={fancy ? { opacity: 0, x: -14 } : false}
      animate={fancy ? { opacity: 1, x: 0 } : { opacity: 1 }}
      transition={
        fancy
          ? { type: "spring", stiffness: 340, damping: 26, delay: 0.32 + index * 0.045 }
          : { duration: 0 }
      }
      whileHover={fancy ? { x: 5, scale: 1.02 } : undefined}
      whileTap={fancy ? { scale: 0.97 } : undefined}
      className="group flex items-center gap-2.5 rounded-2xl border border-white/10 bg-black/35 p-3 text-left backdrop-blur-md transition-colors hover:border-emerald-500/40 hover:bg-black/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
    >
      <span className={`veil-pop-in veil-stagger-${(index % 8) + 1} flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800`}>
        {idx < urls.length ? (
          <img
            src={urls[idx]}
            alt=""
            width={18}
            height={18}
            loading="lazy"
            onError={() => setIdx((i) => i + 1)}
            className="size-[18px] rounded-sm object-contain"
          />
        ) : (
          <Globe aria-hidden className="size-4 text-zinc-500" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-zinc-200 group-hover:text-zinc-100">{label}</span>
        <span className="block truncate text-[10.5px] text-zinc-500">
          {visit.host} · {timeAgo(visit.updatedAt)}
        </span>
      </span>
    </motion.button>
  );
}
