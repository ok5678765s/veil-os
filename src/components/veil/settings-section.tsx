"use client";

/**
 * Veil Settings — the control room.
 *
 * Six tabs:
 *  - Privacy: the per-site panel — every host visited through the veil,
 *    its visit count, its cookie count, one-click wipe per site (and
 *    bulk wipes). Backed by /api/privacy over the existing SiteVisit +
 *    SiteCookie tables.
 *  - Appearance: clock 24h + weather units (the start-page chips listen
 *    to the veil:settings-changed event).
 *  - Browsing: session behavior — a restart always lands on the start
 *    page (scrubbed legacy restore), and "when I come back" decides
 *    whether switching to another browser tab resets Veil or keeps the
 *    page (veil:keep-session, read live by the visibility handler).
 *  - Security: the quick-exit kit — the panic key (a combo that
 *    instantly replaces the page with a site of your choosing) and the
 *    about:blank cloak (the veil running inside a blank-tab window).
 *  - Data: local stores (wallpaper selection, favorites, saved library)
 *    + the browsing history/cookies bulk wipes.
 *  - About: what the veil is.
 */

import * as React from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  AppWindow,
  ArrowLeft,
  CalendarDays,
  Check,
  Cookie,
  Copy,
  Database,
  Download,
  EyeOff,
  Globe,
  Info,
  Loader2,
  MessageCircle,
  MonitorPlay,
  Moon,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Siren,
  Sparkles,
  Thermometer,
  Timer,
  Trash2,
  Upload,
  UserRound,
  VenetianMask,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openVeilInAboutBlank, readPanicConfig, sanitizeUrl } from "@/lib/veil/panic";
import { syncFancyDomAttr } from "@/lib/veil/motion";
import {
  CLOAK_PRESETS,
  applyTabCloak,
  readTabCloakId,
  writeTabCloakId,
} from "@/lib/veil/tab-cloak";
import { clearLibrary, clearWallpaperSelection } from "@/lib/veil/wallpapers";
import {
  DEFAULT_PROXY_ENGINE,
  PROXY_ENGINES,
  SEARCH_ENGINES,
  proxyEngineId,
  readKeepSession,
  searchEngineId,
  setProxyEngineId,
  viewerHeaders,
  writeKeepSession,
  type ProxyEngineId,
} from "@/lib/veil/shared";
import {
  describeRestore,
  exportVeilBackup,
  importVeilBackup,
  veilBackupStats,
  type VeilBackupStats,
} from "@/lib/veil/backup";
import { historyReady } from "@/lib/veil/history-store";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Types + small helpers                                                */
/* ------------------------------------------------------------------ */

interface SiteRow {
  host: string;
  visits: number;
  lastAt: string;
  cookies: number;
}

interface PrivacyResponse {
  sites: SiteRow[];
  totals: { sites: number; visits: number; cookies: number };
  error?: string;
}

type Tab = "privacy" | "appearance" | "browsing" | "security" | "data";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "privacy", label: "Privacy", icon: ShieldCheck },
  { id: "appearance", label: "Appearance", icon: Settings2 },
  { id: "browsing", label: "Browsing", icon: AppWindow },
  { id: "security", label: "Security", icon: VenetianMask },
  { id: "data", label: "Data", icon: Database },
];

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return "—";
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** One setting row: label, hint, and a two-option segmented switch. */
function SwitchRow({
  icon: Icon,
  label,
  hint,
  value,
  options,
  onChange,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "veil-hover-lift flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 lg:flex-row lg:items-center",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-zinc-100">{label}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">{hint}</p>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-950/70 p-1"
      >
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            onClick={() => onChange(o.id)}
            className={cn(
              "veil-press flex h-8 items-center gap-1 rounded-lg px-3 text-[12.5px] font-medium transition",
              value === o.id
                ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
                : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"
            )}
          >
            {value === o.id && <Check aria-hidden className="size-3" />}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A free-text setting row (the greeting name). */
function TextRow({
  icon: Icon,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="veil-hover-glow flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-zinc-100">{label}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">{hint}</p>
        </div>
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 24))}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        className="veil-focus-bloom h-9 w-full rounded-xl border-zinc-800 bg-zinc-950/70 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20 sm:w-56"
      />
    </div>
  );
}

/** Danger action row with a two-step confirm. */
function DangerRow({
  label,
  hint,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  hint: string;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3500);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <div className="veil-hover-lift flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-300/90 ring-1 ring-rose-500/20">
          <Trash2 aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-zinc-100">{label}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">{hint}</p>
        </div>
      </div>
      <Button
        variant={armed ? "destructive" : "outline"}
        size="sm"
        onClick={() => {
          if (armed) {
            onConfirm();
            setArmed(false);
          } else {
            setArmed(true);
          }
        }}
        className={cn(
          "veil-press h-9 shrink-0 rounded-xl px-4 text-[13px]",
          armed
            ? "bg-rose-500 text-rose-950 hover:bg-rose-400"
            : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-rose-500/50 hover:bg-zinc-800 hover:text-rose-300"
        )}
      >
        {armed ? confirmLabel : "Clear"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Privacy tab                                                          */
/* ------------------------------------------------------------------ */

function PrivacyTab() {
  const [data, setData] = React.useState<PrivacyResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busyHost, setBusyHost] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/privacy", { cache: "no-store", headers: viewerHeaders() });
      const d = (await res.json()) as PrivacyResponse;
      if (!res.ok) throw new Error(d.error ?? "unreachable");
      setData(d);
    } catch {
      setError("The privacy panel couldn't reach the veil's site store.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const wipeHost = async (host: string) => {
    setBusyHost(host);
    try {
      await fetch(`/api/privacy?host=${encodeURIComponent(host)}`, { method: "DELETE", headers: viewerHeaders() });
      await load();
    } catch {
      /* the reload shows the truth */
    } finally {
      setBusyHost(null);
    }
  };

  const wipeScope = async (scope: "cookies" | "history" | "all") => {
    setBusyHost(scope);
    try {
      const url = scope === "all" ? "/api/privacy" : `/api/privacy?scope=${scope}`;
      await fetch(url, { method: "DELETE", headers: viewerHeaders() });
      await load();
    } catch {
      /* the reload shows the truth */
    } finally {
      setBusyHost(null);
    }
  };

  const sites = data?.sites ?? [];
  const query = q.trim().toLowerCase();
  const filtered = query ? sites.filter((s) => s.host.includes(query)) : sites;

  return (
    <div className="space-y-4">
      {/* Totals + bulk actions */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4">
        <ShieldCheck aria-hidden className="size-5 shrink-0 text-emerald-400/90" />
        <p className="min-w-0 flex-1 text-[13px] text-zinc-300">
          {data
            ? `${data.totals.sites} site${data.totals.sites === 1 ? "" : "s"} · ${data.totals.visits.toLocaleString()} visits · ${data.totals.cookies.toLocaleString()} cookies stored server-side`
            : "Loading the veil's site store…"}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !data?.totals.cookies}
            onClick={() => wipeScope("cookies")}
            className="veil-press h-8 rounded-xl border-zinc-700 bg-zinc-900 px-3 text-[12.5px] text-zinc-300 hover:border-emerald-500/50 hover:bg-zinc-800 hover:text-emerald-300 disabled:opacity-40"
          >
            {busyHost === "cookies" ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Cookie aria-hidden className="size-3.5" />
            )}
            Wipe all cookies
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !data?.totals.visits}
            onClick={() => wipeScope("history")}
            className="veil-press h-8 rounded-xl border-zinc-700 bg-zinc-900 px-3 text-[12.5px] text-zinc-300 hover:border-emerald-500/50 hover:bg-zinc-800 hover:text-emerald-300 disabled:opacity-40"
          >
            {busyHost === "history" ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Globe aria-hidden className="size-3.5" />
            )}
            Wipe history
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter sites…"
          aria-label="Filter sites"
          className="veil-focus-bloom h-10 w-full rounded-xl border border-zinc-800 bg-zinc-900/70 pl-4 pr-4 text-[13.5px] text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-emerald-500/50 focus:ring-2 focus:ring-emerald-500/20"
        />
      </div>

      {/* Sites list */}
      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-10 text-zinc-400">
          <Loader2 aria-hidden className="size-4 animate-spin text-emerald-400" />
          <span className="text-[13px]">Reading the site store…</span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-10">
          <p className="text-[13px] text-rose-300/90">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            className="veil-press h-8 rounded-xl border-zinc-700 bg-zinc-900 px-3 text-[12.5px] text-zinc-300 hover:border-emerald-500/50 hover:bg-zinc-800 hover:text-emerald-300"
          >
            <RotateCw aria-hidden className="size-3.5" />
            Try again
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-10 text-center text-[13px] text-zinc-500">
          {query ? "No sites match that filter." : "No sites visited through the veil yet."}
        </div>
      ) : (
        <ul className="veil-scroll-slim max-h-[46vh] divide-y divide-zinc-800/60 overflow-y-auto rounded-2xl border border-zinc-800/80 bg-zinc-900/40">
          {filtered.map((s) => (
            <li
              key={s.host}
              className="veil-hover-glow flex items-center gap-3 px-4 py-3 transition hover:bg-zinc-900/70"
            >
              <Globe aria-hidden className="size-4 shrink-0 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-medium text-zinc-100">{s.host}</p>
                <p className="text-[11.5px] text-zinc-500">
                  {s.visits.toLocaleString()} visit{s.visits === 1 ? "" : "s"} · last {timeAgo(s.lastAt)}
                  {s.cookies > 0 && (
                    <span className="text-amber-300/80"> · {s.cookies} cookie{s.cookies === 1 ? "" : "s"}</span>
                  )}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={busyHost === s.host}
                aria-label={`Wipe ${s.host} — cookies and history`}
                onClick={() => wipeHost(s.host)}
                className="veil-press h-8 shrink-0 rounded-xl px-3 text-[12.5px] text-zinc-400 transition hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-40"
              >
                {busyHost === s.host ? (
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 aria-hidden className="size-3.5" />
                )}
                Wipe
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Appearance tab                                                       */
/* ------------------------------------------------------------------ */

function AppearanceTab() {
  const [clock24, setClock24] = React.useState(false);
  const [unit, setUnit] = React.useState<"C" | "F">("C");
  const [engine, setEngine] = React.useState("bing");
  const [proxyEngine, setProxyEngineState] = React.useState<ProxyEngineId>(DEFAULT_PROXY_ENGINE);
  const [hoverPreviews, setHoverPreviews] = React.useState(true);
  const [dim, setDim] = React.useState<"0" | "25" | "55">("0");
  const [moreAnim, setMoreAnim] = React.useState(true);
  const [name, setName] = React.useState("");

  React.useEffect(() => {
    try {
      setClock24(window.localStorage.getItem("veil:clock-24h") === "1");
      const u = window.localStorage.getItem("veil:temp-unit");
      if (u === "F" || u === "C") setUnit(u);
      setEngine(searchEngineId());
      setProxyEngineState(proxyEngineId());
      setHoverPreviews(window.localStorage.getItem("veil:hover-previews") !== "0");
      const d = window.localStorage.getItem("veil:backdrop-dim");
      setDim(d === "25" || d === "55" ? d : "0");
      setMoreAnim(window.localStorage.getItem("veil:more-animations") !== "0");
      setName((window.localStorage.getItem("veil:greeting-name") ?? "").slice(0, 24));
    } catch {
      /* private mode — defaults */
    }
  }, []);

  const save = React.useCallback((fn: () => void) => {
    fn();
    window.dispatchEvent(new CustomEvent("veil:settings-changed"));
  }, []);

  return (
    <div className="space-y-3">
      <SwitchRow
        icon={Timer}
        label="Clock format"
        hint="The start-page clock — 12-hour or 24-hour time."
        value={clock24 ? "24" : "12"}
        options={[
          { id: "12", label: "12h" },
          { id: "24", label: "24h" },
        ]}
        onChange={(id) =>
          save(() => {
            setClock24(id === "24");
            try {
              window.localStorage.setItem("veil:clock-24h", id === "24" ? "1" : "0");
            } catch {
              /* ignore */
            }
          })
        }
      />
      <SwitchRow
        icon={Thermometer}
        label="Weather units"
        hint="The start-page weather chip — Celsius or Fahrenheit."
        value={unit}
        options={[
          { id: "C", label: "°C" },
          { id: "F", label: "°F" },
        ]}
        onChange={(id) =>
          save(() => {
            setUnit(id as "C" | "F");
            try {
              window.localStorage.setItem("veil:temp-unit", id);
            } catch {
              /* ignore */
            }
          })
        }
      />
      <SwitchRow
        icon={Search}
        label="Search engine"
        hint="What the command bar queries when input isn't a URL. Bing renders server-side; the others may show their JS shells through the veil."
        value={engine}
        options={Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label }))}
        onChange={(id) =>
          save(() => {
            if (!(id in SEARCH_ENGINES)) return;
            setEngine(id);
            try {
              window.localStorage.setItem("veil:search-engine", id);
            } catch {
              /* ignore */
            }
          })
        }
      />
      <SwitchRow
        icon={Globe}
        label="Proxy engine"
        hint="Which machinery loads remote pages in the browser. Quasar 2.1.0 (the default) rewrites server-side with runtime hooks, a service-worker safety net, WebSocket bridging, multi-account containers (right-click a tab), per-tab egress/UA, find-in-page (Ctrl+F) and a server-side static cache; Veil is the classic built-in lane. Every site — youtube.com included — loads through the engine you pick; video searches still land on the local library."
        value={proxyEngine}
        options={Object.entries(PROXY_ENGINES).map(([id, e]) => ({ id, label: e.label }))}
        onChange={(id) =>
          save(() => {
            if (!(id in PROXY_ENGINES)) return;
            const next = id as ProxyEngineId;
            setProxyEngineState(next);
            setProxyEngineId(next);
            /* live tabs pick the new lane up on their next load — nudge them */
            window.dispatchEvent(new CustomEvent("veil:proxy-engine"));
          })
        }
      />
      <SwitchRow
        icon={MonitorPlay}
        label="Hover previews"
        hint="Resting on a live wallpaper card streams a quiet 1080p preview. Off saves bandwidth and decoders."
        value={hoverPreviews ? "on" : "off"}
        options={[
          { id: "on", label: "On" },
          { id: "off", label: "Off" },
        ]}
        onChange={(id) =>
          save(() => {
            setHoverPreviews(id === "on");
            try {
              window.localStorage.setItem("veil:hover-previews", id === "on" ? "1" : "0");
            } catch {
              /* ignore */
            }
          })
        }
      />
      <SwitchRow
        icon={Moon}
        label="Backdrop dim"
        hint="A dark scrim between the wallpaper and the page — easier reading on bright wallpapers."
        value={dim}
        options={[
          { id: "0", label: "Off" },
          { id: "25", label: "Subtle" },
          { id: "55", label: "Deep" },
        ]}
        onChange={(id) =>
          save(() => {
            setDim(id as "0" | "25" | "55");
            try {
              window.localStorage.setItem("veil:backdrop-dim", id);
            } catch {
              /* ignore */
            }
          })
        }
      />
      <SwitchRow
        icon={Sparkles}
        label="More animations"
        className="veil-border-dance"
        hint="Beautiful motion across the whole site — pages glide in behind a soft blur, a light-sweep follows every navigation, the start page rises and cascades, tabs spring, buttons breathe. Off is calmer and leaner."
        value={moreAnim ? "on" : "off"}
        options={[
          { id: "on", label: "On" },
          { id: "off", label: "Off" },
        ]}
        onChange={(id) =>
          save(() => {
            setMoreAnim(id === "on");
            try {
              window.localStorage.setItem("veil:more-animations", id === "on" ? "1" : "0");
            } catch {
              /* ignore */
            }
            /* Flip the mega-tier CSS attribute immediately — the event
             * below also re-syncs every mounted hook, but this guarantees
             * the html[data-veil-fancy] toggle even with nothing mounted. */
            syncFancyDomAttr();
          })
        }
      />
      <TextRow
        icon={UserRound}
        label="Greeting name"
        hint="The weather chip's greeting learns your name — “Good evening, Sam”."
        value={name}
        placeholder="Your name (optional)"
        onChange={(v) =>
          save(() => {
            setName(v);
            try {
              if (v.trim()) window.localStorage.setItem("veil:greeting-name", v.trim());
              else window.localStorage.removeItem("veil:greeting-name");
            } catch {
              /* ignore */
            }
          })
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Session sync card — the "different place" fix's cross-device side  */
/* ------------------------------------------------------------------ */

function SessionSyncCard() {
  const [veilKey, setVeilKey] = React.useState("");
  const [copied, setCopied] = React.useState<"" | "key" | "link">("");
  const [pullValue, setPullValue] = React.useState("");
  const [pulling, setPulling] = React.useState(false);
  const [pullErr, setPullErr] = React.useState("");

  React.useEffect(() => {
    let dead = false;
    fetch("/api/veil-session", { cache: "no-store", headers: viewerHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { viewer?: string } | null) => {
        if (!dead && typeof d?.viewer === "string") setVeilKey(d.viewer);
      })
      .catch(() => {
        /* card still renders — just without the key */
      });
    return () => {
      dead = true;
    };
  }, []);

  const copy = async (what: "key" | "link") => {
    const text =
      what === "key"
        ? veilKey
        : `${typeof window !== "undefined" ? window.location.origin : ""}/?vv=${encodeURIComponent(veilKey)}`;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      /* clipboard blocked — the key is selectable text as a fallback */
    }
  };

  const pull = async () => {
    const key = pullValue.trim();
    if (!key || pulling) return;
    setPulling(true);
    setPullErr("");
    try {
      const res = await fetch(`/api/veil-session?key=${encodeURIComponent(key)}`, {
        cache: "no-store",
        headers: viewerHeaders(),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        state?: { section?: string | null; tabs?: unknown; keep?: boolean } | null;
      } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error || "key not found");
      // Guard flag: the boot's pagehide session-flush must NOT fire during
      // this navigation — it would re-mirror the OLD page's state (this
      // overlay open, old tabs) over the session we're about to adopt.
      // Cleared by the boot on the other side.
      try {
        sessionStorage.setItem("veil:pulling", "1");
      } catch {
        /* private mode — best effort */
      }
      // Adopt the other place's viewer identity — history, notes and the
      // session mirror all follow — then stage the session locally so the
      // boot restore picks it up, and navigate into it.
      try {
        window.localStorage.setItem("veil.viewer", key);
        if (data.state?.tabs) {
          window.localStorage.setItem("veil:tabs:v1", JSON.stringify(data.state.tabs));
        } else {
          window.localStorage.removeItem("veil:tabs:v1");
        }
        if (typeof data.state?.section === "string") {
          window.localStorage.setItem("veil:section", data.state.section);
        } else {
          window.localStorage.removeItem("veil:section");
        }
        if (data.state?.keep === false) {
          // Adopt the other place's privacy choice — written through the
          // v2 helper so the value is actually honored (a bare "0" without
          // the marker gets healed away as stale legacy).
          writeKeepSession(false);
        } else {
          try {
            window.localStorage.removeItem("veil:keep-session");
          } catch {
            /* best effort */
          }
        }
      } catch {
        /* private mode — the ?vv= identity adoption below still works */
      }
      window.location.replace(`/?vv=${encodeURIComponent(key)}`);
    } catch (e) {
      setPullErr(e instanceof Error ? e.message : "couldn't reach the session store");
      setPulling(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/25">
          <Globe aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-zinc-100">Carry your veil between places</p>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
            Your open apps and tabs are mirrored on the server for this browser — open Veil
            anywhere with the same key and you land right back where you left off, never the home
            screen. On a new device: paste the key (or open the link) below once.
          </p>
        </div>
        <span className="veil-text-breathe shrink-0 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/25">
          Always on
        </span>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2">
          <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-400/80">
            Veil Key
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-zinc-200 select-all"
            title={veilKey || "resolving…"}
          >
            {veilKey || "…"}
          </span>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy("key")}
            disabled={!veilKey}
            className="h-9 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12px] text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-200"
          >
            {copied === "key" ? (
              <Check aria-hidden className="size-3.5 text-emerald-400" />
            ) : (
              <Copy aria-hidden className="size-3.5" />
            )}
            {copied === "key" ? "Copied" : "Copy key"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy("link")}
            disabled={!veilKey}
            className="h-9 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12px] text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-200"
          >
            {copied === "link" ? (
              <Check aria-hidden className="size-3.5 text-emerald-400" />
            ) : (
              <Copy aria-hidden className="size-3.5" />
            )}
            {copied === "link" ? "Copied" : "Copy link"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-2.5 sm:flex-row sm:items-center">
        <Input
          value={pullValue}
          onChange={(e) => {
            setPullValue(e.target.value);
            setPullErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void pull();
            }
          }}
          placeholder="Paste a Veil Key from another device…"
          aria-label="Pull a session from another device with its Veil Key"
          spellCheck={false}
          className="h-9 flex-1 rounded-lg border-zinc-800 bg-zinc-950/70 font-mono text-[12.5px] text-zinc-200 placeholder:font-sans placeholder:text-zinc-600 focus-visible:ring-emerald-500/30"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => void pull()}
          disabled={!pullValue.trim() || pulling}
          className="h-9 shrink-0 gap-1.5 rounded-lg bg-emerald-500 px-3.5 text-[12px] font-semibold text-emerald-950 hover:bg-emerald-400"
        >
          {pulling ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <RotateCw aria-hidden className="size-3.5" />
          )}
          {pulling ? "Pulling…" : "Pull session"}
        </Button>
      </div>
      {pullErr && (
        <p className="text-[11.5px] text-amber-400" role="alert">
          {pullErr}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Browsing tab                                                         */
/* ------------------------------------------------------------------ */

function BrowsingTab() {
  const [keepSession, setKeepSession] = React.useState(true);

  React.useEffect(() => {
    try {
      // Default is KEEP — switching away and returning must never dump the
      // user on the start page (owner request 2026-10-13). Only an explicit
      // post-v2 "Start page" choice (writeKeepSession stamps the marker)
      // opts back into the reset; a pre-v2 leftover "0" is healed away.
      setKeepSession(readKeepSession());
    } catch {
      /* private mode — defaults */
    }
  }, []);

  const save = React.useCallback((fn: () => void) => {
    fn();
    window.dispatchEvent(new CustomEvent("veil:settings-changed"));
  }, []);

  return (
    <div className="space-y-3">
      <SwitchRow
        icon={AppWindow}
        label="When I come back"
        hint="Opening another browser tab (or switching away) and returning — Veil can reset to the start page or keep the page you were on. Read live: the very next switch obeys this."
        value={keepSession ? "keep" : "reset"}
        options={[
          { id: "reset", label: "Start page" },
          { id: "keep", label: "Keep my page" },
        ]}
        onChange={(id) =>
          save(() => {
            setKeepSession(id === "keep");
            // writeKeepSession stamps the v2 marker — from now on this
            // EXPLICIT choice is honored by the visibility sweep (page.tsx).
            writeKeepSession(id === "keep");
          })
        }
      />

      {/* Restart behavior — same-tab reloads put you back where you were
          (server restarts, F5); a NEW tab still opens on the start page. */}
      <div className="flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
            <RotateCw aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-zinc-100">Restart behavior</p>
            <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
              A reload in this tab (server restart or refresh) brings you right back to the page or section you were
              on — chat stays logged in. Opening the veil in a new tab later still starts fresh on the start page.
            </p>
          </div>
        </div>
        <span className="veil-text-breathe shrink-0 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/25">
          Same-tab restore
        </span>
      </div>

      {/* Cross-place session sync — server mirror + Veil Key */}
      <SessionSyncCard />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Security tab — the quick-exit kit (panic key + about:blank cloak)   */
/* ------------------------------------------------------------------ */

/** Pretty-print a stored combo: "ctrl+shift+y" → "Ctrl Shift Y". */
function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

/** A key-combo recorder row: click "record", press any combo with a real
 *  key in it, done. Escape cancels. Saves through `onCommit`. */
function KeyCaptureRow({
  icon: Icon,
  label,
  hint,
  value,
  onCommit,
  accent = "emerald",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  value: string;
  onCommit: (combo: string) => string | null;
  accent?: "emerald" | "amber";
}) {
  const [recording, setRecording] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const key = (e.key || "").toLowerCase();
      if (["control", "shift", "alt", "meta"].includes(key)) return; // wait for a real key
      if (key === "escape") {
        setRecording(false);
        setErr(null);
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("ctrl");
      if (e.metaKey) mods.push("meta");
      if (e.altKey) mods.push("alt");
      if (e.shiftKey) mods.push("shift");
      const combo = [...mods, key].join("+");
      const problem = onCommit(combo);
      if (problem) {
        setErr(problem);
        return; // keep recording — they get another try
      }
      setErr(null);
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onCommit]);

  return (
    <div className="veil-hover-lift flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-xl ring-1",
            accent === "amber"
              ? "bg-amber-500/10 text-amber-300 ring-amber-500/25"
              : "bg-zinc-800/80 text-zinc-300 ring-transparent"
          )}
        >
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-zinc-100">{label}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">{hint}</p>
          {err && <p className="mt-1 text-[12px] text-rose-300">{err}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          setErr(null);
          setRecording((r) => !r);
        }}
        aria-label={`Change the ${label} shortcut`}
        className={cn(
          "veil-press flex h-9 shrink-0 items-center gap-2 rounded-xl border px-3.5 font-mono text-[12.5px] font-semibold transition",
          recording
            ? "animate-pulse border-rose-500/50 bg-rose-500/10 text-rose-300"
            : accent === "amber"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:border-amber-400/60 hover:bg-amber-500/20"
              : "border-zinc-700 bg-zinc-950/70 text-zinc-200 hover:border-emerald-500/50 hover:bg-zinc-800"
        )}
      >
        {recording ? "press any combo… (esc cancels)" : <kbd>{comboLabel(value)}</kbd>}
      </button>
    </div>
  );
}

function SecurityTab() {
  const [cfg, setCfg] = React.useState(() => ({
    panicEnabled: true,
    panicKey: "ctrl+y",
    panicUrl: "https://www.google.com",
    cloakKey: "alt+b",
    cloakTitle: "Home",
  }));
  const [flash, setFlash] = React.useState<string | null>(null);
  const [urlDraft, setUrlDraft] = React.useState("");
  const [tabCloakId, setTabCloakId] = React.useState("off");

  React.useEffect(() => {
    const c = readPanicConfig();
    setCfg(c);
    setUrlDraft(c.panicUrl);
    setTabCloakId(readTabCloakId());
  }, []);

  const persist = React.useCallback((fn: () => void) => {
    fn();
    window.dispatchEvent(new CustomEvent("veil:settings-changed"));
  }, []);

  const ping = React.useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 2800);
  }, []);

  /* Tab disguise: persist the pick, apply it immediately to THIS tab
   * (title + favicon swap live — no reload), and confirm. */
  const pickCloak = React.useCallback(
    (id: string) => {
      writeTabCloakId(id);
      setTabCloakId(id);
      applyTabCloak();
      const p = CLOAK_PRESETS.find((x) => x.id === id);
      ping(
        id === "off"
          ? "Disguise off — the tab is Veil again."
          : `Disguised as ${p ? p.name : id} — look at your tab.`
      );
    },
    [ping]
  );

  const commitPanicKey = React.useCallback(
    (combo: string): string | null => {
      if (combo === cfg.cloakKey) return "That's the cloak shortcut — pick a different combo.";
      persist(() => {
        try {
          window.localStorage.setItem("veil:panic-key", combo);
        } catch {
          /* private mode */
        }
      });
      setCfg((c) => ({ ...c, panicKey: combo }));
      return null;
    },
    [cfg.cloakKey, persist]
  );

  const commitCloakKey = React.useCallback(
    (combo: string): string | null => {
      if (combo === cfg.panicKey) return "That's the panic key — pick a different combo.";
      persist(() => {
        try {
          window.localStorage.setItem("veil:cloak-key", combo);
        } catch {
          /* private mode */
        }
      });
      setCfg((c) => ({ ...c, cloakKey: combo }));
      return null;
    },
    [cfg.panicKey, persist]
  );

  return (
    <div className="space-y-3">
      <AnimatePresence>
        {flash && (
          <motion.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-[12.5px] text-emerald-300"
            role="status"
          >
            {flash}
          </motion.p>
        )}
      </AnimatePresence>

      {/* ── the panic key ── */}
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25">
            <Siren aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-zinc-100">Panic key</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
              One combo and the veil is gone — the page is replaced instantly (no Back trail, the
              tab&apos;s history entry is erased) with the site below. Works while typing, in every
              section, even inside a veiled page or a running game.
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <SwitchRow
            icon={Siren}
            label="Panic key enabled"
            hint="Off means the combo does nothing — the safety is disarmed."
            value={cfg.panicEnabled ? "on" : "off"}
            options={[
              { id: "on", label: "Armed" },
              { id: "off", label: "Off" },
            ]}
            onChange={(id) =>
              persist(() => {
                const on = id === "on";
                setCfg((c) => ({ ...c, panicEnabled: on }));
                try {
                  window.localStorage.setItem("veil:panic-enabled", on ? "1" : "0");
                } catch {
                  /* private mode */
                }
              })
            }
          />
          <KeyCaptureRow
            icon={VenetianMask}
            label="Panic shortcut"
            hint="Ctrl+Y by default — click the combo to re-record it. Any combo with a real key works; Escape never will."
            value={cfg.panicKey}
            onCommit={commitPanicKey}
            accent="amber"
          />
          <div className="veil-hover-glow flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
                <Globe aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-zinc-100">Where it goes</p>
                <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
                  The site the panic key opens — something that looks like homework.
                </p>
              </div>
            </div>
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value.slice(0, 300))}
              onBlur={() => {
                const url = sanitizeUrl(urlDraft);
                setUrlDraft(url);
                persist(() => {
                  setCfg((c) => ({ ...c, panicUrl: url }));
                  try {
                    window.localStorage.setItem("veil:panic-url", url);
                  } catch {
                    /* private mode */
                  }
                });
                if (url !== cfg.panicUrl) ping("Panic target saved.");
              }}
              placeholder="https://www.google.com"
              aria-label="Panic target URL"
              spellCheck={false}
              inputMode="url"
              className="veil-focus-bloom h-9 w-full rounded-xl border-zinc-800 bg-zinc-950/70 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus-visible:border-rose-500/50 focus-visible:ring-rose-500/20 sm:w-64"
            />
          </div>
        </div>
      </div>

      {/* ── the about:blank cloak ── */}
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">
            <EyeOff aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-zinc-100">About:blank cloak</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
              Opens the whole veil inside a new window whose address bar just reads{" "}
              <span className="font-mono text-zinc-300">about:blank</span> — history and the URL bar
              never learn the veil&apos;s address. The panic key works inside the cloak too.
            </p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <KeyCaptureRow
            icon={EyeOff}
            label="Cloak shortcut"
            hint="Alt+B by default — presses it anywhere to pop the veil into an about:blank window."
            value={cfg.cloakKey}
            onCommit={commitCloakKey}
          />
          <div className="veil-hover-glow flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
                <Timer aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-zinc-100">Cloak tab title</p>
                <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
                  What the cloaked window calls itself — keep it boring.
                </p>
              </div>
            </div>
            <Input
              value={cfg.cloakTitle}
              onChange={(e) => {
                const v = e.target.value.slice(0, 60);
                setCfg((c) => ({ ...c, cloakTitle: v }));
                persist(() => {
                  try {
                    window.localStorage.setItem("veil:cloak-title", v || "Home");
                  } catch {
                    /* private mode */
                  }
                });
              }}
              placeholder="Home"
              aria-label="Cloak tab title"
              spellCheck={false}
              className="veil-focus-bloom h-9 w-full rounded-xl border-zinc-800 bg-zinc-950/70 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/50 focus-visible:ring-emerald-500/20 sm:w-48"
            />
          </div>
          <div className="veil-hover-lift flex flex-col gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
                <AppWindow aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-zinc-100">Open in about:blank now</p>
                <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
                  Launch the cloaked window from here — or use the shortcut above, any time, in any
                  section. (If nothing happens, allow popups for this site.)
                </p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => {
                const ok = openVeilInAboutBlank();
                ping(ok ? "Cloaked — the veil is running in an about:blank window." : "The popup was blocked — allow popups for this site.");
              }}
              className="veil-hover-glow veil-press h-9 shrink-0 rounded-xl bg-emerald-500/90 px-4 text-[13px] font-semibold text-emerald-950 hover:bg-emerald-400"
            >
              <EyeOff aria-hidden className="size-3.5" />
              Cloak it
            </Button>
          </div>
        </div>
      </div>

      {/* ---- Tab disguise (title + favicon presets) ---------------------- */}
      <div className="rounded-3xl border border-zinc-800/80 bg-zinc-950/60 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">
            <VenetianMask aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-zinc-100">Tab disguise</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
              One tap dresses THIS tab up as school work — the title and the favicon switch
              instantly (no reload), and the about:blank cloak wears the same disguise. All
              icons are drawn locally; nothing is fetched.
            </p>
          </div>
        </div>
        <div
          className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="radiogroup"
          aria-label="Tab disguise preset"
        >
          <CloakPresetCard
            id="off"
            name="Veil"
            blurb="no disguise"
            icon="/icon.svg"
            title={"Veil — Full-Screen Web Viewer"}
            active={tabCloakId === "off"}
            onPick={() => pickCloak("off")}
          />
          {CLOAK_PRESETS.map((p) => (
            <CloakPresetCard
              key={p.id}
              id={p.id}
              name={p.name}
              blurb={p.blurb}
              icon={p.icon}
              title={p.title}
              active={tabCloakId === p.id}
              onPick={() => pickCloak(p.id)}
            />
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-zinc-600">
          The Blank preset (and the about:blank cloak) uses the “Cloak tab title” above. Disguise
          is per-browser — it lives in this device’s storage only.
        </p>
      </div>
    </div>
  );
}

/* A single tab-disguise preset tile: mini favicon preview, name, one-line
 * blurb, active ring. Radiogroup semantics via role/aria-checked. */
function CloakPresetCard(props: {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  title: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.active}
      onClick={props.onPick}
      title={props.title}
      className={cn(
        "veil-hover-lift veil-press group flex flex-col items-start gap-2 rounded-2xl border p-3 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
        props.active
          ? "border-emerald-500/60 bg-emerald-500/10"
          : "border-zinc-800/80 bg-zinc-900/50 hover:border-zinc-700 hover:bg-zinc-900"
      )}
    >
      <span className="flex w-full items-center justify-between">
        <img
          src={props.icon}
          alt=""
          width={20}
          height={20}
          className={cn(
            "size-5 shrink-0 rounded",
            props.id === "blank" && "opacity-0"
          )}
          aria-hidden
        />
        {props.active && <Check aria-hidden className="size-3.5 text-emerald-400" />}
      </span>
      <span className="text-[13px] font-medium text-zinc-100">{props.name}</span>
      <span className="text-[11px] leading-snug text-zinc-500">{props.blurb}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Chat account Takeout (Settings → Data)                               */
/* ------------------------------------------------------------------ */

type ChatSummary = {
  username: string;
  displayName: string;
  role: string;
  coins: number;
  messages: number;
  friends: number;
  dms: number;
  joinedAt: string;
  hasAvatar: boolean;
};

/** Resolve the chat session exactly the way chat-app does: the
 * "veil:chat-account" localStorage entry first, then the
 * veil_chat_session cookie mirror (survives partitioned storage). */
function loadChatSession(): { token: string } | null {
  const read = (raw: string | null | undefined) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === "string" && parsed.token) {
        return parsed as { token: string };
      }
    } catch {
      /* ignore */
    }
    return null;
  };
  try {
    const s = read(window.localStorage.getItem("veil:chat-account"));
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    const m = document.cookie
      .split("; ")
      .find((c) => c.startsWith("veil_chat_session="));
    if (m) {
      const s = read(decodeURIComponent(m.slice("veil_chat_session=".length)));
      if (s) return s;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function monthYear(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString([], { month: "short", year: "numeric" });
}

function ChatDataCard({ ping }: { ping: (msg: string, bad?: boolean) => void }) {
  const [summary, setSummary] = React.useState<ChatSummary | null>(null);
  const [state, setState] = React.useState<"loading" | "signed-out" | "ready" | "error">(
    "loading",
  );
  const [busy, setBusy] = React.useState<"export" | "import" | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const refresh = React.useCallback(async () => {
    const session = loadChatSession();
    if (!session) {
      setState("signed-out");
      return;
    }
    try {
      const res = await fetch(
        `/api/chat-takeout?summary=1&token=${encodeURIComponent(session.token)}`,
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        summary?: ChatSummary;
      };
      if (!res.ok || data.ok === false || !data.summary) {
        setState(res.status === 401 ? "signed-out" : "error");
        return;
      }
      setSummary(data.summary);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const doExport = async () => {
    const session = loadChatSession();
    if (!session) {
      ping("Sign into Chat first — then your profile can be exported.", true);
      return;
    }
    setBusy("export");
    try {
      const res = await fetch(
        `/api/chat-takeout?token=${encodeURIComponent(session.token)}`,
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        takeout?: {
          account: { username: string };
          stats: { messages: number; friends: number };
        };
      };
      if (!res.ok || data.ok === false || !data.takeout) {
        throw new Error(data.error || "The export didn't complete.");
      }
      const stamp = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const fname = `veil-chat-data-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.json`;
      const blob = new Blob([JSON.stringify(data.takeout, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      ping(
        `Exported @${data.takeout.account.username} — ${data.takeout.stats.messages} messages · ${data.takeout.stats.friends} friend${data.takeout.stats.friends === 1 ? "" : "s"} → ${fname}`,
      );
    } catch (e) {
      ping(e instanceof Error ? e.message : "The export didn't complete.", true);
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (file: File) => {
    const session = loadChatSession();
    if (!session) {
      ping("Sign into Chat first — the restore lands on your account.", true);
      return;
    }
    setBusy("import");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      // Accept the takeout bundle, a bare account object, or a top-level
      // profile — anything with the fields we know how to restore.
      const t = parsed.takeout as Record<string, unknown> | undefined;
      const acct = (t?.account ?? parsed.account ?? parsed) as Record<string, unknown>;
      if (!acct || typeof acct !== "object") {
        throw new Error("No chat profile found in that file.");
      }
      const profile: Record<string, string> = {};
      if (typeof acct.displayName === "string") profile.displayName = acct.displayName;
      if (typeof acct.bio === "string") profile.bio = acct.bio;
      if (typeof acct.avatarColor === "string") profile.avatarColor = acct.avatarColor;
      if (typeof acct.avatarImage === "string" && acct.avatarImage) {
        profile.avatarImage = acct.avatarImage;
      }
      if (Object.keys(profile).length === 0) {
        throw new Error("No importable profile fields in that file.");
      }
      const res = await fetch("/api/chat-takeout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token, profile }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        account?: { username: string };
        imported?: string[];
      };
      if (!res.ok || data.ok === false || !data.account) {
        throw new Error(data.error || "The import didn't complete.");
      }
      // Keep the stored session snapshot in sync + let the open chat app
      // adopt the fresh account immediately.
      try {
        const raw = window.localStorage.getItem("veil:chat-account");
        if (raw) {
          const stored = JSON.parse(raw) as { account?: unknown; token?: string };
          window.localStorage.setItem(
            "veil:chat-account",
            JSON.stringify({ ...stored, account: data.account }),
          );
        }
      } catch {
        /* ignore */
      }
      window.dispatchEvent(
        new CustomEvent("veil:chat-account-updated", { detail: data.account }),
      );
      void refresh();
      ping(
        `Restored onto @${data.account.username}: ${(data.imported || []).join(" · ")}. Coins and purchases stay server-side.`,
      );
    } catch (e) {
      ping(
        e instanceof Error ? e.message : "The import didn't complete.",
        true,
      );
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (state === "signed-out") {
    return (
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-500">
            <MessageCircle aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-medium text-zinc-400">Your Chat account</h3>
            <p className="mt-0.5 text-[12px] leading-snug text-zinc-600">
              Sign into Chat first — then your profile, picture and message archive
              can be exported (and restored) from here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
          <MessageCircle aria-hidden className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium text-zinc-100">
            Your Chat account{" "}
            {summary ? (
              <span className="font-normal text-zinc-500">
                @{summary.username}
              </span>
            ) : null}
          </h3>
          <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
            Your chat profile, picture and bio live on the Veil server. Export a
            portable JSON backup (profile + your last 1,000 messages + friends),
            or restore a saved look onto this account.
          </p>
        </div>
      </div>

      {/* What the server is holding right now */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            { label: "Messages", value: summary ? String(summary.messages) : undefined },
            { label: "Friends", value: summary ? String(summary.friends) : undefined },
            { label: "Coins", value: summary ? String(summary.coins) : undefined },
            { label: "Member since", value: summary ? monthYear(summary.joinedAt) : undefined },
          ] as const
        ).map((s) => (
          <div
            key={s.label}
            className="veil-hover-glow rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 text-center"
          >
            <p className="text-[10px] uppercase tracking-wider text-zinc-500">{s.label}</p>
            <p className="mt-0.5 text-[15px] font-semibold text-zinc-100">
              {s.value === undefined ? "…" : s.value}
            </p>
          </div>
        ))}
      </div>

      {state === "error" ? (
        <p className="mt-3 text-[11.5px] text-rose-400">
          Couldn't reach the chat server — the numbers above may be stale.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void doExport()}
          disabled={busy !== null}
          className="veil-hover-glow veil-press gap-1.5 rounded-xl bg-emerald-500/90 text-black hover:bg-emerald-400"
        >
          {busy === "export" ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <Download aria-hidden className="size-3.5" />
          )}
          Export chat data
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="veil-hover-glow veil-press gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        >
          {busy === "import" ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <Upload aria-hidden className="size-3.5" />
          )}
          Restore profile
        </Button>
        <span className="text-[11px] text-zinc-600">
          coins, purchased tags &amp; accessories stay server-side — they can never
          be imported
        </span>
      </div>

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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Data tab                                                             */
/* ------------------------------------------------------------------ */

function DataTab() {
  const [flash, setFlash] = React.useState<string | null>(null);
  const [flashBad, setFlashBad] = React.useState(false);
  const [busy, setBusy] = React.useState<"export" | "import" | null>(null);
  const [stats, setStats] = React.useState<VeilBackupStats | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const ping = (msg: string, bad = false) => {
    setFlashBad(bad);
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4200);
  };

  // Refresh the backup stats whenever the Data tab mounts or any Veil
  // data family changes underneath us (right after an import, a wallpaper
  // pick, a subscription…).
  React.useEffect(() => {
    const refresh = () => setStats(veilBackupStats());
    refresh();
    const events = [
      "veil-stream-history",
      "veil-stream-subs",
      "veil-stream-playlists",
      "veil-stream-ratings",
      "veil-stream-prefs",
      "veil-stream-notinterested",
      "veil:wallpaper-changed",
      "veil:wallpaper-favs-changed",
      "veil:wallpaper-library-changed",
      "veil:settings-changed",
      "veil:layout-changed",
    ];
    events.forEach((e) => window.addEventListener(e, refresh));
    return () => events.forEach((e) => window.removeEventListener(e, refresh));
  }, []);

  const doExport = async () => {
    setBusy("export");
    try {
      /* prime the IndexedDB history mirror first — the backup must
       * carry the FULL watch history, not whatever loaded so far */
      await historyReady();
      const backup = exportVeilBackup();
      const keys = Object.keys(backup.keys);
      if (keys.length === 0) {
        ping("Nothing to export yet — this browser has no Veil data at all.", true);
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
      const s = veilBackupStats();
      const bits: string[] = [];
      if (s.wallpaperSet || s.wallpaperFavs) bits.push("wallpaper");
      if (s.history) bits.push(`${s.history} history`);
      if (s.subs) bits.push(`${s.subs} subs`);
      if (s.playlists) bits.push(`${s.playlists} playlists`);
      if (s.prefs) bits.push(`${s.prefs} settings/prefs`);
      ping(`Exported ${keys.length} keys — ${bits.join(" · ") || "state"} → ${fname}`);
    } catch (e) {
      ping(e instanceof Error ? e.message : "Export didn't complete.", true);
    } finally {
      setBusy(null);
    }
  };

  const doImport = async (file: File) => {
    setBusy("import");
    try {
      const text = await file.text();
      await historyReady();
      const s = importVeilBackup(text);
      setStats(veilBackupStats());
      const desc = describeRestore(s);
      if (!desc) {
        ping("That file parsed, but it carries no Veil data keys.", true);
      } else {
        ping(`Restored: ${desc} — reloading…`);
        // Give the toast a beat to be read, then reload so EVERY panel
        // (start page, links, arcade, tabs, AI chats) re-reads the
        // restored state — not just the event-wired ones.
        window.setTimeout(() => window.location.reload(), 1400);
      }
    } catch (e) {
      ping(e instanceof Error ? e.message : "The import didn't complete.", true);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <AnimatePresence>
        {flash && (
          <motion.p
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className={cn(
              "rounded-xl border px-4 py-2.5 text-[12.5px]",
              flashBad
                ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
            )}
            role="status"
          >
            {flash}
          </motion.p>
        )}
      </AnimatePresence>

      {/* Full device backup — Takeout-style export / import */}
      <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-zinc-800/80 text-zinc-300">
            <Database aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-medium text-zinc-100">Your Veil data — full backup</h3>
            <p className="mt-0.5 text-[12px] leading-snug text-zinc-500">
              Export everything Veil keeps on this device — wallpaper, watch history, subscriptions,
              playlists, likes, start-page layout &amp; links, arcade favourites and every setting —
              as one portable JSON. Merge it back on any device; nothing is ever deleted.
            </p>
          </div>
        </div>

        {/* What's stored right now */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              { label: "Wallpaper", value: stats ? (stats.wallpaperSet || stats.wallpaperFavs || stats.savedWallpapers ? `♥ ${stats.wallpaperFavs + stats.savedWallpapers}` : "—") : undefined },
              { label: "History", value: stats?.history },
              { label: "Subscriptions", value: stats?.subs },
              { label: "Playlists", value: stats?.playlists },
              { label: "Liked", value: stats?.liked },
              { label: "Settings", value: stats?.prefs },
            ] as const
          ).map((s) => (
            <div
              key={s.label}
              className="veil-hover-glow rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 text-center"
            >
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">{s.label}</p>
              <p className="mt-0.5 text-[15px] font-semibold text-zinc-100">
                {s.value === undefined ? "…" : s.value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={doExport} disabled={busy !== null} className="gap-1.5 rounded-xl bg-emerald-500/90 text-black hover:bg-emerald-400">
            {busy === "export" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Download aria-hidden className="size-3.5" />}
            Export data
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== null}
            className="veil-hover-glow veil-press gap-1.5 rounded-xl border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          >
            {busy === "import" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Upload aria-hidden className="size-3.5" />}
            Import data
          </Button>
          <span className="text-[11px] text-zinc-600">
            wallpaper · history · subs · settings — everything, on this device, moves with the file
          </span>
        </div>

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
      </div>

      <ChatDataCard ping={ping} />

      <DangerRow
        label="Wallpaper selection"
        hint="The currently applied background (keeps your saved pack)."
        confirmLabel="Confirm"
        onConfirm={() => {
          clearWallpaperSelection();
          ping("Wallpaper selection cleared — the default look is back.");
        }}
      />
      <DangerRow
        label="Saved wallpapers"
        hint="The live/4K wallpapers you ♥-saved into My pack."
        confirmLabel="Confirm"
        onConfirm={() => {
          clearLibrary();
          ping("Saved wallpapers cleared.");
        }}
      />
      <DangerRow
        label="All site data"
        hint="Every cookie, every history row, every local store — a fresh veil."
        confirmLabel="Confirm"
        onConfirm={() => {
          void fetch("/api/privacy", { method: "DELETE", headers: viewerHeaders() })
            .then(() => ping("Server site data wiped."))
            .catch(() => ping("Server wipe failed — try again."));
          try {
            window.localStorage.clear();
          } catch {
            /* ignore */
          }
          window.dispatchEvent(new CustomEvent("veil:wallpaper-changed"));
          ping("Everything wiped — reload the page for a clean slate.");
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section shell                                                        */
/* ------------------------------------------------------------------ */

export function SettingsSection({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = React.useState<Tab>("privacy");
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex h-full w-full flex-col text-zinc-100">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-800/80 px-4 pb-4 pt-5 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onBack}
            aria-label="Back to the start page"
            className="veil-hover-bounce h-9 gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 text-zinc-300 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <ArrowLeft aria-hidden className="size-4" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30">
              <Settings2 aria-hidden className="size-4.5 text-emerald-300" />
            </span>
            <div className="min-w-0">
              <h2 className="veil-text-shine truncate text-[17px] font-semibold tracking-tight">
                Settings<span className="text-emerald-400">.</span>
              </h2>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Settings sections"
          className="mx-auto mt-4 flex w-full max-w-3xl items-center gap-1 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-1"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={cn(
                  "veil-press flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition",
                  active
                    ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
                    : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Body */}
      <div className="veil-scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-6 sm:px-6">
        <motion.div
          key={tab}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="mx-auto w-full max-w-3xl"
        >
          {tab === "privacy" && <PrivacyTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "browsing" && <BrowsingTab />}
          {tab === "security" && <SecurityTab />}
          {tab === "data" && <DataTab />}
        </motion.div>
      </div>
    </div>
  );
}
