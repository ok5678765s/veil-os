/**
 * Veil — the AI operator assistant (Updates → Veil AI, owner-unlocked).
 *
 * The owner talks to an assistant that can actually DO things on the live
 * site, exactly like asking a developer for changes:
 *   • post updates to the site feed   → :::action {"type":"post_update",…}
 *   • build & install new site apps   → the Extension Maker HTML format
 *     (installed apps appear in the Arcade's Apps tab)
 *
 * Everything reuses the /api/ai streaming machinery (watchdogs, heartbeat,
 * truncation auto-repair) so app builds are just as resilient here.
 *
 *   POST /api/ai-operator { password, messages, stream? }
 *   → SSE frames {delta} … {done, reply, actions, app}   (stream)
 *   → JSON { reply, actions, app }                        (compat)
 *
 * Actions found in the reply are executed server-side BEFORE the final
 * frame, so the client can refresh the feed / app list the moment the
 * conversation settles.
 */

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { parseExtReply, stripExtHtml } from "@/lib/veil/ext-maker"
import { ownerPasswordOk } from "@/lib/veil/owner-auth"
import { scheduleAppsPackRebuild } from "@/lib/veil/apps-pack"
import { llmCreate, llmCreateVision } from "@/lib/veil/llm-client"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* ── the operator system prompt: chat + the two real action types ──
 * The static rules plus a LIVE inventory of the Arcade's Apps tab —
 * so the operator never "discovers" it rebuilt a duplicate. */
const OPERATOR_BASE_PROMPT = [
  "You are Veil AI — the owner's assistant inside the Updates section of Veil. You were unlocked with the owner password, so you may act on the live site.",
  "",
  "You can genuinely DO things — not just talk:",
  "",
  "1) POST SITE UPDATES (the feed every visitor sees). When the owner asks you to announce/post/log something, emit ONE action block and then a one-line confirmation:",
  ":::action",
  '{"type":"post_update","title":"Short title","body":"One to four plain sentences about what changed or what to know.","kind":"feature"}',
  ":::",
  'kind is exactly one of: feature, fix, notice. Action blocks are NEVER inside code fences. Emit the action block first, then the confirmation sentence.',
  "",
  "2) BUILD NEW APPS for the site. When the owner asks for a new app, game, or tool (\"add a tic-tac-toe app\", \"make me a pomodoro timer\", \"add a unit converter\"), build it as ONE complete, self-contained HTML page:",
  "- One short intro sentence (max 2 lines), then ONE fenced ```html code block containing the ENTIRE app, nothing after the closing fence.",
  '- The first line inside the block, right after <!doctype html>, must be the metadata comment:',
  '  <!-- veil-ext {"name":"Short Name","desc":"One-line description","icon":"icon"} -->',
  "  icon must be ONE of: bot, joypad, image, globe, dices, search, spark, calc, trophy, zap, timer, brush, pen, filetext, monitor, key, palette, worm, bomb, music, heart, desktop, play, archive, package.",
  "- Zero external requests: no CDN, no fetch, no import, no web fonts, no images from the web. Inline <style> and <script> only.",
  "- Dark theme (zinc/neutral palette, a single emerald or violet accent), fully responsive, works on touch AND keyboard.",
  '- <!doctype html> + <html lang="en"> + <meta charset="utf-8"> + <meta name="viewport" content="width=device-width, initial-scale=1"> + <title> + <meta name="description">.',
  "- localStorage (guarded with try/catch) for scores/settings; safe if storage is unavailable.",
  "- No alert()/confirm()/prompt(); use inline UI. No external libraries.",
  "- Aim for a genuinely fun/usable, polished app: real loop, real state, restart, score/progress, win/lose states where sensible. Roughly 150-600 lines.",
  "- The page runs inside a sandboxed iframe (srcdoc): never rely on window.top, never navigate away.",
  "The app is installed into the Arcade's Apps tab (Arcade › Apps) AND announced in the Updates feed automatically — no separate action block needed for the install. Only add a post_update action if the owner wants custom wording in the announcement.",
  "Every installed app is ALSO bundled automatically into the \"Veil AI Apps\" offline extension pack (downloadable from Arcade › Apps) — mention that in one clause when you install something, no action needed for it.",
  "If the request is unclear, pick a reasonable interpretation and build it — never answer a build request with questions instead of the code block.",
  "",
  "3) RELAY SITE CHANGES TO THE DEV (dev requests). When the owner asks you to change the SITE ITSELF — a new engine for an existing section (e.g. \"add a new engine to chat\"), a change to how an existing section/app works, a core feature, a bug report (\"wallpaper thumbnails are missing\"), or anything that is NOT a brand-new self-contained app — you cannot rewrite the site's source code yourself. Instead, hand it to the real developer with ONE action block, then a one-line confirmation:",
  ":::action",
  '{"type":"dev_request","title":"Short imperative title","body":"Everything the owner asked for, in their own words plus the specifics needed to build it. Include section names, expected behavior, and examples."}',
  ":::",
  'After the action block, confirm in ONE short line that you brought it to the dev — e.g. "Brought this to the dev — they get pinged automatically within a few minutes and it ships into the site for real." Never claim the change is already live: the dev builds it and it will show up in the Updates feed as “shipped” when done. The action block is REQUIRED — saying you forwarded it without emitting the block does nothing.',
  "A dev request is for SITE-LEVEL work. A brand-new standalone app/game/tool (\"add a snake app\") is yours to BUILD as HTML — do not relay those. When unsure: standalone thing → build it; change to something that already exists or how the site works → relay it.",
  "ATTACHMENTS: the owner can attach images and files to their messages — you SEE images inline, and file names/sizes appear as [Attached file: …] notes. The attachments automatically ride along with any dev_request you file (the server appends download links), so never claim an attachment was lost; acknowledge it in your reply when relevant (e.g. \"got the screenshot\").",
  "",
  "4) CHAT: answer questions about Veil and its sections (Veil AI, Arcade — including its Apps tab where your built apps land and its Math tab, a built-in number-rush game with three modes (sprint 60 seconds, survival with 3 lives, zen practice), streak multipliers, difficulty levels and per-mode best scores; Bloxd and the Blooks quiz platform are both retired, Stream, Chat — including its shop, where coins earned chatting buy profile accessories and name tags (Chat → profile menu), and file attachments up to 300 MB (paperclip in the composer — images/videos/audio play inline), Wallpapers — including \"My pack → Add yours\": the owner can upload their OWN images (png/jpg/webp/gif/avif) and videos (mp4/webm/mov) up to 300 MB straight into the wallpaper pack, no dev needed, Music, Links, History, Updates, Settings — including its Security tab with the panic key (Ctrl+Y default, configurable, instantly replaces the page with a chosen site) and the about:blank cloak (Alt+B default — the veil in a blank-tab window)), and general help. Concise, warm, 2-5 sentences.",
  "",
  "WALLPAPER & MEDIA ASKS: if the owner wants to add their own images or mp4s to the wallpaper pack, DON'T relay it — point them at Wallpapers → My pack → \"Add yours\" (drag-drop works too; the owner password unlocks it, videos get an auto poster). Media uploads for the pack are self-serve now.",
  "",
  "CRITICAL DISCIPLINE RULES:",
  "- ONLY build an app when the owner EXPLICITLY asks for one (\"add…\", \"build…\", \"make me…\", \"I want a…\"). Never build an app to demonstrate, illustrate, or show off — a question like \"what can you do?\" gets a PROSE answer only.",
  "- If the owner's latest message is a question, greeting, or conversation (NOT a build request), your reply contains NO html code block and NO page — pure prose. Describe what you can do; do not build a demo to prove it.",
  "- Never install or post anything the owner did not ask for.",
  "- One app per reply. Do not chain extra actions after a build beyond the automatic announcement.",
  "- A site-change request gets EXACTLY ONE dev_request action — never both a dev request AND a build for the same ask. Never emit a dev_request for something you were not asked to change.",
  "- A site-change ask is relayed with a dev_request action — NEVER with only a post_update. post_update announces things that already happened (a shipped fix, a new app); it does not relay what the owner wants changed. If the owner asks for a change you cannot build yourself, file the dev_request and say it is on the developer's desk.",
  "",
  "Style rules:",
  "- Keep answers short (2-5 sentences) unless the user asks for depth.",
  "- Use markdown lightly: **bold** for key terms, `inline code` for code. Links as [label](https://…) — never invent URLs.",
  "- Never invent action types beyond post_update and dev_request. Never claim a site-level change is live — you can only relay it. If asked for something you can neither build nor relay sensibly, say what you CAN do instead.",
  "- If you do not know something, say so plainly.",
].join("\n")

/* Installed-apps inventory, cached briefly (operator calls are rare and
 * password-gated — a 30s cache just avoids re-hitting SQLite per nudge). */
let installedAppsCache: { at: number; lines: string[] } | null = null

async function buildSystemPrompt(): Promise<string> {
  let lines: string[]
  if (installedAppsCache && Date.now() - installedAppsCache.at < 30_000) {
    lines = installedAppsCache.lines
  } else {
    try {
      const apps = await db.siteApp.findMany({
        select: { name: true, desc: true, createdBy: true },
        orderBy: { createdAt: "asc" },
        take: 60,
      })
      lines = apps.map(
        (a) => `- ${a.name}${a.desc ? ` — ${a.desc}` : ""} (${a.createdBy === "ai" ? "built by you" : a.createdBy})`,
      )
    } catch {
      lines = []
    }
    installedAppsCache = { at: Date.now(), lines }
  }
  const inventory =
    lines.length > 0
      ? `\nCURRENTLY INSTALLED APPS (live in the Arcade's Apps tab — do NOT rebuild these):\n${lines.join("\n")}\nIf the owner asks for an app that is already installed, tell them it already exists and ask what they want changed — only build a replacement version if they clearly want one. When you DO rebuild an existing app on request, say it's an update. If the owner asks for several and some exist, build only the missing ones.\n`
      : `\nNo apps are installed in the Arcade's Apps tab yet.\n`

  /* Dev-request ledger: the owner's past site-change asks + what became
   * of them. The operator can then answer "what happened to my X
   * request" truthfully, and never re-file an ask already in flight. */
  let reqLines: string[] = []
  try {
    const reqs = await db.devRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { title: true, status: true, note: true },
    })
    const label: Record<string, string> = {
      pending: "sent to the dev — awaiting the next dev pass",
      in_progress: "the dev is building it right now",
      done: "SHIPPED — already live on the site",
      declined: "DECLINED by the dev",
    }
    reqLines = reqs.map(
      (r) =>
        `- ${r.title} — ${label[r.status] ?? r.status}${r.note ? `: ${r.note.slice(0, 260)}` : ""}`,
    )
  } catch {
    reqLines = []
  }
  const ledger =
    reqLines.length > 0
      ? `\nDEV REQUEST LEDGER (the owner's past site-change asks and what became of them — NEVER re-file any of these as a new dev_request; if the owner asks for a status, answer from this ledger truthfully):\n${reqLines.join("\n")}\n`
      : `\nNo dev requests have been filed yet.\n`

  return OPERATOR_BASE_PROMPT + inventory + ledger
}

/** Invalidate the installed-apps inventory (call after an install/update
 *  or delete so the very next operator reply sees the fresh list). */
function invalidateInstalledAppsCache(): void {
  installedAppsCache = null
}

/* ── watchdogs + stream plumbing (same contracts as /api/ai) ── */
const UPSTREAM_STALL_MS = 90_000
const UPSTREAM_SILENCE_MS = 150_000
const CREATE_TIMEOUT_MS = 75_000
const TOTAL_CAP_MS = 6 * 60_000
const HARD_DEADLINE_MS = TOTAL_CAP_MS + 60_000
const CONTINUATION_ROUNDS = 2

/* (The create() watchdog moved into lib/veil/llm-client.ts so every
 * retried attempt gets its own timeout budget.) */

async function consumeStream(
  stream: AsyncIterable<unknown>,
  onDelta: (d: string) => void,
  onFinish?: (reason: string | null) => void,
): Promise<string> {
  const it = stream[Symbol.asyncIterator]()
  let full = ""
  let carry = ""
  let lastDelta = Date.now()
  const push = (d: string) => {
    full += d
    lastDelta = Date.now()
    onDelta(d)
  }
  for (;;) {
    const nextP = it.next()
    const budget = Math.max(1, Math.min(UPSTREAM_STALL_MS, UPSTREAM_SILENCE_MS - (Date.now() - lastDelta)))
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const stall = new Promise<never>((_, reject) => {
      stallTimer = setTimeout(
        () =>
          reject(
            new Error(
              Date.now() - lastDelta >= UPSTREAM_SILENCE_MS - 1
                ? "the model stopped writing mid-build"
                : "the model connection stalled mid-build",
            ),
          ),
        budget,
      )
    })
    let res: IteratorResult<unknown>
    try {
      res = await Promise.race([nextP, stall])
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
    }
    if (res.done) break
    carry += Buffer.from(res.value as Uint8Array).toString("utf8")
    let nl: number
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl)
      carry = carry.slice(nl + 1)
      emitDelta(line, push, onFinish)
    }
  }
  if (carry) emitDelta(carry, push, onFinish)
  return full
}

function emitDelta(
  line: string,
  onDelta: (d: string) => void,
  onFinish?: (reason: string | null) => void,
): void {
  if (!line.startsWith("data:")) return
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return
  try {
    const j = JSON.parse(payload) as {
      choices?: {
        delta?: { content?: unknown }
        message?: { content?: unknown }
        finish_reason?: unknown
      }[]
    }
    const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content
    if (typeof d === "string" && d) onDelta(d)
    const fin = j.choices?.[0]?.finish_reason
    if (typeof fin === "string" && fin) onFinish?.(fin)
  } catch {
    /* partial line — skip */
  }
}

function looksTruncated(t: string): boolean {
  const s = t.trim()
  if (!s) return false
  if (/<\/html>/i.test(s)) return false
  if (/<!doctype html/i.test(s)) return true
  const first = s.indexOf("```")
  return first !== -1 && s.indexOf("```", first + 3) === -1
}

function mergeContinuation(a: string, b: string): string {
  const bb = b.replace(/^\s+/, "")
  const max = Math.min(400, a.length, bb.length)
  for (let n = max; n >= 40; n--) {
    if (a.slice(-n) === bb.slice(0, n)) return a + bb.slice(n)
  }
  return a + bb
}

const CONTINUE_PROMPT = [
  "Your previous message was cut off before the page was finished.",
  "Continue the HTML app from EXACTLY the point where you stopped.",
  "Output ONLY the continuation — never repeat the intro, never restart the page, no commentary.",
  "Finish the remaining markup/script and close the document with </html>.",
].join(" ")

const NUDGE_PROMPT = [
  "You answered without building anything.",
  "Build it now, following the output format exactly:",
  "one short intro sentence, then ONE fenced ```html code block containing the ENTIRE self-contained app page, nothing after the closing fence.",
].join(" ")

const NUDGE_HARD_PROMPT = [
  "That reply STILL contained no code block — you described the app again.",
  "Reply now with EXACTLY two things and nothing else: one short intro line, then ONE fenced ```html code block containing the complete self-contained app page.",
  "No more description, no summary, no apologies. The code block or nothing.",
].join(" ")

/* ── build-intent detection ──
 * The nudge + auto-install machinery must only fire when the owner
 * actually ASKED for an app. A plain question ("what can you do?") gets a
 * prose answer — the old unconditional nudge would force a demo build onto
 * it (observed live: "What can you do?" → an unsolicited Pomodoro Timer).
 * The gate: the latest user message must pair a build verb with an
 * artifact noun. The re-verbs matter: "rebuild/remake/redesign the app"
 * is a build of a REPLACEMENT — without them the gate reads those asks
 * as no-build and the lying-announcement guard goes deaf. */
const BUILD_VERBS =
  /\b(add|build|make|create|give|design|write|want|need|install|generate|code|rebuild|remake|redo|redesign|restyle|refresh|renew|update|upgrade|improve|polish|fix)\b/i
const BUILD_NOUNS =
  /\b(app|apps|game|games|tool|widget|timer|clock|calculator|converter|counter|player|board|puzzle|quiz|tracker|notepad|to-?do list|snake|tetris|chess|checkers|tic-?tac-?toe|pong|breakout|flappy|minesweeper|sudoku|2048|memory game|pomodoro|stopwatch|dice roller|simulator|flashlight|paint|sketch|drawing)\b/i

function userWantsBuild(history: { role: string; content: string }[]): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? ""
  return BUILD_VERBS.test(lastUser) && BUILD_NOUNS.test(lastUser)
}

/* ── site-change intent detection (the relay safety net) ──
 * LLMs occasionally write the confirmation prose but skip the action
 * block. When the owner's latest message reads as a change to something
 * that already exists on the site (engine/section/feature nouns + change
 * verbs, and NOT a standalone app build), and the reply produced no
 * dev_request, no app install and no feed post, the server files the dev
 * request itself from the owner's own words — an ask can never silently
 * evaporate. */
const CHANGE_VERBS =
  /\b(add|build|make|create|change|fix|update|improve|bring|enable|allow|turn|set|remove|delete|hide|show|support|include|want|need|give|send|sent|share|upload|put|use|restart|restarts|restarting|restarted|stops|stopped|dies|died|dying|crash|crashes|crashed|crashing|loads|loading|loaded|lags?|lagging|laggy|slow|breaks?|broke)\b/i
const SITE_NOUNS =
  /\b(engine|engines|chat|section|sections|site|website|page(s)?|wallpapers?|gifs?|thumbnails?|images?|videos?|music|stream|streams|arcade|search|history|settings|updates?|feed|player|browser|tab(s)?|dock|start ?page|login|logins|accounts?|mods?|moderator(s)?|bans?|coins?|theme(s)?|downloads?|offline|features?|pack|uploads?|media|mp4|mp3|photos?|clips?|stickers?|emotes?|avatars?|pfps?|profile pictures?|backdrop|backgrounds?)\b/i

function userWantsSiteChange(history: { role: string; content: string }[]): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? ""
  if (!lastUser.trim() || userWantsBuild(history)) return false
  return CHANGE_VERBS.test(lastUser) && SITE_NOUNS.test(lastUser)
}

/** Media/pack asks ("here are images/mp4s for my pack") and bug-report
 *  phrasing ("dev requests aren't being sent", "uploads broken") — they
 *  often carry no change verb, so the verb+noun gate misses them. Used
 *  only by the outage outbox (LLM dead = no answer to lose). */
const ASK_SIGNAL =
  /\b(images?|videos?|photos?|mp4|mp3|media|clips?|wallpapers?|pack|pfp|pfps|stickers?|emotes?|dev ?requests?|broken|bug|bugs|glitch(es)?|crash(es|ed|ing)?|stuck|frozen?)\b|not working|isn.t working|doesn.t work|don.t work|arent being|aren.t being/i

/** Any ask-shaped message — the outage outbox files these when the LLM
 *  itself fails, so an ask never dies with the assistant. */
function userHasAsk(history: { role: string; content: string }[]): boolean {
  const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? ""
  if (!lastUser.trim()) return false
  return userWantsSiteChange(history) || userWantsBuild(history) || ASK_SIGNAL.test(lastUser)
}

/** File a dev request straight from the owner's message (safety net —
 * deduped like the model-emitted ones). Returns the action result or
 * null when nothing was filed. */
async function fileDevRequestFromUser(
  history: { role: string; content: string; files?: { name: string; size: number; type: string; url?: string }[]; images?: string[] }[],
): Promise<ActionResult | null> {
  const lastMsg = [...history].reverse().find((m) => m.role === "user")
  const lastUser = (lastMsg?.content ?? "").trim()
  if (!lastUser) return null
  const title = lastUser.replace(/\s+/g, " ").slice(0, 140)
  let body = lastUser.slice(0, 6000)
  // Attachments ride with the dev request: the developer gets stable
  // URLs to download exactly what the owner attached.
  const attach: string[] = []
  if (lastMsg?.files?.length) {
    const kb = (x) =>
      x >= 1048576 ? (x / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(x / 1024)) + "KB"
    for (const f of lastMsg.files)
      attach.push(
        "- " + f.name + " (" + (f.type || "file") + ", " + kb(f.size) + ")" +
          (f.url ? " — download: " + f.url : ""),
      )
  }
  if (lastMsg?.images?.length) attach.push("- " + lastMsg.images.length + " inline image(s) were attached to this ask")
  if (attach.length)
    body += "Attached files:" + NL + NL + attach.join(NL)
  try {
    const key = devRequestKey(title)
    const open = await db.devRequest.findMany({
      where: { status: { in: ["pending", "in_progress"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
    })
    const match = open.find((r) => devRequestKey(r.title) === key)
    const row = match
      ? await db.devRequest.update({ where: { id: match.id }, data: { title, body } })
      : await db.devRequest.create({ data: { title, body } })
    return { type: "dev_request", ok: true, id: row.id, title, status: row.status }
  } catch {
    return null
  }
}

/* ── action parsing: :::action {json} ::: blocks ── */

interface ParsedAction {
  type: string
  title?: string
  body?: string
  kind?: string
}

/* Normalize a dev-request title for dedupe (same ask twice → one row). */
function devRequestKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120)
}

function parseActions(reply: string): { clean: string; actions: ParsedAction[] } {
  const actions: ParsedAction[] = []
  let clean = String(reply || "")
  // Accept both the canonical :::action\n{...}\n::: and a loose one-line
  // form :::action {...} ::: the models sometimes emit.
  clean = clean.replace(
    /:::action\s*(\{[\s\S]*?\})\s*:::/g,
    (_m, json: string) => {
      try {
        const j = JSON.parse(json) as ParsedAction
        if (j && typeof j.type === "string") {
          actions.push(j)
          return ""
        }
      } catch {
        /* malformed block — drop it */
      }
      return ""
    },
  )
  // A bare un-fenced :::action line with JSON on the next line(s).
  clean = clean.replace(/^[ \t]*:::action[ \t]*$/gm, "")
  return { clean: clean.trim(), actions }
}

interface ActionResult {
  type: string
  ok: boolean
  error?: string
  title?: string
  id?: string
  status?: string
}

interface AppResult {
  id: string
  name: string
  desc: string
  icon: string
  posted: boolean
  /** true when an existing app (same name) was updated in place. */
  updated?: boolean
}

/** Execute the parsed actions + install a built app. Runs INSIDE the
 *  request so the final frame lands after the DB writes. */
async function executeActions(
  actions: ParsedAction[],
  ext: { name: string; desc: string; icon: string; html: string } | null,
): Promise<{ results: ActionResult[]; app: AppResult | null }> {
  const results: ActionResult[] = []

  for (const a of actions) {
    if (a.type === "dev_request") {
      const title = String(a.title || "").trim().slice(0, 140)
      let body = String(a.body || "").trim().slice(0, 6000)
      // Server-side truth: whatever the owner actually attached rides
      // with the request, whether the model mentioned it or not.
      if (currentAttachNote && !body.includes("Attached files:")) {
        body += currentAttachNote
      }
      if (!title || !body) {
        results.push({ type: "dev_request", ok: false, error: "title and body are required" })
        continue
      }
      try {
        // Dedupe: an identical pending/in-progress ask updates in place
        // instead of stacking duplicates.
        const key = devRequestKey(title)
        const open = await db.devRequest.findMany({
          where: { status: { in: ["pending", "in_progress"] } },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
        const match = open.find((r) => devRequestKey(r.title) === key)
        const row = match
          ? await db.devRequest.update({
              where: { id: match.id },
              data: { title, body, status: "pending" },
            })
          : await db.devRequest.create({ data: { title, body } })
        results.push({ type: "dev_request", ok: true, id: row.id, title, status: row.status })
      } catch (e) {
        results.push({ type: "dev_request", ok: false, error: e instanceof Error ? e.message : "db error" })
      }
    } else if (a.type === "post_update") {
      const title = String(a.title || "").trim().slice(0, 140)
      const body = String(a.body || "").trim().slice(0, 4000)
      const kindRaw = String(a.kind || "feature").toLowerCase()
      const kind = ["feature", "fix", "notice"].includes(kindRaw) ? kindRaw : "feature"
      if (!title || !body) {
        results.push({ type: "post_update", ok: false, error: "title and body are required" })
        continue
      }
      try {
        const row = await db.siteUpdate.create({ data: { title, body, kind } })
        results.push({ type: "post_update", ok: true, id: row.id, title })
      } catch (e) {
        results.push({ type: "post_update", ok: false, error: e instanceof Error ? e.message : "db error" })
      }
    } else {
      results.push({ type: a.type, ok: false, error: "unknown action type" })
    }
  }

  let app: AppResult | null = null
  if (ext && ext.html && ext.html.length >= 400) {
    try {
      // Duplicate guard: if an app with the same name (case-insensitive)
      // is already installed, UPDATE it in place instead of adding a
      // twin card to the grid.
      const norm = ext.name.trim().toLowerCase()
      const existing = await db.siteApp.findFirst({
        where: { name: { contains: norm } },
        orderBy: { createdAt: "desc" },
      })
      const dupe =
        existing && existing.name.trim().toLowerCase() === norm ? existing : null
      const saved = dupe
        ? await db.siteApp.update({
            where: { id: dupe.id },
            data: {
              name: ext.name.slice(0, 60),
              desc: ext.desc.slice(0, 140),
              icon: ext.icon,
              html: ext.html.slice(0, 900_000),
            },
          })
        : await db.siteApp.create({
            data: {
              name: ext.name.slice(0, 60),
              desc: ext.desc.slice(0, 140),
              icon: ext.icon,
              html: ext.html.slice(0, 900_000),
              createdBy: "ai",
            },
          })
      invalidateInstalledAppsCache()
      /* the offline “Veil AI Apps” pack picks the install/update up */
      scheduleAppsPackRebuild()
      // Auto-announce the install — unless the model already wrote its own
      // announcement in the same reply (then that post_update IS the news).
      const announced = actions.some(
        (a) => a.type === "post_update" && (a as { ok?: boolean }).ok !== false,
      )
      let posted = false
      if (!announced) {
        try {
          await db.siteUpdate.create({
            data: {
              title: `${dupe ? "App updated" : "New app"}: ${ext.name.slice(0, 120)}`,
              body: `${ext.desc || "Built and installed by Veil AI."} Find it in the Arcade, under the Apps tab.`,
              kind: "feature",
            },
          })
          posted = true
        } catch {
          /* the install still counts even if the announcement failed */
        }
      }
      app = {
        id: saved.id,
        name: saved.name,
        desc: saved.desc,
        icon: saved.icon,
        posted,
        updated: Boolean(dupe),
      }
    } catch (e) {
      results.push({ type: "install_app", ok: false, error: e instanceof Error ? e.message : "db error" })
    }
  }

  return { results, app }
}

const NL = "\n"

/* ── request handling ── */

/* Per-request attachment note (see POST) — appended to dev_request
 * bodies so attachments never get lost in relay. */
let currentAttachNote = ""

const bodySchema = z.object({
  password: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(200_000),
        /** Attached images — inline data:image/ URLs the model SEES
         * (multimodal). Only the last user message keeps them. */
        images: z
          .array(z.string().startsWith("data:image/").max(7_000_000))
          .max(4)
          .optional(),
        /** Attached files, stored in the attachment vault. URLs ride
         * with dev requests so the developer can download them. */
        files: z
          .array(
            z.object({
              name: z.string().max(160),
              size: z.number().max(200_000_000),
              type: z.string().max(120),
              url: z.string().max(400).optional(),
            }),
          )
          .max(8)
          .optional(),
      }),
    )
    .min(1),
  stream: z.boolean().optional(),
})

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "expected { password, messages: [{ role, content }] }" },
      { status: 400 },
    )
  }
  if (!(await ownerPasswordOk(parsed.data.password))) {
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 403 })
  }

  const history = parsed.data.messages.slice(-20)
  // Attachment note for dev requests filed during THIS request.
  const lastMsg = [...history].reverse().find((m) => m.role === "user")
  const attachBits: string[] = []
  if (lastMsg?.files?.length) {
    const kb = (x) =>
      x >= 1048576 ? (x / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(x / 1024)) + "KB"
    for (const f of lastMsg.files)
      attachBits.push(
        "- " + f.name + " (" + (f.type || "file") + ", " + kb(f.size) + ")" +
          (f.url ? " — download: " + f.url : ""),
      )
  }
  if (lastMsg?.images?.length)
    attachBits.push("- " + lastMsg.images.length + " inline image(s) were attached to this ask")
  currentAttachNote = attachBits.length
    ? "Attached files:" + NL + NL + attachBits.join(NL)
    : ""
  const wantStream = parsed.data.stream === true
  // The build machinery (nudge / continuation / auto-install) only runs
  // when the owner's latest message actually asks for an app.
  const wantsBuild = userWantsBuild(history)

  const { default: ZAI } = await import("z-ai-web-dev-sdk").catch(() => ({
    default: null as null | typeof import("z-ai-web-dev-sdk"),
  }))
  if (!ZAI) {
    return NextResponse.json({ ok: false, error: "assistant unavailable: the SDK failed to load" }, { status: 502 })
  }

  try {
    const systemPrompt = await buildSystemPrompt()
    /* Multimodal: the LAST user message may carry inline images the
     * model actually sees, plus attached-file notes. Older turns are
     * plain text (the client strips their images before sending). */
    const lastUserIdx = (() => {
      for (let i = history.length - 1; i >= 0; i--)
        if (history[i].role === "user") return i
      return -1
    })()
    const attachNoteFor = (m): string => {
      const bits: string[] = []
      if (m.files?.length) {
        const kb = (x) =>
          x >= 1048576 ? (x / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(x / 1024)) + "KB"
        for (const f of m.files)
          bits.push("[Attached file: " + f.name + " — " + (f.type || "file") + ", " + kb(f.size) + (f.url ? ", stored at " + f.url : "") + "]")
      }
      if (m.images?.length) bits.push("[Also attached: " + m.images.length + " image(s) — you can see them inline]")
      return bits.length ? NL + NL + bits.join(NL) : ""
    }
    const hasImages = (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === "assistant") continue
        return (history[i].images?.length ?? 0) > 0
      }
      return false
    })()
    const create = hasImages ? llmCreateVision : llmCreate
    const llmMessages = () => [
      { role: "system" as const, content: systemPrompt },
      ...history.map((m, i) => {
        if (m.role !== "user" || i !== lastUserIdx || (!m.images?.length && !m.files?.length))
          return { role: m.role as "user" | "assistant", content: m.content }
        const parts: Record<string, unknown>[] = [
          { type: "text", text: m.content + attachNoteFor(m) },
        ]
        for (const url of m.images || []) parts.push({ type: "image_url", image_url: { url } })
        return { role: m.role as "user" | "assistant", content: parts }
      }),
    ]

    if (wantStream) {
      const enc = new TextEncoder()
      /* llmCreate: transient upstream failures (401 token glitch, 429
         bursts, wedged creates) retry with a fresh SDK instance + backoff
         instead of surfacing as an instant 502. */
      const stream = await create<AsyncIterable<unknown>>(
        {
          messages: llmMessages(),
          stream: true,
          thinking: { type: "disabled" },
          max_tokens: 16384,
        },
        { createTimeoutMs: CREATE_TIMEOUT_MS },
      )

      const sse = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false
          const send = (obj: unknown) => {
            if (closed) return
            try {
              controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"))
            } catch {
              closed = true
            }
          }
          const heart = setInterval(() => {
            if (closed) return
            try {
              controller.enqueue(enc.encode(": ping\n\n"))
            } catch {
              closed = true
            }
          }, 4000)

          const hardTimer = setTimeout(() => {
            if (closed) return
            send({ ok: false, error: "the assistant ran past the total time limit — try again" })
            closed = true
            clearInterval(heart)
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }, HARD_DEADLINE_MS)

          const started = Date.now()
          let full = ""
          let finishReason: string | null = null
          try {
            full = await consumeStream(
              stream,
              (d) => send({ delta: d }),
              (r) => {
                finishReason = r
              },
            )

            /* auto-repair an app build (nudge + continuation rounds) —
               ONLY when the owner asked for a build; a prose answer to a
               plain question is correct and must not be nudged. When a
               build WAS requested, only a real app page satisfies it —
               a post_update action announcing a never-built app does
               NOT count (observed live: "add a coin flip app" → the
               model announced the app without building it). */
            if (
              wantsBuild &&
              !looksTruncated(full) &&
              !parseExtReply(full) &&
              Date.now() - started < TOTAL_CAP_MS
            ) {
              for (let round = 0; round < 2 && Date.now() - started < TOTAL_CAP_MS; round++) {
                send({ continuing: 1 })
                const nudge = await llmCreate<AsyncIterable<unknown>>(
                  {
                    messages: [
                      ...llmMessages(),
                      { role: "assistant", content: full.slice(0, 4000) },
                      { role: "user", content: round === 0 ? NUDGE_PROMPT : NUDGE_HARD_PROMPT },
                    ],
                    stream: true,
                    thinking: { type: "disabled" },
                    max_tokens: 16384,
                  },
                  { attempts: 2, createTimeoutMs: CREATE_TIMEOUT_MS },
                )
                const more = await consumeStream(nudge, (d) => send({ delta: d }), (r) => (finishReason = r))
                if (more.trim()) {
                  if (parseExtReply(more)) {
                    full = more
                    break
                  }
                  full = mergeContinuation(full, more)
                }
                if (parseExtReply(full)) break
              }
            }

            for (
              let round = 0;
              round < CONTINUATION_ROUNDS &&
              wantsBuild &&
              (looksTruncated(full) || (finishReason === "length" && !parseExtReply(full))) &&
              Date.now() - started < TOTAL_CAP_MS;
              round++
            ) {
              send({ continuing: 1 })
              const cont = await llmCreate<AsyncIterable<unknown>>(
                {
                  messages: [
                    ...llmMessages(),
                    { role: "assistant", content: full.slice(-16000) },
                    { role: "user", content: CONTINUE_PROMPT },
                  ],
                  stream: true,
                  thinking: { type: "disabled" },
                  max_tokens: 16384,
                },
                { attempts: 2, createTimeoutMs: CREATE_TIMEOUT_MS },
              )
              const more = await consumeStream(cont, (d) => send({ delta: d }), (r) => (finishReason = r))
              if (!more.trim()) break
              full = mergeContinuation(full, more)
            }

            if (!full.trim()) {
              /* Outage outbox — even when the assistant returns nothing, an
                 ask-shaped message is filed so it can never evaporate
                 (the exact "I sent 2 and nothing loaded" failure). */
              const net = userHasAsk(history) ? await fileDevRequestFromUser(history) : null
              send({
                ok: false,
                error: net
                  ? "the assistant returned nothing — but your ask was filed and the developer will see it"
                  : "the assistant returned nothing",
                actions: net ? [net] : [],
              })
            } else {
              /* execute actions + install apps, then settle. An app block
                 that appears without a build request is NOT installed —
                 the prose answer stands alone. */
              const { clean, actions } = parseActions(full)
              const ext = wantsBuild ? parseExtReply(full) : null
              const prose = stripExtHtml(clean).trim() || (ext ? `Built **${ext.name}** — installed into Arcade › Apps.` : "")
              const { results, app } = await executeActions(actions, ext)
              /* Relay safety net: a site-change ask that produced NO dev
                 request is filed from the owner's own words — never
                 dropped. A post_update announcement does NOT count as the
                 ask being relayed (observed live: the model announced a
                 change in the feed and skipped the dev_request). */
              if (
                !results.some((r) => r.type === "dev_request" && r.ok) &&
                !app &&
                (userWantsSiteChange(history) || wantsBuild)
              ) {
                const net = await fileDevRequestFromUser(history)
                if (net) results.push(net)
              }
              send({ done: 1, ok: true, reply: prose, actions: results, app })
            }
          } catch (e) {
            const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error"
            /* Outage outbox — a hard LLM failure must not swallow an ask. */
            let net: ActionResult | null = null
            try {
              net = userHasAsk(history) ? await fileDevRequestFromUser(history) : null
            } catch {
              /* filing is best-effort */
            }
            send({
              ok: false,
              error: net
                ? `assistant unavailable: ${message} — but your ask was filed and the developer will see it`
                : `assistant unavailable: ${message}`,
              actions: net ? [net] : [],
            })
          } finally {
            clearTimeout(hardTimer)
            clearInterval(heart)
            closed = true
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          }
        },
      })

      return new Response(sse, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store, no-transform",
          "x-accel-buffering": "no",
        },
      })
    }

    /* ── classic JSON path ── */
    const completion = (await create<{
      choices?: { message?: { content?: string }; delta?: { content?: string } }[]
    }>({
      messages: llmMessages(),
      max_tokens: 16384,
    })) as { choices?: { message?: { content?: string }; delta?: { content?: string } }[] }
    let content =
      (completion.choices?.[0]?.message?.content as string | undefined) ??
      (completion.choices?.[0]?.delta?.content as string | undefined) ??
      null
    if (!content) {
      /* Outage outbox (non-streaming) — file ask-shaped messages even
         when the assistant failed, so the ask can't evaporate. */
      const net = userHasAsk(history) ? await fileDevRequestFromUser(history) : null
      return NextResponse.json(
        {
          ok: false,
          error: net
            ? "the assistant returned nothing — but your ask was filed and the developer will see it"
            : "the assistant returned nothing",
          actions: net ? [net] : [],
        },
        { status: 502 },
      )
    }

    // truncated-build repair (non-streaming)
    if (looksTruncated(content)) {
      const cont = (await llmCreate<{
        choices?: { message?: { content?: string } }[]
      }>({
        messages: [...llmMessages(), { role: "assistant", content: content.slice(-16000) }, { role: "user", content: CONTINUE_PROMPT }],
        max_tokens: 16384,
      }, { attempts: 2 })) as { choices?: { message?: { content?: string } }[] }
      const more = (cont.choices?.[0]?.message?.content as string | undefined) ?? ""
      if (more.trim()) content = mergeContinuation(content, more)
    }

    // missing-build repair (non-streaming, same contract as the streaming
    // path): the owner asked for an app but the reply carries none — the
    // model announced instead of building. Nudge it into the code block.
    if (wantsBuild && !parseExtReply(content) && !looksTruncated(content)) {
      for (let round = 0; round < 2; round++) {
        const nudge = (await llmCreate<{
          choices?: { message?: { content?: string } }[]
        }>({
          messages: [
            ...llmMessages(),
            { role: "assistant", content: content.slice(0, 4000) },
            { role: "user", content: round === 0 ? NUDGE_PROMPT : NUDGE_HARD_PROMPT },
          ],
          max_tokens: 16384,
        }, { attempts: 2 })) as { choices?: { message?: { content?: string } }[] }
        const more = (nudge.choices?.[0]?.message?.content as string | undefined) ?? ""
        if (more.trim()) {
          if (parseExtReply(more)) {
            content = more
            break
          }
          content = mergeContinuation(content, more)
        }
        if (parseExtReply(content)) break
      }
    }

    const { clean, actions } = parseActions(content)
    const ext = wantsBuild ? parseExtReply(content) : null
    // Truth-in-advertising guard: when a build was requested but no app
    // materialized, drop any post_update that claims one was built —
    // the feed never carries a build announcement without a build.
    const safeActions =
      wantsBuild && !ext
        ? actions.filter((a) => {
            if (a.type !== "post_update") return true
            const t = `${a.title ?? ""} ${a.body ?? ""}`.toLowerCase()
            return !/\b(rebuilt|redesigned|rebuilt|rebuild|installed|new app|app (is )?(now )?(live|installed|updated))\b/.test(t)
          })
        : actions
    const prose = stripExtHtml(clean).trim() || (ext ? `Built **${ext.name}** — installed into Arcade › Apps.` : "")
    const { results, app } = await executeActions(safeActions, ext)
    /* Relay safety net (non-streaming path — same contract as above):
       an app ask that produced no app is relayed too. */
    if (
      !results.some((r) => r.type === "dev_request" && r.ok) &&
      !app &&
      (userWantsSiteChange(history) || wantsBuild)
    ) {
      const net = await fileDevRequestFromUser(history)
      if (net) results.push(net)
    }
    return NextResponse.json({ ok: true, reply: prose, actions: results, app })
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error"
    /* Outage outbox (non-streaming, outer catch) — file ask-shaped
       messages even on a hard failure. */
    let net: ActionResult | null = null
    try {
      net = userHasAsk(history) ? await fileDevRequestFromUser(history) : null
    } catch {
      /* filing is best-effort */
    }
    return NextResponse.json(
      {
        ok: false,
        error: net
          ? `assistant unavailable: ${message} — but your ask was filed and the developer will see it`
          : `assistant unavailable: ${message}`,
        actions: net ? [net] : [],
      },
      { status: 502 },
    )
  }
}
