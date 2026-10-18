"use client";

/**
 * Veil Roblox — "Coin Tycoon" / "Pizza Tycoon" engine.
 *
 * DOM-only idle tycoon: one giant squishy clicker, six dropper tiers, click
 * upgrades, rebirths with permanent multipliers and a conveyor flourish.
 * No canvas, no iframe — progress persists to localStorage per experience id
 * and the whole loop pauses (state kept) while the tab is hidden.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import {
  type GameProps,
  type RobloxAvatar,
  type TycoonConfig,
  fmtBig,
} from "@/components/veil/roblox/shared";

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

const TIER_BASE_COST = [15, 120, 700, 3_600, 18_000, 90_000];
const TIER_INCOME = [1, 6, 32, 165, 820, 4_100];
const COST_GROWTH = 1.55;
const CLICK_UPGRADE_BASE = 50;
const CLICK_UPGRADE_GROWTH = 2.1;
const GOLDEN_BASE = 500;
const GOLDEN_GROWTH = 4;
const MAX_GOLDEN = 10;
const REBIRTH_REQ = 100_000;
/** Conveyor flourish durations (s) — 5 speed tiers, capped so it never spins silly. */
const CONVEYOR_DURATIONS = [3.4, 2.7, 2.1, 1.6, 1.25];

const FALLBACK_CONFIG: TycoonConfig = {
  kind: "tycoon",
  theme: "coin",
  currency: "coins",
  emoji: "🪙",
  tiers: ["Noob Dropper", "Pro Dropper", "Mega Press", "Vault Conveyor", "Golden Factory", "Coin Portal"],
  accent: "#ffc531",
  accent2: "#a86e00",
};

interface TycoonSave {
  coins: number;
  owned: number[];
  clickLevel: number;
  /** Golden Touch level (persists through rebirths — the permanent meta upgrade). */
  golden: number;
  rebirths: number;
  totalEarned: number;
  /** Once-ever badge flags so rewards never re-fire on remount. */
  badges: string[];
}

interface Pop {
  id: number;
  x: number;
  y: number;
  label: string;
}

const HAT_COLORS: Record<string, string> = {
  tophat: "#1f2022",
  cone: "#ff7a1a",
  party: "#ff5fb0",
  bucket: "#8a8f98",
  viking: "#ffd23c",
  dominus: "#c0392b",
  prop: "#f2f3f3",
};

/** Chunky Roblox-style button base (inner shadow lip + press travel). */
const CHUNKY =
  "rounded-[8px] font-bold shadow-[inset_0_-3px_0_rgba(0,0,0,0.28)] transition-colors active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-45";

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

function defaultSave(): TycoonSave {
  return { coins: 0, owned: [0, 0, 0, 0, 0, 0], clickLevel: 0, golden: 0, rebirths: 0, totalEarned: 0, badges: [] };
}

function loadSave(key: string): TycoonSave {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw) as Partial<TycoonSave>;
    const num = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : fallback;
    return {
      coins: num(parsed.coins, 0),
      owned: TIER_BASE_COST.map((_, i) => Math.floor(num(parsed.owned?.[i], 0))),
      clickLevel: Math.floor(num(parsed.clickLevel, 0)),
      golden: Math.min(MAX_GOLDEN, Math.floor(num(parsed.golden, 0))),
      rebirths: Math.floor(num(parsed.rebirths, 0)),
      totalEarned: num(parsed.totalEarned, 0),
      badges: Array.isArray(parsed.badges) ? parsed.badges.filter((b): b is string => typeof b === "string") : [],
    };
  } catch {
    return defaultSave();
  }
}

/* ------------------------------------------------------------------ */
/* Derived numbers (pure, safe inside state updaters)                  */
/* ------------------------------------------------------------------ */

function rebirthMult(rebirths: number): number {
  return 1 + 0.5 * rebirths;
}

function incomeOf(s: TycoonSave): number {
  let sum = 0;
  for (let i = 0; i < TIER_INCOME.length; i++) sum += TIER_INCOME[i] * (s.owned[i] ?? 0);
  return sum * rebirthMult(s.rebirths);
}

function clickPowerOf(s: TycoonSave): number {
  return (1 + s.clickLevel) * Math.pow(1.25, s.golden) * rebirthMult(s.rebirths);
}

function tierCost(tier: number, owned: number): number {
  return TIER_BASE_COST[tier] * Math.pow(COST_GROWTH, owned);
}

function clickCost(level: number): number {
  return CLICK_UPGRADE_BASE * Math.pow(CLICK_UPGRADE_GROWTH, level);
}

function goldenCost(level: number): number {
  return GOLDEN_BASE * Math.pow(GOLDEN_GROWTH, level);
}

function conveyorTier(income: number): number {
  if (income >= 20_000) return 4;
  if (income >= 4_000) return 3;
  if (income >= 600) return 2;
  if (income >= 80) return 1;
  return 0;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) =>
    Math.round(((pa >> shift) & 0xff) * (1 - t) + ((pb >> shift) & 0xff) * t);
  return `#${((1 << 24) + (ch(16) << 16) + (ch(8) << 8) + ch(0)).toString(16).slice(1)}`;
}

/* ------------------------------------------------------------------ */
/* Presentational bits                                                 */
/* ------------------------------------------------------------------ */

/** Value-keyed span that pops whenever its formatted value changes. */
function PopText({ value, className }: { value: string; className?: string }) {
  return (
    <motion.span
      key={value}
      initial={{ scale: 1.14 }}
      animate={{ scale: 1 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={className}
      style={{ display: "inline-block" }}
    >
      {value}
    </motion.span>
  );
}

/** ~50px blocky avatar that endlessly works the press. */
function BlockyWorker({ avatar }: { avatar: RobloxAvatar }) {
  const hat = avatar.hatId ? HAT_COLORS[avatar.hatId] : undefined;
  return (
    <motion.div
      aria-hidden
      animate={{ y: [0, -2, 0] }}
      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
      className="flex shrink-0 flex-col items-center"
    >
      {hat && <div className="h-2 w-3.5 rounded-t-[3px]" style={{ background: hat }} />}
      <div
        className="relative mt-px h-[18px] w-[18px] rounded-[4px]"
        style={{ background: avatar.skin, boxShadow: "inset 0 -2px 3px rgba(0,0,0,0.18)" }}
      >
        <div className="absolute inset-x-0 top-[4px] flex justify-center gap-[3px]">
          <span className="h-[3px] w-[3px] rounded-full bg-[#1f2022]" />
          <span className="h-[3px] w-[3px] rounded-full bg-[#1f2022]" />
        </div>
        <span className="absolute bottom-[2px] left-1/2 h-[3px] w-[8px] -translate-x-1/2 rounded-b-full border-b-2 border-[#1f2022]" />
      </div>
      <div className="flex items-start">
        <motion.div
          className="h-[16px] w-[5px] rounded-[2px]"
          style={{ background: avatar.skin, transformOrigin: "top center" }}
          animate={{ rotate: [16, -14, 16] }}
          transition={{ duration: 0.55, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="mx-px h-[16px] w-[20px] rounded-[3px]" style={{ background: avatar.shirt }} />
        <motion.div
          className="h-[16px] w-[5px] rounded-[2px]"
          style={{ background: avatar.skin, transformOrigin: "top center" }}
          animate={{ rotate: [-16, 14, -16] }}
          transition={{ duration: 0.55, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <div className="flex gap-[3px]">
        <div className="h-[12px] w-[7px] rounded-b-[3px]" style={{ background: avatar.pants }} />
        <div className="h-[12px] w-[7px] rounded-b-[3px]" style={{ background: avatar.pants }} />
      </div>
    </motion.div>
  );
}

function ConveyorRow({ isPizza }: { isPizza: boolean }) {
  return (
    <div className="flex h-full w-1/2 items-center justify-around" aria-hidden>
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          className={
            isPizza
              ? "relative h-4 w-4 rounded-full bg-[#e8b563] shadow-[inset_0_-2px_3px_rgba(0,0,0,0.3)]"
              : "relative h-4 w-4 rounded-full bg-[#ffc531] shadow-[inset_0_-2px_3px_rgba(0,0,0,0.3)]"
          }
        >
          {isPizza && (
            <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#c0392b]" />
          )}
        </span>
      ))}
    </div>
  );
}

/** Giant gold coin with an embossed dollar emblem (pure CSS, no emoji). */
function CoinArt() {
  return (
    <div
      className="relative h-full w-full rounded-full"
      style={{
        background: "radial-gradient(circle at 35% 30%, #ffe08a 0%, #ffc531 45%, #d99a00 100%)",
        boxShadow:
          "inset 0 -7px 12px rgba(0,0,0,0.24), inset 0 6px 9px rgba(255,255,255,0.35), 0 12px 26px rgba(0,0,0,0.45)",
      }}
    >
      <div className="absolute inset-[13%] rounded-full border-[5px] border-[#b47c00]/70" />
      <span
        className="absolute inset-0 flex items-center justify-center text-[64px] font-black leading-none text-[#a06e00] sm:text-[76px]"
        style={{ textShadow: "0 2px 0 rgba(255,255,255,0.4), 0 -1px 0 rgba(0,0,0,0.25)" }}
      >
        $
      </span>
    </div>
  );
}

/** Whole pizza: tan disc, crust ring, pepperoni dots. */
function PizzaArt() {
  const pepperoni: Array<[number, number]> = [
    [22, 20],
    [55, 16],
    [38, 44],
    [66, 50],
    [20, 56],
    [48, 70],
  ];
  return (
    <div
      className="relative h-full w-full rounded-full"
      style={{
        background: "radial-gradient(circle at 35% 30%, #f7d488 0%, #e8b563 55%, #cf9440 100%)",
        boxShadow:
          "inset 0 -7px 12px rgba(0,0,0,0.24), inset 0 6px 9px rgba(255,255,255,0.3), 0 12px 26px rgba(0,0,0,0.45)",
      }}
    >
      <div className="absolute inset-[5%] rounded-full border-[6px] border-[#b5762c]" />
      {pepperoni.map(([left, top]) => (
        <span
          key={`${left}-${top}`}
          className="absolute rounded-full bg-[#c0392b] shadow-[inset_0_-2px_3px_rgba(0,0,0,0.4)]"
          style={{ left: `${left}%`, top: `${top}%`, width: "14%", height: "14%" }}
        />
      ))}
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col bg-[#232527] px-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-wider text-[#bdbebe]">{label}</span>
      <span className="truncate text-sm font-black tabular-nums text-white">{value}</span>
    </div>
  );
}

function UpgradeCard(props: {
  title: string;
  desc: string;
  level: number;
  cost: number | null;
  emoji: string;
  affordable: boolean;
  onBuy: () => void;
}) {
  const maxed = props.cost === null;
  return (
    <div className="flex flex-col gap-2 rounded-[8px] border border-white/5 bg-[#2e3133] p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-black uppercase tracking-wide text-white">{props.title}</p>
        <span className="rounded-full bg-black/30 px-2 py-0.5 text-[11px] font-bold text-[#bdbebe]">
          Lv {props.level}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-[#bdbebe]">{props.desc}</p>
      <button
        type="button"
        disabled={!props.affordable || maxed}
        onClick={props.onBuy}
        className={`${CHUNKY} mt-auto flex h-11 items-center justify-center gap-1.5 px-3 text-sm tabular-nums ${
          props.affordable && !maxed ? "bg-[#00b06f] text-white hover:bg-[#00c67d]" : "bg-[#3a3d40] text-[#bdbebe]"
        }`}
      >
        {props.cost === null ? "MAX" : `${props.emoji} ${fmtBig(props.cost)}`}
      </button>
    </div>
  );
}

function StartOverlay(props: {
  name: string;
  creator: string;
  desc: string;
  accent: string;
  ready: boolean;
  onReady: () => void;
  onPlay: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden p-6 text-center">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: `radial-gradient(circle at 50% 30%, ${props.accent}22, transparent 65%)` }}
      />
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.35 }}
        className="relative flex w-full max-w-md flex-col items-center gap-3"
      >
        <p className="text-xs font-bold uppercase tracking-[0.25em] text-[#bdbebe]">by {props.creator}</p>
        <h2 className="text-3xl font-black leading-tight text-white sm:text-4xl">{props.name}</h2>
        <p className="text-sm leading-relaxed text-[#bdbebe]">{props.desc}</p>
        <div className="mt-3 h-2.5 w-64 overflow-hidden rounded-full bg-[#2e3133]">
          <motion.div
            className="h-full rounded-full"
            style={{ background: props.accent }}
            initial={{ width: "2%" }}
            animate={{ width: "100%" }}
            transition={{ duration: 1.15, ease: "easeInOut" }}
            onAnimationComplete={props.onReady}
          />
        </div>
        <button
          type="button"
          onClick={props.onPlay}
          disabled={!props.ready}
          className={`${CHUNKY} mt-3 flex h-14 w-44 items-center justify-center gap-2 bg-[#00b06f] text-lg text-white hover:bg-[#00c67d]`}
        >
          <span
            aria-hidden
            className="ml-1 h-0 w-0 border-y-[9px] border-l-[14px] border-y-transparent border-l-white"
          />
          {props.ready ? "PLAY" : "LOADING"}
        </button>
      </motion.div>
    </div>
  );
}

function PauseVeil(props: { canResume: boolean; onResume: () => void; onLeave: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Game paused"
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black/70 p-4 backdrop-blur-[2px]"
    >
      <p className="text-3xl font-black tracking-[0.3em] text-white">PAUSED</p>
      <p className="max-w-xs text-center text-xs text-[#bdbebe]">
        {props.canResume
          ? "Take a breather — your tycoon keeps every coin."
          : "Paused — switch back to the Arcade tab to keep playing."}
      </p>
      <div className="flex gap-3">
        {props.canResume && (
          <button
            type="button"
            onClick={props.onResume}
            className={`${CHUNKY} h-11 bg-[#00b06f] px-6 text-white hover:bg-[#00c67d]`}
          >
            RESUME
          </button>
        )}
        <button
          type="button"
          onClick={props.onLeave}
          className={`${CHUNKY} h-11 border border-[#ff5a5a]/50 bg-[#2e3133] px-6 text-[#ff8a8a] hover:bg-[#3a3d40]`}
        >
          LEAVE
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export function TycoonGame(props: GameProps) {
  const { exp, avatar, active, onExit } = props;
  const config: TycoonConfig = exp.config.kind === "tycoon" ? exp.config : FALLBACK_CONFIG;
  const isPizza = config.theme === "pizza";
  const saveKey = `veil:roblox:save:${exp.id}`;

  const [phase, setPhase] = useState<"start" | "playing">("start");
  const [ready, setReady] = useState(false);
  const [save, setSave] = useState<TycoonSave>(() => loadSave(saveKey));
  const [escPaused, setEscPaused] = useState(false);
  const [docHidden, setDocHidden] = useState(false);
  const [pops, setPops] = useState<Pop[]>([]);
  const [celebrate, setCelebrate] = useState(false);

  const saveRef = useRef(save);
  const badgesRef = useRef<Set<string>>(new Set(save.badges));
  const cbRef = useRef({ onRobux: props.onRobux, onBadge: props.onBadge, onBest: props.onBest });
  const writeTimer = useRef<number | null>(null);
  const popTimers = useRef<number[]>([]);
  const celebTimer = useRef<number | null>(null);
  const popSeq = useRef(0);
  const lastRebirth = useRef(save.rebirths);

  const running = phase === "playing" && active && !escPaused && !docHidden;

  const income = incomeOf(save);
  const power = clickPowerOf(save);
  const speedTier = conveyorTier(income);

  /* Keep callback + save mirrors fresh (read by timers and the unmount flush). */
  useEffect(() => {
    cbRef.current = { onRobux: props.onRobux, onBadge: props.onBadge, onBest: props.onBest };
    saveRef.current = save;
  });

  /* Pause while the browser tab itself is hidden. */
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /* Esc opens the pause veil (capture + stopPropagation so the shell ignores it). */
  useEffect(() => {
    if (phase !== "playing") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setEscPaused((p) => !p);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [phase]);

  /* Debounced persistence: at most one trailing write per ~500ms of changes. */
  useEffect(() => {
    if (writeTimer.current !== null) return;
    writeTimer.current = window.setTimeout(() => {
      writeTimer.current = null;
      try {
        localStorage.setItem(saveKey, JSON.stringify(saveRef.current));
      } catch {
        /* storage unavailable — keep playing in memory */
      }
    }, 500);
  }, [save, saveKey]);

  /* Unmount: clear every timer, flush the save. */
  useEffect(
    () => () => {
      for (const t of popTimers.current) window.clearTimeout(t);
      popTimers.current = [];
      if (celebTimer.current !== null) window.clearTimeout(celebTimer.current);
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      try {
        localStorage.setItem(saveKey, JSON.stringify(saveRef.current));
      } catch {
        /* ignore */
      }
    },
    [saveKey],
  );

  /* Income tick — 100ms slices, fully paused when not running. */
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      setSave((s) => {
        const slice = incomeOf(s) / 10;
        if (slice <= 0) return s;
        return { ...s, coins: s.coins + slice, totalEarned: s.totalEarned + slice };
      });
    }, 100);
    return () => window.clearInterval(t);
  }, [running]);

  /* Badge bridge — fires once ever, thanks to the persisted flags. */
  const grant = useCallback((id: string) => {
    if (badgesRef.current.has(id)) return;
    badgesRef.current.add(id);
    setSave((s) => (s.badges.includes(id) ? s : { ...s, badges: [...s.badges, id] }));
    cbRef.current.onBadge(id);
  }, []);

  /* Millionaire check rides along with the counters. */
  useEffect(() => {
    if (phase !== "playing") return;
    if (save.coins >= 1_000_000 || save.totalEarned >= 1_000_000) grant(`${exp.id}:millionaire`);
  }, [phase, save.coins, save.totalEarned, grant, exp.id]);

  /* Rebirth rewards + celebration, keyed off the (rare) rebirths change. */
  useEffect(() => {
    if (save.rebirths <= lastRebirth.current) return;
    const r = save.rebirths;
    lastRebirth.current = r;
    cbRef.current.onRobux(15 * r, "rebirth");
    cbRef.current.onBest(r, `${r} rebirths`);
    if (r >= 1) grant(`${exp.id}:rebirth1`);
    if (r >= 5) grant(`${exp.id}:rebirth5`);
    setCelebrate(true);
    if (celebTimer.current !== null) window.clearTimeout(celebTimer.current);
    celebTimer.current = window.setTimeout(() => setCelebrate(false), 1900);
  }, [save.rebirths, grant, exp.id]);

  /* ------------------------- interactions ------------------------- */

  const spawnPop = (label: string, x: number, y: number) => {
    const id = ++popSeq.current;
    setPops((list) => [...list.slice(-11), { id, x, y, label }]);
    const t = window.setTimeout(() => {
      popTimers.current = popTimers.current.filter((pt) => pt !== t);
      setPops((list) => list.filter((p) => p.id !== id));
    }, 800);
    popTimers.current.push(t);
  };

  const start = () => {
    setPhase("playing");
    grant(`${exp.id}:welcome`);
  };

  const bigClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.min(92, Math.max(8, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(80, Math.max(10, ((e.clientY - rect.top) / rect.height) * 100));
    setSave((s) => {
      const gain = clickPowerOf(s);
      return { ...s, coins: s.coins + gain, totalEarned: s.totalEarned + gain };
    });
    spawnPop(`+${fmtBig(power)}`, x, y);
  };

  const buyTier = (i: number) =>
    setSave((s) => {
      const cost = tierCost(i, s.owned[i]);
      if (s.coins < cost) return s;
      const owned = s.owned.slice();
      owned[i] += 1;
      return { ...s, coins: s.coins - cost, owned };
    });

  const buyClick = () =>
    setSave((s) => {
      const cost = clickCost(s.clickLevel);
      if (s.coins < cost) return s;
      return { ...s, coins: s.coins - cost, clickLevel: s.clickLevel + 1 };
    });

  const buyGolden = () =>
    setSave((s) => {
      if (s.golden >= MAX_GOLDEN) return s;
      const cost = goldenCost(s.golden);
      if (s.coins < cost) return s;
      return { ...s, coins: s.coins - cost, golden: s.golden + 1 };
    });

  const doRebirth = () =>
    setSave((s) =>
      s.coins < REBIRTH_REQ
        ? s
        : { ...s, coins: 0, owned: [0, 0, 0, 0, 0, 0], clickLevel: 0, rebirths: s.rebirths + 1 },
    );

  /* ---------------------------- render ---------------------------- */

  const tierList = TIER_BASE_COST.map((_, i) => ({
    tier: i,
    name: config.tiers[i] ?? `Dropper ${i + 1}`,
  }));

  return (
    <div className="relative flex h-full min-h-[560px] w-full select-none flex-col overflow-hidden rounded-[8px] bg-[#191b1d] font-sans text-white">
      {phase === "playing" && (
        <>
          <header className="flex items-center gap-2 border-b border-white/5 bg-[#232527] px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold leading-tight">{exp.name}</p>
              <p className="truncate text-[11px] leading-tight text-[#bdbebe]">by {exp.creator}</p>
            </div>
            <span
              className="hidden rounded-full px-2.5 py-1 text-xs font-black tabular-nums text-[#191b1d] sm:inline-block"
              style={{ background: config.accent }}
            >
              {fmtBig(income)}/s
            </span>
            <span className="rounded-full bg-[#2e3133] px-2.5 py-1 text-xs font-black tabular-nums text-white">
              {config.emoji} <PopText value={fmtBig(save.coins)} />
            </span>
            <button
              type="button"
              aria-label="Leave game"
              onClick={onExit}
              className="flex h-11 w-11 items-center justify-center rounded-[8px] bg-[#2e3133] text-[#ff8a8a] transition-colors hover:bg-[#3a3d40]"
            >
              <X size={18} aria-hidden />
            </button>
          </header>

          <div className="veil-scroll-slim grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden">
            {/* ------------------------------ left ------------------------------ */}
            <div className="veil-scroll-slim flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
              <section className="relative flex flex-col items-center gap-1 overflow-hidden rounded-[8px] border border-white/5 bg-[#232527] px-3 pb-3 pt-4">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl leading-none" role="img" aria-label={config.currency}>
                    {config.emoji}
                  </span>
                  <PopText value={fmtBig(save.coins)} className="text-4xl font-black tabular-nums leading-none" />
                </div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#bdbebe]">
                  {config.currency} held
                </p>

                <div className="mt-2 flex w-full items-center justify-center gap-4 sm:gap-8">
                  <BlockyWorker avatar={avatar} />
                  <div className="relative">
                    <motion.button
                      type="button"
                      whileHover={{ scale: 1.03 }}
                      whileTap={{ scale: 0.92 }}
                      onClick={bigClick}
                      aria-label={`Earn ${config.currency}`}
                      className="h-36 w-36 rounded-full outline-none focus-visible:ring-4 focus-visible:ring-[#00b06f]/60 sm:h-44 sm:w-44"
                    >
                      {isPizza ? <PizzaArt /> : <CoinArt />}
                    </motion.button>
                    <div className="pointer-events-none absolute inset-0">
                      {pops.map((p) => (
                        <motion.span
                          key={p.id}
                          className="absolute text-lg font-black text-[#ffe08a]"
                          style={{
                            left: `${p.x}%`,
                            top: `${p.y}%`,
                            textShadow: "0 2px 4px rgba(0,0,0,0.65)",
                          }}
                          initial={{ opacity: 1, y: 6, scale: 0.9 }}
                          animate={{ opacity: 0, y: -64, scale: 1.05 }}
                          transition={{ duration: 0.75, ease: "easeOut" }}
                        >
                          {p.label}
                        </motion.span>
                      ))}
                    </div>
                  </div>
                  <BlockyWorker avatar={avatar} />
                </div>

                {/* conveyor flourish — speed rises with income (5 capped tiers) */}
                <div className="mt-4 h-9 w-full overflow-hidden rounded-[6px] border-y-2 border-[#151719] bg-[#2a2d2f]">
                  <motion.div
                    className="flex h-full w-[200%]"
                    animate={{ x: ["0%", "-50%"] }}
                    transition={{ duration: CONVEYOR_DURATIONS[speedTier], ease: "linear", repeat: Infinity }}
                  >
                    <ConveyorRow isPizza={isPizza} />
                    <ConveyorRow isPizza={isPizza} />
                  </motion.div>
                </div>
              </section>

              <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <UpgradeCard
                  title="Click Power"
                  desc={`+1 per tap — currently +${fmtBig(power)} per tap`}
                  level={save.clickLevel}
                  cost={clickCost(save.clickLevel)}
                  emoji={config.emoji}
                  affordable={save.coins >= clickCost(save.clickLevel)}
                  onBuy={buyClick}
                />
                <UpgradeCard
                  title="Golden Touch"
                  desc={`x1.25 tap power each — currently x${Math.pow(1.25, save.golden).toFixed(2)}`}
                  level={save.golden}
                  cost={save.golden >= MAX_GOLDEN ? null : goldenCost(save.golden)}
                  emoji={config.emoji}
                  affordable={save.golden >= MAX_GOLDEN || save.coins >= goldenCost(save.golden)}
                  onBuy={buyGolden}
                />
              </section>

              <section
                className="rounded-[8px] border p-3"
                style={{
                  borderColor: `${config.accent}55`,
                  background: `linear-gradient(135deg, ${config.accent}14, transparent 60%), #2e3133`,
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-black uppercase tracking-wide" style={{ color: config.accent }}>
                      Rebirth
                    </p>
                    <p className="text-[11px] leading-snug text-[#bdbebe]">
                      Resets {config.currency}, droppers &amp; click level — permanent x
                      {(1 + 0.5 * (save.rebirths + 1)).toFixed(1)} income multiplier.
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#bdbebe]">Rebirths</p>
                    <PopText value={String(save.rebirths)} className="text-xl font-black tabular-nums leading-none" />
                  </div>
                </div>
                <div className="mt-2 h-3 overflow-hidden rounded-full bg-black/40" role="progressbar" aria-label="Rebirth progress">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (save.coins / REBIRTH_REQ) * 100)}%`,
                      background: config.accent,
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] tabular-nums text-[#bdbebe]">
                    {fmtBig(save.coins)} / {fmtBig(REBIRTH_REQ)} {config.currency}
                  </p>
                  <button
                    type="button"
                    disabled={save.coins < REBIRTH_REQ}
                    onClick={doRebirth}
                    className={`${CHUNKY} h-11 px-5 text-sm ${
                      save.coins >= REBIRTH_REQ
                        ? "bg-[#ffc531] text-[#3a2a00] hover:bg-[#ffd23c]"
                        : "bg-[#3a3d40] text-[#bdbebe]"
                    }`}
                  >
                    REBIRTH
                  </button>
                </div>
              </section>
            </div>

            {/* ------------------------------ right ------------------------------ */}
            <aside className="veil-scroll-slim flex min-w-0 flex-col gap-2 rounded-[8px] border border-white/5 bg-[#232527] p-3 lg:min-h-0 lg:overflow-y-auto">
              <h2 className="text-xs font-black uppercase tracking-wider text-[#bdbebe]">
                Droppers — {fmtBig(income)}/s total
              </h2>
              <div className="veil-scroll-slim grid max-h-96 gap-2 overflow-y-auto overscroll-contain pr-1 lg:max-h-none lg:flex-1 lg:content-start">
                {tierList.map(({ tier, name }) => {
                  const owned = save.owned[tier];
                  const cost = tierCost(tier, owned);
                  const each = TIER_INCOME[tier] * rebirthMult(save.rebirths);
                  const affordable = save.coins >= cost;
                  return (
                    <div key={tier} className="flex items-center gap-2.5 rounded-[8px] bg-[#2e3133] p-2.5">
                      <div
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[6px]"
                        style={{
                          background: `linear-gradient(150deg, ${mixHex(config.accent, config.accent2, tier / 5)}, ${config.accent2})`,
                        }}
                      >
                        <span
                          className={
                            isPizza
                              ? "h-4 w-4 rounded-full bg-[#e8b563] shadow-[inset_0_-2px_3px_rgba(0,0,0,0.3)]"
                              : "h-4 w-4 rounded-full bg-[#ffe08a] shadow-[inset_0_-2px_3px_rgba(0,0,0,0.3)]"
                          }
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-[13px] font-bold">{name}</p>
                          <span className="shrink-0 rounded-full bg-black/30 px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-[#bdbebe]">
                            x{owned}
                          </span>
                        </div>
                        <p className="truncate text-[11px] tabular-nums text-[#bdbebe]">
                          +{fmtBig(each)}/s each{owned > 0 ? ` · ${fmtBig(each * owned)}/s` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!affordable}
                        onClick={() => buyTier(tier)}
                        className={`${CHUNKY} flex h-11 min-w-[74px] shrink-0 items-center justify-center gap-1 px-2 text-[13px] tabular-nums ${
                          affordable ? "bg-[#00b06f] text-white hover:bg-[#00c67d]" : "bg-[#3a3d40] text-[#bdbebe]"
                        }`}
                      >
                        {config.emoji} {fmtBig(cost)}
                      </button>
                    </div>
                  );
                })}
              </div>
            </aside>
          </div>

          <footer className="grid grid-cols-2 gap-px border-t border-white/5 bg-white/5 sm:grid-cols-4">
            <StatCell label="Total earned" value={`${config.emoji} ${fmtBig(save.totalEarned)}`} />
            <StatCell label="Rebirths" value={`${save.rebirths} (x${rebirthMult(save.rebirths).toFixed(1)})`} />
            <StatCell label="Income" value={`${fmtBig(income)}/s`} />
            <StatCell label="Per click" value={`+${fmtBig(power)}`} />
          </footer>
        </>
      )}

      {/* REBIRTH! celebration */}
      {celebrate && (
        <div className="absolute inset-0 z-40 flex items-center justify-center overflow-hidden bg-black/60">
          <motion.div
            aria-hidden
            className="absolute -inset-[45%]"
            style={{
              background: `repeating-conic-gradient(from 0deg, ${config.accent}30 0deg 14deg, transparent 14deg 36deg)`,
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 7, ease: "linear", repeat: Infinity }}
          />
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-white"
            initial={{ opacity: 0.85 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.55 }}
          />
          <motion.div
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 16 }}
            className="relative flex flex-col items-center gap-1"
          >
            <p
              className="text-5xl font-black tracking-widest sm:text-6xl"
              style={{ color: config.accent, textShadow: "0 4px 0 rgba(0,0,0,0.45)" }}
            >
              REBIRTH!
            </p>
            <p className="text-sm font-bold text-white">
              Permanent x{(1 + 0.5 * save.rebirths).toFixed(1)} multiplier unlocked
            </p>
          </motion.div>
        </div>
      )}

      {(escPaused || !active) && phase === "playing" && (
        <PauseVeil
          canResume={escPaused}
          onResume={() => setEscPaused(false)}
          onLeave={onExit}
        />
      )}

      {phase === "start" && (
        <StartOverlay
          name={exp.name}
          creator={exp.creator}
          desc={exp.desc}
          accent={config.accent}
          ready={ready}
          onReady={() => setReady(true)}
          onPlay={start}
        />
      )}
    </div>
  );
}
