/**
 * Veil — AI Image generation endpoint (Veil AI › Image mode).
 *
 * POST /api/ai/image { prompt, size }
 *   → { ok: true, taskId }   (IMMEDIATELY — generation runs server-side)
 *
 * The generation itself takes 5-60s, and the outer gateway cuts silent
 * long-running requests with a 502 (the exact reason /api/ai streams with
 * heartbeats). So this route only REGISTERS a task and answers in
 * milliseconds; the client polls GET /api/ai/image/status?taskId=… until
 * it holds the finished data URL (or the failure). Uses
 * z-ai-web-dev-sdk's images.generations.create — backend only.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_SIZES = new Set([
  "1024x1024",
  "768x1344",
  "864x1152",
  "1344x768",
  "1152x864",
  "1440x720",
  "720x1440",
]);

const MAX_PROMPT = 2000;
const MAX_TASKS = 24; // ring of recent tasks (server restart drops them all)
const TASK_TTL_MS = 12 * 60_000;

type ImgTask = {
  id: string;
  status: "processing" | "done" | "fail";
  image?: string;
  error?: string;
  createdAt: number;
};

/* Task table on globalThis — survives route module reloads in dev. */
const G = globalThis as unknown as {
  __veilImgTasks?: Map<string, ImgTask>;
  __veilImgBusy?: { n: number };
};
const tasks = (G.__veilImgTasks ??= new Map<string, ImgTask>());
const busy = (G.__veilImgBusy ??= { n: 0 });

function sweep(): void {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - t.createdAt > TASK_TTL_MS) tasks.delete(id);
  }
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    tasks.delete(oldest);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const b = body as { prompt?: unknown; size?: unknown };
  const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, MAX_PROMPT) : "";
  const size = typeof b.size === "string" && SUPPORTED_SIZES.has(b.size) ? b.size : "1024x1024";
  if (!prompt) {
    return NextResponse.json({ ok: false, error: "describe the image first" }, { status: 400 });
  }
  if (busy.n >= 2) {
    return NextResponse.json(
      { ok: false, error: "an image is already generating — let it finish first" },
      { status: 429 }
    );
  }

  const { default: ZAI } = await import("z-ai-web-dev-sdk").catch(() => ({
    default: null as null | typeof import("z-ai-web-dev-sdk"),
  }));
  if (!ZAI) {
    return NextResponse.json({ ok: false, error: "image generation unavailable" }, { status: 502 });
  }

  sweep();
  const id = crypto.randomUUID().replace(/-/g, "");
  tasks.set(id, { id, status: "processing", createdAt: Date.now() });

  /* Fire-and-forget: the generation runs while the client polls. A task
   * slot is held for its whole life so the busy gate stays honest. */
  busy.n++;
  void (async () => {
    try {
      const zai = await ZAI.create();
      const res = await zai.images.generations.create({ prompt, size });
      const b64 = res?.data?.[0]?.base64;
      if (typeof b64 !== "string" || !b64) {
        tasks.set(id, { id, status: "fail", error: "the model returned no image — try again", createdAt: Date.now() });
      } else {
        tasks.set(id, {
          id,
          status: "done",
          image: `data:image/png;base64,${b64}`,
          createdAt: Date.now(),
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
      console.error("[ai-image] failed:", message);
      tasks.set(id, { id, status: "fail", error: message, createdAt: Date.now() });
    } finally {
      busy.n--;
    }
  })();

  return NextResponse.json({ ok: true, taskId: id });
}
