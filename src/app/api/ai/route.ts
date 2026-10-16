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
  /** stream: true → Server-Sent Events instead of one JSON blob. Long
   *  replies can take a while; a silent connection gets cut by outer
   *  proxies which answer with an HTML error page the client then fails
   *  to parse ("Unexpected token '<'"). The stream sends deltas as they
   *  arrive plus a 4s heartbeat so the pipe never idles. */
  stream: z.boolean().optional(),
});

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
      const stream = await create<AsyncIterable<unknown>>(
        {
          messages: toLlmMessages(history, SYSTEM_PROMPT),
          stream: true,
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
            send({ error: "the reply ran past the total time limit — ask again" });
            closed = true;
            clearInterval(heart);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }, HARD_DEADLINE_MS);

          let full = "";
          try {
            full = await consumeStream(stream, (d) => send({ delta: d }));

            if (!full.trim()) {
              send({ error: "the assistant returned nothing" });
            } else {
              send({ done: 1, reply: full });
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
      messages: toLlmMessages(history, SYSTEM_PROMPT),
    })) as { choices?: { message?: { content?: string }; delta?: { content?: string } }[]; usage?: unknown };

    let content =
      completion.choices?.[0]?.message?.content ??
      completion.choices?.[0]?.delta?.content ??
      null;

    if (!content) {
      return cors(NextResponse.json({ error: "the assistant returned nothing" }, { status: 502 }));
    }

    return cors(
      NextResponse.json({
        reply: content,
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
