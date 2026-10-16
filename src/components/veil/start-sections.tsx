"use client";

/**
 * Veil — start-page overlay sections: Quick links and History.
 *
 * Full-viewport overlays above the start page (page.tsx renders these
 * inside a fixed inset-0 wrapper). Links = the curated launch-pad grid;
 * History = the full visit log with per-item delete + clear-all.
 */

import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock,
  Globe,
  History as HistoryIcon,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  QUICK_LINKS,
  faviconUrls,
  timeAgo,
  viewerHeaders,
  type HistoryResponse,
  type Visit,
} from "@/lib/veil/shared";

/* ------------------------------------------------------------------ */
/* Custom quick links (localStorage)                                   */
/* ------------------------------------------------------------------ */

const CUSTOM_LINKS_KEY = "veil:links:v1";
const CUSTOM_LINKS_MAX = 24;

interface CustomLink {
  name: string;
  url: string;
  host: string;
}

function loadCustomLinks(): CustomLink[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LINKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (l): l is CustomLink =>
          !!l &&
          typeof l === "object" &&
          typeof (l as CustomLink).name === "string" &&
          typeof (l as CustomLink).url === "string" &&
          typeof (l as CustomLink).host === "string"
      )
      .slice(0, CUSTOM_LINKS_MAX);
  } catch {
    return [];
  }
}

function saveCustomLinks(list: CustomLink[]): void {
  try {
    localStorage.setItem(CUSTOM_LINKS_KEY, JSON.stringify(list.slice(0, CUSTOM_LINKS_MAX)));
  } catch {
    /* storage unavailable — links stay in-memory for this session */
  }
}

/** Parse user input into a custom link, or return a reason it can't be one. */
function parseCustomLink(
  rawUrl: string,
  rawName: string
): { link: CustomLink } | { error: string } {
  const input = rawUrl.trim();
  if (!input) return { error: "Enter a site URL — e.g. example.com" };
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)
    ? input
    : `https://${input.replace(/^\/+/, "")}`;
  let host: string;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: "Only http(s) links are supported." };
    }
    host = u.hostname;
  } catch {
    return { error: "That doesn't look like a URL — try example.com" };
  }
  if (!host.includes(".")) {
    return { error: "That looks like a search, not a site — include a domain like example.com" };
  }
  const url = withScheme;
  const name = rawName.trim().slice(0, 40) || host.replace(/^www\./, "");
  return { link: { name, url, host } };
}

export function SectionShell({
  title,
  subtitle,
  icon,
  onBack,
  children,
  wide,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  onBack: () => void;
  children: React.ReactNode;
  /** true → the content column opens up to 1600px (the HTML Coder's
   *  side-by-side workshop needs the room; default stays max-w-4xl). */
  wide?: boolean;
}) {
  return (
    /* Root is intentionally transparent: the page-level overlay container
       carries the translucent scrim (bg-zinc-950/72 + blur) so the applied
       wallpaper keeps showing behind the section. */
    <div className="relative flex h-full w-full flex-col overflow-hidden text-zinc-100">
      {/* ambient orbs (clipped so they never extend scrollHeight) */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="veil-orb-a absolute -top-40 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="veil-orb-b absolute -bottom-32 right-[-6rem] h-80 w-80 rounded-full bg-teal-500/10 blur-3xl" />
      </div>

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
              {icon}
            </div>
            <div className="min-w-0">
              <h1 className="veil-text-shine truncate text-base font-semibold tracking-tight text-zinc-50 sm:text-lg">
                {title}
              </h1>
              <p className="truncate text-[12px] text-zinc-500">{subtitle}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="veil-scroll-slim relative z-10 min-h-0 flex-1 overflow-y-auto">
        {wide ? (
          /* Wide sections (HTML Coder) manage their own inner overflow —
             give them a definite full-height flex chain instead of the
             document-flow column. */
          <div className="mx-auto h-full w-full max-w-[1600px]">{children}</div>
        ) : (
          <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">{children}</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quick links                                                         */
/* ------------------------------------------------------------------ */

function FaviconImg({ host, name, className }: { host: string; name: string; className?: string }) {
  const urls = React.useMemo(() => faviconUrls(host), [host]);
  const [idx, setIdx] = React.useState(0);
  const failed = idx >= urls.length;
  if (failed) {
    return (
      <div
        aria-hidden
        className={`flex items-center justify-center rounded-xl bg-emerald-500/15 font-semibold text-emerald-300 ${className ?? "h-12 w-12"}`}
      >
        {name.replace(/^www\./, "").charAt(0).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={urls[idx]}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      onError={() => setIdx((i) => i + 1)}
      className={`rounded-xl bg-zinc-800 object-contain p-1 ${className ?? "h-12 w-12"}`}
    />
  );
}

export function LinksSection({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (url: string) => void;
}) {
  const [custom, setCustom] = React.useState<CustomLink[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState("");
  const urlRef = React.useRef<HTMLInputElement>(null);

  // Load persisted links once on mount (client-only value).
  React.useEffect(() => {
    setCustom(loadCustomLinks());
  }, []);

  React.useEffect(() => {
    if (adding) urlRef.current?.focus();
  }, [adding]);

  const addLink = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseCustomLink(url, name);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (custom.some((l) => l.url === parsed.link.url)) {
      setError("That link is already saved.");
      return;
    }
    if (custom.length >= CUSTOM_LINKS_MAX) {
      setError(`Saved links are capped at ${CUSTOM_LINKS_MAX} — remove one first.`);
      return;
    }
    const next = [...custom, parsed.link];
    setCustom(next);
    saveCustomLinks(next);
    setAdding(false);
    setName("");
    setUrl("");
    setError("");
  };

  const removeLink = (linkUrl: string) => {
    const next = custom.filter((l) => l.url !== linkUrl);
    setCustom(next);
    saveCustomLinks(next);
  };

  return (
    <SectionShell
      title="Quick links"
      subtitle="Sites that render beautifully through the veil"
      icon={<Globe className="size-5" aria-hidden />}
      onBack={onBack}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {QUICK_LINKS.map((s, i) => (
          <motion.button
            key={s.url}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.05 + i * 0.04 }}
            onClick={() => onNavigate(s.url)}
            aria-label={`Open ${s.name}`}
            className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border bg-zinc-900/50 p-4 text-left transition hover:-translate-y-0.5 hover:bg-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
              s.featured
                ? "border-emerald-500/25 hover:border-emerald-500/50"
                : "border-zinc-800/80 hover:border-emerald-500/40"
            }`}
          >
            {s.featured && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-emerald-400 via-teal-400/60 to-transparent opacity-70 transition group-hover:opacity-100"
              />
            )}
            <FaviconImg host={s.host} name={s.name} className="h-12 w-12 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[14.5px] font-semibold text-zinc-100">{s.name}</span>
                {s.tag && (
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-[1.5px] text-[9px] font-bold uppercase tracking-wide ${
                      s.featured
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        : "border-zinc-700 bg-zinc-800/50 text-zinc-400"
                    }`}
                  >
                    {s.tag}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[12px] text-zinc-500">{s.desc}</span>
              <span className="mt-1 block truncate text-[11px] text-zinc-600">{s.host}</span>
            </span>
            <ArrowRight aria-hidden className="size-4 shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-emerald-400" />
          </motion.button>
        ))}
      </div>

      {/* ----- your links (user-added, persisted) ----- */}
      <div className="mt-9">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          <Plus aria-hidden className="size-3.5 text-emerald-400" />
          Your links
          {custom.length > 0 && (
            <span className="font-normal normal-case tracking-normal text-zinc-600">
              {custom.length} saved
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {custom.map((l, i) => (
            <motion.div
              key={l.url}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.04 * i }}
              className="group relative flex items-center gap-4 rounded-2xl border border-emerald-500/20 bg-zinc-900/50 p-4 transition hover:-translate-y-0.5 hover:border-emerald-500/40 hover:bg-zinc-900"
            >
              <button
                type="button"
                onClick={() => onNavigate(l.url)}
                className="flex min-w-0 flex-1 items-center gap-4 text-left"
                aria-label={`Open ${l.name}`}
              >
                <FaviconImg host={l.host} name={l.name} className="h-12 w-12 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold text-zinc-100">{l.name}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-zinc-500">Your link</span>
                  <span className="mt-1 block truncate text-[11px] text-zinc-600">{l.host}</span>
                </span>
                <ArrowUpRight
                  aria-hidden
                  className="size-4 shrink-0 text-zinc-600 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100 group-hover:text-emerald-400"
                />
              </button>
              <button
                type="button"
                onClick={() => removeLink(l.url)}
                aria-label={`Remove ${l.name} from your links`}
                title="Remove this link"
                className="absolute right-2.5 top-2.5 flex size-7 shrink-0 items-center justify-center rounded-lg text-zinc-500 opacity-0 transition hover:bg-red-500/15 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </motion.div>
          ))}

          {/* add-link tile: dashed card → inline form */}
          {adding ? (
            <form
              onSubmit={addLink}
              className="flex flex-col gap-2.5 rounded-2xl border border-emerald-500/30 bg-zinc-900/70 p-4"
              aria-label="Add a custom link"
            >
              <Input
                ref={urlRef}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (error) setError("");
                }}
                placeholder="example.com"
                aria-label="Site URL"
                inputMode="url"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                className="h-10 rounded-xl border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25"
              />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (optional)"
                aria-label="Link name (optional)"
                maxLength={40}
                autoCapitalize="off"
                autoComplete="off"
                className="h-10 rounded-xl border-zinc-800 bg-zinc-950/70 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25"
              />
              {error && (
                <p role="alert" className="text-[12px] leading-snug text-amber-300/90">
                  {error}
                </p>
              )}
              <div className="mt-0.5 flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="h-9 gap-1.5 rounded-xl bg-emerald-500 px-4 text-[13px] font-semibold text-emerald-950 hover:bg-emerald-400"
                >
                  <Check aria-hidden className="size-3.5" />
                  Save link
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAdding(false);
                    setName("");
                    setUrl("");
                    setError("");
                  }}
                  className="h-9 rounded-xl px-3 text-[13px] text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200"
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex min-h-[104px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-zinc-700/80 bg-zinc-900/20 p-4 text-zinc-500 transition hover:border-emerald-500/50 hover:bg-emerald-500/5 hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
            >
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full border border-dashed border-zinc-600/80"
              >
                <Plus aria-hidden className="size-4" />
              </span>
              <span className="text-[13px] font-medium">Add your own link</span>
              <span className="text-[11.5px] text-zinc-600">Saved on this device</span>
            </button>
          )}
        </div>
      </div>

      <p className="mt-8 text-center text-[12px] text-zinc-600">
        Everything loads through Veil's server-side veil — nothing touches your browser directly.
      </p>
    </SectionShell>
  );
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export function HistorySection({
  onBack,
  onNavigate,
  history,
  onHistoryChanged,
}: {
  onBack: () => void;
  onNavigate: (url: string) => void;
  history: HistoryResponse | null;
  onHistoryChanged: () => void;
}) {
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const visits = React.useMemo(() => {
    const list = history?.visits ?? [];
    const query = q.trim().toLowerCase();
    if (!query) return list;
    return list.filter(
      (v) =>
        v.host.toLowerCase().includes(query) ||
        (v.title ?? "").toLowerCase().includes(query) ||
        v.url.toLowerCase().includes(query)
    );
  }, [history, q]);

  const removeVisit = async (id: string) => {
    try {
      await fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: viewerHeaders() });
      onHistoryChanged();
    } catch {
      /* non-fatal */
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await fetch("/api/history", { method: "DELETE", headers: viewerHeaders() });
      onHistoryChanged();
    } catch {
      /* non-fatal */
    } finally {
      setBusy(false);
    }
  };

  const stats = history?.stats;

  return (
    <SectionShell
      title="Browsing history"
      subtitle={
        stats
          ? `${stats.sites.toLocaleString()} sites · ${stats.pageVisits.toLocaleString()} page loads`
          : "Local to this Veil"
      }
      icon={<HistoryIcon className="size-5" aria-hidden />}
      onBack={onBack}
    >
      {/* controls */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Clock
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-500"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter history…"
            aria-label="Filter history"
            className="h-10 rounded-xl border-zinc-800 bg-zinc-900/70 pl-10 pr-4 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25"
          />
        </div>
        {visits.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={clearAll}
            disabled={busy}
            className="h-10 gap-2 rounded-xl border-red-500/30 bg-red-500/10 text-[13px] text-red-300 transition hover:border-red-500/50 hover:bg-red-500/20 disabled:opacity-50"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Clear all
          </Button>
        )}
      </div>

      {/* list */}
      {visits.length === 0 ? (
        <div className="flex h-56 flex-col items-center justify-center gap-2 text-zinc-500">
          <HistoryIcon aria-hidden className="size-8" />
          <p className="text-sm">
            {q ? "Nothing matches that filter." : "No history yet — go browse something."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {visits.map((v: Visit, i) => (
            <motion.li
              key={v.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i * 0.02, 0.3) }}
              className="group flex items-center gap-3 rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3 transition hover:border-emerald-500/40 hover:bg-zinc-900/70"
            >
              <button
                type="button"
                onClick={() => onNavigate(v.url)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label={`Revisit ${v.title || v.host}`}
              >
                <FaviconImg host={v.host} name={v.host} className="h-10 w-10 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-zinc-100">
                    {v.title || v.url.replace(/^https?:\/\//, "")}
                  </span>
                  <span className="block truncate text-[11.5px] text-zinc-500">
                    {v.host} · {timeAgo(v.updatedAt)}
                    {v.visitCount > 1 && (
                      <span className="text-emerald-500/80"> · {v.visitCount} visits</span>
                    )}
                  </span>
                </span>
                <ArrowUpRight
                  aria-hidden
                  className="size-4 shrink-0 text-zinc-600 opacity-0 transition group-hover:opacity-100 group-hover:text-emerald-400"
                />
              </button>
              <button
                type="button"
                onClick={() => void removeVisit(v.id)}
                aria-label={`Remove ${v.title || v.host} from history`}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 opacity-0 transition hover:bg-red-500/15 hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 aria-hidden className="size-3.5" />
              </button>
            </motion.li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}
