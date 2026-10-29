import { NextRequest, NextResponse } from "next/server"
import { spawn } from "child_process"
import { readdirSync, openSync } from "fs"
import { db } from "@/lib/db"
import { getAccountFromToken } from "@/lib/chat-auth"
import { cors, corsOptions } from "@/lib/veil/cors"
import { readJsonBody, badBody } from "@/lib/veil/body"
import {
  restoreChatBackup,
  fetchJsDelivrBackup,
  fetchRawGithubBackup,
  readLocalBackup,
  readBackupState,
  purgeJSDelivrData,
  BACKUP_HISTORY_DIR,
  BACKUP_REPO,
  JSDELIVR_LATEST,
  JSDELIVR_PURGE,
} from "@/lib/veil/chat-backup"

export const runtime = "nodejs"

/* Preflight + wildcard origin — Veil Chat also runs from the single-file
 * HTML build (file:// sends Origin: null). Tokens live in the body/query. */
export async function OPTIONS(): Promise<Response> {
  return corsOptions()
}

const SUPER_ADMIN_USERNAME = "Veil"
function isModAccount(a: { username: string; role: string }): boolean {
  return (
    a.role === "moderator" ||
    a.role === "admin" ||
    a.username.toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase()
  )
}

function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// GET — backup status (mods/owner only)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  return cors(await handleGet(req))
}

async function handleGet(req: NextRequest): Promise<Response> {
  try {
    const token = req.nextUrl.searchParams.get("token") || ""
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }
    if (!isModAccount(account)) {
      return NextResponse.json(
        { ok: false, error: "Owner or moderator access required." },
        { status: 403 },
      )
    }

    const state = readBackupState()
    const [accounts, messages, dms] = await Promise.all([
      db.chatAccount.count(),
      db.chatMessage.count(),
      db.chatDM.count(),
    ])
    const history = listJson(BACKUP_HISTORY_DIR)
    const seeds = listJson("/home/z/my-project/backups/chat/seeds")

    const lastRunMs = state?.lastRun ? new Date(state.lastRun).getTime() : 0
    return NextResponse.json({
      ok: true,
      repo: `https://github.com/${BACKUP_REPO}`,
      jsdelivr: JSDELIVR_LATEST,
      purge: JSDELIVR_PURGE,
      lastBackupAt: state?.lastBackupAt ?? null,
      lastCounts: state?.lastCounts ?? null,
      lastPushOk: state?.lastPushOk ?? null,
      lastPushError: state?.lastPushError ?? null,
      lastPushAt: state?.lastPushAt ?? null,
      autoBackupLive: Date.now() - lastRunMs < 120_000,
      dbCounts: { accounts, messages, dms },
      history: history.slice(-20),
      historyCount: history.length,
      seeds,
    })
  } catch (err) {
    console.error("[chat-backup GET] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error reading backup status." },
      { status: 500 },
    )
  }
}

// ---------------------------------------------------------------------------
// POST — { action: "backup-now" | "restore" }
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  return cors(await handlePost(req))
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = await readJsonBody<{
      token?: string
      action?: string
      source?: string // "jsdelivr" | "local"
      name?: string // local snapshot file name
    }>(req)
    if (!body) return badBody()
    const account = await getAccountFromToken(body.token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }
    if (!isModAccount(account)) {
      return NextResponse.json(
        { ok: false, error: "Owner or moderator access required." },
        { status: 403 },
      )
    }

    if (body.action === "backup-now") {
      // Full pipeline (snapshot → commit → push → CDN purge) runs in the
      // scripts/chat-backup.ts body — detached so the request returns at
      // once; the UI polls GET for the fresh status.
      const out = openSync("/home/z/my-project/tmp/chat-backup-manual.log", "a")
      const child = spawn(
        "bun",
        ["scripts/chat-backup.ts", "--force"],
        {
          cwd: "/home/z/my-project",
          detached: true,
          stdio: ["ignore", out, out],
          env: { ...process.env },
        },
      )
      child.unref()
      return NextResponse.json({ ok: true, started: true })
    }

    if (body.action === "restore") {
      // "Restore from GitHub" must pull WHAT IS ON GITHUB RIGHT NOW.
      // 2026-10-22 incident: the owner hand-edited latest.json on GitHub
      // (coins 0 → 250k) and clicked Restore — but the jsDelivr edge was
      // still serving its cached pre-edit copy (and even after purges,
      // different edges kept serving 9- and 75-tx-older files), so
      // nothing landed. Strategy now:
      //   1. purge the CDN data files (best-effort; keeps the fallback
      //      and the public jsDelivr link converging toward fresh),
      //   2. fetch raw.githubusercontent.com FIRST — it tracks the repo
      //      at ~minute granularity,
      //   3. fall back to the jsDelivr CDN (2s after the purge) only if
      //      raw is unreachable.
      let loaded: { data: unknown; restoredFrom: string } | { error: string }
      if (body.source === "local" && body.name) {
        loaded = readLocalBackup(body.name)
      } else {
        await purgeJSDelivrData()
        loaded = await fetchRawGithubBackup()
        if ("error" in loaded) {
          // Edge invalidation lands within a few seconds — give the purge
          // a beat before pulling from the CDN fallback.
          await new Promise((r) => setTimeout(r, 2000))
          loaded = await fetchJsDelivrBackup()
        }
      }
      if ("error" in loaded) {
        return NextResponse.json(
          { ok: false, error: loaded.error },
          { status: 400 },
        )
      }
      // Surface WHICH backup version this was, so a mod can see the
      // restore actually pulled the fresh state (and not a stale edge
      // copy that predates their GitHub edit).
      const raw = loaded.data as { exportedAt?: unknown }
      const exportedAt =
        typeof raw?.exportedAt === "string" ? raw.exportedAt : null
      const res = await restoreChatBackup(loaded.data, {
        restoredFrom: loaded.restoredFrom,
      })
      if (!res.ok) {
        return NextResponse.json(res, { status: 400 })
      }
      // The daemon loop notices the DB change within 30s and snapshots +
      // publishes the restored state automatically.
      return NextResponse.json({ ...res, exportedAt })
    }

    return NextResponse.json(
      { ok: false, error: "Unknown action — use backup-now or restore." },
      { status: 400 },
    )
  } catch (err) {
    console.error("[chat-backup POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error." },
      { status: 500 },
    )
  }
}
