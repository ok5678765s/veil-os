/**
 * Veil — /api/roblox: the server-side client for the REAL Roblox.
 *
 * The Arcade's Roblox tab renders native React (no iframes), fed by this
 * route which proxies roblox.com's public web APIs server-side (they're
 * browser-CORS-locked, so the fetches must happen here):
 *
 *   home    → explore-api get-sort-content (the exact sorts roblox.com's
 *             own home page shows: Top Playing Now, Top Trending, …)
 *   search  → search-api omni-search
 *   detail  → games.roblox.com v1/games + votes + recommendations,
 *             thumbnails.roblox.com icons / banners / creator headshots
 *
 * Every response is normalized to the shapes in
 * src/components/veil/roblox/shared.ts, cached in memory (charts 2 min,
 * search/detail longer) with in-flight dedupe, and degrades gracefully —
 * a dead sub-fetch never sinks the whole payload.
 */

import { NextRequest, NextResponse } from "next/server";
import type {
  RobloxGameCard,
  RobloxHomeResponse,
  RobloxHomeRow,
  RobloxSearchResponse,
  RobloxDetailResponse,
} from "@/components/veil/roblox/shared";

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HOME_SORTS: { id: string; fallbackTitle: string }[] = [
  { id: "top-playing-now", fallbackTitle: "Top Playing Now" },
  { id: "top-trending", fallbackTitle: "Top Trending" },
  { id: "up-and-coming", fallbackTitle: "Up-and-Coming" },
  { id: "fun-with-friends", fallbackTitle: "Fun with Friends" },
  { id: "top-revisited", fallbackTitle: "Top Revisited" },
];

const HOME_ROW_SIZE = 24;
const ICON_BATCH = 50;

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

function cached<T>(key: string, ttlMs: number, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);

  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const p = (async () => {
    const value = await make();
    cache.set(key, { expires: Date.now() + ttlMs, value });
    inFlight.delete(key);
    if (cache.size > 128) {
      const now = Date.now();
      for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    }
    return value;
  })();
  inFlight.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ */
/* Roblox fetch helpers                                                */
/* ------------------------------------------------------------------ */

async function robloxJson<T>(url: string, timeoutMs = 9000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function sessionId(): string {
  return crypto.randomUUID();
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* icons: thumbnails.roblox.com/v1/games/icons (batched, 50 ids per call) */
async function fetchIcons(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  await Promise.all(
    chunk(ids, ICON_BATCH).map(async (batch) => {
      const d = await robloxJson<{
        data?: { targetId: number; state: string; imageUrl: string }[];
      }>(
        `https://thumbnails.roblox.com/v1/games/icons?universeIds=${batch.join(",")}&size=256x256&format=Png&isCircular=false`
      );
      if (d?.data) {
        for (const t of d.data) {
          if (t.state === "Completed" && t.imageUrl) map.set(t.targetId, t.imageUrl);
        }
      }
    })
  );
  return map;
}

/* ------------------------------------------------------------------ */
/* Upstream shapes (only the fields we read)                           */
/* ------------------------------------------------------------------ */

interface UpstreamGame {
  universeId: number;
  rootPlaceId?: number;
  placeId?: number;
  name: string;
  playerCount?: number;
  playing?: number;
  totalUpVotes?: number;
  totalDownVotes?: number;
  upVotes?: number;
  downVotes?: number;
  isSponsored?: boolean;
  genreL1?: string | null;
  contentMaturity?: string | null;
  creatorName?: string;
  creatorHasVerifiedBadge?: boolean;
}

interface ExploreResponse {
  sortDisplayName?: string;
  games?: UpstreamGame[];
}

interface OmniResponse {
  searchResults?: {
    contentGroupType: string;
    contents?: UpstreamGame[];
  }[];
}

interface GamesV1Response {
  data?: {
    id: number;
    rootPlaceId: number;
    name: string;
    description: string | null;
    creator: { id: number; name: string; type: string; hasVerifiedBadge: boolean };
    playing: number;
    visits: number;
    maxPlayers: number;
    created: string;
    updated: string;
    genre: string | null;
    isAllGenre?: boolean;
    favoritedCount: number;
  }[];
}

interface VotesResponse {
  data?: { universeId: number; upVotes: number; downVotes: number }[];
}

interface RecResponse {
  games?: UpstreamGame[];
}

interface MultigetThumbsResponse {
  data?: { universeId: number; thumbnails?: { state: string; imageUrl: string }[] }[];
}

interface UserThumbResponse {
  data?: { targetId: number; state: string; imageUrl: string }[];
}

/* ------------------------------------------------------------------ */
/* Normalizers                                                         */
/* ------------------------------------------------------------------ */

function toCard(g: UpstreamGame, icons: Map<number, string>): RobloxGameCard {
  return {
    universeId: g.universeId,
    placeId: g.rootPlaceId ?? g.placeId ?? 0,
    name: g.name,
    icon: icons.get(g.universeId) ?? null,
    playing: g.playerCount ?? g.playing ?? 0,
    upVotes: g.totalUpVotes ?? g.upVotes ?? 0,
    downVotes: g.totalDownVotes ?? g.downVotes ?? 0,
    creatorName: g.creatorName,
    creatorVerified: g.creatorHasVerifiedBadge,
    genre: g.genreL1 ?? null,
    maturity: g.contentMaturity ?? null,
    sponsored: g.isSponsored === true,
  };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleHome(): Promise<RobloxHomeResponse> {
  const rows = await Promise.all(
    HOME_SORTS.map(async (sort) => {
      const d = await robloxJson<ExploreResponse>(
        `https://apis.roblox.com/explore-api/v1/get-sort-content?sessionId=${sessionId()}&sortId=${sort.id}&rowsPerPage=${HOME_ROW_SIZE}&pageType=home`
      );
      return {
        id: sort.id,
        title: d?.sortDisplayName || sort.fallbackTitle,
        games: (d?.games ?? []).slice(0, HOME_ROW_SIZE),
      };
    })
  );

  const ids = [...new Set(rows.flatMap((r) => r.games.map((g) => g.universeId)))];
  const icons = await fetchIcons(ids);

  const normalized: RobloxHomeRow[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    games: r.games.map((g) => toCard(g, icons)),
  }));

  if (normalized.every((r) => r.games.length === 0)) {
    throw new Error("Roblox's charts are unreachable right now.");
  }
  return { ok: true, rows: normalized };
}

async function handleSearch(q: string): Promise<RobloxSearchResponse> {
  const trimmed = q.trim().slice(0, 64);
  if (!trimmed) return { ok: true, query: trimmed, results: [] };

  const d = await robloxJson<OmniResponse>(
    `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(
      trimmed
    )}&pageType=all&sessionId=${sessionId()}`
  );

  const pool: UpstreamGame[] = [];
  const seen = new Set<number>();
  for (const group of d?.searchResults ?? []) {
    if (group.contentGroupType !== "Game") continue;
    for (const g of group.contents ?? []) {
      if (seen.has(g.universeId)) continue;
      seen.add(g.universeId);
      pool.push(g);
    }
  }
  const top = pool.slice(0, 30);
  const icons = await fetchIcons(top.map((g) => g.universeId));
  return { ok: true, query: trimmed, results: top.map((g) => toCard(g, icons)) };
}

async function handleDetail(universeId: number): Promise<RobloxDetailResponse> {
  const [games, votes, recs, iconMap, thumbs] = await Promise.all([
    robloxJson<GamesV1Response>(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
    robloxJson<VotesResponse>(
      `https://games.roblox.com/v1/games/votes?universeIds=${universeId}`
    ),
    robloxJson<RecResponse>(
      `https://games.roblox.com/v1/games/recommendations/game/${universeId}?model.maxRows=12`
    ),
    fetchIcons([universeId]),
    robloxJson<MultigetThumbsResponse>(
      `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&size=768x432&format=Png&isCircular=false`
    ),
  ]);

  const g = games?.data?.[0];
  if (!g) throw new Error("That experience doesn't exist (or Roblox hid it).");

  const creatorAvatar =
    g.creator.type === "User"
      ? await robloxJson<UserThumbResponse>(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${g.creator.id}&size=150x150&format=Png&isCircular=true`
        )
      : null;
  const creatorAvatarUrl =
    creatorAvatar?.data?.find((t) => t.state === "Completed")?.imageUrl ?? null;

  const recGames = (recs?.games ?? []).slice(0, 12);
  const recIcons = await fetchIcons(recGames.map((r) => r.universeId));

  const banner =
    thumbs?.data?.[0]?.thumbnails?.find((t) => t.state === "Completed")?.imageUrl ?? null;

  return {
    ok: true,
    game: {
      universeId: g.id,
      placeId: g.rootPlaceId,
      name: g.name,
      description: g.description ?? "",
      icon: iconMap.get(universeId) ?? null,
      thumb: banner,
      playing: g.playing,
      visits: g.visits,
      favorites: g.favoritedCount,
      upVotes: votes?.data?.[0]?.upVotes ?? 0,
      downVotes: votes?.data?.[0]?.downVotes ?? 0,
      maxPlayers: g.maxPlayers,
      created: g.created,
      updated: g.updated,
      genre: g.isAllGenre ? null : (g.genre ?? null),
      maturity:
        (recGames.find((r) => r.universeId === universeId)?.contentMaturity as string | undefined) ??
        null,
      creator: {
        name: g.creator.name,
        type: g.creator.type,
        verified: g.creator.hasVerifiedBadge,
        avatarUrl: creatorAvatarUrl,
      },
    },
    recommended: recGames.map((r) => toCard(r, recIcons)),
  };
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const kind = params.get("kind");

  try {
    if (kind === "home") {
      const data = await cached("home", 120_000, handleHome);
      return NextResponse.json(data);
    }

    if (kind === "search") {
      const q = params.get("q") ?? "";
      const data = await cached(`search:${q.trim().toLowerCase()}`, 300_000, () =>
        handleSearch(q)
      );
      return NextResponse.json(data);
    }

    if (kind === "detail") {
      const id = Number(params.get("universeId"));
      if (!Number.isInteger(id) || id <= 0) {
        return NextResponse.json({ ok: false, error: "Invalid experience id." }, { status: 400 });
      }
      const data = await cached(`detail:${id}`, 600_000, () => handleDetail(id));
      return NextResponse.json(data);
    }

    return NextResponse.json({ ok: false, error: "Unknown kind." }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Roblox is unreachable right now." },
      { status: 502 }
    );
  }
}
