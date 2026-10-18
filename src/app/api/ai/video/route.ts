/**
 * Veil — AI Video generation endpoint (Veil AI › Video mode).
 *
 * POST /api/ai/video { prompt, duration, quality, fps, size, withAudio }
 *   → { ok: true, taskId }        (async task — poll /api/ai/video/status)
 *
 * The video model is task-based: create returns a task id, the client
 * polls /api/ai/video/status?taskId=… every few seconds until it holds
 * SUCCESS (with a playable URL) or FAIL. Backend only (z-ai-web-dev-sdk).
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
  "1920x1080",
]);

const MAX_PROMPT = 2000;

/* Small per-process gate — video tasks are heavy; keep a lid on parallel
 * submissions (polling old tasks stays free). */
const busy = (globalThis as Record<string, unknown>).__veilVidBusy ??= {
  count: 0,
} as { count: number };

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const b = body as {
    prompt?: unknown;
    duration?: unknown;
    quality?: unknown;
    fps?: unknown;
    size?: unknown;
    withAudio?: unknown;
  };
  const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) {
    return NextResponse.json({ ok: false, error: "describe the video first" }, { status: 400 });
  }
  const duration = b.duration === 10 ? 10 : 5;
  const quality = b.quality === "quality" ? "quality" : "speed";
  const fps = b.fps === 60 ? 60 : 30;
  const size = typeof b.size === "string" && SUPPORTED_SIZES.has(b.size) ? b.size : undefined;
  const withAudio = b.withAudio === true;

  if (busy.count >= 2) {
    return NextResponse.json(
      { ok: false, error: "a video is already generating — let it finish first" },
      { status: 429 }
    );
  }

  const { default: ZAI } = await import("z-ai-web-dev-sdk").catch(() => ({
    default: null as null | typeof import("z-ai-web-dev-sdk"),
  }));
  if (!ZAI) {
    return NextResponse.json({ ok: false, error: "video generation unavailable" }, { status: 502 });
  }

  busy.count++;
  try {
    const zai = await ZAI.create();
    const task = await zai.video.generations.create({
      prompt,
      quality,
      with_audio: withAudio,
      ...(size ? { size } : {}),
      fps,
      duration,
    });
    const taskId = (task as { id?: unknown })?.id;
    if (typeof taskId !== "string" || !taskId) {
      return NextResponse.json(
        { ok: false, error: "the video service did not accept the task — try again" },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, taskId });
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
    console.error("[ai-video] create failed:", message);
    return NextResponse.json({ ok: false, error: `video generation failed: ${message}` }, { status: 502 });
  } finally {
    busy.count--;
  }
}
