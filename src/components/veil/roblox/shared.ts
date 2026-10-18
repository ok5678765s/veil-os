/**
 * Veil Roblox — shared types, client fetchers and helpers for the
 * Arcade's Roblox tab. The tab is a native React client for the REAL
 * Roblox: charts, search, game pages and play launches all talk to
 * roblox.com (server-proxied via /api/roblox) — no iframes, no clones.
 */

/* ------------------------------------------------------------------ */
/* Response types (mirrored by /api/roblox)                            */
/* ------------------------------------------------------------------ */

export interface RobloxGameCard {
  universeId: number;
  placeId: number;
  name: string;
  icon: string | null;
  playing: number;
  upVotes: number;
  downVotes: number;
  creatorName?: string;
  creatorVerified?: boolean;
  genre?: string | null;
  maturity?: string | null;
  sponsored?: boolean;
}

export interface RobloxHomeRow {
  id: string;
  title: string;
  games: RobloxGameCard[];
}

export interface RobloxHomeResponse {
  ok: true;
  rows: RobloxHomeRow[];
}

export interface RobloxSearchResponse {
  ok: true;
  query: string;
  results: RobloxGameCard[];
}

export interface RobloxDetailGame {
  universeId: number;
  placeId: number;
  name: string;
  description: string;
  icon: string | null;
  thumb: string | null;
  playing: number;
  visits: number;
  favorites: number;
  upVotes: number;
  downVotes: number;
  maxPlayers: number;
  created: string;
  updated: string;
  genre: string | null;
  maturity: string | null;
  creator: {
    name: string;
    type: string;
    verified: boolean;
    avatarUrl: string | null;
  };
}

export interface RobloxDetailResponse {
  ok: true;
  game: RobloxDetailGame;
  recommended: RobloxGameCard[];
}

export interface RobloxErrorResponse {
  ok: false;
  error: string;
}

export type RobloxResponse =
  | RobloxHomeResponse
  | RobloxSearchResponse
  | RobloxDetailResponse
  | RobloxErrorResponse;

/* ------------------------------------------------------------------ */
/* Client fetchers                                                     */
/* ------------------------------------------------------------------ */

async function getJson<T extends RobloxResponse>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok || (data as RobloxErrorResponse).ok === false) {
    const err = data as unknown as RobloxErrorResponse;
    throw new Error(err.error || "Roblox is unreachable right now.");
  }
  return data;
}

export function fetchRobloxHome(): Promise<RobloxHomeResponse> {
  return getJson<RobloxHomeResponse>("/api/roblox?kind=home");
}

export function fetchRobloxSearch(query: string): Promise<RobloxSearchResponse> {
  return getJson<RobloxSearchResponse>(
    `/api/roblox?kind=search&q=${encodeURIComponent(query)}`
  );
}

export function fetchRobloxDetail(universeId: number): Promise<RobloxDetailResponse> {
  return getJson<RobloxDetailResponse>(
    `/api/roblox?kind=detail&universeId=${encodeURIComponent(universeId)}`
  );
}

/* ------------------------------------------------------------------ */
/* Play — the real Roblox launch                                       */
/* ------------------------------------------------------------------ */

/**
 * The roblox-player:// deep link roblox.com itself fires when you press
 * Play — the browser hands it to the installed Roblox app, which joins
 * the place directly. Constructed exactly like the site's launcher.
 */
export function robloxPlayerLink(placeId: number): string {
  return (
    "roblox-player://1+launchmode:play+gameid:0+launchtime:0+" +
    `placeid:${placeId}+linkid:0+visitorid:0+isguest:false+` +
    "robloxLocale:en_us+gameLocale:en_us"
  );
}

/**
 * True when Veil is running embedded inside another page (the sandbox
 * preview panel). Subframe origins cannot navigate to custom protocols —
 * Chrome/Firefox silently block roblox-player:// fired from an iframe —
 * so the UI offers working fallbacks (new tab / the in-app browser).
 */
export function isEmbeddedContext(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent: window.top access itself threw — embedded.
    return true;
  }
}

/**
 * Fire the protocol from a user-gesture context (browsers require it).
 *
 * Top-level windows: identical to what roblox.com's own launcher does.
 * Embedded (preview iframe): browsers block custom-protocol navigation
 * from subframes, so we first try to hand the link to the TOP frame —
 * when the host page is same-origin that works and the OS still shows
 * the "Open Roblox?" prompt. Cross-origin parents throw, caught, and we
 * fall back to the (blocked-but-harmless) subframe attempt; the dialog's
 * fallback actions are what the user actually sees.
 */
export function launchRobloxApp(placeId: number): void {
  const link = robloxPlayerLink(placeId);
  try {
    if (typeof window !== "undefined" && window.self !== window.top) {
      try {
        window.top!.location.href = link;
        return;
      } catch {
        /* cross-origin host page — the subframe attempt below stands in */
      }
    }
    window.location.href = link;
  } catch {
    /* no handler installed — the dialog's fallback links take over */
  }
}

/**
 * Open the real game page in a genuine browser tab. Returns false when
 * the browser refused the popup (sandboxed preview iframes without
 * allow-popups) so the caller can fall back to the in-app browser.
 *
 * NOTE: the "noopener"/"noreferrer" window features make window.open
 * return null BY SPEC even on success — useless for blocked-detection.
 * So we open plain (keeping the return value) and then null the opener
 * handle ourselves (a permitted cross-origin write) for the same
 * no-tabnabbing protection.
 */
export function openRobloxGamePageTab(placeId: number): boolean {
  try {
    const w = window.open(robloxGamePageUrl(placeId), "_blank");
    if (!w) return false;
    try {
      w.opener = null;
    } catch {
      /* cross-origin edge — the tab is roblox.com, risk is nil */
    }
    return true;
  } catch {
    return false;
  }
}

/** The real game page on roblox.com (opens in a genuine browser tab). */
export function robloxGamePageUrl(placeId: number): string {
  return `https://www.roblox.com/games/${placeId}`;
}

/* ------------------------------------------------------------------ */
/* Recently played (localStorage — powers the Continue row)            */
/* ------------------------------------------------------------------ */

export interface RecentGame {
  universeId: number;
  placeId: number;
  name: string;
  icon: string | null;
  at: number;
}

const RECENT_KEY = "veil:roblox:recent:v1";
const RECENT_MAX = 12;

function isRecent(x: unknown): x is RecentGame {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as RecentGame).universeId === "number" &&
    typeof (x as RecentGame).placeId === "number" &&
    typeof (x as RecentGame).name === "string"
  );
}

export function loadRecent(): RecentGame[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function recordRecentGame(game: {
  universeId: number;
  placeId: number;
  name: string;
  icon: string | null;
}): void {
  try {
    const list = loadRecent().filter((g) => g.universeId !== game.universeId);
    list.unshift({ ...game, at: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* storage unavailable — Continue simply won't persist */
  }
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function compact(n: number, plus: boolean): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return Math.round(n).toString();
  const units = [
    { v: 1e9, s: "B" },
    { v: 1e6, s: "M" },
    { v: 1e3, s: "K" },
  ];
  for (const { v, s } of units) {
    if (n >= v) {
      const x = n / v;
      const str = x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, "");
      return `${str}${s}${plus ? "+" : ""}`;
    }
  }
  return Math.round(n).toString();
}

/** Live player counts — "96.7K" (Roblox card style). */
export function fmtCount(n: number): string {
  return compact(n, false);
}

/** Visits / favorites — "2.1B+" (Roblox stat style). */
export function fmtVisits(n: number): string {
  return compact(n, true);
}

/** Like ratio 0–100 from raw votes. */
export function ratingPct(up: number, down: number): number {
  const total = up + down;
  if (total <= 0) return 0;
  return Math.round((up / total) * 100);
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Content-maturity chip labels (Roblox's own wording). */
export function maturityLabel(m: string | null | undefined): string | null {
  switch (m) {
    case "mild":
      return "Mild";
    case "moderate":
      return "Moderate";
    case "restricted":
      return "Restricted";
    default:
      return null;
  }
}
