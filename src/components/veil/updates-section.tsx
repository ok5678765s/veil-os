"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Megaphone,
  Plus,
  Trash2,
  Lock,
  Unlock,
  Loader2,
  Sparkles,
  Wrench,
  Info,
  Send,
  Bot,
  Package,
  SquarePen,
  Hammer,
  KeyRound,
  Check,
  Eye,
  EyeOff,
  Paperclip,
  X,
} from "lucide-react"
import { SectionShell } from "@/components/veil/start-sections"
import { liveCutExt } from "@/lib/veil/ext-maker"
import {
  beginPick,
  fmtAttSize,
  settlePending,
  MAX_ATTACH,
  type PendingAtt,
} from "@/lib/veil/attach"

const NL2 = "\n"

/* ------------------------------------------------------------------ */
/* Site updates — the owner's control room. Two tabs:                  */
/*   • Feed      — the changelog every visitor sees                    */
/*   • Updates   — the site's own developer: talk to it like the       */
/*                 assistant that built the site — it posts updates    */
/*                 and builds new apps (they land in Arcade › Apps)    */
/* ------------------------------------------------------------------ */

interface SiteUpdate {
  id: string
  title: string
  body: string
  kind: string
  createdAt: string
}

interface OperatorAction {
  type: string
  ok: boolean
  error?: string
  title?: string
  id?: string
}

interface OperatorApp {
  id: string
  name: string
  desc: string
  icon: string
  posted: boolean
  /** true when an existing app was updated in place (not a fresh install). */
  updated?: boolean
}

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  actions?: OperatorAction[]
  app?: OperatorApp | null
  /** Attached images (inline data URLs — fresh turn only). */
  images?: string[]
  /** Attached files with durable vault URLs (images included). */
  files?: { name: string; size: number; type: string; url?: string }[]
}

const KIND_META: Record<
  string,
  { label: string; chip: string; icon: React.ComponentType<{ className?: string }> }
> = {
  feature: {
    label: "Feature",
    chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    icon: Sparkles,
  },
  fix: {
    label: "Fix",
    chip: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    icon: Wrench,
  },
  notice: {
    label: "Notice",
    chip: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
    icon: Info,
  },
}

function kindMeta(kind: string) {
  return KIND_META[kind] ?? KIND_META.feature
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  })
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
  if (!res.ok || (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error || `Request failed (${res.status})`)
  }
  return data
}

/* ---- tiny markdown: **bold**, `code`, [links](…), fenced blocks ---- */

const INLINE_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g

function renderInline(line: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  const re = new RegExp(INLINE_RE.source, "g")
  let i = 0
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index))
    if (m[1] && m[2]) {
      out.push(
        <a
          key={`${keyBase}-l${i}`}
          href={m[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-emerald-300 underline decoration-emerald-400/40 underline-offset-2 hover:text-emerald-200"
        >
          {m[1]}
        </a>,
      )
    } else if (m[3]) {
      out.push(
        <strong key={`${keyBase}-b${i}`} className="font-semibold text-zinc-100">
          {m[3]}
        </strong>,
      )
    } else if (m[4]) {
      out.push(
        <code
          key={`${keyBase}-c${i}`}
          className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[12px] text-emerald-300"
        >
          {m[4]}
        </code>,
      )
    }
    last = re.lastIndex
    i++
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

function MarkdownText({ text }: { text: string }) {
  const blocks = React.useMemo(() => {
    const lines = String(text || "").split("\n")
    const out: { type: "text" | "code"; lines: string[] }[] = []
    let para: string[] = []
    let inCode = false
    let code: string[] = []
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (inCode) {
          out.push({ type: "code", lines: code })
          code = []
          inCode = false
        } else {
          if (para.length) {
            out.push({ type: "text", lines: para })
            para = []
          }
          inCode = true
        }
        continue
      }
      if (inCode) code.push(line)
      else para.push(line)
      if (!inCode && para.length && line.trim() === "") {
        out.push({ type: "text", lines: para })
        para = []
      }
    }
    if (inCode && code.length) out.push({ type: "code", lines: code })
    if (para.length) out.push({ type: "text", lines: para })
    return out
  }, [text])

  return (
    <div className="space-y-2">
      {blocks.map((b, bi) =>
        b.type === "code" ? (
          <pre
            key={bi}
            className="veil-scroll-slim max-h-56 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 font-mono text-[11.5px] leading-relaxed text-zinc-300"
          >
            {b.lines.join("\n")}
          </pre>
        ) : (
          <p key={bi} className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">
            {b.lines.map((l, li) => (
              <React.Fragment key={li}>
                {li > 0 && "\n"}
                {renderInline(l, `b${bi}l${li}`)}
              </React.Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  )
}

/* ---- the SSE reader for /api/ai-operator streams ---- */

interface StreamFrame {
  delta?: string
  continuing?: number
  done?: number
  ok?: boolean
  reply?: string
  actions?: OperatorAction[]
  app?: OperatorApp | null
  error?: string
}

async function readOperatorStream(
  messages: ChatMessage[],
  password: string,
  onDelta: (d: string) => void,
): Promise<StreamFrame> {
  const ctrl = new AbortController()
  const hardTimer = setTimeout(() => ctrl.abort(), 7 * 60_000)
  // The server heartbeats every 4s — silence past 90s means the stream is
  // wedged (dead server, dropped connection). Fail fast with a clear
  // message instead of leaving the assistant stuck "streaming" forever.
  let lastFrameAt = Date.now()
  const idleTimer = setInterval(() => {
    if (Date.now() - lastFrameAt > 90_000) ctrl.abort()
  }, 5_000)
  try {
    const res = await fetch("/api/ai-operator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password,
        stream: true,
        messages: (() => {
          let lastUser = -1
          for (let i = messages.length - 1; i >= 0; i--)
            if (messages[i].role === "user") { lastUser = i; break }
          return messages.map((m, i) => ({
            role: m.role,
            content: m.content,
            ...(i === lastUser && m.images?.length ? { images: m.images.slice(0, 4) } : {}),
            ...(i === lastUser && m.files?.length ? { files: m.files.slice(0, 8) } : {}),
          }))
        })(),
      }),
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error || `Request failed (${res.status})`)
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    let final: StreamFrame | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      lastFrameAt = Date.now()
      buf += dec.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const line = raw.split("\n").find((l) => l.startsWith("data:"))
        if (!line) continue
        try {
          const frame = JSON.parse(line.slice(5).trim()) as StreamFrame
          if (typeof frame.delta === "string" && frame.delta) onDelta(frame.delta)
          if (frame.done || frame.error) final = frame
        } catch {
          /* partial — keep buffering */
        }
      }
    }
    return final ?? {}
  } catch (e) {
    if (ctrl.signal.aborted) {
      throw new Error("the assistant stopped responding — try sending it again")
    }
    throw e
  } finally {
    clearTimeout(hardTimer)
    clearInterval(idleTimer)
  }
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

let msgSeq = 0
const uid = () => `m${Date.now().toString(36)}${(msgSeq++).toString(36)}`

export function UpdatesSection({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = React.useState<"feed" | "assistant">("feed")
  const [updates, setUpdates] = React.useState<SiteUpdate[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")

  // Composer (owner)
  const [composing, setComposing] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [title, setTitle] = React.useState("")
  const [body, setBody] = React.useState("")
  const [kind, setKind] = React.useState("feature")
  const [posting, setPosting] = React.useState(false)
  const [postError, setPostError] = React.useState("")
  const [posted, setPosted] = React.useState(false)

  // Manage mode (owner) — enables deletes, unlocks the assistant.
  const [manageMode, setManageMode] = React.useState(false)
  const [unlockError, setUnlockError] = React.useState("")
  const [deletingId, setDeletingId] = React.useState<string | null>(null)

  // Change password (owner) — the session's own `password` IS the current
  // one (owner mode is unlocked); the form only asks for the new + confirm.
  const [pwOpen, setPwOpen] = React.useState(false)
  const [pwNext, setPwNext] = React.useState("")
  const [pwConfirm, setPwConfirm] = React.useState("")
  const [pwShow, setPwShow] = React.useState(false)
  const [pwBusy, setPwBusy] = React.useState(false)
  const [pwErr, setPwErr] = React.useState("")
  const [pwDone, setPwDone] = React.useState(false)

  // Assistant (operator chat)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [draft, setDraft] = React.useState("")
  const [streaming, setStreaming] = React.useState(false)
  /* attachments for the next ask */
  const [pending, setPending] = React.useState<PendingAtt[]>([])
  const attachInputRef = React.useRef<HTMLInputElement | null>(null)
  const [attachError, setAttachError] = React.useState("")
  const [streamText, setStreamText] = React.useState("")
  const [chatError, setChatError] = React.useState("")
  const [appJustAdded, setAppJustAdded] = React.useState<string | null>(null)
  const scroller = React.useRef<HTMLDivElement>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const feed = await apiJson<{ updates: SiteUpdate[] }>("/api/updates")
      setUpdates(feed.updates || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load updates.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    const t = setInterval(() => {
      void load().catch(() => {})
    }, 30_000)
    return () => clearInterval(t)
  }, [load])

  React.useEffect(() => {
    // Keep the chat pinned to the newest message while streaming.
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [messages, streamText, streaming])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim() || !title.trim() || !body.trim() || posting) return
    setPosting(true)
    setPostError("")
    try {
      await apiJson("/api/updates", {
        method: "POST",
        body: JSON.stringify({ password, title, body, kind }),
      })
      setTitle("")
      setBody("")
      setKind("feature")
      setPosted(true)
      setComposing(false)
      setManageMode(true)
      await load()
    } catch (e) {
      setPostError(e instanceof Error ? e.message : "Could not post the update.")
    } finally {
      setPosting(false)
    }
  }

  const unlockManage = async () => {
    if (!password.trim()) {
      setUnlockError("Enter the owner password first.")
      return
    }
    setUnlockError("")
    try {
      await apiJson("/api/updates", {
        method: "POST",
        body: JSON.stringify({ password, title: "", body: "" }),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : ""
      if (msg.toLowerCase().includes("password")) {
        setUnlockError("Wrong password.")
        return
      }
      setManageMode(true)
      return
    }
    setManageMode(true)
  }

  const remove = async (id: string) => {
    if (deletingId) return
    setDeletingId(id)
    try {
      await apiJson(`/api/updates?id=${encodeURIComponent(id)}&password=${encodeURIComponent(password)}`, {
        method: "DELETE",
      })
      setUpdates((prev) => prev.filter((u) => u.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete.")
    } finally {
      setDeletingId(null)
    }
  }

  /* ---- owner: change the password ---- */
  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pwBusy) return
    setPwErr("")
    setPwDone(false)
    const next = pwNext.trim()
    if (next.length < 8) {
      setPwErr("New password must be at least 8 characters.")
      return
    }
    if (next !== pwConfirm) {
      setPwErr("The two new passwords don't match.")
      return
    }
    setPwBusy(true)
    try {
      await apiJson("/api/owner-password", {
        method: "POST",
        body: JSON.stringify({ password, next }),
      })
      /* keep the session working with the new one — every gate (feed
       * posts, deletes, Veil AI, apps) accepts it from this moment on */
      setPassword(next)
      setPwNext("")
      setPwConfirm("")
      setPwDone(true)
      window.setTimeout(() => setPwDone(false), 4000)
    } catch (e) {
      setPwErr(e instanceof Error ? e.message : "Could not change the password.")
    } finally {
      setPwBusy(false)
    }
  }

  /* ---- assistant: send a turn ---- */
  const send = async (text?: string) => {
    const base = (text ?? draft).trim()
    if ((!base && pending.length === 0) || streaming) return
    if (pending.some((a) => a.uploading && !a.error)) {
      setAttachError("Attachments are still uploading — one moment…")
      return
    }
    const settled = pending.length ? settlePending(pending) : { content: "", images: [], files: [] }
    if (!settled) return
    const content = (base + (base && settled.content ? NL2 : "") + settled.content).slice(0, 40000)
    setDraft("")
    setChatError("")
    setAppJustAdded(null)
    setPending([])
    setAttachError("")

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: content || "(attachments)",
      ...(settled.images.length ? { images: settled.images } : {}),
      ...(settled.files.length ? { files: settled.files } : {}),
    }
    const history = [...messages, userMsg]
    setMessages(history)
    setStreaming(true)
    setStreamText("")

    try {
      const final = await readOperatorStream(history, password, (d) => {
        setStreamText((t) => t + d)
      })
      if (final.error) {
        setChatError(final.error)
        if (!final.reply) {
          // Outage outbox: the assistant failed but the ask was still
          // filed — keep a visible receipt in the thread so the owner
          // knows it landed on the developer's desk.
          const filed = (final.actions || []).some(
            (a) => a.type === "dev_request" && a.ok,
          )
          if (filed) {
            setMessages((prev) => [
              ...prev,
              {
                id: uid(),
                role: "assistant",
                content:
                  "_(the assistant hit an error, but your ask was filed — the developer will see it)_",
                actions: final.actions || [],
              },
            ])
          }
          setStreaming(false)
          setStreamText("")
          return
        }
      }
      const reply = String(final.reply || "")
      const actions = final.actions || []
      const app = final.app ?? null
      // A compact note about what was done rides in the stored content so
      // later turns keep the model aware of its own actions.
      const notes: string[] = []
      for (const a of actions) if (a.type === "post_update" && a.ok) notes.push(`[posted update: ${a.title}]`)
      for (const a of actions)
        if (a.type === "dev_request" && a.ok) notes.push(`[sent dev request: ${a.title}]`)
      if (app) notes.push(`[${app.updated ? "updated app" : "installed app"}: ${app.name}]`)
      const stored = (reply + (notes.length ? "\n\n" + notes.join(" ") : "")).trim()

      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          content: reply || "(no reply)",
          actions,
          app,
        },
      ])

      // Live side-effects: refresh the feed, ping the Apps grid.
      if (actions.some((a) => (a.type === "post_update" || a.type === "dev_request") && a.ok) || app)
        void load()
      if (app) {
        setAppJustAdded(app.name)
        window.dispatchEvent(new CustomEvent("veil:apps-changed"))
      }
    } catch (e) {
      setChatError(e instanceof Error ? e.message : "The assistant is unreachable.")
    } finally {
      setStreaming(false)
      setStreamText("")
    }
  }

  const suggestions = [
    "What can you do?",
    "Post an update saying real-time chat just landed",
    "Add a tic-tac-toe app",
    "Add a new engine to chat",
  ]

  /* ---- render ---- */

  const cut = liveCutExt(streamText)
  const streamProse = cut.prose
  const building = cut.building && streaming

  return (
    <SectionShell
      title="Site updates"
      subtitle="What's new on Veil — straight from the source"
      icon={<Megaphone className="size-5" aria-hidden />}
      onBack={onBack}
    >
      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Updates sections"
        className="mb-4 inline-flex rounded-xl border border-zinc-800 bg-zinc-900/70 p-1 backdrop-blur"
      >
        {(
          [
            { id: "feed", label: "Feed", icon: Megaphone },
            { id: "assistant", label: "Updates", icon: Bot },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`veil-press inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition ${
              tab === t.id
                ? "bg-gradient-to-br from-emerald-400 to-teal-600 text-zinc-950 shadow"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <t.icon className="size-3.5" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "feed" ? (
        <>
          {/* Owner controls */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setComposing((c) => !c)
                setPostError("")
              }}
              className="veil-hover-glow veil-press bg-gradient-to-br from-emerald-400 to-teal-600 font-semibold text-zinc-950 hover:from-emerald-300 hover:to-teal-500"
            >
              {composing ? <Loader2 className="mr-1.5 size-3.5" aria-hidden /> : <Plus className="mr-1.5 size-3.5" aria-hidden />}
              {composing ? "Close composer" : "Post an update"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => (manageMode ? setManageMode(false) : void unlockManage())}
              className="veil-press gap-1.5 border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              {manageMode ? (
                <>
                  <Unlock className="size-3.5" aria-hidden /> Owner mode on
                </>
              ) : (
                <>
                  <Lock className="size-3.5" aria-hidden /> Owner mode
                </>
              )}
            </Button>
            {!manageMode && !composing && (
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Owner password"
                aria-label="Owner password"
                className="veil-focus-bloom max-w-48 border-zinc-700 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600"
              />
            )}
            {posted && !composing && (
              <span className="veil-pop-in rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-400/30">
                Update posted ✓
              </span>
            )}
            {manageMode && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPwOpen((v) => !v)
                  setPwErr("")
                  setPwDone(false)
                }}
                aria-expanded={pwOpen}
                className={pwOpen ? "veil-press gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15" : "veil-press gap-1.5 border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"}
              >
                <KeyRound className="size-3.5" aria-hidden />
                {pwOpen ? "Close password" : "Password"}
              </Button>
            )}
          </div>

          {/* Change password (owner) — the session's unlocked password is the
              current one; this form sets the new one for every gate at once */}
          {manageMode && pwOpen && (
            <form
              onSubmit={changePassword}
              className="mb-6 rounded-2xl border border-amber-500/20 bg-zinc-900/70 p-4 backdrop-blur-xl sm:p-5"
            >
              <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-zinc-400">
                <KeyRound className="size-4 text-amber-400" aria-hidden />
                Change the owner password
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="relative">
                  <Input
                    type={pwShow ? "text" : "password"}
                    value={pwNext}
                    onChange={(e) => setPwNext(e.target.value)}
                    placeholder="New password (8+ characters)"
                    maxLength={100}
                    autoComplete="new-password"
                    aria-label="New owner password"
                    className="veil-focus-bloom border-zinc-700 bg-zinc-950/60 pr-10 text-zinc-100 placeholder:text-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={() => setPwShow((v) => !v)}
                    aria-label={pwShow ? "Hide the password" : "Show the password"}
                    className="veil-press absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 transition hover:text-zinc-200"
                  >
                    {pwShow ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                  </button>
                </div>
                <Input
                  type={pwShow ? "text" : "password"}
                  value={pwConfirm}
                  onChange={(e) => setPwConfirm(e.target.value)}
                  placeholder="Repeat the new password"
                  maxLength={100}
                  autoComplete="new-password"
                  aria-label="Repeat the new owner password"
                  className="veil-focus-bloom border-zinc-700 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600"
                />
              </div>
              {pwErr && (
                <p role="alert" className="mt-2.5 text-[12.5px] text-rose-400">
                  {pwErr}
                </p>
              )}
              {pwDone && (
                <p role="status" className="veil-pop-in mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-[12px] font-medium text-emerald-300 ring-1 ring-emerald-400/30">
                  <Check className="size-3.5" aria-hidden /> Password changed — every gate takes it now
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pwBusy || !pwNext.trim() || !pwConfirm.trim()}
                  className="veil-hover-glow veil-press bg-gradient-to-br from-amber-400 to-orange-500 font-semibold text-zinc-950 hover:from-amber-300 hover:to-orange-400"
                >
                  {pwBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : <Check className="mr-1.5 size-3.5" aria-hidden />}
                  {pwBusy ? "Changing…" : "Change password"}
                </Button>
                <p className="text-[11.5px] text-zinc-500">
                  Applies instantly to Veil AI, feed posts, app deletes, and dev relays — this session stays unlocked.
                </p>
              </div>
            </form>
          )}

          {/* Composer */}
          {composing && (
            <form
              onSubmit={submit}
              className="veil-slide-up-pop mb-6 rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-4 backdrop-blur-xl sm:p-5"
            >
              <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-zinc-400">
                <Megaphone className="size-4 text-emerald-400" aria-hidden />
                New update
              </div>
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Title — e.g. Real-time chat is here"
                    maxLength={140}
                    aria-label="Update title"
                    className="veil-focus-bloom border-zinc-700 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600"
                  />
                  <Select value={kind} onValueChange={setKind}>
                    <SelectTrigger
                      aria-label="Update kind"
                      className="veil-press w-full border-zinc-700 bg-zinc-950/60 text-zinc-200 sm:w-32"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="border-zinc-700 bg-zinc-900">
                      <SelectItem value="feature">Feature</SelectItem>
                      <SelectItem value="fix">Fix</SelectItem>
                      <SelectItem value="notice">Notice</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="What changed? (shown to everyone on the site)"
                  rows={4}
                  maxLength={4000}
                  aria-label="Update body"
                  className="veil-focus-bloom resize-y border-zinc-700 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600"
                />
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Owner password"
                    aria-label="Owner password"
                    className="max-w-56 border-zinc-700 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600"
                  />
                  <Button
                    type="submit"
                    disabled={posting || !title.trim() || !body.trim() || !password.trim()}
                    className="veil-hover-glow veil-press bg-emerald-500 font-semibold text-zinc-950 hover:bg-emerald-400"
                  >
                    {posting ? (
                      <>
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> Posting…
                      </>
                    ) : (
                      "Publish"
                    )}
                  </Button>
                </div>
                {postError && (
                  <p className="text-[12px] text-rose-400" role="alert">
                    {postError}
                  </p>
                )}
              </div>
            </form>
          )}

          {unlockError && !composing && (
            <p className="mb-4 text-[12px] text-rose-400" role="alert">
              {unlockError}
            </p>
          )}

          {error && (
            <p className="mb-4 text-[13px] text-rose-400" role="alert">
              {error}
            </p>
          )}

          {/* Feed */}
          {loading ? (
            <div className="grid h-40 place-items-center text-zinc-500">
              <Loader2 className="size-6 animate-spin" aria-hidden />
            </div>
          ) : updates.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/40 p-8 text-center">
              <Megaphone className="mx-auto mb-2 size-6 text-zinc-600" aria-hidden />
              <p className="text-sm text-zinc-400">No updates posted yet.</p>
              <p className="mt-1 text-[12px] text-zinc-600">
                Post one yourself, or ask the AI assistant to write it.
              </p>
            </div>
          ) : (
            <ol className="space-y-3">
              {updates.map((u, i) => {
                const meta = kindMeta(u.kind)
                const Icon = meta.icon
                return (
                  <li
                    key={u.id}
                    className={`veil-slide-up-pop veil-stagger-${(i % 8) + 1} group relative rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-4 backdrop-blur-md transition hover:border-zinc-700 sm:p-5`}
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={`veil-hover-glow flex size-9 shrink-0 items-center justify-center rounded-xl ring-1 ${meta.chip}`}
                        aria-hidden
                      >
                        <Icon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`veil-hover-wobble rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${meta.chip}`}
                          >
                            {meta.label}
                          </span>
                          <time
                            className="veil-hover-glow text-[11px] text-zinc-500"
                            dateTime={new Date(u.createdAt).toISOString()}
                          >
                            {timeAgo(u.createdAt)}
                          </time>
                        </div>
                        <h2 className="mt-1.5 text-[15px] font-semibold tracking-tight text-zinc-50">
                          {u.title}
                        </h2>
                        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-zinc-400">
                          {u.body}
                        </p>
                      </div>
                      {manageMode && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => void remove(u.id)}
                          disabled={deletingId === u.id}
                          aria-label={`Delete update: ${u.title}`}
                          className="veil-press size-8 shrink-0 text-zinc-600 hover:bg-rose-500/10 hover:text-rose-400"
                        >
                          {deletingId === u.id ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : (
                            <Trash2 className="size-4" aria-hidden />
                          )}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </>
      ) : (
        /* ================= VEIL AI TAB ================= */
        <div className="flex min-h-[60vh] flex-col">
          {!manageMode ? (
            <div className="veil-pop-in mx-auto mt-8 w-full max-w-md rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-6 backdrop-blur-xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400/25 to-purple-600/25 text-violet-300 ring-1 ring-violet-400/30">
                  <Bot className="size-5" aria-hidden />
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold tracking-tight text-zinc-50">Veil AI</h2>
                  <p className="text-[12px] text-zinc-500">Owner tools &amp; site management</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void unlockManage()
                  }}
                  placeholder="Owner password"
                  aria-label="Owner password"
                  className="veil-focus-bloom border-zinc-700 bg-zinc-950/60 text-zinc-100 placeholder:text-zinc-600"
                />
                <Button
                  onClick={() => void unlockManage()}
                  className="veil-hover-glow veil-press bg-gradient-to-br from-violet-400 to-purple-600 font-semibold text-zinc-950 hover:from-violet-300 hover:to-purple-500"
                >
                  <Unlock className="mr-1.5 size-3.5" aria-hidden /> Unlock
                </Button>
              </div>
              {unlockError && (
                <p className="mt-3 text-[12px] text-rose-400" role="alert">
                  {unlockError}
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Chat scroller */}
              <div
                ref={scroller}
                className="veil-scroll-slim mb-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
                style={{ maxHeight: "min(58vh, 560px)" }}
                aria-live="polite"
              >
                {messages.length === 0 && (
                  <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-5 backdrop-blur-md">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400/25 to-purple-600/25 text-violet-300 ring-1 ring-violet-400/30">
                        <Bot className="size-5" aria-hidden />
                      </div>
                      <div>
                        <h2 className="text-[15px] font-semibold tracking-tight text-zinc-50">
                          Veil AI on call
                        </h2>
                        <p className="text-[12px] text-zinc-500">
                          Post updates, build apps, relay site changes to the dev.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => void send(s)}
                          className="veil-hover-lift veil-press rounded-full border border-zinc-700/80 bg-zinc-900/70 px-3.5 py-1.5 text-[12.5px] text-zinc-300 transition hover:border-violet-400/50 hover:text-zinc-100"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`veil-slide-up-pop max-w-[86%] rounded-2xl px-4 py-3 backdrop-blur-md ${
                        m.role === "user"
                          ? "bg-gradient-to-br from-emerald-400 to-teal-600 text-zinc-950"
                          : "border border-zinc-800/80 bg-zinc-900/70 text-zinc-200"
                      }`}
                    >
                      {m.role === "user" ? (
                        <>
                          {m.files && m.files.length > 0 && (
                            <div className="mb-2 flex flex-wrap gap-2">
                              {m.files.map((f, i) =>
                                f.type && f.type.startsWith("image/") && (f.url || m.images?.[i]) ? (
                                  <a
                                    key={i}
                                    href={f.url || m.images?.[i]}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block overflow-hidden rounded-lg ring-1 ring-emerald-900/40"
                                  >
                                    { }
                                    <img
                                      src={f.url || m.images?.[i]}
                                      alt={f.name}
                                      className="max-h-44 max-w-[220px] rounded-lg object-cover"
                                    />
                                  </a>
                                ) : (
                                  <span
                                    key={i}
                                    className="flex items-center gap-2 rounded-lg bg-zinc-950/25 px-2.5 py-1.5 text-[11.5px] text-emerald-950/90 ring-1 ring-emerald-900/30"
                                    title={f.name}
                                  >
                                    <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                                    <span className="max-w-40 truncate font-medium">{f.name}</span>
                                    <span className="text-emerald-900/60">{fmtAttSize(f.size)}</span>
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                          {m.content && (
                            <p className="whitespace-pre-wrap break-words text-[13.5px] font-medium leading-relaxed">
                              {m.content}
                            </p>
                          )}
                        </>
                      ) : (
                        <>
                          <MarkdownText text={m.content} />
                          {/* action result chips */}
                          {(m.actions || []).length > 0 && (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                              {m.actions!.map((a, i) =>
                                a.type === "post_update" ? (
                                  <span
                                    key={i}
                                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${
                                      a.ok
                                        ? "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30"
                                        : "bg-rose-500/15 text-rose-300 ring-rose-400/30"
                                    }`}
                                  >
                                    {a.ok ? (
                                      <>
                                        <SquarePen className="size-3" aria-hidden /> Posted to feed
                                      </>
                                    ) : (
                                      <>
                                        <Wrench className="size-3" aria-hidden /> {a.error || "Failed"}
                                      </>
                                    )}
                                  </span>
                                ) : a.type === "dev_request" ? (
                                  <span
                                    key={i}
                                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${
                                      a.ok
                                        ? "bg-amber-500/15 text-amber-300 ring-amber-400/30"
                                        : "bg-rose-500/15 text-rose-300 ring-rose-400/30"
                                    }`}
                                  >
                                    {a.ok ? (
                                      <>
                                        <Hammer className="size-3" aria-hidden /> Sent to the dev — it
                                        gets built into the site
                                      </>
                                    ) : (
                                      <>
                                        <Wrench className="size-3" aria-hidden /> {a.error || "Failed"}
                                      </>
                                    )}
                                  </span>
                                ) : (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-300 ring-1 ring-rose-400/30"
                                  >
                                    {a.error || "Failed"}
                                  </span>
                                ),
                              )}
                            </div>
                          )}
                          {m.app && (
                            <div className="veil-pop-in mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 py-2">
                              <Package className="size-4 shrink-0 text-violet-300" aria-hidden />
                              <p className="min-w-0 flex-1 text-[12px] text-violet-200">
                                <span className="font-semibold">{m.app.name}</span>{" "}
                                {m.app.updated ? "updated — re-bundled into the offline" : "installed — bundled into the offline"}
                                <span className="font-semibold"> Veil AI Apps pack</span>
                                <span className="text-violet-300/70"> (Arcade › Roblox replaced the old Apps tab)</span>.
                              </p>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}

                {/* streaming bubble */}
                {streaming && (
                  <div className="flex justify-start">
                    <div className="veil-slide-up-pop max-w-[86%] rounded-2xl border border-zinc-800/80 bg-zinc-900/70 px-4 py-3 text-zinc-200 backdrop-blur-md">
                      {streamProse ? (
                        <MarkdownText text={streamProse} />
                      ) : (
                        <div className="flex items-center gap-1.5 py-1" aria-label="The operator is thinking">
                          <span className="size-1.5 animate-bounce rounded-full bg-violet-300 [animation-delay:0ms]" />
                          <span className="size-1.5 animate-bounce rounded-full bg-violet-300 [animation-delay:150ms]" />
                          <span className="size-1.5 animate-bounce rounded-full bg-violet-300 [animation-delay:300ms]" />
                        </div>
                      )}
                      {building && (
                        <div className="mt-2 flex items-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/10 px-3 py-2">
                          <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-300" aria-hidden />
                          <p className="text-[12px] tabular-nums text-violet-200">
                            Building the app… {(cut.bytes / 1024).toFixed(1)} KB
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {appJustAdded && (
                  <p className="veil-pop-in text-center text-[11px] text-emerald-400/80" role="status">
                    {appJustAdded} is live in Arcade › Apps
                  </p>
                )}
              </div>

              {chatError && (
                <p className="mb-2 text-[12px] text-rose-400" role="alert">
                  {chatError}
                </p>
              )}

              {/* Composer */}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void send()
                }}
                className="shrink-0"
              >
                <div className="mb-2">
                  {pending.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {pending.map((a) => (
                        <span
                          key={a.id}
                          className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11.5px] ${
                            a.error
                              ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                              : "border-zinc-700/80 bg-zinc-900/90 text-zinc-300"
                          }`}
                          title={a.file.name}
                        >
                          {a.dataUrl ? (
                             
                            <img src={a.dataUrl} alt={a.file.name} className="h-9 w-9 rounded-md object-cover" />
                          ) : (
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                          )}
                          <span className="max-w-36 truncate">{a.file.name}</span>
                          <span className="text-zinc-500">{fmtAttSize(a.file.size)}</span>
                          {a.uploading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" aria-hidden />
                          ) : a.error ? (
                            <span className="text-rose-300">{a.error}</span>
                          ) : (
                            <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                          )}
                          <button
                            type="button"
                            aria-label={"Remove " + a.file.name}
                            onClick={() => setPending((pp) => pp.filter((x) => x.id !== a.id))}
                            className="veil-press ml-0.5 rounded-full p-0.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  {attachError && (
                    <p className="mb-2 text-[11.5px] text-rose-400" role="alert">
                      {attachError}
                    </p>
                  )}
                </div>
                <div className="flex items-end gap-2 rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-2 backdrop-blur-xl focus-within:border-violet-400/50">
                  <input
                    ref={attachInputRef}
                    type="file"
                    multiple
                    aria-label="Attach files"
                    className="hidden"
                    onChange={(e) => {
                      beginPick(e.target.files, setPending, setAttachError, uid)
                      e.currentTarget.value = ""
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label="Attach images or files"
                    title="Attach images or files — they ride with your ask (and any dev request)"
                    onClick={() => attachInputRef.current?.click()}
                    disabled={pending.length >= MAX_ATTACH}
                    className="veil-hover-wobble size-9 shrink-0 border border-zinc-700/60 bg-zinc-950/40 p-0 text-zinc-400 hover:text-zinc-100"
                  >
                    <Paperclip className="size-4" aria-hidden />
                  </Button>
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        void send()
                      }
                    }}
                    rows={1}
                    placeholder="Ask for changes — “add a new engine to chat”, “add a snake app”, “post an update about the new wallpapers”…"
                    aria-label="Message the AI operator"
                    className="veil-focus-bloom max-h-32 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-[13.5px] text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-0"
                  />
                  <Button
                    type="submit"
                    disabled={streaming || (!draft.trim() && pending.length === 0)}
                    aria-label="Send"
                    className="veil-hover-glow veil-press size-9 shrink-0 bg-gradient-to-br from-violet-400 to-purple-600 text-zinc-950 hover:from-violet-300 hover:to-purple-500"
                  >
                    {streaming ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Send className="size-4" aria-hidden />
                    )}
                  </Button>
                </div>
                <p className="mt-2 text-center text-[11px] text-zinc-600">
                  Veil AI posts updates, installs apps, and takes bigger site changes to the dev —
                  apps land in Arcade › Apps.
                </p>
              </form>
            </>
          )}
        </div>
      )}
    </SectionShell>
  )
}
