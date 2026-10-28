/**
 * Veil Stream — impression-fatigue store ("you keep showing me this").
 *
 * A video the user SCROLLS PAST again and again is a video they don't
 * want — YouTube's home feed learned this the hard way (the 2019 "too
 * many repeat impressions" adjustments). This store counts how many
 * times a video was actually SHOWN on a feed surface without being
 * picked:
 *
 *   • noteImpression(id) — an IntersectionObserver in the card fires
 *     once per card per mount when the thumbnail is ≥50% on screen;
 *   • clearImpression(id) — the moment the video is WATCHED (or the
 *     user interacts: not-interested already hides it outright), the
 *     counter resets — engagement is a fresh start;
 *   • impressionCounts() — the ranker reads the whole map: 3+ ignored
 *     impressions start to sink the card, 5+ sink it hard, 10+ removes
 *     it from For You entirely (search/channel pages are untouched —
 *     those are navigational, not recommendations).
 *
 * Purely per-device (localStorage, capped, LRU-evicted) like every
 * other Stream signal — nothing leaves the browser.
 */

export const IMPRESSIONS_LS_KEY = "veil.stream.impressions.v1";

/** enough for a month of heavy browsing; evicts stalest first */
const CAP = 3000;
/** coalesce writes — the observer can fire in bursts while scrolling */
const WRITE_DEBOUNCE_MS = 1500;

type ImpressionMap = Record<string, { n: number; at: number }>;

let cache: ImpressionMap | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function readAll(): ImpressionMap {
  if (cache) return cache;
  if (typeof window === "undefined") return {};
  try {
    const j = JSON.parse(window.localStorage.getItem(IMPRESSIONS_LS_KEY) || "{}") as ImpressionMap;
    cache = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof k === "string" && k && v && Number.isFinite(v.n) && Number.isFinite(v.at)) {
        cache[k] = { n: Math.max(0, Math.floor(v.n)), at: v.at };
      }
    }
    return cache;
  } catch {
    return {};
  }
}

function flush(): void {
  if (typeof window === "undefined" || !cache) return;
  try {
    const keys = Object.keys(cache);
    if (keys.length > CAP) {
      const byAge = keys.sort((a, b) => (cache![a]?.at ?? 0) - (cache![b]?.at ?? 0));
      for (const k of byAge.slice(0, keys.length - CAP)) delete cache![k];
    }
    window.localStorage.setItem(IMPRESSIONS_LS_KEY, JSON.stringify(cache));
  } catch {
    /* quota / private mode — impressions are advisory, never fatal */
  }
}

/** Count one unclicked on-screen impression. Cheap + coalesced. */
export function noteImpression(id: string): void {
  if (!id || typeof window === "undefined") return;
  const all = readAll();
  const cur = all[id];
  all[id] = { n: (cur?.n ?? 0) + 1, at: Date.now() };
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, WRITE_DEBOUNCE_MS);
}

/** Engagement resets the counter — a watch means the recommendation
 * worked; future impressions start from zero again. */
export function clearImpression(id: string): void {
  if (!id || typeof window === "undefined") return;
  const all = readAll();
  if (all[id]) {
    delete all[id];
    flush();
  }
}

/** The whole map, for the ranker (one read per feed load). */
export function impressionCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(readAll())) out[k] = v.n;
  return out;
}
