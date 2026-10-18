/**
 * Runtime cache-dir resolver — keeps every disk cache OUT of the project
 * tree that `next dev` watches.
 *
 * 2026-10-17 "restarts to home screen every minute" postmortem: caches
 * that lived at the project root (.quasar-cache/, .mbgs-cache/) were
 * flushed by daemons/timers while users browsed. Each write inside the
 * watched tree invalidated the module graph, Next recompiled every route
 * importing the cache's module, and Fast Refresh force-reloaded EVERY
 * connected browser — one viewer browsing kicked all viewers back to the
 * start screen roughly once a minute.
 *
 * Resolution order (mirrors quasar/fetcher.ts):
 *   1. explicit env override (QUASAR_CACHE_DIR-style, per caller);
 *   2. $HOME/.veil-cache/<name> — outside the tree on any sane box;
 *   3. cwd fallback — only for containers where $HOME is unusable.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function runtimeCacheDir(name: string, envOverride?: string): string {
  if (envOverride) return envOverride;
  const home = homedir();
  if (home && home !== "/") {
    const dir = join(home, ".veil-cache", name);
    // Only reject the home location if it lands INSIDE the watched project
    // tree (cwd being $HOME itself, or a project checked out at $HOME/…).
    const insideTree = dir === process.cwd() || dir.startsWith(process.cwd() + "/");
    if (!insideTree) {
      try {
        mkdirSync(dir, { recursive: true });
        return dir;
      } catch {
        /* unwritable home — fall through */
      }
    }
  }
  return join(process.cwd(), `.${name}`);
}
