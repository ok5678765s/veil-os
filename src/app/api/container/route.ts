/**
 * Quasar Container API (v2.1.0)
 * -----------------------------
 * POST /api/container { op: "drop", container } — wipe every cookie jar of a
 * container. The UI fires this when the last incognito tab closes so
 * ephemeral sessions leave no residue. The default container is refuse-listed
 * (dropping it would log everyone out of every site for no good reason).
 * GET returns the active containers (debug panel aid).
 */

import { NextRequest } from "next/server";
import { clearContainer, jarStats, normContainer, DEFAULT_CONTAINER } from "@/lib/veil/quasar/cookies";
import { gate } from "@/lib/veil/quasar/security";
import { readJsonBody, badBody } from "@/lib/veil/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const denied = gate(req, false);
  if (denied) return denied;
  const byContainer = new Map<string, number>();
  for (const j of jarStats()) {
    byContainer.set(j.container, (byContainer.get(j.container) ?? 0) + j.cookies);
  }
  return Response.json({
    containers: Array.from(byContainer.entries()).map(([container, cookies]) => ({
      container,
      cookies,
    })),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = gate(req, false);
  if (denied) return denied;
  try {
    const body = await readJsonBody<{ op?: string; container?: string }>(req);
    if (!body) return badBody();
    if (body.op !== "drop") return Response.json({ error: "bad-op" }, { status: 400 });
    const container = normContainer(body.container);
    if (container === DEFAULT_CONTAINER) {
      return Response.json({ error: "default-container-protected" }, { status: 403 });
    }
    const removed = clearContainer(container);
    return Response.json({ ok: true, removed });
  } catch {
    return Response.json({ error: "bad-json" }, { status: 400 });
  }
}
