"use client";

/**
 * Veil — offline download button (RE-ENABLED).
 *
 * Serves download/veil-offline.html — the single-file "living room" build
 * (chat + players + friends/DMs/groups + streak) that runs from file://
 * and talks back to its birth origin. The download is password-gated by
 * /api/offline (?verify=1&pw=… checks first, then the attachment URL),
 * and the origin is stamped into the file in-flight by the API route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";

export function OfflineDownload({
  variant = "header",
  className,
}: {
  variant?: "header" | "pill";
  className?: string;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* Probe the build — the button only appears when the file is real. */
  useEffect(() => {
    let stopped = false;
    const probe = async () => {
      try {
        const res = await fetch("/api/offline?status=1", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { ready?: boolean };
        if (!stopped) setReady(!!data.ready);
      } catch {
        /* next probe retries */
      }
    };
    void probe();
    const t = setInterval(probe, 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  /* Click-outside closes the password popover. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setHint(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const verifyAndDownload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    try {
      const res = await fetch(
        `/api/offline?verify=1&pw=${encodeURIComponent(pw)}`,
        { cache: "no-store" },
      )
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        hint?: string
      }
      if (!res.ok || !data.ok) {
        setHint(data.hint || "Wrong password — downloads stay locked.")
        return
      }
      /* Verified — hand the browser the attachment. The download URL
       * carries THIS page's origin explicitly (every proxy hop rewrites
       * Host, so the server can't know the public address on its own) —
       * the API stamps it into the file as it streams. */
      window.location.href = `/api/offline?pw=${encodeURIComponent(pw)}&origin=${encodeURIComponent(window.location.origin)}`
      setOpen(false)
      setPw("")
    } catch {
      setHint("Couldn't reach the download — try again in a moment.")
    } finally {
      setBusy(false)
    }
  }, [busy, pw])

  if (ready !== true) return null

  return (
    <div ref={wrapRef} className={`relative ${className || ""}`}>
      <button
        onClick={() => {
          setOpen((s) => !s)
          setHint(null)
        }}
        className={
          variant === "pill"
            ? "flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
            : "flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
        }
        title="Download the offline single-file veil — runs from your device"
      >
        <Download className="h-3.5 w-3.5" />
        Offline veil
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-white/10 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-xl">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-white">
                Offline veil — one HTML file
              </p>
              <p className="mt-0.5 text-[10.5px] leading-snug text-white/45">
                The living room as a single file: chat, players with live
                online dots, friends, DMs, groups and your daily streak —
                straight from your device.
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-white/40 hover:bg-white/10 hover:text-white"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void verifyAndDownload()}
              placeholder="Download password"
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white outline-none focus:border-emerald-400/50"
            />
            <button
              onClick={() => void verifyAndDownload()}
              disabled={busy || !pw}
              className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-black transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              Get
            </button>
          </div>
          {hint && <p className="mt-2 text-[10.5px] text-rose-300">{hint}</p>}
        </div>
      )}
    </div>
  )
}
