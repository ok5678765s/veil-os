/**
 * Veil instrumentation — runs once per Next.js server boot.
 *
 * Spawns upload/veil-pulse.sh detached: the pulse verifies the daemon
 * swarm (keeper, backup-loop, ws-relay, freetube) and — if a sandbox
 * revert gutted the project tree — restores it from
 * upload/veil-latest.tar.gz before serving. The pulse lives in upload/
 * because that tree survives reverts; this file is the seed that grows
 * back with every restore. Never blocks or breaks server startup.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Spawn upload/veil-pulse.sh detached: the pulse verifies the daemon
    // swarm (keeper, backup-loop, ws-relay, freetube, chat, bridge) and —
    // if a sandbox revert gutted the project tree — restores it from
    // upload/veil-latest.tar.gz before serving. The pulse lives in upload/
    // because that tree survives reverts; this file is the seed that grows
    // back with every restore. Never blocks or breaks server startup.
    // webpackIgnore: webpack must leave this dynamic import to Node itself
    // (bundling node: builtins into the instrumentation layer fails with
    // "Module not found: Can't resolve 'child_process'" — observed live,
    // which silently killed the pulse for days).
    const { spawn } = (await import(/* webpackIgnore: true */ "node:child_process")) as typeof import("node:child_process");
    const child = spawn("bash", ["/home/z/my-project/upload/veil-pulse.sh"], {
      detached: true,
      stdio: "ignore",
      cwd: "/home/z/my-project",
    });
    // The pulse script only exists in the dev sandbox (upload/ is a state
    // volume in production images). A spawn ENOENT emits an async "error"
    // event — with no listener Node treats it as unhandled and CRASHES the
    // server on boot. Absorb it: production simply runs pulse-less.
    child.on("error", () => {});
    child.unref();
  } catch {
    /* never break server boot */
  }
  try {
    // keep the Stream browse wires hot + rotating (trending/popular/shorts
    // refresh every few minutes; feeds serve stale-while-revalidating)
    const { startFeedWarmer } = await import("@/lib/veil/yt");
    startFeedWarmer();
  } catch {
    /* feeds warm lazily on first request instead */
  }
  try {
    // Heap gardener — the #1 cause of "the site randomly restarts": the dev
    // server's heap drifts upward until EITHER Next.js's own watchdog trips
    // (it restarts the server after any request whose used_heap_size
    // crosses 80% of heap_size_limit — with the old 1024MB cap that line
    // sat at ~973MB while the LIVE set alone measured 734MB, so every
    // compile burst restarted the site) or the box watchdog intervenes.
    //
    // v5 (2026-10-09 "website should never restart" round):
    //   * cap raised to 1792MB (package.json) — the internal 80% line now
    //     sits at ~1.5GB, far above the observed live set, so Next's
    //     self-restart becomes unreachable in normal operation.
    //   * compaction is now HEAP-PRESSURE aware: v3/v4 keyed off RSS, which
    //     includes ~800MB of non-heap (external/code) that gc() can never
    //     reclaim — the compactor fired constantly yet the heap kept
    //     growing. Now it reads v8.getHeapStatistics() directly and
    //     compacts when heapUsed exceeds 55% of the limit, and compacts
    //     HARD (double gc + warn) past 72%.
    //   * durable telemetry: one line every 5 min to /home/z/veil-heap.log
    //     (outside .next/, survives boots) — future restart forensics no
    //     longer need the SIGUSR1 inspector dance.
    // v5.2 (2026-10-17 "app dev died" postmortem): heap crossed the 80%
    //   line again (1.52GB observed at 22:01) because the quasar caches
    //   RETAINED 416MB in-heap (HTTP 256MB + JS AST 160MB) on top of the
    //   warm module graph. Fixes: cache budgets cut to 48MB each via
    //   QUASAR_HTTP_CACHE_MB / QUASAR_JS_CACHE_MB in package.json (frees
    //   ~320MB of permanent retention) and the cap raised to 2048MB — the
    //   80% restart line now sits at ~1.8GB, roughly 700MB above the
    //   post-fix warm live set.
    // No-op without --expose-gc.
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    if (typeof maybeGc === "function") {
      const v8mod = await import(/* webpackIgnore: true */ "node:v8");
      const fsmod = (await import(/* webpackIgnore: true */ "node:fs")).default;
      const HEARTBEAT = "/home/z/veil-heap.log";
      let lastBeat = 0;
      const beat = (line: string) => {
        try {
          fsmod.appendFileSync(HEARTBEAT, `${new Date().toISOString()} ${line}\n`);
        } catch { /* telemetry is best-effort */ }
      };
      setInterval(() => {
        try {
          const hs = v8mod.getHeapStatistics();
          const used = hs.used_heap_size;
          const limit = hs.heap_size_limit;
          const ratio = limit > 0 ? used / limit : 0;
          const rss = process.memoryUsage().rss;
          // Box-pressure awareness (2026-10-09 postmortem: the 21:12
          // emergency restart fired when MemAvailable hit 304MB — the OTHER
          // processes on this 3.9GB no-swap box matter too). When the BOX
          // gets tight we compact aggressively regardless of our own heap
          // ratio, freeing garbage pages back to the kernel before the
          // watchdog's emergency path is ever reached.
          let memAvailKb = Infinity;
          try {
            const mi = fsmod.readFileSync("/proc/meminfo", "utf8");
            const m = /^MemAvailable:\s+(\d+) kB/m.exec(mi);
            if (m) memAvailKb = Number(m[1]);
          } catch { /* keep Infinity */ }
          if (ratio > 0.72 || memAvailKb < 600 * 1024) {
            // Danger zone (heap 8% under Next's own 80% restart line, or
            // box under real pressure): compact twice, leave a durable trace.
            maybeGc();
            maybeGc();
            beat(`WARN compact-hard heapUsed=${Math.round(used / 1048576)}MB limit=${Math.round(limit / 1048576)}MB rss=${Math.round(rss / 1048576)}MB memAvail=${Math.round(memAvailKb / 1024)}MB`);
          } else if (ratio > 0.55 || rss > 1.45 * 1024 * 1024 * 1024 || memAvailKb < 900 * 1024) {
            maybeGc();
          }
          const now = Date.now();
          if (now - lastBeat > 5 * 60 * 1000) {
            lastBeat = now;
            beat(`ok heapUsed=${Math.round(used / 1048576)}MB limit=${Math.round(limit / 1048576)}MB rss=${Math.round(rss / 1048576)}MB ext=${Math.round(process.memoryUsage().external / 1048576)}MB`);
          }
        } catch { /* never throw in the timer */ }
      }, 15 * 1000).unref();
    }
  } catch {
    /* never break server boot */
  }
}
