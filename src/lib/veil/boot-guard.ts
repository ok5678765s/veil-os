"use client";

/**
 * Veil — stale-build self-heal (boot guard).
 *
 * Dev-server restarts (watchdog cycles, .next wipes, crash loops) can leave
 * an already-open tab running a dead bundle: HMR gives up, the page keeps
 * executing OLD code — removed tabs keep rendering, new routes 404 on a
 * page that doesn't know they exist, and the owner sees ghosts like the
 * long-dead "Apps" tab sitting where Roblox should be.
 *
 * /api/session now stamps every response with `boot` — the server
 * process's start time (a fresh boot = a fresh stamp). This guard watches
 * that stamp: when it CHANGES under a live tab, the server restarted since
 * the page loaded, so the bundle is suspect → reload ONCE. Sections
 * restore from storage on reload by design ("a restart must never dump
 * the user back on the start page"), so the reload is survivable.
 *
 * Loop-safe: the new stamp is written BEFORE reloading, so the post-reload
 * check compares equal and stops. Private mode (no sessionStorage) simply
 * skips — a missing stored stamp is treated as "first load", never a
 * mismatch.
 */

import * as React from "react";

const BOOT_KEY = "veil:boot";
const POLL_MS = 60_000;

export function useBootGuard(): void {
  React.useEffect(() => {
    let stopped = false;
    // A stamp seen changed ONCE is only a *candidate* — it must survive a
    // SECOND consecutive poll before we treat it as a real restart. This
    // makes the guard immune to any residual one-off stamp flakiness
    // (proxy hiccup, cached response, clock wobble): a glitch reverts on
    // the next poll and cancels the candidate; a real restart confirms.
    let candidate: string | null = null;

    const check = async () => {
      try {
        const res = await fetch("/api/session", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { boot?: number };
        if (stopped || typeof data.boot !== "number") return;

        const stamp = String(data.boot);
        const prev = sessionStorage.getItem(BOOT_KEY);
        if (prev === null) {
          sessionStorage.setItem(BOOT_KEY, stamp);
          candidate = null;
          return;
        }
        if (prev === stamp) {
          // back to the known stamp — any pending candidate was a glitch
          candidate = null;
          return;
        }
        if (candidate === stamp) {
          // CONFIRMED across two consecutive polls: the server really
          // restarted under this tab and the running bundle is stale.
          // Refresh to the current build exactly once.
          sessionStorage.setItem(BOOT_KEY, stamp);
          candidate = null;
          window.location.reload();
          return;
        }
        // first sighting of a different stamp — hold it as a candidate
        candidate = stamp;
      } catch {
        /* fetch failed (offline / server down) — HMR's own reconnect
         * flow owns that case; try again on the next tick. */
      }
    };

    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
}
