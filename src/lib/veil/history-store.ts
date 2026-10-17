/**
 * Veil — watch history store (IndexedDB, 1,000,000-row class).
 *
 * History used to live in one localStorage string, which capped the whole
 * feature at whatever fit the browser's ~5MB quota (~12k rows) no matter
 * how high the row caps were raised — a full YouTube Takeout import
 * silently kept only the newest slice. This module moves the store to
 * IndexedDB (hundreds of MB, still per-device, still never uploaded)
 * while keeping the READ path synchronous for the UI:
 *
 *   • a full in-memory mirror (newest-first, deduped by video id) is
 *     primed once at startup — historySnapshot() reads it with zero
 *     copies, exactly like the old localStorage parse did;
 *   • every mutation updates the mirror synchronously, dispatches the
 *     same "veil-stream-history" event the app already listens for, and
 *     enqueues the IndexedDB write on a serialized queue in the
 *     background (a single watch = one tiny put, not a 1M-row rewrite);
 *   • big imports persist in chunked transactions (4k rows each) and
 *     report the honest landed count — IndexedDB quota errors stop the
 *     chunk loop instead of corrupting the store;
 *   • the first run migrates the old "veil.stream.history.v1"
 *     localStorage payload into IndexedDB (merge by id, newest `at`
 *     wins) and then frees that key, releasing ~5MB of quota back;
 *   • browsers without IndexedDB fall back to the legacy localStorage
 *     behavior (quota-trimmed) so the app never loses the feature.
 *
 * The row cap (HISTORY_CAP) is the single source of truth — the Stream
 * section imports it so parse, store and UI all agree on "1 million".
 */

export interface VeilHistoryCard {
  id: string;
}
export interface VeilHistoryRow {
  card: VeilHistoryCard;
  at: number;
}

export const HISTORY_CAP = 1_000_000;
export const HISTORY_EVENT = "veil-stream-history";
export const HISTORY_LS_KEY = "veil.stream.history.v1";

const DB_NAME = "veil-stream";
const DB_VERSION = 1;
const STORE = "history";
/** rows per IndexedDB transaction — big imports commit in slices so the
 * browser keeps responding and a quota error only costs the tail */
const PUT_CHUNK = 4000;
/** the localStorage fallback's byte budget (the old writeHistory logic) */
const LS_BUDGET = 4.5 * 1024 * 1024;

let db: IDBDatabase | null = null;
/** "idb" (normal) | "ls" (no IndexedDB — legacy localStorage mode) */
let mode: "idb" | "ls" = "idb";
/** newest-first mirror of the whole store; null until historyReady() lands */
let mirror: VeilHistoryRow[] | null = null;
let readyPromise: Promise<VeilHistoryRow[]> | null = null;
/** serialized write queue — never interleave a clear with chunked puts */
let queueTail: Promise<unknown> = Promise.resolve();

/* ── tiny helpers ─────────────────────────────────────────────────── */

function announce(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(HISTORY_EVENT));
}

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = queueTail.then(op, op);
  queueTail = run.catch(() => undefined);
  return run;
}

function tx(mode_: IDBTransactionMode): { store: IDBObjectStore; done: Promise<void> } {
  const t = db!.transaction(STORE, mode_);
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error("idb transaction failed"));
    t.onabort = () => reject(t.error ?? new Error("idb transaction aborted"));
  });
  return { store: t.objectStore(STORE), done };
}

function normalizeRow(v: unknown): VeilHistoryRow | null {
  if (!v || typeof v !== "object") return null;
  const r = v as { card?: { id?: unknown }; at?: unknown };
  const id = r.card?.id;
  if (typeof id !== "string" || !id) return null;
  return { card: r.card as VeilHistoryCard, at: typeof r.at === "number" ? r.at : 0 };
}

/* ── init / migration ─────────────────────────────────────────────── */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: "card.id" });
        s.createIndex("at", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onblocked = () => reject(new Error("indexedDB blocked by another tab"));
  });
}

/** Everything in the store, newest-first. Reads via the PRIMARY KEY in
 * PAGES — one giant getAll() must serialize its whole result into a
 * single mojo message, and past ~200MB of rows Chromium silently never
 * resolves it (the million-row class hung exactly there); 100k-row
 * pages (~35MB) chain inside one transaction instead. The JS sort is
 * index-independent, so a rebuilt/migrated database whose "at" index
 * rows are missing still loads whole. */
const LOAD_PAGE = 100_000;
function loadAll(): Promise<VeilHistoryRow[]> {
  return new Promise((resolve, reject) => {
    const t = db!.transaction(STORE, "readonly");
    const store = t.objectStore(STORE);
    const out: VeilHistoryRow[] = [];
    let lastKey: string | null = null;
    const fail = (e: unknown) => reject(e instanceof Error ? e : new Error("idb getAll failed"));
    const step = () => {
      /* keyPath is "card.id" — page by primary key, exclusive of the
       * last one seen (keys are unique, no duplicates slip through) */
      const range = lastKey === null ? null : IDBKeyRange.lowerBound(lastKey, true);
      const req = store.getAll(range, LOAD_PAGE);
      req.onsuccess = () => {
        const batch = req.result ?? [];
        for (const raw of batch) {
          const r = normalizeRow(raw);
          if (r) out.push(r);
        }
        const last = batch[batch.length - 1] as { card?: { id?: unknown } } | undefined;
        const nextKey = typeof last?.card?.id === "string" ? last.card.id : null;
        if (batch.length < LOAD_PAGE || nextKey === null || nextKey === lastKey) {
          out.sort((a, b) => b.at - a.at); /* newest first */
          resolve(out);
          return;
        }
        lastKey = nextKey;
        step();
      };
      req.onerror = () => fail(req.error);
    };
    step();
  });
}

/* ── two-stage priming ──────────────────────────────────────────────
 *
 * The FULL river read (loadAll) is the only path that knows the whole
 * store — but on a Takeout-scale history (a million rows, hundreds of
 * MB) it takes minutes, and Chromium can silently never resolve the
 * giant getAll pages at all. The UI must not wait for it: For You's
 * seen-list caps at 20k ids, the ranker's signal window at 5k rows, the
 * History tab pages 24 — so STAGE 1 walks the "at" INDEX backwards for
 * the newest NEWEST_N rows (a B-tree seek plus N cursor hops — instant
 * at any store size) and lands the mirror in well under a second.
 * STAGE 2 then reads the whole river in the background and swaps the
 * complete set in; even if it never lands, the app keeps working on
 * the newest slice. Every step is deadline-guarded — a wedged
 * IndexedDB (corrupted store, frozen private mode) resolves with what
 * it has instead of hanging the feed forever. */
const NEWEST_N = 25_000;
const OPEN_MS = 2_500;
const STAGE1_MS = 4_000;

/** Resolve with `fallback` once `ms` passes — never leave a caller
 *  waiting on a promise that may not settle. */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The newest `n` rows, newest-first — reverse cursor over the "at"
 *  index, deadline-guarded. A missing index throws synchronously and
 *  resolves empty; the caller falls back to the full read. */
function loadNewest(n: number, deadlineMs: number): Promise<VeilHistoryRow[]> {
  return new Promise((resolve) => {
    if (!db) {
      resolve([]);
      return;
    }
    const out: VeilHistoryRow[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(out);
    };
    timer = setTimeout(finish, deadlineMs);
    try {
      const t = db.transaction(STORE, "readonly");
      t.onabort = () => finish();
      const req = t.objectStore(STORE).index("at").openCursor(null, "prev");
      req.onsuccess = () => {
        if (settled) return; /* deadline won — let the txn commit */
        const cur = req.result;
        if (!cur || out.length >= n) {
          finish();
          return;
        }
        const r = normalizeRow(cur.value);
        if (r) out.push(r);
        cur.continue();
      };
      req.onerror = () => finish();
    } catch {
      finish();
    }
  });
}

/** Live mutations recorded while stage 2 was still reading, replayed
 *  on top of the full set: id → row (a touch) | null (a delete). */
let priming = false;
let primePatches: Map<string, VeilHistoryRow | null> | null = null;
let primeCleared = false;
let settledPromise: Promise<void> | null = null;

function notePatch(id: string, row: VeilHistoryRow | null): void {
  if (priming && primePatches && id) primePatches.set(id, row);
}

/** Stage 2 — the full river, then swap it in. Merge rules: the full
 *  read is the base; the live mirror overlays it (newest `at` per id —
 *  covers watches and bulk imports that landed mid-prime); a clear
 *  drops the base entirely; patch nulls delete, patch rows re-apply. */
async function finishPrime(): Promise<void> {
  await migrateLegacy();
  const full = await loadAll();
  const byId = new Map<string, VeilHistoryRow>();
  if (!primeCleared) for (const r of full) byId.set(r.card.id, r);
  for (const r of mirror ?? []) {
    const prev = byId.get(r.card.id);
    if (!prev || r.at >= prev.at) byId.set(r.card.id, r);
  }
  if (primePatches) {
    for (const [id, row] of primePatches) {
      if (row === null) byId.delete(id);
      else byId.set(id, row);
    }
  }
  mirror = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_CAP);
  announce();
}

function countAll(): Promise<number> {
  return new Promise((resolve) => {
    const t = db!.transaction(STORE, "readonly");
    const req = t.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result ?? 0);
    req.onerror = () => resolve(0);
  });
}

/** Chunked bulk put. Returns how many rows actually landed — an
 * IndexedDB quota error stops the loop and reports the tail as lost. */
function putChunked(rows: VeilHistoryRow[]): Promise<number> {
  let landed = 0;
  const run = async (): Promise<number> => {
    for (let i = 0; i < rows.length; i += PUT_CHUNK) {
      const chunk = rows.slice(i, i + PUT_CHUNK);
      try {
        const { store, done } = tx("readwrite");
        for (const r of chunk) store.put(r);
        await done;
        landed += chunk.length;
      } catch {
        break; /* quota or worse — keep what landed */
      }
    }
    return landed;
  };
  return enqueue(run);
}

function clearStore(): Promise<void> {
  return enqueue(async () => {
    const { store, done } = tx("readwrite");
    store.clear();
    await done;
  });
}

/** Delete the OLDEST rows so the store physically fits HISTORY_CAP
 * (reads already slice to the cap — this reclaims the disk space).
 * Index-independent: reads everything, sorts, deletes the tail by
 * primary key. */
function trimOverCap(): Promise<void> {
  return enqueue(async () => {
    const total = await countAll();
    const excess = total - HISTORY_CAP;
    if (excess <= 0) return;
    const all = await loadAll();
    const oldest = all.slice(HISTORY_CAP).map((r) => r.card.id);
    if (oldest.length === 0) return;
    const { store, done } = tx("readwrite");
    for (const id of oldest) store.delete(id);
    await done;
  });
}

function readLegacyLs(): VeilHistoryRow[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: VeilHistoryRow[] = [];
    for (const v of parsed) {
      const r = normalizeRow(v);
      if (r) rows.push(r);
    }
    return rows;
  } catch {
    return [];
  }
}

/** One-time: move the old localStorage history into IndexedDB, then
 * free the key (releasing ~5MB of quota for everything else). */
async function migrateLegacy(): Promise<void> {
  const legacy = readLegacyLs();
  if (legacy.length === 0) {
    /* nothing to migrate — but if a previous run wrote the key empty,
     * still drop it so nothing reads stale data */
    try {
      window.localStorage.removeItem(HISTORY_LS_KEY);
    } catch {
      /* best-effort */
    }
    return;
  }
  const existing = await loadAll();
  const byId = new Map<string, VeilHistoryRow>();
  for (const r of [...existing, ...legacy]) {
    const prev = byId.get(r.card.id);
    if (!prev || r.at > prev.at) byId.set(r.card.id, r);
  }
  const merged = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_CAP);
  const landed = await putChunked(merged);
  if (landed >= merged.length) {
    try {
      window.localStorage.removeItem(HISTORY_LS_KEY);
    } catch {
      /* best-effort */
    }
  }
}

/** Prime the mirror — TWO STAGES (see the block comment above
 *  loadNewest). Stage 1 lands the newest slice and resolves; stage 2
 *  reads the full river detached and swaps it in. Idempotent;
 *  auto-kicked on client module load so the first historySnapshot()
 *  usually already has data. */
export function historyReady(): Promise<VeilHistoryRow[]> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (typeof window === "undefined") {
      mirror = [];
      settledPromise = Promise.resolve();
      return [];
    }
    if (typeof indexedDB !== "undefined") {
      try {
        db = await withDeadline(openDb(), OPEN_MS, null);
      } catch {
        db = null;
      }
    }
    mode = db ? "idb" : "ls";
    if (mode === "idb") {
      /* STAGE 1 — the newest slice, deadline-guarded */
      let newest: VeilHistoryRow[] = [];
      try {
        newest = await loadNewest(NEWEST_N, STAGE1_MS);
      } catch {
        newest = [];
      }
      /* un-migrated legacy rows ride along (merged by newest `at`; the
       * write-side migration still belongs to stage 2) */
      const legacy = readLegacyLs();
      if (legacy.length > 0) {
        const byId = new Map<string, VeilHistoryRow>();
        for (const r of [...newest, ...legacy]) {
          const prev = byId.get(r.card.id);
          if (!prev || r.at > prev.at) byId.set(r.card.id, r);
        }
        newest = [...byId.values()].sort((a, b) => b.at - a.at);
      }
      mirror = newest.slice(0, NEWEST_N);
      announce(); /* the feed unblocks on the newest slice alone */
      /* STAGE 2 — only when there is more river than the slice (or a
       * legacy payload still waiting on its write-side migration) */
      let total = -1;
      try {
        total = await withDeadline(countAll(), 2_000, -1);
      } catch {
        total = -1;
      }
      if (total > mirror.length || legacy.length > 0) {
        priming = true;
        primePatches = new Map();
        primeCleared = false;
        settledPromise = (async () => {
          try {
            await finishPrime();
          } catch {
            /* the full river read failed — the newest slice keeps serving */
          } finally {
            priming = false;
          }
        })();
      } else {
        settledPromise = Promise.resolve();
      }
    } else {
      mirror = readLegacyLs().slice(0, HISTORY_CAP);
      settledPromise = Promise.resolve();
    }
    return mirror;
  })();
  return readyPromise;
}

/** Resolves once the mirror holds the FULL store — stage 2 done, or
 *  never needed. Backups await this so they carry everything even when
 *  the prime is still reading the deep river. */
export function historySettled(): Promise<void> {
  if (settledPromise) return settledPromise;
  return historyReady().then(() => settledPromise ?? Promise.resolve());
}

/* ── sync reads (mirror) ──────────────────────────────────────────── */

/** The whole history, newest-first, deduped by video id. READ-ONLY —
 * callers must not mutate (sort/slice into copies like they always did
 * with the parsed localStorage array). Zero-copy: the internal mirror
 * is handed out directly so a million rows cost one array, not a
 * fresh 8MB copy per call. */
export function historySnapshot<C>(): { card: C; at: number }[] {
  return (mirror ?? []) as unknown as { card: C; at: number }[];
}

export function historyCount(): number {
  return mirror?.length ?? 0;
}

/** Serialize the mirror as the exact legacy localStorage JSON — the
 * on-disk backup format (veil.stream.history.v1) never changes, only
 * where it lives does. Chunked stringify so a 1M-row backup doesn't
 * double-buffer through JSON.stringify's replacer path. */
export function historySerialize(): string {
  const rows = mirror ?? [];
  if (rows.length === 0) return "[]";
  const parts: string[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) parts[i] = JSON.stringify(rows[i]);
  return `[${parts.join(",")}]`;
}

/* ── localStorage fallback (no IndexedDB) ──────────────────────────── */

function persistLs(): void {
  if (mode !== "ls" || !mirror) return;
  try {
    window.localStorage.setItem(HISTORY_LS_KEY, JSON.stringify(mirror));
  } catch {
    /* quota — step down until the newest rows fit (legacy logic) */
    try {
      const sample = mirror.slice(0, 100);
      const avg = Math.max(64, (JSON.stringify(sample).length + 2) / Math.max(1, sample.length));
      let keep = Math.min(mirror.length, Math.floor(LS_BUDGET / avg));
      while (keep > 0) {
        try {
          window.localStorage.setItem(HISTORY_LS_KEY, JSON.stringify(mirror.slice(0, keep)));
          mirror = mirror.slice(0, keep);
          break;
        } catch {
          keep = Math.floor(keep * 0.85);
        }
      }
    } catch {
      /* storage unavailable entirely — history stays best-effort */
    }
  }
}

/* ── mutations (sync mirror + queued persist) ─────────────────────── */

/** Record a watch (or re-record with a known timestamp — the undo
 * restore uses the entry's original `at`). Updates the mirror
 * immediately (as a NEW array — React state set with the same
 * reference would bail out of re-rendering), persists one tiny put
 * in the background. */
export function historyTouch(card: VeilHistoryCard, at = Date.now()): void {
  if (typeof window === "undefined" || !card?.id) return;
  if (mirror === null) {
    void historyReady().then(() => historyTouch(card, at));
    return;
  }
  const row: VeilHistoryRow = { card, at };
  const idx = mirror.findIndex((h) => h.card.id === card.id);
  mirror =
    idx >= 0
      ? [row, ...mirror.slice(0, idx), ...mirror.slice(idx + 1)]
      : [row, ...mirror];
  if (mirror.length > HISTORY_CAP) mirror.length = HISTORY_CAP;
  notePatch(card.id, row);
  if (mode === "idb" && db) {
    void enqueue(async () => {
      const { store, done } = tx("readwrite");
      store.put(row);
      await done;
    }).catch(() => undefined);
  } else {
    persistLs();
  }
  announce();
}

/** Remove one video from history (the × on a history card). */
export function historyDelete(id: string): void {
  if (typeof window === "undefined" || !id) return;
  if (mirror === null) {
    void historyReady().then(() => historyDelete(id));
    return;
  }
  const idx = mirror.findIndex((h) => h.card.id === id);
  if (idx < 0) return;
  mirror = mirror.filter((h) => h.card.id !== id); /* new array — React sees the change */
  notePatch(id, null);
  if (mode === "idb" && db) {
    void enqueue(async () => {
      const { store, done } = tx("readwrite");
      store.delete(id);
      await done;
    }).catch(() => undefined);
  } else {
    persistLs();
  }
  announce();
}

/** Wipe the whole history ("Clear all watch history"). */
export function historyClear(): void {
  if (typeof window === "undefined") return;
  if (mirror === null) {
    void historyReady().then(() => historyClear());
    return;
  }
  mirror = [];
  if (priming) {
    /* a clear mid-prime drops the incoming full set too */
    primeCleared = true;
    primePatches = new Map();
  }
  if (mode === "idb" && db) {
    void clearStore().catch(() => undefined);
  } else {
    persistLs();
  }
  announce();
}

/** Merge rows from a Veil backup file into this device (newest `at`
 * wins per id, nothing is ever deleted). Mirror- synchronous so the
 * battle-tested sync importers keep their signatures; the IndexedDB
 * upserts run chunked in the background. Returns the merged total. */
export function historyMergeBackup(inRows: VeilHistoryRow[]): number {
  if (typeof window === "undefined") return 0;
  if (mirror === null) {
    void historyReady().then(() => historyMergeBackup(inRows));
    return 0;
  }
  if (!Array.isArray(inRows) || inRows.length === 0) return mirror.length;
  const byId = new Map<string, VeilHistoryRow>();
  for (const h of mirror) byId.set(h.card.id, h);
  const changed: VeilHistoryRow[] = [];
  for (const v of inRows) {
    const r = normalizeRow(v);
    if (!r) continue;
    const prev = byId.get(r.card.id);
    if (!prev || r.at > prev.at) {
      byId.set(r.card.id, r);
      changed.push(r);
    }
  }
  const merged = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, HISTORY_CAP);
  mirror = merged;
  if (changed.length > 0) {
    if (mode === "idb" && db) {
      void putChunked(changed)
        .then(() => trimOverCap())
        .catch(() => undefined);
    } else {
      persistLs();
    }
  }
  announce();
  return merged.length;
}

/** Merge Takeout watch-history rows (fresh imports — existing entries
 * win, their cards are complete). Awaits the full chunked persist and
 * returns the HONEST count of new rows that landed (post-cap,
 * post-quota). */
export async function historyImportTakeout(fresh: VeilHistoryRow[]): Promise<number> {
  await historyReady();
  if (mirror === null || !Array.isArray(fresh) || fresh.length === 0) return 0;
  const have = new Set(mirror.map((h) => h.card.id));
  const add: VeilHistoryRow[] = [];
  for (const v of fresh) {
    const r = normalizeRow(v);
    if (!r || have.has(r.card.id)) continue;
    have.add(r.card.id);
    add.push(r);
  }
  if (add.length === 0) return 0;
  const merged = [...mirror, ...add].sort((a, b) => b.at - a.at).slice(0, HISTORY_CAP);
  const keptIds = new Set(merged.map((m) => m.card.id));
  const kept = add.filter((a) => keptIds.has(a.card.id));
  mirror = merged;
  let landed = 0;
  if (mode === "idb" && db) {
    landed = await putChunked(kept);
    await trimOverCap().catch(() => undefined);
    if (landed < kept.length) {
      /* quota bit mid-import — the mirror promised more than landed;
       * re-read the truth so the UI count is honest */
      try {
        mirror = (await loadAll()).slice(0, HISTORY_CAP);
      } catch {
        /* keep the optimistic mirror */
      }
    }
  } else {
    persistLs();
    landed = Math.min(kept.length, mirror.length);
  }
  announce();
  return Math.min(landed, kept.length);
}

/** Replace the whole store (used by internal maintenance paths). */
export async function historyReplaceAll(rows: VeilHistoryRow[]): Promise<number> {
  await historyReady();
  const clean: VeilHistoryRow[] = [];
  const byId = new Set<string>();
  for (const v of rows) {
    const r = normalizeRow(v);
    if (r && !byId.has(r.card.id)) {
      byId.add(r.card.id);
      clean.push(r);
    }
  }
  clean.sort((a, b) => b.at - a.at);
  mirror = clean.slice(0, HISTORY_CAP);
  if (priming) {
    /* replaceAll rebuilds everything — treat like a clear so the
     * incoming full set can't resurrect the rows it just dropped */
    primeCleared = true;
    primePatches = new Map();
  }
  if (mode === "idb" && db) {
    await clearStore();
    const landed = await putChunked(mirror);
    announce();
    return landed;
  }
  persistLs();
  announce();
  return mirror.length;
}

/* auto-prime on client load — by the time a user can click anything the
 * mirror is usually ready, and historyReady() is idempotent anyway */
if (typeof window !== "undefined") {
  void historyReady().catch(() => {
    if (mirror === null) mirror = [];
  });
}
