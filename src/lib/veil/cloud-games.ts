/**
 * Veil — apps built by the owner with AI CODER (the HTML maker that
 * replaced the Extension Maker, and before that the Cloud Game Studio).
 *
 * AI Coder asks the model for complete self-contained HTML pages (all
 * HTML/CSS/JS inline). They live here:
 * - a localStorage-backed store ("My AI builds") that survives reloads,
 * - a pending-play handoff so "Play in the Arcade" works from ANY section
 *   (the AI section → the Arcade's Roblox tab, where the build runs in an
 *   embedded player — never a browser tab, never a new window),
 * - a pending hop back the other way ("Build with AI Coder" in the
 *   Arcade arms the AI section's Coder mode).
 */

export interface MadeGame {
  /** Stable id (assigned at save time). */
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** The complete self-contained HTML page — plays via iframe srcDoc. */
  html: string;
  at: number;
  plays: number;
}

const STORE_KEY = "veil:cloud-games:v1";
const MAX_GAMES = 24;

/** window event: a made build should start playing in the Arcade now. */
export const PLAY_MADE_GAME_EVENT = "veil:play-made-game";
/** window event: the made-builds store changed (save/delete). */
export const MADE_GAMES_CHANGED_EVENT = "veil:cloud-games-changed";
/** window event: open the AI section in AI Coder mode. */
export const OPEN_AI_GAMES_EVENT = "veil:open-ai-games";

function isMadeGame(x: unknown): x is MadeGame {
  return (
    !!x &&
    typeof x === "object" &&
    typeof (x as MadeGame).id === "string" &&
    typeof (x as MadeGame).name === "string" &&
    typeof (x as MadeGame).html === "string" &&
    typeof (x as MadeGame).at === "number"
  );
}

export function loadMadeGames(): MadeGame[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMadeGame)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_GAMES);
  } catch {
    return [];
  }
}

function persist(list: MadeGame[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_GAMES)));
  } catch {
    /* quota / private mode — the in-memory copy still works this session */
  }
  try {
    window.dispatchEvent(new CustomEvent(MADE_GAMES_CHANGED_EVENT));
  } catch {
    /* not a browser context */
  }
}

/** Save (or update) a made build. Returns the stored build with its id. */
export function saveMadeGame(
  game: Omit<MadeGame, "id" | "at" | "plays"> & { id?: string }
): MadeGame {
  const list = loadMadeGames();
  const existing = game.id ? list.find((g) => g.id === game.id) : undefined;
  const stored: MadeGame = {
    id: game.id || "mg-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (game.name || "My AI Build").slice(0, 60),
    desc: (game.desc || "Built with AI Coder").slice(0, 160),
    icon: game.icon || "filetext",
    html: game.html,
    at: existing ? existing.at : Date.now(),
    plays: existing ? existing.plays : 0,
  };
  persist([stored, ...list.filter((g) => g.id !== stored.id)]);
  return stored;
}

export function deleteMadeGame(id: string): void {
  persist(loadMadeGames().filter((g) => g.id !== id));
}

export function findMadeGame(id: string): MadeGame | null {
  return loadMadeGames().find((g) => g.id === id) ?? null;
}

export function bumpMadeGamePlays(id: string): void {
  const list = loadMadeGames();
  const g = list.find((x) => x.id === id);
  if (!g) return;
  g.plays += 1;
  persist(list);
}

/* ------------------------------------------------------------------ */
/* Pending play — the cross-section handoff                            */
/* ------------------------------------------------------------------ */

/**
 * When "Play in the Arcade" fires from the AI section, the Arcade may not
 * be mounted yet (first-ever open) — its Roblox-tab listener cannot have
 * attached. The pending slot bridges that: set BEFORE the event fires,
 * consumed by the Roblox tab on mount (or by its live listener).
 * Stale pendings (older than 30s) are dropped so a later, unrelated
 * arcade visit never auto-launches a game.
 */
let pending: { id: string; at: number } | null = null;

/* The Arcade's tab jump needs its own slot: React runs CHILD effects
 * before PARENT effects, so RobloxTab (child) consumes the game id
 * before ArcadeSection's (parent) effect could ever see it. */
let pendingRobloxJump = false;

export function setPendingMadeGame(id: string): void {
  pending = { id, at: Date.now() };
  pendingRobloxJump = true;
}

export function takePendingMadeGame(): string | null {
  if (!pending) return null;
  const { id, at } = pending;
  pending = null;
  if (Date.now() - at > 30_000) return null;
  return id;
}

/** ArcadeSection consumes this on mount — lands the tab on Roblox when
 * a made-game play was requested before the arcade had ever mounted
 * (post-reload first open). */
export function takePendingRobloxJump(): boolean {
  const v = pendingRobloxJump;
  pendingRobloxJump = false;
  return v;
}

/** Ask the app to play a made game right now (any section → Arcade). */
export function playMadeGameInArcade(id: string): void {
  setPendingMadeGame(id);
  try {
    window.dispatchEvent(new CustomEvent(PLAY_MADE_GAME_EVENT, { detail: { id } }));
  } catch {
    /* not a browser context */
  }
}

/* Same handoff for the AI hop: "Build with AI Coder" (Roblox tab) opens
 * the AI section in AI Coder mode. If the section isn't
 * mounted yet (first-ever open), the event fires into the void — the
 * pending slot below bridges exactly that gap. */
let pendingAiGames = false;

/** Open the AI section in AI Coder mode (any section → AI). */
export function requestAiGames(): void {
  pendingAiGames = true;
  try {
    window.dispatchEvent(new CustomEvent(OPEN_AI_GAMES_EVENT));
  } catch {
    /* not a browser context */
  }
}

/** Consume a pending AI-coder hop (true once, then false). */
export function takePendingAiGames(): boolean {
  const v = pendingAiGames;
  pendingAiGames = false;
  return v;
}
