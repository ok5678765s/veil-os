"use client";

/**
 * Veil AI — the AI assistant overlay.
 *
 * Chat UI over POST /api/ai ({ messages: [{ role, content }] } — system
 * prompt lives server-side). Assistant replies render through a tiny
 * hand-rolled markdown renderer: **bold**, `inline code`, fenced code
 * blocks, headings, bullets, and [label](https://…) links which become
 * tappable chips that open through Veil (onOpenUrl). No markdown dependency.
 */

import * as React from "react";
import { motion } from "framer-motion";
import {
  Archive,
  ArrowLeft,
  Bomb,
  Bot,
  Brush,
  Calculator,
  Check,
  Copy,
  Dices,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  Globe,
  Image as ImageIcon,
  Joystick,
  Key,
  Link2,
  Loader2,
  Monitor,
  MonitorPlay,
  Music,
  Package,
  Palette,
  Paperclip,
  Pen,
  Play,
  RotateCw,
  Send,
  Square,
  Sparkles,
  Terminal,
  Timer,
  Trophy,
  TriangleAlert,
  Worm,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { uid } from "@/lib/veil/shared";
import { cn } from "@/lib/utils";
import { liveCutExt, parseExtReply, stripExtHtml, type AiExt } from "@/lib/veil/ext-maker";
import { OPEN_AI_GAMES_EVENT, playMadeGameInArcade, saveMadeGame, takePendingAiGames } from "@/lib/veil/cloud-games";
import {
  beginPick,
  fmtAttSize,
  settlePending,
  MAX_ATTACH,
  type PendingAtt,
} from "@/lib/veil/attach";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Error bubbles never get sent back to the API. */
  error?: boolean;
  /** Extension Maker replies carry the built app. */
  ext?: AiExt;
  /** Live bubble — text is still streaming in (renders a caret). */
  streaming?: boolean;
  /** Live status note (e.g. the server is finishing a truncated build). */
  note?: string;
  /** Attached images (inline data URLs — only the fresh turn carries
   * them; the sessionStorage snapshot strips them to stay in quota). */
  images?: string[];
  /** Attached files with durable vault URLs (images included — the
   * bubble renders from these so attachments survive reloads). */
  files?: { name: string; size: number; type: string; url?: string }[];
  /** AI Image mode — the generated picture (inline data URL, stripped
   * from the sessionStorage snapshot to stay in quota). */
  image?: string;
  /** AI Video mode — the playable URL once the render finishes. */
  video?: string;
  /** Which generation is in flight while this bubble streams. */
  gen?: "image" | "video";
  /** The prompt that produced a generated image/video (echoed under it). */
  genPrompt?: string;
}

const SUGGESTIONS: { icon: LucideIcon; text: string }[] = [
  { icon: Globe, text: "What works well through Veil?" },
  { icon: Joystick, text: "Find me a title to play" },
  { icon: ImageIcon, text: "Suggest a new wallpaper" },
];

/* sessionStorage key for the conversation survival feature: this sandbox
 * restarts the dev server often (restores, Fast Refresh on cold route
 * compile), and each reload used to wipe the chat mid-build. */
const CHAT_STORE_KEY = "veil:ai-chat-v1";

/* Image-mode sizes the backend accepts (mirrors the SDK contract). */
const IMAGE_SIZES: { id: string; label: string }[] = [
  { id: "1024x1024", label: "Square" },
  { id: "1344x768", label: "Landscape" },
  { id: "768x1344", label: "Portrait" },
  { id: "1440x720", label: "Wide" },
];

/* veil-ext icon names (the offline file's icon set) → lucide components.
 * Rendered through the ExtIcon wrapper (static lookup, WxGlyph-style) so
 * the React compiler keeps the component identity stable. */
const EXT_ICONS: Record<string, LucideIcon> = {
  bot: Bot, joypad: Joystick, image: ImageIcon, globe: Globe, dices: Dices,
  search: Globe, spark: Sparkles, calc: Calculator, trophy: Trophy, zap: Sparkles,
  timer: Timer, brush: Brush, pen: Pen, filetext: FileCode2,
  monitor: Monitor, key: Key, palette: Palette, worm: Worm, bomb: Bomb,
  music: Music, heart: Play, desktop: Monitor, play: Play,
  archive: Archive, package: Package,
};
function ExtIcon({ name, className }: { name: string; className?: string }) {
  const Icon = EXT_ICONS[name] ?? Package;
  return <Icon aria-hidden className={className} />;
}

/** links | **bold** | `inline code` (built fresh per call — no shared /g state). */
const INLINE_PATTERN =
  "\\[([^\\]]+)\\]\\((https?://[^\\s)]+)\\)|\\*\\*([^*\\n]+)\\*\\*|`([^`\\n]+)`";

/* ------------------------------------------------------------------ */
/* Tiny markdown renderer                                              */
/* ------------------------------------------------------------------ */

type Block = { type: "text"; lines: string[] } | { type: "code"; lang: string; code: string };

function splitBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) {
      blocks.push({ type: "text", lines: para });
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const lang = line.replace(/^\s*```/, "").trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

function InlineText({
  text,
  onOpenUrl,
  idp,
}: {
  text: string;
  onOpenUrl: (url: string) => void;
  idp: string;
}) {
  const re = new RegExp(INLINE_PATTERN, "g");
  const parts: React.ReactNode[] = [];
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const key = `${idp}-${n++}`;
    const linkLabel = m[1];
    const linkHref = m[2];
    const bold = m[3];
    const code = m[4];
    if (linkLabel !== undefined && linkHref !== undefined) {
      parts.push(
        <button
          key={key}
          type="button"
          onClick={() => onOpenUrl(linkHref)}
          aria-label={`Open ${linkLabel} through Veil`}
          className="veil-press inline-flex max-w-full items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-3 py-1 align-middle text-[12.5px] font-medium text-emerald-300 transition hover:bg-emerald-500/25 hover:ring-2 hover:ring-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
        >
          <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{linkLabel}</span>
        </button>
      );
    } else if (bold !== undefined) {
      parts.push(
        <strong key={key} className="font-semibold text-zinc-50">
          {bold}
        </strong>
      );
    } else if (code !== undefined) {
      parts.push(
        <code
          key={key}
          className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[12.5px] text-emerald-300"
        >
          {code}
        </code>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function TextBlock({
  lines,
  onOpenUrl,
  idp,
}: {
  lines: string[];
  onOpenUrl: (url: string) => void;
  idp: string;
}) {
  const nodes: React.ReactNode[] = [];
  let bullets: string[] = [];
  let bi = 0;
  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    const ulKey = `${idp}-ul${bi++}`;
    nodes.push(
      <ul key={ulKey} className="ml-1 space-y-1.5">
        {items.map((b, i) => (
          <li
            key={`${ulKey}-${i}`}
            className="relative break-words pl-4 before:absolute before:left-0 before:top-[0.55em] before:h-1 before:w-1 before:rounded-full before:bg-emerald-400/70"
          >
            <InlineText text={b} onOpenUrl={onOpenUrl} idp={`${ulKey}-${i}`} />
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };
  lines.forEach((line, idx) => {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flushBullets();
    if (line.trim() === "") return;
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    nodes.push(
      <p key={`${idp}-p${idx}`} className={cn("min-w-0 break-words", heading && "font-semibold text-zinc-100")}>
        <InlineText text={heading ? heading[1] : line} onOpenUrl={onOpenUrl} idp={`${idp}-p${idx}`} />
      </p>
    );
  });
  flushBullets();
  return <div className="space-y-2">{nodes}</div>;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/90">
      <div className="border-b border-zinc-800/70 px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-zinc-500">
          {lang || "code"}
        </span>
      </div>
      <pre className="veil-scroll-slim overflow-x-auto p-3 text-[12.5px] leading-relaxed text-zinc-300">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

function AssistantMessage({ content, onOpenUrl }: { content: string; onOpenUrl: (url: string) => void }) {
  const blocks = React.useMemo(() => splitBlocks(content), [content]);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <CodeBlock key={`c${i}`} lang={b.lang} code={b.code} />
        ) : (
          <TextBlock key={`t${i}`} lines={b.lines} onOpenUrl={onOpenUrl} idp={`t${i}`} />
        )
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bubbles                                                             */
/* ------------------------------------------------------------------ */

function TypingDots() {
  return (
    <div className="flex items-center gap-1.5 px-1 py-1" role="status" aria-label="The assistant is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400/80"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}

/* ── View code — the actual source, in the open ───────────────────── */
const CODE_LINES_MAX = 1500;

function fileNameSlug(ext: AiExt): string {
  const slug = ext.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "veil-app"}.html`;
}

/* ── “Give it to you”: the raw build as a real .html file on disk.
   Shared by the ExtCard button and the View-code dialog. ── */
function downloadExtFile(ext: AiExt): void {
  const url = URL.createObjectURL(new Blob([ext.html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileNameSlug(ext);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── Live preview — the build running INLINE in a sandboxed iframe,
   never a browser tab, never a new window. No allow-popups in the
   sandbox, so even window.open attempts inside the build stay put. ── */
function ExtPreviewDialog({ ext, open, onOpenChange }: { ext: AiExt; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [reloads, setReloads] = React.useState(0);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setLoaded(false);
      setReloads(0);
    }
  }, [open, ext.html]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden border-zinc-800 bg-zinc-950/95 p-0 backdrop-blur-xl sm:rounded-2xl">
        <DialogHeader className="flex-row items-center gap-3 border-b border-zinc-800 bg-violet-500/[0.06] px-4 py-3">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-400/30"
          >
            <MonitorPlay className="h-4.5 w-4.5 text-violet-300" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[14px] font-semibold text-zinc-50">{ext.name} — live preview</DialogTitle>
            <DialogDescription className="truncate text-[12px] text-zinc-400">
              Runs right here in Veil · sandboxed · no browser tab
            </DialogDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setLoaded(false);
              setReloads((r) => r + 1);
            }}
            aria-label="Reload the preview"
            title="Reload"
            className="veil-press h-8 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12.5px] font-medium text-zinc-300 hover:border-violet-500/40 hover:text-violet-200"
          >
            <RotateCw aria-hidden className="h-3.5 w-3.5" />
            Reload
          </Button>
        </DialogHeader>
        <div className="relative h-[68vh] bg-zinc-950">
          {!loaded && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3">
              <Loader2 aria-hidden className="h-6 w-6 animate-spin text-violet-300" />
              <p className="text-[12.5px] text-zinc-400">Starting {ext.name}…</p>
            </div>
          )}
          <iframe
            key={reloads}
            srcDoc={ext.html}
            title={`${ext.name} live preview`}
            className="absolute inset-0 size-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-downloads"
            allow="fullscreen; autoplay; gamepad"
            onLoad={() => setLoaded(true)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ExtCodeDialog({ ext, open, onOpenChange }: { ext: AiExt; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [copied, setCopied] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const lines = React.useMemo(() => ext.html.replace(/\r\n?/g, "\n").split("\n"), [ext.html]);
  const shown = lines.length > CODE_LINES_MAX;
  const view = shown ? lines.slice(0, CODE_LINES_MAX) : lines;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ext.html);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = ext.html;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  /* Preview runs INLINE (sandboxed iframe inside the dialog) — never
   * a browser tab, never a new window. */
  const openPreview = () => setPreviewing(true);

  const downloadRaw = () => downloadExtFile(ext);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-0 overflow-hidden border-zinc-800 bg-zinc-950/95 p-0 backdrop-blur-xl sm:rounded-2xl">
        <DialogHeader className="flex-row items-center gap-3 border-b border-zinc-800 bg-violet-500/[0.06] px-4 py-3.5">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-400/30"
          >
            <FileCode2 className="h-4.5 w-4.5 text-violet-300" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[14px] font-semibold text-zinc-50">{ext.name} — HTML</DialogTitle>
            <DialogDescription className="truncate text-[12px] text-zinc-400">
              The actual source code of the app · {lines.length.toLocaleString()} lines ·{" "}
              {Math.round(ext.html.length / 1024)} KB
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-4 py-2.5">
          <Button
            type="button"
            onClick={copy}
            className="veil-press h-8 gap-1.5 rounded-xl bg-zinc-800 px-3 text-[12.5px] font-medium text-zinc-200 hover:bg-zinc-700"
          >
            {copied ? <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy code"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={openPreview}
            className="veil-press h-8 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12.5px] font-medium text-zinc-300 hover:border-violet-500/40 hover:text-violet-200"
          >
            <MonitorPlay aria-hidden className="h-3.5 w-3.5" />
            Preview
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={downloadRaw}
            className="veil-press h-8 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12.5px] font-medium text-zinc-300 hover:border-violet-500/40 hover:text-violet-200"
          >
            <Download aria-hidden className="h-3.5 w-3.5" />
            Save .html
          </Button>
          <p className="w-full text-[11px] text-zinc-500 sm:w-auto sm:flex-1 sm:text-right">
            Runs anywhere — a single self-contained page.
          </p>
        </div>
        <div className="veil-scroll-slim max-h-[55vh] overflow-auto bg-zinc-950">
          <table className="w-full border-collapse font-mono text-[11.5px] leading-relaxed">
            <tbody>
              {view.map((ln, i) => (
                <tr key={i} className="align-top">
                  <td className="w-12 select-none border-r border-zinc-800/70 bg-zinc-900/40 px-2 text-right text-[10.5px] text-zinc-600">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre-wrap break-all px-3 text-zinc-300">{ln || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown && (
            <p className="border-t border-zinc-800 px-4 py-2.5 text-[11.5px] text-zinc-500">
              +{(lines.length - CODE_LINES_MAX).toLocaleString()} more lines — use Copy code or Save .html for the full source.
            </p>
          )}
        </div>
      </DialogContent>
      {previewing && <ExtPreviewDialog ext={ext} open={previewing} onOpenChange={setPreviewing} />}
    </Dialog>
  );
}

/* ── AI Coder build card — the finished app, ready to run ────────── */
function ExtCard({ ext }: { ext: AiExt }) {
  const [shown, setShown] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const [launched, setLaunched] = React.useState(false);
  const gameId = React.useRef<string | null>(null);
  const kb = Math.round(ext.html.length / 1024);
  /* Save into “My AI builds” and hand off to the Arcade — the build
   * plays embedded in the Roblox tab, never a browser tab. */
  const playInArcade = () => {
    const stored = saveMadeGame({
      ...(gameId.current ? { id: gameId.current } : {}),
      name: ext.name,
      desc: ext.desc,
      icon: ext.icon,
      html: ext.html,
    });
    gameId.current = stored.id;
    setLaunched(true);
    playMadeGameInArcade(stored.id);
  };
  return (
    <div className="veil-pop-in mt-2 overflow-hidden rounded-2xl border border-violet-500/30 bg-zinc-950/80">
      <div className="flex items-center gap-3 border-b border-violet-500/20 bg-violet-500/[0.08] px-4 py-3">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-400/30"
        >
          <ExtIcon name={ext.icon} className="h-4.5 w-4.5 text-violet-300" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-zinc-50">{ext.name}</p>
          <p className="truncate text-[12px] text-zinc-400">{ext.desc}</p>
        </div>
        <span className="shrink-0 rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 font-mono text-[10.5px] text-violet-300">
          {kb} KB
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button
          type="button"
          onClick={playInArcade}
          className="veil-hover-glow veil-press h-8 gap-1.5 rounded-xl bg-violet-500 px-3 text-[12.5px] font-medium text-white shadow-lg shadow-violet-500/20 hover:bg-violet-400"
        >
          <Play aria-hidden className="h-3.5 w-3.5" />
          {launched ? "Playing in the Arcade — launch again" : "Play in the Arcade"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setPreview(true)}
          className="veil-press h-8 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12.5px] font-medium text-zinc-300 hover:border-violet-500/40 hover:text-violet-200"
        >
          <MonitorPlay aria-hidden className="h-3.5 w-3.5" />
          Preview
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setShown((s) => !s)}
          aria-expanded={shown}
          className="veil-press h-8 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12.5px] font-medium text-zinc-300 hover:border-violet-500/40 hover:text-violet-200"
        >
          <Eye aria-hidden className="h-3.5 w-3.5" />
          {shown ? "Hide code" : "View code"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => downloadExtFile(ext)}
          title="Save the raw build as an .html file"
          className="veil-press h-8 gap-1.5 rounded-xl border-zinc-700 bg-zinc-900/60 px-3 text-[12.5px] font-medium text-zinc-300 hover:border-violet-500/40 hover:text-violet-200"
        >
          <Download aria-hidden className="h-3.5 w-3.5" />
          Save .html
        </Button>
        <p className="w-full text-[11px] leading-relaxed text-zinc-500 sm:w-auto sm:flex-1 sm:text-right">
          Saved to <span className="text-zinc-300">My AI builds</span> — runs right here or inside the Arcade, never a browser tab.
        </p>
      </div>
      {shown && (
        <ExtCodeDialog ext={ext} open={shown} onOpenChange={setShown} />
      )}
      {preview && (
        <ExtPreviewDialog ext={ext} open={preview} onOpenChange={setPreview} />
      )}
    </div>
  );
}

/** Live build console — the AI Coder's code streaming in real time.
 *  A terminal-style tail (bottom-anchored, so the newest lines always
 *  stay visible) plus a running elapsed-seconds counter: even a long
 *  build feels alive instead of a silent KB counter. Mounts only while
 *  a maker reply streams, so the ticker's interval never outlives it. */
function BuildConsole({ codeTail }: { codeTail: string }) {
  const [secs, setSecs] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-zinc-700/50 bg-zinc-950/70">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/70 px-2.5 py-1">
        <span
          aria-hidden
          className="flex items-center gap-1.5 font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-violet-300/70"
        >
          <Terminal className="h-3 w-3" /> live code
        </span>
        <span className="font-mono text-[9.5px] tabular-nums text-zinc-500">{secs}s</span>
      </div>
      <div className="flex max-h-24 flex-col justify-end overflow-hidden">
        <pre
          aria-hidden
          className="whitespace-pre-wrap break-all px-2.5 py-1.5 font-mono text-[10px] leading-[1.5] text-emerald-300/60"
        >
          {codeTail}
          <span className="veil-ai-caret ml-px inline-block h-3 w-[6px] translate-y-[2px] rounded-[1.5px] bg-emerald-400/80" />
        </pre>
      </div>
    </div>
  );
}

function Bubble({
  msg,
  maker,
  onRetry,
  onOpenUrl,
}: {
  msg: Msg;
  /** Maker mode — a streaming reply hides the code being written. */
  maker: boolean;
  onRetry: () => void;
  onOpenUrl: (url: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex justify-end"
      >
        <div className="veil-slide-up-pop max-w-[85%] rounded-2xl rounded-tr-md bg-emerald-500/15 px-4 py-2.5 text-[13.5px] leading-relaxed text-emerald-50 ring-1 ring-emerald-500/25">
          {msg.files && msg.files.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {msg.files.map((f, i) =>
                f.type && f.type.startsWith("image/") && (f.url || msg.images?.[i]) ? (
                  <a
                    key={i}
                    href={f.url || msg.images?.[i]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block overflow-hidden rounded-lg ring-1 ring-emerald-400/30"
                  >
                    { }
                    <img
                      src={f.url || msg.images?.[i]}
                      alt={f.name}
                      className="max-h-44 max-w-[220px] object-cover"
                    />
                  </a>
                ) : (
                  <span
                    key={i}
                    className="flex items-center gap-2 rounded-lg bg-black/25 px-2.5 py-1.5 text-[11.5px] text-emerald-100/90 ring-1 ring-emerald-400/20"
                    title={f.name}
                  >
                    <Paperclip aria-hidden className="h-3 w-3 shrink-0" />
                    <span className="max-w-40 truncate">{f.name}</span>
                    <span className="text-emerald-200/50">{fmtAttSize(f.size)}</span>
                  </span>
                ),
              )}
            </div>
          )}
          {msg.content && <p className="whitespace-pre-wrap break-words">{msg.content}</p>}
        </div>
      </motion.div>
    );
  }

  if (msg.streaming) {
    /* Image / Video generation in flight — a dedicated panel with the
       prompt echo and a live status note (the poller updates msg.note). */
    if (msg.gen === "image" || msg.gen === "video") {
      const isImg = msg.gen === "image";
      return (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex justify-start"
        >
          <div className="veil-slide-up-pop max-w-[85%] rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${
                  isImg
                    ? "bg-cyan-500/15 text-cyan-300 ring-cyan-400/30"
                    : "bg-rose-500/15 text-rose-300 ring-rose-400/30"
                }`}
              >
                {isImg ? <ImageIcon className="h-4 w-4" /> : <MonitorPlay className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-100">
                  {isImg ? "Painting your image…" : "Rendering your video…"}
                </p>
                <p className="text-[11.5px] text-zinc-500">{msg.note ?? "working…"}</p>
              </div>
              <Loader2 aria-hidden className="ml-auto h-4 w-4 shrink-0 animate-spin text-zinc-400" />
            </div>
            {msg.genPrompt && (
              <p className="mt-2 line-clamp-2 rounded-lg bg-zinc-950/60 px-2.5 py-1.5 text-[11px] italic text-zinc-500">
                “{msg.genPrompt}”
              </p>
            )}
          </div>
        </motion.div>
      );
    }
    /* Maker builds never paint the raw HTML into the chat — the code
       starts streaming (open fence / doctype / metadata comment) and the
       bubble switches to a live "building" panel; the code's only home
       is the ExtCard's View HTML viewer once it lands. */
    const live = maker ? liveCutExt(msg.content) : null;
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex justify-start"
      >
        <div className="veil-slide-up-pop max-w-[85%] rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13.5px] leading-relaxed">
          {msg.content.trim() === "" ? (
            <div className="flex items-center gap-2.5">
              <TypingDots />
              <span className="veil-text-shine text-[12.5px] text-zinc-500">Veil AI is thinking…</span>
            </div>
          ) : live && live.building ? (
            <>
              {live.prose && <AssistantMessage content={live.prose} onOpenUrl={onOpenUrl} />}
              <div className="mt-1 rounded-xl border border-violet-500/25 bg-violet-500/[0.06] px-3.5 py-2.5">
                <div className="flex items-center gap-3">
                  <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-violet-300" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-zinc-100">
                      {msg.note ? "Veil AI is finishing the build…" : "Veil AI is writing the code…"}
                    </p>
                    <p className="text-[11.5px] text-zinc-500">
                      {msg.note ? (
                        <>
                          {msg.note} · {(live.bytes / 1024).toFixed(1)} KB so far.
                        </>
                      ) : (
                        `${(live.bytes / 1024).toFixed(1)} KB · ${live.lines} lines — streaming below.`
                      )}
                    </p>
                  </div>
                </div>
                <BuildConsole codeTail={live.codeTail} />
              </div>
              <p className="mt-1 text-[10.5px] text-zinc-600">
                Taking too long? The stop button next to the composer cancels and keeps your text.
              </p>
            </>
          ) : (
            <>
              <AssistantMessage content={live ? live.prose : msg.content} onOpenUrl={onOpenUrl} />
              <span
                aria-hidden
                className="veil-ai-caret ml-0.5 inline-block h-4 w-[7px] translate-y-[3px] rounded-[2px] bg-emerald-400/90"
              />
            </>
          )}
        </div>
      </motion.div>
    );
  }

  if (msg.error) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex justify-start"
      >
        <div className="veil-slide-up-pop max-w-[85%] rounded-2xl rounded-tl-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] leading-relaxed text-amber-200">
          <div className="flex items-start gap-2">
            <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p className="break-words">{msg.content}</p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            aria-label="Retry the last request"
            className="mt-2.5 veil-press inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-zinc-900/60 px-2.5 py-1 text-[12px] font-medium text-amber-200 transition hover:border-amber-400/50 hover:text-amber-100"
          >
            <RotateCw aria-hidden className="h-3 w-3" />
            Retry
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="flex justify-start"
    >
      <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-zinc-800 bg-zinc-900 px-4 py-3 text-[13.5px] leading-relaxed">
        {/* ── AI Image result card ── */}
        {msg.image ? (
          <figure className="m-0">
            <a
              href={msg.image}
              target="_blank"
              rel="noreferrer"
              aria-label="Open the generated image full size"
              className="block overflow-hidden rounded-xl border border-zinc-700/60"
            >
              <img
                src={msg.image}
                alt={msg.genPrompt ? `AI-generated image: ${msg.genPrompt}` : "AI-generated image"}
                className="block max-h-[420px] w-full object-contain"
              />
            </a>
            <figcaption className="mt-2 flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-300 ring-1 ring-cyan-500/25">
                <ImageIcon aria-hidden className="h-3 w-3" />
                Generated image
              </span>
              <button
                type="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = msg.image ?? "";
                  a.download = `veil-image-${Date.now()}.png`;
                  a.click();
                }}
                className="veil-press inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-cyan-400/50 hover:text-cyan-200"
              >
                <Download aria-hidden className="h-3 w-3" />
                Save PNG
              </button>
              {msg.genPrompt && (
                <span className="min-w-0 flex-1 truncate text-[11px] italic text-zinc-600">
                  “{msg.genPrompt}”
                </span>
              )}
            </figcaption>
          </figure>
        ) : msg.video ? (
          /* ── AI Video result card ── */
          <figure className="m-0">
            <video
              src={msg.video}
              controls
              playsInline
              preload="metadata"
              className="block max-h-[420px] w-full rounded-xl border border-zinc-700/60 bg-black"
            />
            <figcaption className="mt-2 flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-300 ring-1 ring-rose-500/25">
                <MonitorPlay aria-hidden className="h-3 w-3" />
                Generated video
              </span>
              <a
                href={msg.video}
                target="_blank"
                rel="noreferrer"
                className="veil-press inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition hover:border-rose-400/50 hover:text-rose-200"
              >
                <Download aria-hidden className="h-3 w-3" />
                Open / save
              </a>
              {msg.genPrompt && (
                <span className="min-w-0 flex-1 truncate text-[11px] italic text-zinc-600">
                  “{msg.genPrompt}”
                </span>
              )}
            </figcaption>
          </figure>
        ) : (
        <>{" "}</>
        )}
        {/* Safety net ①: a maker reply that still has an open <!doctype but no
            extension card means the model's build came back incomplete (even
            the server's auto-continue rounds couldn't finish it). Never dump
            the half-written code as prose — offer a clean retry instead. */}
        {maker && !msg.ext && /<!doctype html/i.test(msg.content) ? (
          <>
            <div className="flex items-start gap-2.5">
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-100">The build came back incomplete.</p>
                <p className="mt-0.5 text-[12.5px] text-zinc-500">
                  The model stopped mid-code — the build wasn&rsquo;t finished, so there&rsquo;s nothing
                  to run yet. Ask again (a retry usually lands a complete page).
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onRetry}
              aria-label="Retry the build"
              className="mt-2.5 veil-press inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-zinc-900/60 px-2.5 py-1 text-[12px] font-medium text-amber-200 transition hover:border-amber-400/50 hover:text-amber-100"
            >
              <RotateCw aria-hidden className="h-3 w-3" />
              Retry
            </button>
          </>
        ) : maker && !msg.ext && !/```/.test(msg.content) ? (
          <>
            {/* Safety net ②: prose-only — the model described the app but never
                wrote a code block (a known quirk; even the server's nudges
                sometimes get another description back). Show the description,
                but flag it with a retry — the user asked for an app, not
                adjectives. */}
            <AssistantMessage content={msg.content} onOpenUrl={onOpenUrl} />
            <div className="mt-2 flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-2.5">
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-zinc-100">
                  Described — but not built.
                </p>
                <p className="mt-0.5 text-[11.5px] text-zinc-500">
                  The model wrote a description instead of the app. Hit Retry — a
                  rebuild almost always lands the full page.
                </p>
                <button
                  type="button"
                  onClick={onRetry}
                  aria-label="Retry the build"
                  className="mt-2 veil-press inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-zinc-900/60 px-2.5 py-1 text-[12px] font-medium text-amber-200 transition hover:border-amber-400/50 hover:text-amber-100"
                >
                  <RotateCw aria-hidden className="h-3 w-3" />
                  Retry
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* The built app renders as the ExtCard below — strip the giant
                code block (fenced OR the raw fence-less page) from the prose
                so it isn't shown twice. */}
            <AssistantMessage
              content={msg.ext ? stripExtHtml(msg.content) : msg.content}
              onOpenUrl={onOpenUrl}
            />
            {msg.ext && <ExtCard ext={msg.ext} />}
          </>
        )}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* AiSection                                                           */
/* ------------------------------------------------------------------ */

export function AiSection({
  onBack,
  onOpenUrl,
}: {
  /** Close the assistant → back to the start page. */
  onBack: () => void;
  /** Open a suggested site through Veil. */
  onOpenUrl: (url: string) => void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  /** The in-flight request's abort handle — the Stop button and the
   *  quiet-stream watchdog both fire it. Without it a hung build left
   *  the chat unusable (loading never cleared, input locked). */
  const liveCtrl = React.useRef<AbortController | null>(null);

  /* ── conversation survival across reloads ────────────────────────
   * Restore the last finished messages (+ maker flag). If a build was
   * streaming when the page reloaded, an amber notice with Retry marks
   * the spot — the user asks again instead of staring at a lost bubble.
   * The restore runs in an effect, NOT a state initializer: this
   * component is server-rendered, and sessionStorage does not exist
   * during SSR — an initializer would fight hydration. */
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  /** Extension Maker mode — the next message becomes a build request. */
  const [maker, setMaker] = React.useState(false);
  /** Generation mode — Image / Video (mutually exclusive with maker). */
  const [genMode, setGenMode] = React.useState<null | "image" | "video">(null);
  /* image options */
  const [imgSize, setImgSize] = React.useState("1024x1024");
  /* video options */
  const [vidDuration, setVidDuration] = React.useState<5 | 10>(5);
  const [vidQuality, setVidQuality] = React.useState<"speed" | "quality">("speed");
  const [vidAudio, setVidAudio] = React.useState(false);
  /* —— attachments —— */
  const [pending, setPending] = React.useState<PendingAtt[]>([]);
  const attachInputRef = React.useRef<HTMLInputElement | null>(null);
  const [attachError, setAttachError] = React.useState("");

  const pickFiles = (list: FileList | null) => {
    beginPick(list, setPending, setAttachError, uid);
  };

  React.useEffect(() => {
    try {
      const j = JSON.parse(sessionStorage.getItem(CHAT_STORE_KEY) || "null") as
        | { maker?: unknown; interrupted?: unknown; msgs?: unknown }
        | null;
      if (!j || typeof j !== "object" || !Array.isArray(j.msgs)) return;
      const msgs = (j.msgs as Msg[]).filter(
        (m) =>
          m &&
          typeof m.content === "string" &&
          (m.role === "user" || m.role === "assistant") &&
          !m.streaming
      );
      if (j.maker === true) setMaker(true);
      if (j.genMode === "image" || j.genMode === "video") setGenMode(j.genMode);
      if (j.genMode === "image" || j.genMode === "video") setMaker(false);
      if (!msgs.length) return;
      setMessages(
        j.interrupted === true
          ? [
              ...msgs,
              {
                id: uid(),
                role: "assistant" as const,
                content:
                  "The last reply was cut off by a page reload — the conversation is intact, but that build needs to run again. Hit Retry (or ask again).",
                error: true,
              },
            ]
          : msgs
      );
    } catch {
      /* corrupt store — start fresh */
    }
  }, []);

  /* Cross-section jump: "veil:open-ai-games" (e.g. the Roblox tab's
   * My AI builds row) opens this section in AI Coder mode.
   * The pending slot covers the first-ever-open race (the event fires
   * before this section's listener attaches). */
  React.useEffect(() => {
    const activate = () => {
      setMaker(true);
      setGenMode(null);
      setTimeout(() => taRef.current?.focus(), 80);
    };
    window.addEventListener(OPEN_AI_GAMES_EVENT, activate);
    if (takePendingAiGames()) activate();
    return () => window.removeEventListener(OPEN_AI_GAMES_EVENT, activate);
  }, []);

  /* Persist (debounced, plus an immediate flush on pagehide so a reload
   * never loses the last exchange). An in-flight streaming bubble is
   * recorded as interrupted=true for the restore above. The flush runs
   * unconditionally: during a reload, visibilitychange(hidden) fires
   * BEFORE pagehide (part of unload) — skipping on hidden here would
   * delete the store the reload's restore is counting on. Real
   * tab-switch clearing is handled by the privacy sweep in page.tsx,
   * which pagehide cancels. */
  React.useEffect(() => {
    const snapshot = () => {
      try {
        sessionStorage.setItem(
          CHAT_STORE_KEY,
          JSON.stringify({
            maker,
            genMode,
            interrupted: messages.some((m) => m.streaming),
            // Data URLs would blow the 5 MB sessionStorage quota —
          // files[] metadata (with vault urls) survives instead.
          msgs: messages
            .filter((m) => !m.streaming)
            .slice(-40)
            .map((m) => ({ ...m, images: undefined, image: undefined })),
          })
        );
      } catch {
        /* storage quota / private mode — persistence is best-effort */
      }
    };
    const t = setTimeout(snapshot, 500);
    window.addEventListener("pagehide", snapshot);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pagehide", snapshot);
    };
  }, [messages, maker]);

  React.useEffect(() => {
    const t = setTimeout(() => taRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  // Auto-scroll to the latest message.
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  /* ── the streaming request ─────────────────────────────────────────
   * POST /api/ai with stream:true answers text/event-stream: {delta}
   * frames as the model types, a {done} frame with the full reply (and
   * the extracted extension for Maker mode). Long builds no longer sit
   * on a silent connection — outer proxies used to cut those and answer
   * with an HTML error page ("Unexpected token '<'" on the client). */
  const post = React.useCallback(
    async (history: Msg[], makeExt: boolean, attempt = 0): Promise<void> => {
      setLoading(true);
      const bubbleId = uid();
      // Seed the live bubble immediately — its empty state is the thinking UI.
      setMessages((ms) => [...ms, { id: bubbleId, role: "assistant", content: "", streaming: true }]);

      const fail = (reason: string, retryable: boolean) => {
        if (retryable && attempt === 0) {
          // Turn the live bubble into a transient retry note; the rerun
          // removes it and seeds a fresh thinking bubble.
          setMessages((ms) =>
            ms.map((m) => (m.id === bubbleId ? { ...m, content: `Connection hiccup (${reason}) — retrying…` } : m))
          );
          window.setTimeout(() => {
            setMessages((ms) => ms.filter((m) => m.id !== bubbleId));
            void post(history, makeExt, 1);
          }, 1600);
          return;
        }
        setMessages((ms) => {
          const withoutBubble = ms.filter((m) => m.id !== bubbleId);
          return [
            ...withoutBubble,
            {
              id: uid(),
              role: "assistant",
              content: `Couldn't reach the assistant — ${reason}.`,
              error: true,
            },
          ];
        });
        setLoading(false);
      };

      try {
        /* Abortable request: the Stop button and the quiet-stream watchdog
         * both abort; the AbortError branch unwinds without an error bubble. */
        const ctrl = new AbortController();
        liveCtrl.current = ctrl;
        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            stream: true,
            ...(makeExt ? { make: "code" } : {}),
            messages: (() => {
              const clean = history.filter((m) => !m.error && !m.streaming);
              // The LAST user message is the only one that carries
              // attachments to the model (older turns' images would
              // re-send megabytes every reply).
              let lastUser = -1;
              for (let i = clean.length - 1; i >= 0; i--) {
                if (clean[i].role === "user") {
                  lastUser = i;
                  break;
                }
              }
              return clean.map((m, i) => ({
                role: m.role,
                /* never send the built app's code back — a 10KB ext reply
                   would blow the request schema's content cap on the very
                   next message ("Couldn't reach the assistant" right after
                   the first build). The prose summary carries the context. */
                content: (
                  m.ext
                    ? stripExtHtml(m.content) || `[Built "${m.ext.name}" — a complete web app]`
                    : m.content
                ).slice(0, 20000),
                ...(i === lastUser && m.images?.length ? { images: m.images.slice(0, 4) } : {}),
                ...(i === lastUser && m.files?.length
                  ? {
                      files: m.files.slice(0, 8).map((f) => ({
                        name: f.name,
                        size: f.size,
                        type: f.type,
                        ...(f.url ? { url: f.url } : {}),
                      })),
                    }
                  : {}),
              }));
            })(),
          }),
        });

        // Content-type is checked BEFORE any JSON parse: an HTML error page
        // from a restarting server must never become "Unexpected token '<'".
        const ctype = res.headers.get("content-type") || "";
        if (!res.ok || (!ctype.includes("text/event-stream") && !ctype.includes("application/json"))) {
          if (ctype.includes("application/json")) {
            let detail = `HTTP ${res.status}`;
            try {
              const j = (await res.json()) as { error?: string };
              if (j?.error) detail = j.error;
            } catch {
              /* keep the status */
            }
            throw new Error(detail);
          }
          throw new Error(
            `the site answered a web page instead of the assistant (HTTP ${res.status}) — the server is probably restarting`
          );
        }

        // JSON fallback (server kept the compat path) — finalize directly.
        if (ctype.includes("application/json")) {
          const data = (await res.json()) as { reply?: string; error?: string; ext?: AiExt | null };
          if (!res.ok || !data.reply) throw new Error(data.error || "the assistant is unavailable right now");
          const ext = makeExt ? (data.ext ?? parseExtReply(data.reply)) : undefined;
          setMessages((ms) =>
            ms.map((m) => (m.id === bubbleId ? { ...m, content: data.reply as string, streaming: false, ext: ext ?? undefined } : m))
          );
          setLoading(false);
          return;
        }

        // ── consume the SSE stream ──
        if (!res.body) throw new Error("the stream is empty");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let carry = "";
        let final: { reply?: string; ext?: AiExt | null; error?: string } | null = null;
        let sawJsonFrame = false;

        const handleFrame = (raw: string) => {
          for (const line of raw.split("\n")) {
            if (!line.startsWith("data:")) continue; // comments/heartbeats
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue; // partial frame — wait for more bytes
            }
            if (!parsed || typeof parsed !== "object") continue;
            // const binding — the state updater below runs after this loop
            // moves on; a `let` capture would read the NEXT frame's delta.
            const frame = parsed as {
              delta?: string;
              done?: number;
              continuing?: number;
              reply?: string;
              ext?: AiExt | null;
              error?: string;
            };
            sawJsonFrame = true;
            if (typeof frame.delta === "string" && frame.delta) {
              const d = frame.delta;
              touch();
              setMessages((ms) =>
                ms.map((m) => (m.id === bubbleId ? { ...m, content: m.content + d, note: undefined } : m))
              );
            } else if (frame.continuing) {
              // The server is auto-resuming a truncated build — show it.
              touch();
              setMessages((ms) =>
                ms.map((m) => (m.id === bubbleId ? { ...m, note: "finishing the build — the reply was cut short, resuming it" } : m))
              );
            } else if (frame.done) {
              final = { reply: frame.reply, ext: frame.ext };
            } else if (frame.error) {
              final = { error: frame.error };
            }
          }
        };

        /* Two client-side watchdogs (last-resort nets — the server has its
         * own, but a bug there must never spin the UI forever):
         *   ① QUIET_MS — total byte silence: the pipe itself is dead.
         *   ② NO_DELTA_MS — heartbeats keep flowing but no delta or
         *      continuing frame arrives: the server is wedged mid-build
         *      and its own heartbeats are masking the death. That is the
         *      exact "stuck at N KB" freeze mode. */
        const QUIET_MS = 60_000;
        const NO_DELTA_MS = 180_000;
        let lastProgress = Date.now();
        const touch = () => {
          lastProgress = Date.now();
        };
        for (;;) {
          const budget = Math.max(1, Math.min(QUIET_MS, NO_DELTA_MS - (Date.now() - lastProgress)));
          let quietTimer: ReturnType<typeof setTimeout> | undefined;
          const quiet = new Promise<never>((_, reject) => {
            quietTimer = setTimeout(() => {
              /* reject FIRST so the race settles with this error, not the
               * AbortError the abort below triggers on the read promise */
              reject(
                new Error(
                  Date.now() - lastProgress >= NO_DELTA_MS - 1
                    ? "the build stopped making progress"
                    : "the stream went quiet"
                )
              );
              ctrl.abort();
            }, budget);
          });
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await Promise.race([reader.read(), quiet]);
          } finally {
            if (quietTimer) clearTimeout(quietTimer);
          }
          if (r.done) break;
          carry += decoder.decode(r.value, { stream: true });
          let sep: number;
          while ((sep = carry.indexOf("\n\n")) >= 0) {
            const frame = carry.slice(0, sep);
            carry = carry.slice(sep + 2);
            handleFrame(frame);
          }
        }
        if (carry.trim()) handleFrame(carry);

        if (final && "error" in final && final.error) {
          throw new Error(final.error);
        }
        const reply = final?.reply ?? "";
        if (!reply.trim()) {
          throw new Error(sawJsonFrame ? "the assistant returned nothing" : "the stream closed early");
        }
        const ext = makeExt ? (final?.ext ?? parseExtReply(reply)) : undefined;
        setMessages((ms) =>
          ms.map((m) => (m.id === bubbleId ? { ...m, content: reply, streaming: false, note: undefined, ext: ext ?? undefined } : m))
        );
        liveCtrl.current = null;
      } catch (e) {
        const aborted = (e as { name?: string } | null)?.name === "AbortError";
        if (aborted) {
          /* The user pressed Stop: unwind the partial bubble and its
           * request message, and put the text back in the composer so
           * nothing is lost. No error bubble — a cancel is not a failure. */
          const lastUser = history.length ? history[history.length - 1] : null;
          setMessages((ms) => {
            const without = ms.filter((m) => m.id !== bubbleId);
            if (lastUser && without.length > 0 && without[without.length - 1].role === "user") {
              without.pop();
            }
            return without;
          });
          if (lastUser && lastUser.role === "user" && lastUser.content) setInput(lastUser.content);
          liveCtrl.current = null;
          setLoading(false);
          return;
        }
        const reason = e instanceof Error ? e.message : "something went wrong";
        // One quiet retry for transient transport failures (server restart
        // windows, dropped connections, wedged model servers); model-level
        // errors surface directly.
        const retryable =
          attempt === 0 &&
          /restarting|network|Failed to fetch|stream closed|went quiet|stopped making progress|stopped writing|stalled mid-build|create timed out|total time limit|HTTP 5\d\d|Load failed/i.test(
            reason
          );
        fail(reason, retryable);
        return;
      }
      setLoading(false);
    },
    []
  );

  /* ── AI Image generation (Image mode) ───────────────────────────────
   * POST /api/ai/image registers a server-side task instantly (long
   * requests get cut by the outer gateway with a 502 — the reason the
   * chat streams with heartbeats), then /api/ai/image/status is polled
   * every 2.5s until the finished data URL lands. Abortable through the
   * same Stop button (liveCtrl). */
  const generateImage = React.useCallback(
    async (prompt: string): Promise<void> => {
      setLoading(true);
      const bubbleId = uid();
      const started = Date.now();
      setMessages((ms) => [
        ...ms,
        {
          id: bubbleId,
          role: "assistant",
          content: "",
          streaming: true,
          gen: "image",
          genPrompt: prompt,
          note: `painting “${prompt.slice(0, 60)}” — usually 5-30 seconds`,
        },
      ]);
      const ctrl = new AbortController();
      liveCtrl.current = ctrl;
      const setNote = (note: string) =>
        setMessages((ms) => ms.map((m) => (m.id === bubbleId ? { ...m, note } : m)));
      const fail = (reason: string) => {
        setMessages((ms) => {
          const without = ms.filter((m) => m.id !== bubbleId);
          return [
            ...without,
            { id: uid(), role: "assistant", content: `Couldn't generate the image — ${reason}.`, error: true },
          ];
        });
      };
      try {
        const res = await fetch("/api/ai/image", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ prompt, size: imgSize }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; taskId?: string; error?: string } | null;
        if (!res.ok || !data?.ok || typeof data.taskId !== "string") {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const taskId = data.taskId;
        for (;;) {
          const sres = await fetch(`/api/ai/image/status?taskId=${encodeURIComponent(taskId)}`, {
            signal: ctrl.signal,
            cache: "no-store",
          });
          const sdata = (await sres.json().catch(() => null)) as { ok?: boolean; status?: string; image?: string; error?: string } | null;
          if (!sres.ok || !sdata?.ok) throw new Error(sdata?.error || `status check failed (HTTP ${sres.status})`);
          if (sdata.status === "fail") throw new Error(sdata.error || "the render failed");
          if (sdata.status === "done" && typeof sdata.image === "string") {
            setMessages((ms) =>
              ms.map((m) =>
                m.id === bubbleId ? { ...m, content: "", image: sdata.image, streaming: false, note: undefined } : m
              )
            );
            liveCtrl.current = null;
            setLoading(false);
            return;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          setNote(`painting… ${secs}s elapsed`);
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 2500);
            ctrl.signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
          });
        }
      } catch (e) {
        liveCtrl.current = null;
        if ((e as { name?: string } | null)?.name === "AbortError") {
          setMessages((ms) => ms.filter((m) => m.id !== bubbleId));
          setInput(prompt);
          setLoading(false);
          return;
        }
        fail(e instanceof Error ? e.message : "something went wrong");
      }
      setLoading(false);
    },
    [imgSize]
  );

  /* ── AI Video generation (Video mode) ───────────────────────────────
   * POST /api/ai/video creates an async task; poll /api/ai/video/status
   * every 3s until SUCCESS (playable URL) or FAIL. Renders take 1-4
   * minutes — the bubble keeps a live elapsed timer, and Stop cancels. */
  const generateVideo = React.useCallback(
    async (prompt: string): Promise<void> => {
      setLoading(true);
      const bubbleId = uid();
      const started = Date.now();
      setMessages((ms) => [
        ...ms,
        {
          id: bubbleId,
          role: "assistant",
          content: "",
          streaming: true,
          gen: "video",
          genPrompt: prompt,
          note: "submitting the render…",
        },
      ]);
      const ctrl = new AbortController();
      liveCtrl.current = ctrl;
      const setNote = (note: string) =>
        setMessages((ms) => ms.map((m) => (m.id === bubbleId ? { ...m, note } : m)));
      const fail = (reason: string) => {
        setMessages((ms) => {
          const without = ms.filter((m) => m.id !== bubbleId);
          return [
            ...without,
            { id: uid(), role: "assistant", content: `Couldn't generate the video — ${reason}.`, error: true },
          ];
        });
      };
      try {
        const res = await fetch("/api/ai/video", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            prompt,
            duration: vidDuration,
            quality: vidQuality,
            withAudio: vidAudio,
            ...(vidQuality === "quality" ? { fps: 30, size: "1920x1080" } : {}),
          }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; taskId?: string; error?: string } | null;
        if (!res.ok || !data?.ok || typeof data.taskId !== "string") {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        const taskId = data.taskId;
        for (;;) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 3000);
            ctrl.signal.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
          });
          const sres = await fetch(`/api/ai/video/status?taskId=${encodeURIComponent(taskId)}`, {
            signal: ctrl.signal,
            cache: "no-store",
          });
          const sdata = (await sres.json().catch(() => null)) as { ok?: boolean; status?: string; url?: string; error?: string } | null;
          if (!sres.ok || !sdata?.ok) throw new Error(sdata?.error || `status check failed (HTTP ${sres.status})`);
          if (sdata.status === "FAIL") throw new Error("the video service failed the render");
          if (sdata.status === "SUCCESS" && typeof sdata.url === "string") {
            setMessages((ms) =>
              ms.map((m) =>
                m.id === bubbleId ? { ...m, content: "", video: sdata.url, streaming: false, note: undefined } : m
              )
            );
            liveCtrl.current = null;
            setLoading(false);
            return;
          }
          const secs = Math.round((Date.now() - started) / 1000);
          setNote(`rendering… ${secs}s elapsed — videos take 1-4 minutes`);
        }
      } catch (e) {
        liveCtrl.current = null;
        if ((e as { name?: string } | null)?.name === "AbortError") {
          setMessages((ms) => ms.filter((m) => m.id !== bubbleId));
          setInput(prompt);
          setLoading(false);
          return;
        }
        fail(e instanceof Error ? e.message : "something went wrong");
      }
      setLoading(false);
    },
    [vidDuration, vidQuality, vidAudio]
  );

  const send = React.useCallback(
    (raw?: string) => {
      const text = (raw ?? input).trim();
      if ((!text && pending.length === 0) || loading) return;
      // Generation modes take the prompt directly — no chat context, no
      // attachments. A plain user bubble goes up, the result lands under it.
      if (genMode === "image" || genMode === "video") {
        if (!text) return;
        setMessages((ms) => [...ms, { id: uid(), role: "user", content: text }]);
        if (raw === undefined) setInput("");
        setPending([]);
        setAttachError("");
        if (genMode === "image") void generateImage(text);
        else void generateVideo(text);
        return;
      }
      // Still-uploading attachments: wait for their vault URLs.
      if (pending.some((a) => a.uploading && !a.error)) {
        setAttachError("Attachments are still uploading — one moment…");
        return;
      }
      const settled = settlePending(pending);
      if (!settled) return;
      const images = settled.images;
      const files = settled.files;
      const content = (text + settled.content).slice(0, 40000);
      const userMsg: Msg = {
        id: uid(),
        role: "user",
        content: content || "(attachments)",
        ...(images.length ? { images: images.slice(0, 4) } : {}),
        ...(files.length ? { files } : {}),
      };
      setMessages((ms) => [...ms, userMsg]);
      if (raw === undefined) setInput("");
      setPending([]);
      setAttachError("");
      void post([...messages.filter((m) => !m.error && !m.streaming), userMsg], maker);
    },
    [input, loading, maker, messages, pending, post, genMode, generateImage, generateVideo]
  );

  const retry = React.useCallback(() => {
    if (loading) return;
    const ms = [...messages];
    // Pop trailing error bubbles AND dead streaming notes (a retry that
    // raced an in-flight attempt can leave one behind).
    while (ms.length > 0 && (ms[ms.length - 1].error || ms[ms.length - 1].streaming)) ms.pop();
    if (ms.length === 0) return;
    setMessages(ms);
    void post(ms, maker);
  }, [loading, maker, messages, post]);

  /** Stop button: abort the in-flight request. The post() catch sees the
   *  AbortError, unwinds the partial bubble, and returns the user's text
   *  to the composer — a cancel never surfaces as an error. */
  const stop = React.useCallback(() => {
    if (!loading) return;
    liveCtrl.current?.abort();
  }, [loading]);

  return (
    <div
      role="region"
      aria-label="Veil AI — AI assistant"
      className="relative flex h-full w-full flex-col overflow-hidden text-zinc-100"
    >
      {/* Ambient backdrop — the orb wrapper is clipped (overflow-hidden) so it
          can never extend the document scrollHeight. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="veil-orb-a absolute -top-32 left-1/2 h-[360px] w-[560px] -translate-x-1/2 rounded-full bg-emerald-500/15 blur-[120px]" />
        <div className="veil-orb-b absolute top-40 right-[14%] h-48 w-48 rounded-full bg-teal-500/10 blur-[90px]" />
        <div
          className="absolute inset-0 opacity-[0.10]"
          style={{
            backgroundImage:
              "linear-gradient(to right, #3f3f46 1px, transparent 1px), linear-gradient(to bottom, #3f3f46 1px, transparent 1px)",
            backgroundSize: "52px 52px",
            maskImage: "radial-gradient(ellipse 70% 55% at 50% 30%, black 30%, transparent 100%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 70% 55% at 50% 30%, black 30%, transparent 100%)",
          }}
        />
      </div>

      {/* ---------------- header ---------------- */}
      <header className="relative z-20 flex shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/85 px-4 py-3.5 backdrop-blur-xl sm:gap-2.5 sm:px-6">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          aria-label="Close the assistant"
          className="h-8 shrink-0 gap-1.5 rounded-xl border-zinc-800 bg-zinc-900/60 px-2.5 text-zinc-300 hover:border-emerald-500/40 hover:bg-zinc-900 hover:text-emerald-200 sm:px-3"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          <span className="hidden sm:inline">Back</span>
        </Button>
        <span
          aria-hidden
          className="veil-pulse-glow flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30"
        >
          <Bot className="h-4 w-4 text-emerald-400" />
        </span>
        <h1 className="veil-text-shine truncate text-lg font-semibold tracking-tight">Veil AI</h1>
        <Badge className="shrink-0 rounded-full border-emerald-500/25 bg-emerald-500/10 px-2.5 text-[11px] font-medium text-emerald-300">
          AI assistant
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Mode switcher — Chat · Image · Video · Coder (AI Coder) */}
          <div
            role="group"
            aria-label="Veil AI mode"
            className="flex items-center gap-0.5 rounded-full border border-zinc-800 bg-zinc-900/60 p-0.5"
          >
            {([
              { id: "chat", label: "Chat", icon: Bot, active: !maker && !genMode, on: "border-emerald-400/60 bg-emerald-500/20 text-emerald-200", off: "text-zinc-400 hover:text-zinc-100" },
              { id: "image", label: "Image", icon: ImageIcon, active: genMode === "image", on: "border-cyan-400/60 bg-cyan-500/20 text-cyan-200", off: "text-zinc-400 hover:text-cyan-200" },
              { id: "video", label: "Video", icon: MonitorPlay, active: genMode === "video", on: "border-rose-400/60 bg-rose-500/20 text-rose-200", off: "text-zinc-400 hover:text-rose-200" },
              { id: "ext", label: "AI Coder", icon: FileCode2, active: maker, on: "border-violet-400/60 bg-violet-500/20 text-violet-200", off: "text-zinc-400 hover:text-violet-200" },
            ] as const).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  if (m.id === "ext") {
                    setMaker((prev) => !prev);
                    setGenMode(null);
                  } else if (m.id === "chat") {
                    setMaker(false);
                    setGenMode(null);
                  } else {
                    setMaker(false);
                    setGenMode((prev) => (prev === m.id ? null : (m.id as "image" | "video")));
                  }
                  setTimeout(() => taRef.current?.focus(), 60);
                }}
                aria-pressed={m.active}
                title={
                  m.id === "chat"
                    ? "Chat — ask about sites, titles, wallpapers"
                    : m.id === "image"
                      ? "AI Image — describe a picture, Veil paints it"
                      : m.id === "video"
                        ? "AI Video — describe a scene, Veil renders it (1-4 min)"
                        : "AI Coder — describe any web page, tool or game and Veil AI writes the HTML/CSS/JS"
                }
                className={cn(
                  "veil-press inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition sm:px-3",
                  m.active
                    ? m.on
                    : cn("border-transparent", m.off)
                )}
              >
                <m.icon aria-hidden className="h-3.5 w-3.5" />
                <span className={m.active ? "inline" : "hidden sm:inline"}>{m.label}</span>
                {m.active && m.id !== "chat" && (
                  <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-70" />
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ---------------- message list ---------------- */}
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation with the Veil AI"
        className="veil-scroll-slim relative z-10 min-h-0 flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4 py-8 text-center sm:px-6">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-col items-center"
            >
              {/* Friendly bot illustration */}
              <div className="relative mb-5">
                <span
                  aria-hidden
                  className="veil-pulse-ring flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30"
                >
                  <Bot aria-hidden className="h-9 w-9 text-emerald-300" />
                </span>
                <span
                  aria-hidden
                  className="veil-bounce-soft absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900"
                >
                  <Sparkles aria-hidden className="h-3.5 w-3.5 text-teal-300" />
                </span>
              </div>
              <h2 className="veil-text-shine text-xl font-bold tracking-tight sm:text-2xl">
                Hey — I'm the Veil AI.
              </h2>
              <p className="mt-2.5 max-w-md text-[13.5px] leading-relaxed text-zinc-400">
                I know which sites run well through the veil, what's inside the Arcade (2,000+ titles
                to pick from), the wallpaper packs, and how to get you moving fast. Links I suggest
                open straight through Veil.
              </p>

              {/* Suggestion chips */}
              <div className="mt-6 grid w-full gap-2.5 sm:grid-cols-3">
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={s.text}
                    type="button"
                    onClick={() => send(s.text)}
                    aria-label={s.text}
                    className={`veil-pop-in veil-stagger-${i + 1} veil-hover-lift veil-press group flex items-center gap-2.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-3 text-left transition hover:-translate-y-0.5 hover:border-emerald-500/40 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50`}
                  >
                    <span
                      aria-hidden
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/25"
                    >
                      <s.icon aria-hidden className="h-4 w-4 text-emerald-300" />
                    </span>
                    <span className="text-[13px] font-medium text-zinc-200 group-hover:text-emerald-200">
                      {s.text}
                    </span>
                  </button>
                ))}
              </div>

              {/* AI Coder entry card — the HTML maker */}
              <button
                type="button"
                onClick={() => {
                  setMaker(true);
                  setTimeout(() => taRef.current?.focus(), 60);
                }}
                aria-pressed={maker}
                className="veil-slide-up-pop veil-stagger-4 group mt-2.5 flex w-full items-center gap-3 rounded-2xl border border-violet-500/30 bg-violet-500/[0.07] p-3.5 text-left transition hover:-translate-y-0.5 hover:border-violet-400/60 hover:bg-violet-500/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
              >
                <span
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 ring-1 ring-violet-400/30"
                >
                  <FileCode2 aria-hidden className="h-4 w-4 text-violet-300" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-zinc-100 group-hover:text-violet-100">
                    AI Coder
                  </span>
                  <span className="block truncate text-[12px] text-zinc-400">
                    Describe any page, tool or game — I write the HTML/CSS/JS, it runs right here
                  </span>
                </span>
                <Sparkles aria-hidden className="ml-auto h-4 w-4 shrink-0 text-violet-300/70 group-hover:text-violet-300" />
              </button>

              {/* Image Studio + Video Studio entry cards */}
              <div className="veil-slide-up-pop veil-stagger-5 mt-2.5 grid w-full gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    setMaker(false);
                    setGenMode("image");
                    setTimeout(() => taRef.current?.focus(), 60);
                  }}
                  aria-pressed={genMode === "image"}
                  className="veil-hover-lift veil-press group flex items-center gap-3 rounded-2xl border border-cyan-500/30 bg-cyan-500/[0.07] p-3.5 text-left transition hover:-translate-y-0.5 hover:border-cyan-400/60 hover:bg-cyan-500/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
                >
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15 ring-1 ring-cyan-400/30"
                  >
                    <ImageIcon aria-hidden className="h-4 w-4 text-cyan-300" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold text-zinc-100 group-hover:text-cyan-100">
                      Image Studio
                    </span>
                    <span className="block truncate text-[12px] text-zinc-400">
                      Describe a picture — AI paints it in seconds
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMaker(false);
                    setGenMode("video");
                    setTimeout(() => taRef.current?.focus(), 60);
                  }}
                  aria-pressed={genMode === "video"}
                  className="veil-hover-lift veil-press group flex items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/[0.07] p-3.5 text-left transition hover:-translate-y-0.5 hover:border-rose-400/60 hover:bg-rose-500/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50"
                >
                  <span
                    aria-hidden
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 ring-1 ring-rose-400/30"
                  >
                    <MonitorPlay aria-hidden className="h-4 w-4 text-rose-300" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold text-zinc-100 group-hover:text-rose-100">
                      Video Studio
                    </span>
                    <span className="block truncate text-[12px] text-zinc-400">
                      Describe a scene — AI renders a short clip
                    </span>
                  </span>
                </button>
              </div>
            </motion.div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 sm:px-6">
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} maker={maker} onRetry={retry} onOpenUrl={onOpenUrl} />
            ))}
          </div>
        )}
      </div>

      {/* ---------------- input row ---------------- */}
      <div className="relative z-20 shrink-0 border-t border-zinc-800/80 bg-zinc-950/85 px-4 py-3 backdrop-blur-xl sm:px-6">
        {/* AI Coder status strip */}
        {maker && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mb-2 flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-violet-500/30 bg-violet-500/[0.08] px-3 py-1.5"
          >
            <FileCode2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-violet-300" />
            <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-violet-200/90">
              AI Coder armed — describe what to build (a full web app) or ask for code in
              any language. Big and complete, streamed live.
            </p>
            <button
              type="button"
              onClick={() => setMaker(false)}
              aria-label="Leave AI Coder mode"
              className="veil-press shrink-0 rounded-full border border-violet-500/30 px-2 py-0.5 text-[10.5px] font-medium text-violet-200/80 transition hover:border-violet-300/60 hover:text-violet-100"
            >
              off
            </button>
          </motion.div>
        )}
        {/* AI Image options strip */}
        {genMode === "image" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mb-2 flex w-full max-w-2xl flex-wrap items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/[0.07] px-3 py-1.5"
          >
            <ImageIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
            <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-cyan-200/90">
              Image Studio — describe the picture, it paints in 5-30s.
            </p>
            <div className="flex items-center gap-1" role="group" aria-label="Image size">
              {IMAGE_SIZES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setImgSize(s.id)}
                  aria-pressed={imgSize === s.id}
                  className={cn(
                    "veil-press rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition",
                    imgSize === s.id
                      ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-100"
                      : "border-cyan-500/25 text-cyan-200/70 hover:border-cyan-400/40 hover:text-cyan-100"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
        {/* AI Video options strip */}
        {genMode === "video" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mx-auto mb-2 flex w-full max-w-2xl flex-wrap items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-3 py-1.5"
          >
            <MonitorPlay aria-hidden className="h-3.5 w-3.5 shrink-0 text-rose-300" />
            <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-rose-200/90">
              Video Studio — describe the scene, it renders in 1-4 minutes.
            </p>
            <div className="flex items-center gap-1" role="group" aria-label="Video length">
              {([5, 10] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setVidDuration(d)}
                  aria-pressed={vidDuration === d}
                  className={cn(
                    "veil-press rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition",
                    vidDuration === d
                      ? "border-rose-400/60 bg-rose-500/20 text-rose-100"
                      : "border-rose-500/25 text-rose-200/70 hover:border-rose-400/40 hover:text-rose-100"
                  )}
                >
                  {d}s
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Video quality">
              {(["speed", "quality"] as const).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setVidQuality(q)}
                  aria-pressed={vidQuality === q}
                  className={cn(
                    "veil-press rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition",
                    vidQuality === q
                      ? "border-rose-400/60 bg-rose-500/20 text-rose-100"
                      : "border-rose-500/25 text-rose-200/70 hover:border-rose-400/40 hover:text-rose-100"
                  )}
                >
                  {q === "speed" ? "fast" : "1080p"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setVidAudio((a) => !a)}
              aria-pressed={vidAudio}
              title="Generate AI audio effects with the video"
              className={cn(
                "veil-press rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition",
                vidAudio
                  ? "border-rose-400/60 bg-rose-500/20 text-rose-100"
                  : "border-rose-500/25 text-rose-200/70 hover:border-rose-400/40 hover:text-rose-100"
              )}
            >
              sound
            </button>
          </motion.div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="mx-auto w-full max-w-2xl"
        >
          {/* Pending attachments — thumbnails for images, pills for files */}
          {pending.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pending.map((a) => (
                <span
                  key={a.id}
                  className={cn(
                    "group relative flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-[11.5px]",
                    a.error
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                      : "border-zinc-700/80 bg-zinc-900/90 text-zinc-300",
                  )}
                  title={a.file.name}
                >
                  {a.dataUrl ? (
                     
                    <img
                      src={a.dataUrl}
                      alt={a.file.name}
                      className="h-9 w-9 rounded-md object-cover"
                    />
                  ) : (
                    <Paperclip aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  )}
                  <span className="max-w-36 truncate">{a.file.name}</span>
                  <span className="text-zinc-500">{fmtAttSize(a.file.size)}</span>
                  {a.uploading ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                  ) : a.error ? (
                    <span className="text-rose-300">{a.error}</span>
                  ) : (
                    <Check aria-hidden className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  <button
                    type="button"
                    aria-label={"Remove " + a.file.name}
                    onClick={() => setPending((pp) => pp.filter((x) => x.id !== a.id))}
                    className="ml-0.5 rounded-full p-0.5 text-zinc-500 transition hover:bg-white/10 hover:text-zinc-200"
                  >
                    <X aria-hidden className="h-3.5 w-3.5" />
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
          <div className="flex w-full items-end gap-2">
          <input
            ref={attachInputRef}
            type="file"
            multiple
            aria-label="Attach files"
            className="hidden"
            onChange={(e) => {
              pickFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          {genMode === null && (
            <Button
              type="button"
              variant="ghost"
              aria-label="Attach images or files"
              title="Attach images or files — images are seen by the assistant, text files are read, anything up to 100 MB is stored"
              onClick={() => attachInputRef.current?.click()}
              disabled={pending.length >= MAX_ATTACH}
              className="veil-hover-wobble h-11 w-11 shrink-0 rounded-2xl border border-zinc-800 bg-zinc-900/90 text-zinc-400 shadow-xl shadow-black/30 transition hover:text-zinc-100 disabled:opacity-40"
            >
              <Paperclip aria-hidden className="h-4 w-4" />
            </Button>
          )}
          <Textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              maker
                ? "Describe what to build — “a pomodoro timer with stats”, “a neon snake game”… or ask for code in any language — “a Python script that renames files”…"
                : genMode === "image"
                  ? "Describe the image — “a lighthouse in a storm, oil painting style”…"
                  : genMode === "video"
                    ? "Describe the scene — “a paper boat sailing down a rainy street, cinematic”…"
                    : "Ask about sites, titles, wallpapers…"
            }
            aria-label="Message the Veil AI"
            rows={1}
            spellCheck={false}
            className={cn(
              "veil-focus-bloom veil-scroll-slim min-h-11 max-h-44 flex-1 resize-none rounded-2xl border-zinc-800 bg-zinc-900/90 px-4 py-2.5 text-[14px] text-zinc-100 shadow-xl shadow-black/30 placeholder:text-zinc-500 focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/25",
              maker && "border-violet-500/40 focus-visible:border-violet-400/70 focus-visible:ring-violet-500/25",
              genMode === "image" && "border-cyan-500/40 focus-visible:border-cyan-400/70 focus-visible:ring-cyan-500/25",
              genMode === "video" && "border-rose-500/40 focus-visible:border-rose-400/70 focus-visible:ring-rose-500/25"
            )}
          />
          <Button
            type={loading ? "button" : "submit"}
            aria-label={loading ? "Stop generating" : "Send message"}
            disabled={!loading && !input.trim() && pending.length === 0}
            onClick={loading ? stop : undefined}
            title={loading ? "Stop — cancels the request and keeps your text" : undefined}
            className={cn(
              "veil-hover-glow veil-press h-11 w-11 shrink-0 rounded-2xl shadow-lg transition disabled:opacity-40",
              loading
                ? "bg-zinc-700 text-zinc-100 shadow-zinc-900/40 hover:bg-zinc-600 active:scale-95"
                : maker
                  ? "bg-violet-500 text-white shadow-violet-500/25 hover:bg-violet-400"
                  : genMode === "image"
                    ? "bg-cyan-500 text-cyan-950 shadow-cyan-500/25 hover:bg-cyan-400"
                    : genMode === "video"
                      ? "bg-rose-500 text-rose-950 shadow-rose-500/25 hover:bg-rose-400"
                      : "bg-emerald-500 text-emerald-950 shadow-emerald-500/25 hover:bg-emerald-400"
            )}
          >
            {loading ? (
              <Square aria-hidden className="h-4 w-4 fill-current" />
            ) : genMode === "image" ? (
              <ImageIcon aria-hidden className="h-4 w-4" />
            ) : genMode === "video" ? (
              <MonitorPlay aria-hidden className="h-4 w-4" />
            ) : (
              <Send aria-hidden className="h-4 w-4" />
            )}
          </Button>
          </div>
        </form>
        <p className="mx-auto mt-2 max-w-2xl text-center text-[11px] text-zinc-600">
          {maker ? (
            <>
              Powered by GLM · AI Coder writes complete single-file web apps — HTML, CSS and JS — and code in any language, zero external requests
            </>
          ) : genMode === "image" ? (
            <>Powered by GLM · AI Image — enter paints, Shift+Enter adds a line</>
          ) : genMode === "video" ? (
            <>Powered by GLM · AI Video — renders take 1-4 minutes, keep this tab open</>
          ) : (
            <>Powered by GLM · Enter sends · Shift+Enter adds a line</>
          )}
        </p>
      </div>
    </div>
  );
}
