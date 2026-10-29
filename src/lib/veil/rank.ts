/**
 * Veil Stream — the For You ranker, modeled on YouTube's two-stage
 * recommendation architecture (as described in "Deep Neural Networks for
 * YouTube Recommendations", 2016 + the 2019 MMoE ranking follow-up):
 *
 *   STAGE 1 — candidate generation: the server blend (trending US+GB,
 *   the derived popular wire, watched/subbed channel rails, and
 *   "up-next" recs for recently watched videos) hands over a wide pool
 *   of a few hundred plausible candidates. That pool arrives here.
 *
 *   STAGE 2 — ranking: this module scores every candidate against a
 *   compact "user embedding" built from THIS device's signals (watch
 *   history with recency decay, subscriptions, likes, and the current
 *   session's most recent watches), predicting SEVERAL objectives at
 *   once — expected watch time, click probability, satisfaction — and
 *   blending them into a composite "valued watch time" score, exactly
 *   the way YouTube deliberately moved OFF pure click-through-rate so
 *   clickbait doesn't win. Fresh uploads get a cold-start exploration
 *   boost (an initial pool of impressions to gather feedback), a tiny
 *   seeded jitter keeps the page from feeling frozen, already-watched
 *   videos are demoted, and a diversity pass interleaves channels the
 *   way YouTube's home feed never lets one channel dominate a screen.
 *
 * Everything is pure + client-side: the user's signals live in
 * localStorage and never leave the device, and re-ranking reacts to the
 * last few actions within a session in near-real-time.
 */

/* ------------------------------------------------------------------ */
/* Shapes (structural subsets of the stream YtCard — kept local so     */
/* this module stays dependency-free and testable)                     */
/* ------------------------------------------------------------------ */

export interface RankCard {
  id: string;
  title: string;
  author: string;
  authorId: string;
  verified: boolean;
  durationSec: number;
  views: number;
  publishedAt?: number;
  live: boolean;
  short?: boolean;
  why?: string;
}

export interface RankHistoryEntry {
  card: RankCard;
  at: number;
}

export interface RankSignals {
  /** watch history, newest first (card + watched-at ms). */
  history: RankHistoryEntry[];
  /** subscribed channel ids. */
  subs: string[];
  /** channels behind this device's LIKED videos. */
  likedChannels: string[];
  /** "Not interested" feedback (video-level): the video is removed from
   * the feed and its title/channel carry a small satisfaction penalty,
   * so similar items rank lower — YouTube's negative feedback loop. */
  notInterested?: RankNotInterested[];
  /** "Don't recommend channel" feedback (channel-level): the channel is
   * removed from the For You / Shorts / Popular surfaces entirely. */
  blockedChannels?: string[];
  /** video id → watched fraction 0..1 (the resume cursors). Feeds the
   * graded repeat demotion: finished videos sink hard, abandoned ones
   * sink gently and get the "continue watching" label — the way
   * YouTube's home treats a half-watched video as an invitation, not
   * a repeat. */
  watchFractions?: Record<string, number>;
  /** video id → times SHOWN without a pick (impression fatigue —
   * "stop recommending the same video 10x in a row"). 3+ starts
   * sinking, 5+ sinks hard, 10+ removes from For You entirely. */
  impressions?: Record<string, number>;
  /** THE SEED CONTEXT — the video currently being watched (the Up next
   * rail passes it). Powers the CHAIN objective: binge continuation is
   * the single strongest retention signal a watch page has (YouTube's
   * autoplay rail is tuned for "session time", and session time is won
   * one smooth hand-off at a time). Same-channel, same-series and
   * sequel-shaped candidates chain hardest. */
  chainSeed?: { id: string; title: string; authorId: string };
  /** current time (ms) — injectable for determinism in tests. */
  now?: number;
  /** per-load seed (drives exploration jitter + tie-breaking). */
  seed?: number;
}

export interface RankNotInterested {
  id: string;
  title?: string;
  authorId?: string;
  /** feedback time (ms) — old disinterest fades like old interest. */
  at?: number;
}

/* ------------------------------------------------------------------ */
/* Seeded RNG (mulberry32) — deterministic per load, reshuffles on     */
/* every reload without ever scrambling relative order badly           */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Tokenizer — shared with the server's near-dup pass in spirit: the   */
/* same stopword-free lowercase token set that powers topic matching   */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  "live", "4k", "hd", "hdtv", "ncaaf", "ncaa", "nfl", "nba", "mlb", "nhl", "ufc",
  "college", "football", "basketball", "stream", "streaming", "watch", "full",
  "game", "games", "week", "highlights", "espn", "fox", "free", "men", "women",
  "the", "and", "for", "new", "video", "official", "you", "your", "with", "how",
  "why", "what", "this", "that", "from", "they", "them", "was", "are", "is",
]);

export function tokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

/* ------------------------------------------------------------------ */
/* Series markers — "part 3", "ep 5", "#12": the binge-chain detector   */
/* ------------------------------------------------------------------ */

const SERIES_RE = /\b(?:part|pt|ep|episode|#)\s*(\d{1,3})\b/i;

/** The episode marker in a title, or null ("Part 2" → 2). */
export function seriesMark(title: string): number | null {
  const m = (title || "").match(SERIES_RE);
  return m ? parseInt(m[1], 10) : null;
}

/* ------------------------------------------------------------------ */
/* The user profile — a compact, interpretable "embedding": channel    */
/* affinity, topic affinity, duration preference                       */
/* ------------------------------------------------------------------ */

interface UserProfile {
  /** channel id → affinity in roughly [0, 6+] (saturates via x/(x+3)). */
  channel: Map<string, number>;
  /** topic token → weight. */
  topic: Map<string, number>;
  /** topic token → negative weight (from "not interested" titles). */
  penalty: Map<string, number>;
  /** median watched duration (seconds, non-shorts) — duration fit. */
  medianDur: number;
  /** the most recent session's channels (near-real-time reactivity). */
  sessionChans: Set<string>;
  /** the most recent session's topic tokens. */
  sessionToks: Set<string>;
  /** watched video ids (for demotion). */
  watched: Set<string>;
  /** "not interested" video ids (for removal). */
  hidden: Set<string>;
  /** blocked channel ids (for removal). */
  blocked: Set<string>;
  /** total watches — cold-start switch. */
  total: number;
}

const HALF_LIFE_MS = 3 * 24 * 3600 * 1000; // recency half-life: 3 days
const SESSION_WINDOW_MS = 45 * 60 * 1000; // "the last few actions"
const SESSION_DEPTH = 5;

function decay(at: number, now: number): number {
  const age = Math.max(0, now - at);
  return Math.pow(0.5, age / HALF_LIFE_MS);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function buildProfile(s: RankSignals): UserProfile {
  const now = s.now ?? Date.now();
  const channel = new Map<string, number>();
  const topic = new Map<string, number>();
  const penalty = new Map<string, number>();
  const durations: number[] = [];
  const watched = new Set<string>();

  /* "Not interested" — the negative mirror of the watch signal: the
   * video's own title tokens get a decayed penalty (topic-level "show
   * me fewer like this"), and the channel behind it takes a modest
   * affinity hit so three strikes demote it without nuking a channel
   * the user otherwise watches. YouTube's feedback works exactly this
   * way: video removed now, "fewer like this" softly after. The penalty
   * weight (1.6) is ~1.5 watches worth of negative signal — one NI
   * perceptibly demotes similar items without erasing a loved topic. */
  const hidden = new Set<string>();
  for (const ni of s.notInterested ?? []) {
    if (!ni?.id) continue;
    hidden.add(ni.id);
    const w = decay(ni.at ?? now, now) * 1.6;
    for (const t of tokens(ni.title || "")) penalty.set(t, (penalty.get(t) ?? 0) + w);
    if (ni.authorId) channel.set(ni.authorId, (channel.get(ni.authorId) ?? 0) - 0.8);
  }
  const blocked = new Set(s.blockedChannels ?? []);

  /* watch history — each watch contributes a "valued watch time" proxy:
   * longer watches of the channel count more (log-compressed), and the
   * contribution decays with a 3-day half-life so the profile tracks
   * what you've been into LATELY, not forever-ago. */
  for (const h of s.history) {
    const c = h.card;
    if (!c) continue;
    watched.add(c.id);
    const w = decay(h.at, now) * (1 + Math.log1p(Math.max(0, c.durationSec || 0) / 60));
    if (c.authorId) channel.set(c.authorId, (channel.get(c.authorId) ?? 0) + w);
    const tw = w * 0.8;
    for (const t of tokens(c.title || "")) topic.set(t, (topic.get(t) ?? 0) + tw);
    if (!c.short && (c.durationSec ?? 0) > 30) durations.push(c.durationSec);
  }

  /* subscriptions — a standing-order signal, stronger than any single
   * watch, decayed gently by sub date so ancient subs fade a little. */
  for (const id of s.subs) {
    channel.set(id, (channel.get(id) ?? 0) + 2.5);
    for (const t of tokens(id)) topic.set(t, (topic.get(t) ?? 0) + 0.1);
  }

  /* likes — explicit satisfaction feedback; the channel behind a liked
   * video gets a solid bump (YouTube's satisfaction objective). */
  for (const id of s.likedChannels) {
    channel.set(id, (channel.get(id) ?? 0) + 1.5);
  }

  /* the session slice — the most recent watches inside a 45-minute
   * window power near-real-time reactivity: "recommendations react to
   * your last few actions within a session". */
  const sessionChans = new Set<string>();
  const sessionToks = new Set<string>();
  const recent = s.history.slice(0, SESSION_DEPTH);
  const newestAt = recent.length > 0 ? Math.max(...recent.map((h) => h.at || 0)) : 0;
  for (const h of recent) {
    if (!h.card) continue;
    if (newestAt - (h.at || 0) > SESSION_WINDOW_MS) continue;
    if (h.card.authorId) sessionChans.add(h.card.authorId);
    for (const t of tokens(h.card.title || "")) sessionToks.add(t);
  }

  return {
    channel,
    topic,
    penalty,
    medianDur: median(durations),
    sessionChans,
    sessionToks,
    watched,
    hidden,
    blocked,
    total: s.history.length,
  };
}

/* ------------------------------------------------------------------ */
/* Stage 2 — multi-objective ranking (MMoE-flavored blend)             */
/* ------------------------------------------------------------------ */

interface Objectives {
  /** expected watch time — the head of the composite, as at YouTube. */
  expWatch: number;
  /** click probability proxy (topical + familiarity + freshness). */
  click: number;
  /** satisfaction proxy (liked channel, verified, popularity prior). */
  satisfaction: number;
  /** freshness — YouTube favors recent uploads, decaying over days. */
  freshness: number;
  /** near-real-time session reaction. */
  session: number;
  /** cold-start exploration for fresh/unknown uploads + ε-jitter. */
  explore: number;
  /** BINGE CHAIN — continuity with the seed video (Up next only):
   * same channel, shared title tokens, direct sequels. Retention is
   * the goal — the rail's job is to make leaving feel like a loss. */
  chain: number;
}

/* Retention-tuned weights (sum 1.0). The session + chain pair carries
 * almost a third of the blend now — "keep them watching" beats "get
 * the click" (a click that ends the session is a losing click). */
const W = {
  expWatch: 0.28,
  click: 0.17,
  satisfaction: 0.13,
  freshness: 0.08,
  session: 0.15,
  explore: 0.05,
  chain: 0.14,
};

function scoreCard(c: RankCard, p: UserProfile, rand: () => number, s: RankSignals): Objectives {
  const affinity = Math.min(1, (p.channel.get(c.authorId) ?? 0) / ((p.channel.get(c.authorId) ?? 0) + 3));

  /* topic match — the share of the candidate's distinctive tokens the
   * user has affinity for, normalized so long titles don't win by bulk.
   * "Not interested" penalties subtract first, so a title made of
   * previously-dismissed tokens scores BELOW a no-signal title. */
  const toks = tokens(c.title || "");
  let tSum = 0;
  let tHit = 0;
  for (const t of toks) {
    const net = (p.topic.get(t) ?? 0) - (p.penalty.get(t) ?? 0);
    tSum += Math.max(0, net);
    if (net > 0.05) tHit++;
  }
  const topicMatch = toks.length === 0 ? 0 : Math.min(1, (tHit / toks.length) * 0.7 + Math.min(0.3, tSum / 8));

  /* duration fit — gaussian around the user's median watched length */
  let durFit = 0.45;
  if (p.medianDur > 0 && (c.durationSec ?? 0) > 0 && !c.short) {
    const d = c.durationSec;
    const ratio = Math.max(d, p.medianDur) / Math.max(1, Math.min(d, p.medianDur));
    durFit = Math.exp(-Math.pow(Math.log(ratio), 2) / 1.6); // ~½ at 4× off
  }

  /* freshness — exponential decay over 3 days (YouTube's recency bias) */
  let freshness = 0;
  {
    const ageH =
      c.publishedAt && c.publishedAt > 0
        ? Math.max(0, (Date.now() / 1000 - c.publishedAt) / 3600)
        : c.views === 0
          ? 0.5 // "just dropped" wire items with no view count yet
          : 24 * 30; // unknown → treat as a month old
    freshness = Math.exp(-ageH / 72);
  }

  /* satisfaction — liked channels max out; verified + popularity prior
   * (log-compressed view count) approximate the quality guardrails */
  let satisfaction = 0.25 + Math.min(0.35, Math.log10(1 + Math.max(0, c.views || 0)) / 12);
  if (c.verified) satisfaction += 0.15;

  /* session — did you JUST watch this channel/topic? */
  const inSessionChan = p.sessionChans.has(c.authorId);
  let sessionTokHits = 0;
  for (const t of toks) if (p.sessionToks.has(t)) sessionTokHits++;
  const sessionTokMatch = toks.length === 0 ? 0 : Math.min(1, sessionTokHits / Math.max(2, toks.length));
  const session = Math.min(1, (inSessionChan ? 0.75 : 0) + sessionTokMatch * 0.6);

  /* cold-start exploration — fresh uploads (few views / just published)
   * get an initial pool of impressions, the way YouTube gathers early
   * feedback instead of burying new videos; plus a tiny ε jitter so the
   * page isn't byte-identical forever (and re-deals on reload). */
  const cold = (c.views ?? 0) < 1000 || freshness > 0.6 ? 0.5 : 0.12;
  const explore = cold * (0.5 + rand() * 0.5);

  const familiarity = affinity > 0.05 ? 1 : 0;
  const click =
    0.38 * topicMatch + 0.3 * familiarity + 0.16 * freshness + (c.live ? 0.1 : 0) + 0.06 * durFit;

  const expWatch = 0.5 * affinity + 0.28 * durFit + 0.22 * topicMatch;

  /* the binge chain — continuity with the video ON SCREEN right now.
   * Same channel is half the score (a channel you're mid-session on is
   * the strongest "one more" predictor there is), shared distinctive
   * tokens (series names, subjects) add up to half, and a DIRECT
   * sequel ("part 3" watching → "part 4" candidate) is a straight
   * +0.35 — the exact moment YouTube's autoplay earns its keep. */
  let chain = 0;
  const seed = s.chainSeed;
  if (seed && seed.id !== c.id) {
    const seedToks = new Set(tokens(seed.title || ""));
    if (seedToks.size > 0) {
      let hits = 0;
      for (const t of toks) if (seedToks.has(t)) hits++;
      chain += Math.min(0.5, (hits / Math.max(2, seedToks.size)) * 0.65);
    }
    if (seed.authorId && c.authorId === seed.authorId) chain += 0.5;
    const sm = seriesMark(seed.title || "");
    const cm = seriesMark(c.title || "");
    if (sm !== null && cm !== null && cm === sm + 1) chain += 0.35;
    chain = Math.min(1, chain);
  }

  /* satisfaction refinement — a liked channel is a known-good source */
  // (likedChannels already lifted affinity via the profile)

  return { expWatch, click, satisfaction, freshness, session, explore, chain };
}

/** The "why" label — derived from the DOMINANT objective, so the chip
 * on the card is an honest explanation of the ranking (YouTube shows
 * the same "New from X", "Popular right now", "Because you watched…").
 * The first two strings are load-bearing: they match the user's
 * veil.stream.history.v1 data format exactly. */
function whyLabel(c: RankCard, p: UserProfile, o: Objectives, s: RankSignals): string | undefined {
  const sub = new Set(s.subs);
  const liked = new Set(s.likedChannels);
  const freshish = o.freshness > 0.45;
  const author = (c.author || "").trim();

  if (freshish && (sub.has(c.authorId) || liked.has(c.authorId) || (p.channel.get(c.authorId) ?? 0) > 1.2)) {
    return author ? `new from ${author}` : "new from your channels";
  }
  /* the resume invitation outranks freshness — a half-watched video
   * is the strongest "pick me" signal on the page */
  {
    const frac = s.watchFractions?.[c.id] ?? 0;
    if (frac >= 0.05 && frac < 0.95 && s.history.some((h) => h.card?.id === c.id)) {
      return "continue watching";
    }
  }
  /* the binge chain — only in a seeded (Up next) context */
  if (o.chain > 0.6 && s.chainSeed) {
    const sm = seriesMark(s.chainSeed.title || "");
    const cm = seriesMark(c.title || "");
    if (sm !== null && cm === sm + 1) return `part ${cm} — you're on part ${sm}`;
    return "next in this series";
  }
  if (o.chain > 0.4 && s.chainSeed && s.chainSeed.authorId === c.authorId) {
    return author ? `more from ${author}` : "more from this channel";
  }
  if (o.satisfaction > 0.55 && (c.views ?? 0) > 80_000) return "popular right now";
  if (o.session > 0.5 && p.total > 0) {
    const src = s.history.find((h) => h.card?.authorId === c.authorId && p.sessionChans.has(c.authorId));
    const t = (src?.card?.title || "").trim();
    if (t) {
      const short = t.length > 30 ? `${t.slice(0, 29)}…` : t;
      return `because you watched ${short}`;
    }
    return "because you watched this channel";
  }
  if (sub.has(c.authorId)) return "from your subscriptions";
  if (liked.has(c.authorId)) return "recommended for you";
  return c.why; // keep the server's tag when nothing stronger applies
}

/* ------------------------------------------------------------------ */
/* Diversity pass — YouTube's home feed never lets one channel own a   */
/* screen: cap per channel, enforce spacing, keep the mix breathing    */
/* ------------------------------------------------------------------ */

function diversify(
  scored: { c: RankCard; s: number }[],
  mode?: { cap: number; spacing: number },
): RankCard[] {
  const out: { c: RankCard; s: number }[] = [];
  const perChan = new Map<string, number>();
  const lastAt = new Map<string, number>();
  const CAP = mode?.cap ?? 3; // max cards per channel in the whole page
  const SPACING = mode?.spacing ?? 3; // min positions between same-channel cards

  const pending = [...scored];
  while (out.length < scored.length) {
    let placed = false;
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      const chan = item.c.authorId || item.c.author;
      const n = perChan.get(chan) ?? 0;
      const last = lastAt.get(chan);
      if (n >= CAP) continue;
      if (last !== undefined && out.length - last < SPACING && pending.length > 1) continue;
      out.push(item);
      perChan.set(chan, n + 1);
      lastAt.set(chan, out.length - 1);
      pending.splice(i, 1);
      placed = true;
      break;
    }
    if (!placed) {
      /* nothing fits the spacing rule anymore — relax it for the rest */
      out.push(...pending);
      break;
    }
  }
  return out.map((x) => x.c);
}

/* ------------------------------------------------------------------ */
/* The public ranker                                                   */
/* ------------------------------------------------------------------ */

export interface RankResult {
  cards: RankCard[];
  /** profile diagnostics (top channels/topics) — powers the "For You"
   * header tooltip so the personalization is visible, not magic. */
  profile: {
    topChannels: { id: string; name: string; weight: number }[];
    topTopics: { token: string; weight: number }[];
    watches: number;
  };
}

/** rankFeed options — `rail` loosens the diversity caps for the watch
 * page's Up next list: a binge chain WANTS consecutive same-channel
 * cards (that's the whole point of a series), so spacing drops to 1
 * and the per-channel cap rises. */
export interface RankOpts {
  rail?: boolean;
}

export function rankFeed(candidates: RankCard[], s: RankSignals, opts?: RankOpts): RankResult {
  const now = s.now ?? Date.now();
  const rand = mulberry32((s.seed ?? 1) * 2654435761);
  const p = buildProfile(s);

  /* dedupe by id (the pool blends several wires), keep first */
  const seen = new Set<string>();
  const pool = candidates.filter((c) => c && c.id && !seen.has(c.id) && (seen.add(c.id), true));

  /* negative-feedback hard filter — "Not interested" videos and
   * "Don't recommend channel" channels never render on the feed, the
   * same way YouTube's home drops them from the page entirely. So do
   * videos IGNORED ten-plus times: the user has seen them and scrolled
   * past every single time — that's a no. (Search/channel pages are
   * untouched; this filter only shapes recommendations.) */
  const visible = pool.filter(
    (c) => !p.hidden.has(c.id) && !p.blocked.has(c.authorId) && (s.impressions?.[c.id] ?? 0) < 10,
  );

  const scored = visible.map((c) => {
    const o = scoreCard(c, p, rand, s);
    let score =
      W.expWatch * o.expWatch +
      W.click * o.click +
      W.satisfaction * o.satisfaction +
      W.freshness * o.freshness +
      W.session * o.session +
      W.explore * o.explore +
      W.chain * o.chain;
    /* repeat demotion — GRADED by how far the watch actually got
     * (YouTube's home feed rarely shows what you just watched; the
     * History page is for that):
     *   finished (≥95%)  → ×0.30  sunk, the re-watch invite lives in
     *                             the Watch-it-again shelf
     *   partial (5–95%)  → ×0.82  a gentle dip — the card keeps its red
     *                             resume bar and the "continue watching"
     *                             label, exactly the home-feed treatment
     *   barely started   → ×0.45  a click that didn't stick still counts */
    if (p.watched.has(c.id)) {
      const frac = s.watchFractions?.[c.id] ?? 0;
      score *= frac >= 0.95 ? 0.3 : frac >= 0.05 ? 0.82 : 0.45;
    }
    /* impression fatigue — a video shown over and over without a pick
     * loses standing the way YouTube's home stopped letting repeat
     * impressions dominate: 3+ scrolls-past sink it, 5+ (the user's
     * "I'm ignoring this" threshold) nearly buries it. A watch resets
     * the counter entirely (clearImpression on pushHistory). */
    {
      const im = s.impressions?.[c.id] ?? 0;
      if (im >= 5) score *= 0.18;
      else if (im >= 3) score *= 0.45;
    }
    /* live events get a small standing boost — they expire, watch them now */
    if (c.live) score *= 1.12;
    /* ε-jitter — the calibrated noise that keeps rankings from ossifying */
    score += (rand() - 0.5) * 0.03;
    return { c, s: score, o };
  });
  scored.sort((a, b) => b.s - a.s);

  /* attach honest why-labels to the TOP slice (the visible page); deep
   * tail cards keep whatever the server tagged) */
  const labeled = scored.map((x) => ({
    ...x,
    c: { ...x.c, why: whyLabel(x.c, p, x.o, s) },
  }));

  const topChannels = [...p.channel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, weight]) => ({
      id,
      name:
        s.history.find((h) => h.card?.authorId === id)?.card?.author ??
        (s.subs.includes(id) ? id : id),
      weight: Math.round(weight * 10) / 10,
    }));
  const topTopics = [...p.topic.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([token, weight]) => ({ token, weight: Math.round(weight * 10) / 10 }));

  return {
    cards: diversify(labeled, opts?.rail ? { cap: 6, spacing: 1 } : undefined),
    profile: { topChannels, topTopics, watches: p.total },
  };
}
