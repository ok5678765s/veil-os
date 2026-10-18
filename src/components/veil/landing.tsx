"use client";

/**
 * Veil — landing page.
 * Hero with the command bar, quick links, recent history, how-it-works and features.
 */

import * as React from "react";
import { motion, useReducedMotion, useScroll } from "framer-motion";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  Eye,
  Globe,
  History as HistoryIcon,
  Layers,
  Lock,
  Maximize2,
  Search,
  ShieldCheck,
  Trash2,
  Unlock,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { KeyboardHelp } from "@/components/veil/keyboard-help";
import {
  faviconUrls,
  normalizeInput,
  QUICK_LINKS,
  timeAgo,
  type HistoryResponse,
  type Visit,
} from "@/lib/veil/shared";

function FaviconImg({ host, name, className }: { host: string; name: string; className?: string }) {
  const urls = React.useMemo(() => faviconUrls(host), [host]);
  const [idx, setIdx] = React.useState(0);
  const failed = idx >= urls.length;
  if (failed) {
    return (
      <div
        aria-hidden
        className={`flex items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/20 to-teal-500/10 font-semibold text-emerald-300 ring-1 ring-emerald-500/20 ${className ?? "h-8 w-8"}`}
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
      className={`rounded-lg bg-zinc-800/80 object-contain p-0.5 ring-1 ring-zinc-700/50 ${className ?? "h-8 w-8"}`}
    />
  );
}

const FEATURES = [
  {
    icon: Maximize2,
    title: "True full-screen",
    body: "Browsing takes over the whole viewport. The control bar melts away until you need it — hit F for OS-level fullscreen.",
  },
  {
    icon: Layers,
    title: "Deep link handling",
    body: "Links, stylesheets, images, srcsets, forms and redirects are resolved server-side so pages stay inside the veil.",
  },
  {
    icon: Unlock,
    title: "Embedding limits lifted",
    body: "Sites that normally refuse to be embedded render here without friction, edge to edge.",
  },
  {
    icon: Eye,
    title: "No client trackers",
    body: "Your browser talks only to this app. Every page is fetched by the server, never by your browser.",
  },
  {
    icon: HistoryIcon,
    title: "History, saved locally",
    body: "Sites you visit land in a local SQLite database with visit counts — nothing leaves this machine.",
  },
  {
    icon: Zap,
    title: "Streaming pipeline",
    body: "Binary content streams straight through. HTML and CSS are the only things we pause to process.",
  },
];

const STEPS = [
  { n: "01", title: "Type a URL or a search", body: "Anything that isn't a domain becomes a Bing web search." },
  { n: "02", title: "The server loads it", body: "Your browser never talks to the remote site. Every page is pulled and prepared on the server." },
  { n: "03", title: "You browse full-screen", body: "The page fills your entire screen with a minimal, auto-hiding control bar." },
];

function Divider() {
  return (
    <div
      aria-hidden
      className="mx-auto h-px w-full max-w-6xl bg-gradient-to-r from-transparent via-zinc-800/70 to-transparent"
    />
  );
}

export function Landing({
  onNavigate,
  history,
  onHistoryChanged,
}: {
  onNavigate: (url: string) => void;
  history: HistoryResponse | null;
  onHistoryChanged: () => void;
}) {
  const [input, setInput] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const reduceMotion = useReducedMotion();

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const raw = input.trim();
    if (!raw) {
      inputRef.current?.focus();
      return;
    }
    const target = normalizeInput(raw);
    if (target) onNavigate(target);
  };

  const deleteVisit = async (id: string) => {
    try {
      await fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      onHistoryChanged();
    } catch {
      /* non-fatal */
    }
  };

  const clearAll = async () => {
    try {
      await fetch("/api/history?all=1", { method: "DELETE" });
      onHistoryChanged();
    } catch {
      /* non-fatal */
    } finally {
      setConfirmClear(false);
    }
  };

  const stats = history?.stats;

  return (
    <div className="relative flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Scroll progress bar */}
      <ScrollProgress />

      {/* ---------------- Header ---------------- */}
      <header className="sticky top-0 z-40 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <a href="#top" className="group flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 transition duration-300 group-hover:bg-emerald-500/25 group-hover:ring-emerald-400/50 group-hover:shadow-[0_0_24px_-6px_rgba(52,211,153,0.6)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10Z" />
                <path d="M9 12h2v4" />
              </svg>
            </span>
            <span className="text-[17px] font-semibold tracking-tight">
              Veil<span className="text-emerald-400">.</span>
            </span>
          </a>
          <nav className="hidden items-center gap-7 text-sm text-zinc-400 md:flex" aria-label="Main">
            <a
              className="relative py-1 transition hover:text-zinc-100 after:absolute after:-bottom-0.5 after:left-0 after:h-px after:w-0 after:bg-gradient-to-r after:from-emerald-400 after:to-teal-400 after:transition-all after:duration-300 hover:after:w-full"
              href="#quick-links"
            >
              Quick links
            </a>
            <a
              className="relative py-1 transition hover:text-zinc-100 after:absolute after:-bottom-0.5 after:left-0 after:h-px after:w-0 after:bg-gradient-to-r after:from-emerald-400 after:to-teal-400 after:transition-all after:duration-300 hover:after:w-full"
              href="#history"
            >
              History
            </a>
            <a
              className="relative py-1 transition hover:text-zinc-100 after:absolute after:-bottom-0.5 after:left-0 after:h-px after:w-0 after:bg-gradient-to-r after:from-emerald-400 after:to-teal-400 after:transition-all after:duration-300 hover:after:w-full"
              href="#how"
            >
              How it works
            </a>
            <a
              className="relative py-1 transition hover:text-zinc-100 after:absolute after:-bottom-0.5 after:left-0 after:h-px after:w-0 after:bg-gradient-to-r after:from-emerald-400 after:to-teal-400 after:transition-all after:duration-300 hover:after:w-full"
              href="#features"
            >
              Features
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <KeyboardHelp
              trigger={
                <button
                  type="button"
                  aria-label="Keyboard shortcuts (?)"
                  title="Keyboard shortcuts (?)"
                  className="hidden h-9 w-9 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-800 hover:text-emerald-300 active:scale-95 sm:flex"
                >
                  ?
                </button>
              }
            />
            <Button
              size="sm"
              onClick={() => {
                inputRef.current?.focus();
                inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              className="group bg-emerald-500 font-semibold text-emerald-950 transition-all hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-500/25 active:scale-[0.98]"
            >
              Start browsing
              <ArrowRight aria-hidden className="transition-transform duration-300 group-hover:translate-x-0.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* ---------------- Hero ---------------- */}
      <section id="top" className="relative overflow-hidden">
        {/* backdrop: grid + dots + glows */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div
            className="absolute inset-0 opacity-[0.14]"
            style={{
              backgroundImage:
                "linear-gradient(to right, #3f3f46 1px, transparent 1px), linear-gradient(to bottom, #3f3f46 1px, transparent 1px)",
              backgroundSize: "56px 56px",
              maskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
              WebkitMaskImage: "radial-gradient(ellipse 80% 60% at 50% 0%, black 40%, transparent 100%)",
            }}
          />
          <div
            className="veil-noise absolute inset-0 opacity-50"
            style={{
              maskImage: "radial-gradient(ellipse 70% 55% at 50% 0%, black 40%, transparent 100%)",
              WebkitMaskImage: "radial-gradient(ellipse 70% 55% at 50% 0%, black 40%, transparent 100%)",
            }}
          />
          <div className="veil-orb-a absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-emerald-500/25 blur-[140px]" />
          <div className="veil-orb-b absolute top-24 right-[12%] h-56 w-56 rounded-full bg-teal-500/15 blur-[100px]" />
          <div className="veil-orb-b absolute top-32 left-[10%] h-40 w-40 rounded-full bg-emerald-400/15 blur-[80px]" style={{ animationDelay: "-6s" }} />
        </div>

        <div className="relative mx-auto w-full max-w-4xl px-4 pb-20 pt-20 text-center sm:px-6 sm:pt-28">
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.5 }}
            className="mx-auto inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-medium text-emerald-300 backdrop-blur"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Full-screen · server-side · zero client trackers
          </motion.div>

          <motion.h1
            initial={reduceMotion ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.55, delay: 0.06 }}
            className="mx-auto mt-7 max-w-3xl text-balance text-4xl font-bold leading-[1.08] tracking-tight text-zinc-50 sm:text-6xl"
          >
            The whole web,
            <br />
            <span className="veil-shimmer-text">
              through the veil.
            </span>
          </motion.h1>

          <motion.p
            initial={reduceMotion ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.55, delay: 0.12 }}
            className="mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-zinc-400 sm:text-lg"
          >
            Veil loads pages on the server, resolves every link and asset, and
            presents them to you in a distraction-free full-screen view.
          </motion.p>

          {/* Command bar */}
          <motion.form
            initial={reduceMotion ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.55, delay: 0.18 }}
            onSubmit={submit}
            className="group/bar relative mx-auto mt-10 w-full max-w-2xl"
            role="search"
          >
            {/* ambient glow beneath the bar (focus) */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-8 -bottom-10 -top-6 rounded-[2rem] bg-emerald-500/[0.07] opacity-0 blur-2xl transition-opacity duration-700 group-focus-within/bar:opacity-100"
            />
            {/* rotating conic focus border */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-px overflow-hidden rounded-[17px] opacity-0 transition-opacity duration-500 group-focus-within/bar:opacity-100"
            >
              <div className="veil-bar-spin absolute left-1/2 top-1/2 aspect-square w-[240%] bg-[conic-gradient(from_0deg,transparent_0deg,transparent_280deg,rgba(52,211,153,0.6)_315deg,rgba(94,234,212,0.9)_337deg,rgba(52,211,153,0.6)_357deg,transparent_360deg)]" />
            </div>
            <div className="relative flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl transition-colors duration-300 group-focus-within/bar:border-emerald-500/40 sm:p-2">
              <div className="group relative flex-1">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-zinc-500 transition group-focus-within:text-emerald-400"
                />
                <Input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a URL — or search the web…"
                  aria-label="URL or search query"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  className="h-12 rounded-xl border-0 bg-transparent pl-10 pr-10 text-[15px] text-zinc-100 shadow-none selection:bg-emerald-500/30 selection:text-emerald-50 placeholder:text-zinc-500 focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                />
                <span
                  aria-hidden
                  className={`pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 items-center transition-opacity duration-300 group-focus-within/bar:opacity-0 sm:flex ${
                    input === "" ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <kbd className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-zinc-400 shadow-[0_1px_0_0_rgba(0,0,0,0.5)]">
                    /
                  </kbd>
                </span>
              </div>
              <Button
                type="submit"
                className="h-12 shrink-0 rounded-xl bg-emerald-500 px-5 text-[15px] font-semibold text-emerald-950 shadow-lg shadow-emerald-500/25 transition-all hover:bg-emerald-400 hover:shadow-emerald-400/30 active:scale-[0.96] sm:px-6"
              >
                <Maximize2 aria-hidden className="sm:hidden" />
                <span className="hidden sm:inline">Browse</span>
              </Button>
            </div>
          </motion.form>

          <motion.p
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.5, delay: 0.3 }}
            className="mt-4 text-xs text-zinc-500"
          >
            Tip: press <Kbd>Enter</Kbd> to launch · <Kbd>F</Kbd> toggles fullscreen while browsing
          </motion.p>

          {/* Live stats */}
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.5, delay: 0.36 }}
            className="mx-auto mt-12 flex w-fit max-w-full flex-wrap items-center justify-center gap-x-4 gap-y-3 rounded-2xl border border-zinc-800/70 bg-zinc-900/40 px-4 py-4 backdrop-blur-sm sm:flex-nowrap sm:gap-x-8 sm:px-8"
          >
            <Stat value={stats ? stats.sites.toLocaleString() : "0"} label="sites visited" />
            <div aria-hidden className="hidden h-10 w-px bg-gradient-to-b from-transparent via-zinc-700 to-transparent sm:block" />
            <Stat value={stats ? stats.pageVisits.toLocaleString() : "0"} label="page loads" />
            <div aria-hidden className="hidden h-10 w-px bg-gradient-to-b from-transparent via-zinc-700 to-transparent sm:block" />
            <Stat value="100%" label="server-fetched" />
          </motion.div>
        </div>
      </section>

      <Divider />

      {/* ---------------- Quick links ---------------- */}
      <section id="quick-links" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <SectionHead
          icon={<Globe aria-hidden className="h-4 w-4" />}
          kicker="Launch pads"
          title="Sites that shine through the veil"
          sub="Hand-picked pages that render beautifully inside Veil."
        />
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_LINKS.map((s, i) => (
            <motion.button
              key={s.url}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.4, delay: i * 0.05 }}
              onClick={() => onNavigate(s.url)}
              className="veil-card-sheen group flex items-center gap-4 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 text-left transition duration-300 hover:-translate-y-1 hover:border-emerald-500/50 hover:bg-zinc-900 hover:shadow-[0_12px_40px_-14px_rgba(16,185,129,0.4)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 active:translate-y-0 active:scale-[0.99]"
            >
              <span
                aria-hidden
                className="absolute inset-x-4 top-0 h-px origin-left scale-x-0 bg-gradient-to-r from-emerald-400/80 via-teal-400/40 to-transparent transition-transform duration-500 ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100"
              />
              <FaviconImg
                host={s.host}
                name={s.name}
                className="h-11 w-11 shrink-0 transition duration-300 group-hover:scale-110"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-zinc-100">{s.name}</span>
                <span className="block truncate text-[13px] text-zinc-500">{s.desc}</span>
              </span>
              <ArrowRight
                aria-hidden
                className="h-4 w-4 shrink-0 text-zinc-600 transition duration-300 group-hover:translate-x-1 group-hover:text-emerald-400"
              />
            </motion.button>
          ))}
        </div>
      </section>

      {/* ---------------- History ---------------- */}
      <section id="history" className="border-y border-zinc-800/60 bg-zinc-900/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <SectionHead
              icon={<Clock aria-hidden className="h-4 w-4" />}
              kicker="Your trail"
              title="Recently viewed"
              sub="Stored locally in SQLite — clear it whenever you like."
            />
            {history && history.visits.length > 0 && (
              <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-zinc-700 bg-transparent text-zinc-400 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 active:scale-[0.98]"
                  >
                    <Trash2 aria-hidden /> Clear history
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
                  <AlertDialogHeader>
                    <AlertDialogTitle className="text-zinc-100">Clear all browsing history?</AlertDialogTitle>
                    <AlertDialogDescription className="text-zinc-400">
                      This removes every recorded visit from the local database. It cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
                      Keep it
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={clearAll}
                      className="bg-red-500 text-white hover:bg-red-400"
                    >
                      Clear everything
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>

          {history && history.visits.length > 0 ? (
            <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {history.visits.map((v) => (
                <HistoryCard key={v.id} visit={v} onOpen={onNavigate} onDelete={deleteVisit} />
              ))}
            </ul>
          ) : (
            <div className="relative mt-8 overflow-hidden rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/40 px-6 py-16 text-center">
              <div aria-hidden className="veil-noise pointer-events-none absolute inset-0 opacity-30" />
              <div className="relative mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/15 to-teal-500/10 ring-1 ring-emerald-500/20">
                <HistoryIcon aria-hidden className="h-5 w-5 text-emerald-400/90" />
              </div>
              <p className="relative mt-4 text-sm font-medium text-zinc-300">No history yet</p>
              <p className="relative mx-auto mt-1.5 max-w-xs text-[13px] leading-relaxed text-zinc-500">
                Sites you open through the veil will appear here with visit counts and timestamps.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ---------------- How it works ---------------- */}
      <section id="how" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <SectionHead
          icon={<Lock aria-hidden className="h-4 w-4" />}
          kicker="Under the hood"
          title="Three steps, zero exposure"
          sub="Server-side page loading with a modern, full-screen face."
        />
        <ol className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.li
              key={s.n}
              initial={reduceMotion ? false : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.45, delay: i * 0.08 }}
              className="relative rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-6 transition duration-300 hover:-translate-y-1 hover:border-emerald-500/30 hover:bg-zinc-900/60"
            >
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className="absolute -right-5 top-8 hidden h-4 w-4 items-center justify-center text-zinc-700 md:flex"
                >
                  <ChevronRight className="h-4 w-4" />
                </span>
              )}
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/10 font-mono text-[11px] font-semibold tracking-wider text-emerald-300 ring-1 ring-emerald-500/25">
                {s.n}
              </span>
              <h3 className="mt-4 text-[15px] font-semibold text-zinc-100">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.body}</p>
            </motion.li>
          ))}
        </ol>
      </section>

      <Divider />

      {/* ---------------- Features ---------------- */}
      <section id="features" className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <SectionHead
          icon={<ShieldCheck aria-hidden className="h-4 w-4" />}
          kicker="Why Veil"
          title="Built like a fortress, feels like a native app"
        />
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.4, delay: i * 0.04 }}
              className="group relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-5 transition duration-300 hover:-translate-y-1 hover:border-emerald-500/30 hover:bg-zinc-900/60"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-emerald-500/10 opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-100"
              />
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500/15 to-teal-500/10 ring-1 ring-emerald-500/20 transition duration-300 group-hover:scale-110 group-hover:from-emerald-500/25 group-hover:ring-emerald-500/40">
                <f.icon aria-hidden className="h-4.5 w-4.5 text-emerald-400" />
              </div>
              <h3 className="relative mt-4 text-[15px] font-semibold text-zinc-100">{f.title}</h3>
              <p className="relative mt-1.5 text-sm leading-relaxed text-zinc-400">{f.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      <Divider />

      {/* ---------------- CTA ---------------- */}
      <section className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <div className="veil-card-sheen group relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-emerald-500/10 via-zinc-900 to-zinc-900 px-6 py-14 text-center sm:px-12 sm:py-16">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.1]"
            style={{
              backgroundImage:
                "linear-gradient(to right, #3f3f46 1px, transparent 1px), linear-gradient(to bottom, #3f3f46 1px, transparent 1px)",
              backgroundSize: "44px 44px",
              maskImage: "radial-gradient(ellipse 70% 80% at 50% 100%, black 30%, transparent 100%)",
              WebkitMaskImage: "radial-gradient(ellipse 70% 80% at 50% 100%, black 30%, transparent 100%)",
            }}
          />
          <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[480px] -translate-x-1/2 rounded-full bg-emerald-500/20 blur-[110px]" />
          <div aria-hidden className="veil-noise pointer-events-none absolute inset-0 opacity-40" />
          <span
            aria-hidden
            className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/40 to-transparent"
          />
          <h2 className="relative text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Ready to disappear into the web?
          </h2>
          <p className="relative mx-auto mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
            One URL is all it takes. The veil opens full-screen.
          </p>
          <Button
            size="lg"
            onClick={() => {
              inputRef.current?.focus();
              inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="group/btn relative mt-7 h-12 rounded-xl bg-emerald-500 px-8 text-[15px] font-semibold text-emerald-950 shadow-xl shadow-emerald-500/20 transition-all hover:bg-emerald-400 hover:shadow-emerald-400/30 active:scale-[0.97]"
          >
            Open the veil{" "}
            <ArrowRight aria-hidden className="transition-transform duration-300 group-hover/btn:translate-x-1" />
          </Button>
        </div>
      </section>

      {/* ---------------- Footer (sticky bottom) ---------------- */}
      <footer className="mt-auto border-t border-zinc-800/60 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-[13px] text-zinc-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-emerald-500/10 ring-1 ring-emerald-500/20">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" aria-hidden>
                <path d="M12 22s8-3.6 8-10V5.5L12 2 4 5.5V12c0 6.4 8 10 8 10Z" />
              </svg>
            </span>
            <span className="font-medium text-zinc-400">Veil</span>
            <span className="text-zinc-700" aria-hidden>
              ·
            </span>
            <span>a full-screen web viewer</span>
          </div>
          <p className="text-center sm:text-right">
            Respect site terms · for legitimate browsing only
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------- small pieces ------------------------- */

function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  return (
    <motion.div
      aria-hidden
      style={{ scaleX: scrollYProgress }}
      className="fixed left-0 top-0 z-50 h-0.5 w-full origin-left bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.7)]"
    />
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-2xl font-bold tabular-nums tracking-tight text-zinc-100 sm:text-3xl">{value}</div>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}

function SectionHead({
  icon,
  kicker,
  title,
  sub,
}: {
  icon: React.ReactNode;
  kicker: string;
  title: string;
  sub?: string;
}) {
  return (
    <div className="max-w-2xl">
      <div className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-400">
        <span className="text-emerald-400/80">{icon}</span>
        {kicker}
      </div>
      <h2 className="mt-4 text-balance text-2xl font-bold tracking-tight text-zinc-100 sm:text-3xl">{title}</h2>
      {sub ? <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">{sub}</p> : null}
    </div>
  );
}

function HistoryCard({
  visit,
  onOpen,
  onDelete,
}: {
  visit: Visit;
  onOpen: (url: string) => void;
  onDelete: (id: string) => void;
}) {
  const title = visit.title || visit.url.replace(/^https?:\/\//, "");
  return (
    <li className="group relative">
      <button
        onClick={() => onOpen(visit.url)}
        className="flex w-full items-center gap-3.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-4 text-left transition duration-300 hover:-translate-y-1 hover:border-emerald-500/40 hover:bg-zinc-900 hover:shadow-[0_10px_30px_-12px_rgba(16,185,129,0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 active:translate-y-0"
      >
        <FaviconImg
          host={visit.host}
          name={visit.host}
          className="h-10 w-10 shrink-0 transition duration-300 group-hover:scale-105"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-zinc-100">{title}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[12px] text-zinc-500">
            <span className="truncate">{visit.host}</span>
            <span className="text-zinc-700" aria-hidden>
              ·
            </span>
            <span className="whitespace-nowrap">{timeAgo(visit.updatedAt)}</span>
            {visit.visitCount > 1 && (
              <>
                <span className="text-zinc-700" aria-hidden>
                  ·
                </span>
                <span className="whitespace-nowrap rounded-full bg-emerald-500/10 px-1.5 py-px text-[10.5px] font-semibold leading-4 text-emerald-400/90 ring-1 ring-emerald-500/20">
                  {visit.visitCount}×
                </span>
              </>
            )}
          </span>
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(visit.id);
        }}
        aria-label={`Remove ${visit.host} from history`}
        className="absolute right-2.5 top-2.5 hidden h-7 w-7 items-center justify-center rounded-lg border border-zinc-700/60 bg-zinc-950/90 text-zinc-500 backdrop-blur transition hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 active:scale-90 group-hover:flex focus-visible:flex"
      >
        <Trash2 aria-hidden className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-zinc-300 shadow-[0_1px_0_0_rgba(0,0,0,0.6)]">
      {children}
    </kbd>
  );
}
