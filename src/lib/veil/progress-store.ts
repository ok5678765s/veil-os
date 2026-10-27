/**
 * Veil Stream — watch-progress store (where you left off).
 *
 * A tiny per-device localStorage map of videoId → { pos, dur, at } that
 * powers YouTube's resume behaviors:
 *
 *   • the player seeks back to `pos` when a video is re-opened
 *     (only when it's meaningful: >8s in and <95% through — YouTube
 *     never resumes the last 5% or a video you barely started);
 *   • feed cards carry the red progress bar at the thumbnail's bottom
 *     edge (partial watches) or the "Watched" treatment (≥95%);
 *   • the For You ranker demotes finished videos harder than abandoned
 *     ones and labels partials "continue watching";
 *   • the For You page gets a "Continue watching" shelf.
 *
 * Deliberately separate from the IndexedDB history store: history rows
 * are append-only "you watched this at T" facts (deduped by id), while
 * progress is a MUTABLE per-video cursor. A few thousand entries fit
 * localStorage comfortably (≈150 bytes each) — the cap evicts the
 * stalest cursors first, and finished videos are kept (the "Watched"
 * card treatment rides them) until natural eviction.
 *
 * Events: "veil-stream-progress" fires on every mutation so cards and
 * rails re-render exactly when a cursor moves.
 */

export interface ProgressEntry {
  /** last playback position, seconds */
  pos: number;
  /** video duration at the time of the save, seconds */
  dur: number;
  /** when this cursor was last touched, ms */
  at: number;
}

export const PROGRESS_LS_KEY = "veil.stream.progress.v1";
export const PROGRESS_EVENT = "veil-stream-progress";

/** enough for a heavy viewer's whole "resume later" pile */
const CAP = 2400;
/** below this many seconds a cursor is not worth resuming */
const MIN_RESUME_POS = 8;
/** at/after this fraction a video counts as finished */
export const WATCHED_FRACTION = 0.95;

type ProgressMap = Record<string, ProgressEntry>;

function parse(raw: string | null): ProgressMap {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as ProgressMap;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: ProgressMap = {};
    for (const [k, v] of Object.entries(j)) {
      if (
        typeof k === "string" && k &&
        v && typeof v === "object" &&
        Number.isFinite(v.pos) && Number.isFinite(v.dur) && Number.isFinite(v.at)
      ) {
        out[k] = { pos: Math.max(0, v.pos), dur: Math.max(0, v.dur), at: v.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readAll(): ProgressMap {
  if (typeof window === "undefined") return {};
  try {
    return parse(window.localStorage.getItem(PROGRESS_LS_KEY));
  } catch {
    return {};
  }
}

function writeAll(map: ProgressMap): void {
  if (typeof window === "undefined") return;
  try {
    /* cap — keep the CAP freshest cursors (finished videos included:
     * the Watched treatment rides them) */
    const keys = Object.keys(map);
    if (keys.length > CAP) {
      const byAge = keys.sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0));
      for (const k of byAge.slice(0, keys.length - CAP)) delete map[k];
    }
    window.localStorage.setItem(PROGRESS_LS_KEY, JSON.stringify(map));
    window.dispatchEvent(new Event(PROGRESS_EVENT));
  } catch {
    /* quota / private mode — progress is best-effort, never fatal */
  }
}

/** The cursor for one video (or null when never touched). */
export function getProgress(id: string): ProgressEntry | null {
  if (!id) return null;
  return readAll()[id] ?? null;
}

/** How far a video has been watched, 0..1 (0 when unknown). */
export function watchFraction(id: string): number {
  const p = getProgress(id);
  if (!p || p.dur <= 0) return 0;
  return Math.max(0, Math.min(1, p.pos / p.dur));
}

/** True when the video was watched (essentially) to the end. */
export function isWatchedThrough(id: string): boolean {
  return watchFraction(id) >= WATCHED_FRACTION;
}

/**
 * Move a video's cursor. Called throttled from the player's timeupdate
 * (every few seconds), on pause, on ended and on teardown.
 *
 *   pos <= MIN_RESUME_POS    → the entry is dropped (nothing to resume)
 *   frac >= WATCHED_FRACTION → pos is pinned to dur ("finished" marker)
 */
export function saveProgress(id: string, pos: number, dur: number): void {
  if (!id || !Number.isFinite(pos) || !Number.isFinite(dur) || dur <= 0) return;
  const map = readAll();
  const p = Math.max(0, Math.min(pos, dur));
  if (p <= MIN_RESUME_POS) {
    if (map[id]) {
      delete map[id];
      writeAll(map);
    }
    return;
  }
  map[id] = {
    pos: p >= dur * WATCHED_FRACTION ? dur : p,
    dur,
    at: Date.now(),
  };
  writeAll(map);
}

/** Drop one cursor (History's "remove" also clears the resume state). */
export function clearProgress(id: string): void {
  if (!id) return;
  const map = readAll();
  if (map[id]) {
    delete map[id];
    writeAll(map);
  }
}

/** Every cursor, for the ranker + shelves (reads the whole map once). */
export function progressSnapshot(): ProgressMap {
  return readAll();
}

/**
 * History-clear helper: wipe every cursor (the "Clear all watch
 * history" action owns the resume state too).
 */
export function clearAllProgress(): void {
  writeAll({});
}
