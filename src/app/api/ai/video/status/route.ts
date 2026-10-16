/**
 * Veil — AI Video task status poll (companion to POST /api/ai/video).
 *
 * GET /api/ai/video/status?taskId=…
 *   → { ok: true, status: "PROCESSING" | "SUCCESS" | "FAIL", url? }
 *
 * One query per call — the client paces itself (3s interval). Backend
 * only (z-ai-web-dev-sdk).
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const taskId = req.nextUrl.searchParams.get("taskId") ?? "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    return NextResponse.json({ ok: false, error: "bad task id" }, { status: 400 });
  }
  const { default: ZAI } = await import("z-ai-web-dev-sdk").catch(() => ({
    default: null as null | typeof import("z-ai-web-dev-sdk"),
  }));
  if (!ZAI) {
    return NextResponse.json({ ok: false, error: "status check unavailable" }, { status: 502 });
  }
  try {
    const zai = await ZAI.create();
    const r = (await zai.async.result.query(taskId)) as {
      task_status?: unknown;
      video_result?: { url?: unknown }[];
      video_url?: unknown;
      url?: unknown;
      video?: unknown;
    };
    const status =
      r?.task_status === "SUCCESS" || r?.task_status === "FAIL" ? r.task_status : "PROCESSING";
    const url =
      (typeof r?.video_result?.[0]?.url === "string" && r.video_result[0].url) ||
      (typeof r?.video_url === "string" && r.video_url) ||
      (typeof r?.url === "string" && r.url) ||
      (typeof r?.video === "string" && r.video) ||
      undefined;
    return NextResponse.json({
      ok: true,
      status,
      ...(status === "SUCCESS" && url ? { url } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
    return NextResponse.json({ ok: false, error: `status check failed: ${message}` }, { status: 502 });
  }
}
