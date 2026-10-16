/**
 * Veil — AI Image task status poll (companion to POST /api/ai/image).
 *
 * GET /api/ai/image/status?taskId=…
 *   → { ok: true, status: "processing" | "done" | "fail", image?, error? }
 *
 * One query per call — the client paces itself (2.5s interval). Cheap by
 * design: the answer is a lookup in the in-process task table.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const taskId = req.nextUrl.searchParams.get("taskId") ?? "";
  if (!/^[a-f0-9]{8,64}$/.test(taskId)) {
    return NextResponse.json({ ok: false, error: "bad task id" }, { status: 400 });
  }
  const tasks = (globalThis as unknown as {
    __veilImgTasks?: Map<string, { status: string; image?: string; error?: string }>;
  }).__veilImgTasks;
  const t = tasks?.get(taskId);
  if (!t) {
    return NextResponse.json(
      { ok: false, error: "task expired — generate again" },
      { status: 404 }
    );
  }
  return NextResponse.json({
    ok: true,
    status: t.status,
    ...(t.status === "done" && t.image ? { image: t.image } : {}),
    ...(t.status === "fail" && t.error ? { error: t.error } : {}),
  });
}
