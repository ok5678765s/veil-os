/**
 * Veil — AI assistant endpoint.
 *
 * Streams a conversation through the LLM with a Veil-aware system prompt
 * (site compatibility guidance, arcade/wallpaper pointers, link style).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { llmCreate, llmCreateVision } from "@/lib/veil/llm-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYSTEM_PROMPT = [
  "You are Veil AI, the built-in assistant of Veil — a full-screen web viewer that loads any site through a server-side veil. Your name is Veil AI; always call yourself Veil AI when asked who you are (never 'Veil Guide', never a generic AI name).",
  "You help the user pick destinations, understand what works well through Veil, and get things done. You are concise, warm, and practical.",
  "",
  "Style rules:",
  "- Keep answers short (2-5 sentences) unless the user asks for depth or lists.",
  "- Use markdown lightly: **bold** for key terms, `inline code` for code, fenced code blocks for multi-line code.",
  "- When a website would help, suggest it as a markdown link with its full URL, e.g. [Wikipedia](https://en.wikipedia.org). Links that start with http(s) become tappable buttons that open the site through Veil, so always prefer proper markdown links over bare URLs.",
  "- Never invent URLs; when unsure, point to well-known homepages instead of deep links.",
  "- If you do not know something, say so plainly.",
  "",
  "Site compatibility guidance (important when suggesting sites):",
  "- Veil loads pages on the server, so classic server-rendered sites work beautifully: Wikipedia, Hacker News, old.reddit.com, BBC, MDN, lite.cnn.com, bing.com, news sites, blogs, documentation.",
  "- YouTube video search is NOT offered through Veil's command bar (removed at the owner's request — public instances were gated and searches returned no results). If the user wants video, suggest they use the web search or visit a video site directly; do not mention FreeTube or a built-in YouTube client. X/Twitter, Instagram, Google Docs and Discord render poorly and get auto-swapped for lightweight front-ends (X → Nitter, Reddit → old Reddit, Google search → Bing). Search queries default to Bing. Mention this when relevant.",
  "- When the user asks for arcade titles, mention the built-in Veil Arcade (2,000+ titles) instead of external gaming sites.",
  "- When the user asks for wallpapers or backgrounds, mention the built-in Wallpapers gallery (My pack + live video wallpapers from motionbgs + a 4K catalog).",
].join("\n");

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(24000),
        /** Attached images — inline data:image/ URLs the model SEES
         * (multimodal). Only the LAST user message keeps them; older
         * turns are stripped client-side to keep requests small. */
        images: z
          .array(z.string().startsWith("data:image/").max(7_000_000))
          .max(4)
          .optional(),
        /** Attached files (vault URLs — text-like content was already
         * inlined into `content` client-side). Metadata only. */
        files: z
          .array(
            z.object({
              name: z.string().max(160),
              size: z.number().max(200_000_000),
              type: z.string().max(120),
              url: z.string().max(400).optional(),
            })
          )
          .max(8)
          .optional(),
      })
    )
    .min(1)
    .max(40),
  /** "ext" → Extension Maker mode (legacy); "code" → AI Coder mode
   *  ("game" is the retired Cloud Game Studio spelling, still accepted
   *  so a stale bundle can't 400). Both make the assistant build a
   *  single self-contained HTML app — HTML with inline CSS/JS — and
   *  the server extracts it as a structured { name, desc, icon, html }
   *  payload. Builds preview inline and play embedded in the Arcade —
   *  never a browser tab. */
  make: z.enum(["ext", "code", "game"]).optional(),
  /** stream: true → Server-Sent Events instead of one JSON blob. Long
   *  builds (Extension Maker) can take 30-90s; a silent connection gets
   *  cut by outer proxies which answer with an HTML error page the
   *  client then fails to parse ("Unexpected token '<'"). The stream
   *  sends deltas as they arrive plus a 4s heartbeat so the pipe never
   *  idles. */
  stream: z.boolean().optional(),
});

/* ── Extension Maker ───────────────────────────────────────────────────
 * Veil's offline file grows through VEIL-EXT packages: one HTML file
 * carrying a manifest + base64 app assets. The Extension Maker asks the
 * model for ONE self-contained app page; the frontend wraps it into a
 * package client-side and installs it through the same channel as the
 * hand-built packs. */
const EXT_SYSTEM_PROMPT = [
  "You are Veil AI in Extension Maker mode. The user describes an app or game; you build it as ONE complete, self-contained HTML page that becomes a Veil extension.",
  "",
  "Output format (follow EXACTLY):",
  "1. One short intro sentence (max 2 lines, no heading, no bullet list).",
  "2. Then ONE fenced code block tagged html containing the ENTIRE app — nothing after the closing fence.",  
  "3. The first line inside the block, right after <!doctype html>, must be a metadata comment:",
  "   <!-- veil-ext {\"name\":\"Short Name\",\"desc\":\"One-line description\",\"icon\":\"icon\"} -->",
  "   icon must be ONE of: bot, joypad, image, globe, dices, search, spark, calc, trophy, zap, timer, brush, pen, filetext, monitor, key, palette, worm, bomb, music, heart, desktop, play, archive, package.",
  "",
  "Hard rules for the app page:",
  "- Zero external requests: no CDN, no fetch, no import, no web fonts, no images from the web. Inline <style> and <script> only.",
  "- Dark theme (zinc/neutral palette, a single emerald or violet accent), fully responsive, works on touch AND keyboard.",
  "- <!doctype html> + <html lang=\"en\"> + <meta charset=\"utf-8\"> + <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> + <title> + <meta name=\"description\">.",
  "- localStorage (guarded with try/catch) for scores/settings; safe if storage is unavailable.",
  "- No alert()/confirm()/prompt(); use inline UI. No external libraries.",
  "- Aim for a genuinely fun/usable, polished app: real game loop, real state, restart, score/progress, win/lose states where sensible. Roughly 150-600 lines.",
  "- The page runs inside a sandboxed iframe (srcdoc): never rely on window.top, never navigate away.",
  "",
  "If the request is unclear, pick a reasonable interpretation and build it — never answer with questions instead of the code block.",
].join("\n");

const CODE_SYSTEM_PROMPT = [
  "You are Veil AI in AI CODER mode — a senior engineer who writes COMPLETE, FULL-FEATURED code. The user describes anything and you deliver the whole thing — never a minimal stub, never a demo sketch.",
  "",
  "TWO kinds of requests — pick correctly:",
  "A) Anything that runs in a browser (page, tool, widget, dashboard, game, toy, demo...): build ONE complete, self-contained HTML page with all the HTML, CSS and JavaScript inline. Make it RICH and FULL-FEATURED:",
  "- Target 300-800 lines. 15-40KB of code is normal and good — do NOT artificially shrink the app. If a feature is implied by the request, build it.",
  "- Real depth: proper game loop (requestAnimationFrame + delta time), score, win/lose, restart, settings, stats, keyboard AND touch controls, animations, edge-case handling, polish.",
  "- Crisp on high-DPI (scale canvas by devicePixelRatio when drawing).",
  "B) Code in another language or a non-page form (a Python script, a Node CLI, a React component, SQL, bash, an algorithm, a regex, a config...): write THAT code — ONE fenced block with the correct language tag, complete and runnable, full length, NEVER truncated with '...' placeholders. One short explanation line before it. Do NOT wrap it as an HTML app.",
  "",
  "Style (both paths): dense professional code — no comment spam, no blank-line padding, no dead code; every line does work.",
  "",
  "Output format (follow EXACTLY):",
  "1. One short intro sentence (max 1 line).",
  "2. Then ONE fenced code block — tagged html for browser apps (path A), or the right language for code answers (path B) — nothing after the closing fence.",
  "3. HTML apps only: the first line inside the block, right after <!doctype html>, must be the metadata comment:",
  "   <!-- veil-ext {\"name\":\"Short Name\",\"desc\":\"One-line description\",\"icon\":\"icon\"} -->",
  "   icon must be ONE of: bot, joypad, image, globe, dices, search, spark, calc, trophy, zap, timer, brush, pen, filetext, monitor, key, palette, worm, bomb, music, heart, desktop, play, archive, package.",
  "",
  "Hard rules for HTML app pages:",
  "- Zero external requests: no CDN, no fetch, no import, no web fonts, no images from the web. Inline <style> and <script> only — everything lives in the one file.",
  "- Fully responsive (mobile-first), polished dark theme with ONE vibrant accent, cohesive typography and spacing.",
  "- <!doctype html> + <meta charset=\"utf-8\"> + <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> + <title>.",
  "- localStorage guarded with try/catch for scores/settings/state.",
  "- No alert()/confirm()/prompt(). No external libraries. No window.open, no target=_blank, never navigate away (runs in a sandboxed srcdoc iframe).",
  "",
  "If the request is unclear, pick a reasonable interpretation and build it — never answer with questions instead of code.",
].join("\n");

/** A reply that started writing an app page but never finished it —
 *  the model hit its output cap mid-code (finish_reason: length).
 *  Returns true when the doc/fence is still open, so the server can
 *  issue a continuation round instead of handing the client a broken
 *  build (the old failure mode: "stuck at N KB" or a raw code dump). */
function looksTruncated(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  if (/<\/html>/i.test(s)) return false;
  if (/<!doctype html/i.test(s)) return true;
  const first = s.indexOf("```");
  return first !== -1 && s.indexOf("```", first + 3) === -1;
}

/** Join an original reply with its continuation, dropping the overlap the
 *  model usually repeats (it re-sends the last line or two before going
 *  on). Char-by-char up to 400 chars — cheap and precise enough. */
function mergeContinuation(a: string, b: string): string {
  const bb = b.replace(/^\s+/, "");
  const max = Math.min(400, a.length, bb.length);
  for (let n = max; n >= 40; n--) {
    if (a.slice(-n) === bb.slice(0, n)) return a + bb.slice(n);
  }
  return a + bb;
}

/* Watchdogs. Without them a stalled upstream hangs the SSE pipe forever:
 * the heartbeat keeps the CLIENT connection "alive", so nobody ever
 * errors out and the UI shows "Building… N KB" until the user reloads.
 * Four independent bounds, each covering a distinct wedge mode:
 *   ① create() never resolves (model server wedged after a truncation —
 *      observed live) → CREATE_TIMEOUT_MS
 *   ② reads stop entirely (dead TCP) → UPSTREAM_STALL_MS
 *   ③ frames keep flowing but no content delta (keepalive spam while
 *      the model stopped writing) → UPSTREAM_SILENCE_MS
 *   ④ anything unforeseen → HARD_DEADLINE_MS force-sends a terminal
 *      frame, so the client ALWAYS settles, never spins at "N KB" */
const UPSTREAM_STALL_MS = 90_000;
const UPSTREAM_SILENCE_MS = 150_000;
const CREATE_TIMEOUT_MS = 75_000;
const TOTAL_CAP_MS = 6 * 60_000;
const HARD_DEADLINE_MS = TOTAL_CAP_MS + 60_000;
const CONTINUATION_ROUNDS = 2;

/* (The create() watchdog used to live here — it moved into
 * lib/veil/llm-client.ts so EVERY attempt of a retried call gets its
 * own timeout budget.) */

/** Consume one SDK chat stream: decode raw SSE byte chunks, extract
 *  content deltas, feed them to onDelta, return the assembled text.
 *  Every read races a watchdog whose budget is the stricter of raw
 *  connection silence and content silence (a stream of empty frames /
 *  keepalives must not reset the no-progress clock — that is the exact
 *  mode that left builds "stuck at N KB"). onFinish receives the final
 *  chunk's finish_reason ("length" = the output cap truncated the build). */
async function consumeStream(
  stream: AsyncIterable<unknown>,
  onDelta: (d: string) => void,
  onFinish?: (reason: string | null) => void
): Promise<string> {
  const it = stream[Symbol.asyncIterator]();
  let full = "";
  let carry = ""; // partial SSE line across chunk boundaries
  let lastDelta = Date.now();
  const push = (d: string) => {
    full += d;
    lastDelta = Date.now();
    onDelta(d);
  };
  for (;;) {
    const nextP = it.next();
    const budget = Math.max(
      1,
      Math.min(UPSTREAM_STALL_MS, UPSTREAM_SILENCE_MS - (Date.now() - lastDelta))
    );
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      stallTimer = setTimeout(
        () =>
          reject(
            new Error(
              Date.now() - lastDelta >= UPSTREAM_SILENCE_MS - 1
                ? "the model stopped writing mid-build"
                : "the model connection stalled mid-build"
            )
          ),
        budget
      );
    });
    let res: IteratorResult<unknown>;
    try {
      res = await Promise.race([nextP, stall]);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    if (res.done) break;
    carry += Buffer.from(res.value as Uint8Array).toString("utf8");
    let nl: number;
    while ((nl = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, nl);
      carry = carry.slice(nl + 1);
      emitDelta(line, push, onFinish);
    }
  }
  if (carry) emitDelta(carry, push, onFinish);
  return full;
}

/** Feed one SSE `data:` line from the SDK's raw byte stream to the client.
 * Payloads look like: {"choices":[{"delta":{"content":"…"}}]}. The final
 * chunk carries finish_reason — "length" means the output cap truncated
 * the build, which the caller treats as "must continue". */
function emitDelta(
  line: string,
  onDelta: (d: string) => void,
  onFinish?: (reason: string | null) => void
): void {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  try {
    const j = JSON.parse(payload) as {
      choices?: {
        delta?: { content?: unknown };
        message?: { content?: unknown };
        finish_reason?: unknown;
      }[];
    };
    const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
    if (typeof d === "string" && d) onDelta(d);
    const fin = j.choices?.[0]?.finish_reason;
    if (typeof fin === "string" && fin) onFinish?.(fin);
  } catch {
    /* partial or unexpected line — skip */
  }
}

/** The instruction that makes the model resume a truncated build without
 *  restarting the whole page (repetition is trimmed by mergeContinuation). */
const CONTINUE_PROMPT = [
  "Your previous message was cut off before the page was finished.",
  "Continue the HTML app from EXACTLY the point where you stopped.",
  "Output ONLY the continuation — never repeat the intro, never restart the page, no commentary.",
  "Finish the remaining markup/script and close the document with </html>.",
].join(" ");

/** The reply that answers a build request with prose only (a known model
 *  quirk: intro, no code). One nudge makes it actually build; without this
 *  the user had to notice and re-ask manually. */
const NUDGE_PROMPT = [
  "You answered without writing any code.",
  "Write the code now, following the output format exactly:",
  "if the request is a web page/app: one short intro sentence, then ONE fenced ```html code block containing the ENTIRE self-contained app page, nothing after the closing fence;",
  "if it is code in another language: the complete code in ONE fenced block with the right language tag.",
].join(" ");

/** Second-stage nudge — the model answered the FIRST nudge with yet
 *  another description (observed live: two intros merged, no code, no
 *  card). This one forbids everything that is not the code block. */
const NUDGE_HARD_PROMPT = [
  "That reply STILL contained no code block — you described it again.",
  "Reply now with EXACTLY two things and nothing else: one short intro line, then ONE fenced code block — ```html with the complete self-contained app page for web requests, or the right language tag for other code. No more description, no summary, no apologies. The code block or nothing.",
].join(" ");

/** A reply that already contains a complete fenced code block — a legit
 *  AI Coder answer (path B: python/js/sql/... or any tagged block). The
 *  prose-only nudge must never fire on these; it exists solely for replies
 *  that describe without writing a single line of code. */
function hasClosedFence(t: string): boolean {
  const first = t.indexOf("```");
  return first !== -1 && t.indexOf("```", first + 3) !== -1;
}

/** Pull the app out of an Extension Maker reply.
 * Handles the documented fenced-block shape AND the fence-less raw page
 * some model turns produce (anchored on the veil-ext comment or the
 * doctype) — a missing ``` must never cost the install card.
 * Returns { ext: {name, desc, icon, html} } or null. */
function parseExtReply(reply: string): { name: string; desc: string; icon: string; html: string } | null {
  const src = String(reply || "");
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/.exec(src);
  /* Only a block that actually looks like an HTML page counts as an app —
   * the AI Coder also answers plain code questions (```python, ```js, ...)
   * whose blocks must stay chat code, never become a broken "app" card. */
  const looksHtml = (s: string) =>
    /<!doctype html|<html[\s>]|<body[\s>]|<!--\s*veil-ext/i.test(s);
  let html = fence && looksHtml(fence[1]) ? fence[1].trim() : "";

  if (html.length < 400) {
    /* fence-less: anchor on the metadata comment, else the LAST doctype
       (an intro sentence may precede either) and cut to </html> */
    let start = -1;
    const metaAll = /<!--\s*veil-ext\s*\{[\s\S]*?\}\s*-->/.exec(src);
    if (metaAll) start = metaAll.index;
    if (start === -1) start = src.toLowerCase().lastIndexOf("<!doctype html");
    if (start !== -1) {
      const end = src.toLowerCase().lastIndexOf("</html>");
      if (end !== -1 && end > start) {
        let cut = src.slice(start, end + 7).trim();
        const docIn = cut.toLowerCase().indexOf("<!doctype html");
        if (docIn > 0) cut = cut.slice(docIn).trim();
        if (cut.length >= 400) html = cut;
      }
    }
  }
  if (html.length < 400) return null;

  let name = "";
  let desc = "";
  let icon = "spark";
  const meta = /<!--\s*veil-ext\s*(\{[\s\S]*?\})\s*-->/.exec(html) || /<!--\s*veil-ext\s*(\{[\s\S]*?\})\s*-->/.exec(src);
  if (meta) {
    try {
      const j = JSON.parse(meta[1]) as { name?: string; desc?: string; icon?: string };
      if (typeof j.name === "string") name = j.name.trim().slice(0, 40);
      if (typeof j.desc === "string") desc = j.desc.trim().slice(0, 140);
      if (typeof j.icon === "string" && /^[a-z0-9]+$/i.test(j.icon)) icon = j.icon.toLowerCase();
    } catch {
      /* fall through to <title> */
    }
  }
  const title = /<title>([^<]{1,80})<\/title>/i.exec(html);
  if (!name && title) name = title[1].trim().slice(0, 40);
  if (!name) name = "AI Extension";
  if (!desc) {
    const md = /<meta\s+name=["']description["']\s+content=["']([^"']{1,200})["']/i.exec(html);
    desc = md ? md[1].trim().slice(0, 140) : "Made by Veil AI";
  }

  // The metadata comment is packaging metadata, not page content — strip it
  // from the app HTML so it never shows up in the running app's DOM.
  html = html.replace(/<!--\s*veil-ext\s*\{[\s\S]*?\}\s*-->/, "").trim();

  return { name, desc, icon, html };
}


/* ── attachments ───────────────────────────────────────────────────────
 * Map the request history to LLM messages. The LAST user message may
 * carry inline images (multimodal content parts — the model actually
 * SEES them) and attached-file metadata (text-like content was already
 * inlined client-side; binary files ride as a [Attached …] note so the
 * model can acknowledge them). */
function toLlmMessages(
  history: {
    role: "user" | "assistant";
    content: string;
    images?: string[];
    files?: { name: string; size: number; type: string; url?: string }[];
  }[],
  systemPrompt: string
): { role: string; content: unknown }[] {
  // Index of the last user message (the only one allowed to carry images).
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  return [
    { role: "system", content: systemPrompt },
    ...history.map((m, i) => {
      if (
        m.role !== "user" ||
        i !== lastUser ||
        (!m.images?.length && !m.files?.length)
      ) {
        return { role: m.role, content: m.content };
      }
      const parts: { type: string; text?: string; image_url?: { url: string } }[] = [
        { type: "text", text: m.content },
      ];
      if (m.files?.length) {
        const kb = (n: number) =>
          n >= 1048576
            ? (n / 1048576).toFixed(1) + "MB"
            : Math.max(1, Math.round(n / 1024)) + "KB";
        parts[0].text += "\n\n" + m.files
            .map(
              (f) =>
                "[Attached file: " +
                f.name +
                " — " +
                (f.type || "file") +
                ", " +
                kb(f.size) +
                "]"
            )
            .join("\n");
      }
      for (const url of m.images || []) {
        parts.push({ type: "image_url", image_url: { url } });
      }
      return { role: "user", content: parts };
    }),
  ];
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return cors(NextResponse.json({ error: "invalid JSON body" }, { status: 400 }));
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return cors(
      NextResponse.json(
        { error: "expected { messages: [{ role, content }] }" },
        { status: 400 }
      )
    );
  }

  // Keep the tail of the conversation for context.
  const history = parsed.data.messages.slice(-20);
  const maker = parsed.data.make === "ext" || parsed.data.make === "code" || parsed.data.make === "game";
  /* AI Coder's prompt builds any self-contained web app; the legacy ext
   * flow keeps its own. "game" (retired spelling) maps to AI Coder. */
  const makerPrompt = parsed.data.make === "ext" ? EXT_SYSTEM_PROMPT : CODE_SYSTEM_PROMPT;
  const wantStream = parsed.data.stream === true;
  // Images on the last user message → the multimodal (vision) endpoint.
  const hasImages = (() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === "assistant") continue;
      return (history[i].images?.length ?? 0) > 0;
    }
    return false;
  })();
  const create = hasImages ? llmCreateVision : llmCreate;

  const { default: ZAI } = await import("z-ai-web-dev-sdk").catch(() => ({ default: null as null | typeof import("z-ai-web-dev-sdk") }));
  if (!ZAI) {
    return cors(NextResponse.json({ error: "assistant unavailable: the SDK failed to load" }, { status: 502 }));
  }

  try {
    /* ── streaming path (SSE): deltas + heartbeat, JSON at the end ──
     * llmCreate retries transient upstream failures (401 token glitch,
     * 429 bursts, wedged creates) with a fresh SDK instance per attempt —
     * the old code surfaced those as instant 502s. */
    if (wantStream) {
      const enc = new TextEncoder();
      /* thinking disabled — the maker must START WRITING CODE immediately
       * (a thinking model burns 20-60s reasoning before the first line,
       * which is exactly the "coder takes too long" complaint). Same for
       * plain chat: short answers never need chain-of-thought. */
      const stream = await create<AsyncIterable<unknown>>(
        {
          messages: toLlmMessages(history, maker ? makerPrompt : SYSTEM_PROMPT),
          stream: true,
          thinking: { type: "disabled" },
          ...(maker ? { max_tokens: 16384 } : {}),
        },
        { createTimeoutMs: CREATE_TIMEOUT_MS }
      );

      const sse = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false;
          const send = (obj: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
            } catch {
              closed = true;
            }
          };
          // Heartbeat — keeps outer proxies from declaring the pipe dead
          // while the model thinks. Comments are legal SSE and ignored.
          const heart = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(": ping\n\n"));
            } catch {
              closed = true;
            }
          }, 4000);

          /* HARD DEADLINE — the guarantee the client can rely on: whatever
           * hangs (create, a stream that neither yields nor errors, the
           * repair rounds), a terminal frame goes out and the pipe closes.
           * Before this, a wedged model server left builds "stuck at N KB"
           * forever: heartbeats kept the client transport alive while no
           * code path was left to send an error. */
          const hardTimer = setTimeout(() => {
            if (closed) return;
            send({ error: "the build ran past the total time limit — ask again to rebuild it" });
            closed = true;
            clearInterval(heart);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }, HARD_DEADLINE_MS);

          const started = Date.now();
          let full = "";
          /* finish_reason from the stream's final chunk — "length" means
           * the output cap truncated the build even if the text otherwise
           * looks complete enough to fool the heuristics. */
          let finishReason: string | null = null;
          try {
            full = await consumeStream(
              stream,
              (d) => send({ delta: d }),
              (r) => {
                finishReason = r;
              }
            );

            /* Auto-repair a maker reply, server-side and transparent:
             *   ① nudge — the model answered with prose only (no code at all)
             *   ② continue — the code started but was cut off mid-page
             * Both reuse the client's live streaming bubble; the {done}
             * frame carries whichever full text ends up holding the app. */
            if (maker) {
              if (
                !looksTruncated(full) &&
                !parseExtReply(full) &&
                !hasClosedFence(full) &&
                Date.now() - started < TOTAL_CAP_MS
              ) {
                /* Intro-only reply: up to two nudges, the second much
                 * blunter — the model sometimes answers the first nudge
                 * with ANOTHER description instead of the code. */
                for (
                  let round = 0;
                  round < 2 && Date.now() - started < TOTAL_CAP_MS;
                  round++
                ) {
                  send({ continuing: 1 });
                  const nudge = await llmCreate<AsyncIterable<unknown>>(
                    {
                      messages: [
                        { role: "system", content: makerPrompt },
                        ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
                        { role: "assistant", content: full.slice(0, 4000) },
                        { role: "user", content: round === 0 ? NUDGE_PROMPT : NUDGE_HARD_PROMPT },
                      ],
                      stream: true,
                      thinking: { type: "disabled" },
                      max_tokens: 16384,
                    },
                    { attempts: 2, createTimeoutMs: CREATE_TIMEOUT_MS }
                  );
                  const more = await consumeStream(
                    nudge,
                    (d) => send({ delta: d }),
                    (r) => {
                      finishReason = r;
                    }
                  );
                  if (more.trim()) {
                    /* If the nudged reply contains the app, it IS the reply
                     * (a merge would show two intros); else keep whatever
                     * came. */
                    if (parseExtReply(more)) {
                      full = more;
                      break;
                    }
                    full = mergeContinuation(full, more);
                  }
                  /* Success = an app OR any complete code answer (python/
                   * js/sql…): both satisfy the request, so stop nudging. */
                  if (parseExtReply(full) || hasClosedFence(full)) break;
                }
              }

              for (
                let round = 0;
                round < CONTINUATION_ROUNDS &&
                (looksTruncated(full) || (finishReason === "length" && !parseExtReply(full))) &&
                Date.now() - started < TOTAL_CAP_MS;
                round++
              ) {
                send({ continuing: 1 });
                const cont = await llmCreate<AsyncIterable<unknown>>(
                  {
                    messages: [
                      { role: "system", content: makerPrompt },
                      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
                      { role: "assistant", content: full.slice(-16000) },
                      { role: "user", content: CONTINUE_PROMPT },
                    ],
                    stream: true,
                    thinking: { type: "disabled" },
                    max_tokens: 16384,
                  },
                  { attempts: 2, createTimeoutMs: CREATE_TIMEOUT_MS }
                );
                const more = await consumeStream(
                  cont,
                  (d) => send({ delta: d }),
                  (r) => {
                    finishReason = r;
                  }
                );
                if (!more.trim()) break;
                full = mergeContinuation(full, more);
              }
            }

            if (!full.trim()) {
              send({ error: "the assistant returned nothing" });
            } else {
              send({
                done: 1,
                reply: full,
                ...(maker ? { ext: parseExtReply(full) } : {}),
              });
            }
          } catch (e) {
            const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
            send({ error: `assistant unavailable: ${message}` });
          } finally {
            clearTimeout(hardTimer);
            clearInterval(heart);
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
      });

      return cors(
        new Response(sse, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            // Tell any buffering layer (nginx-style) to pass straight through.
            "x-accel-buffering": "no",
          },
        })
      );
    }

    /* ── classic JSON path (compat) ── */
    const completion = (await create<{
      choices?: { message?: { content?: string }; delta?: { content?: string } }[];
      usage?: unknown;
    }>({
      messages: toLlmMessages(history, maker ? makerPrompt : SYSTEM_PROMPT),
      thinking: { type: "disabled" },
      ...(maker ? { max_tokens: 16384 } : {}),
    })) as { choices?: { message?: { content?: string }; delta?: { content?: string } }[]; usage?: unknown };

    let content =
      completion.choices?.[0]?.message?.content ??
      completion.choices?.[0]?.delta?.content ??
      null;

    if (!content) {
      return cors(NextResponse.json({ error: "the assistant returned nothing" }, { status: 502 }));
    }

    // Truncated builds get the same auto-repair treatment as streaming.
    if (maker) {
      // ① intro-only nudge (a closed code fence = a legit code answer — never nudged)
      if (!looksTruncated(content) && !parseExtReply(content) && !hasClosedFence(content)) {
        const nudge = (await llmCreate<{
          choices?: { message?: { content?: string } }[];
        }>({
          messages: [
            { role: "system", content: makerPrompt },
            ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            { role: "assistant", content: content.slice(0, 4000) },
            { role: "user", content: NUDGE_PROMPT },
          ],
          thinking: { type: "disabled" },
          max_tokens: 16384,
        }, { attempts: 2 })) as { choices?: { message?: { content?: string } }[] };
        const more = nudge.choices?.[0]?.message?.content ?? "";
        if (more.trim()) content = parseExtReply(more) ? more : mergeContinuation(content, more);
      }
      // ② truncated-code continuation
      for (let round = 0; round < CONTINUATION_ROUNDS && looksTruncated(content); round++) {
        const cont = (await llmCreate<{
          choices?: { message?: { content?: string } }[];
        }>({
          messages: [
            { role: "system", content: makerPrompt },
            ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
            { role: "assistant", content: content.slice(-16000) },
            { role: "user", content: CONTINUE_PROMPT },
          ],
          thinking: { type: "disabled" },
          max_tokens: 16384,
        }, { attempts: 2 })) as { choices?: { message?: { content?: string } }[] };
        const more = cont.choices?.[0]?.message?.content ?? "";
        if (!more.trim()) break;
        content = mergeContinuation(content, more);
      }
    }

    return cors(
      NextResponse.json({
        reply: content,
        ...(maker ? { ext: parseExtReply(content) } : {}),
        usage: completion.usage ?? null,
      })
    );
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
    return cors(NextResponse.json({ error: `assistant unavailable: ${message}` }, { status: 502 }));
  }
}

/* CORS — the single-file Veil build (downloaded to disk, opened from
 * file://) calls back to its birth origin for Veil AI. file:// pages
 * send Origin: null, so echo * and answer the preflight. */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function cors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS(): Promise<Response> {
  return cors(new Response(null, { status: 204 }));
}
