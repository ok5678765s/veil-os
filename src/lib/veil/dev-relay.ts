/**
 * Veil — dev-request relay (Veil AI → the real developer's worklog).
 *
 * When Veil AI files a NEW dev request (the owner asked for a site
 * change), it lands in the DevRequest table — but a row in a database
 * nobody watches isn't "sent to the developer". This helper appends a
 * clearly-marked block to /home/z/my-project/worklog.md, the handover
 * document the 15-minute review agent reads FIRST every round — so the
 * owner's ask reaches the developer directly, automatically.
 *
 * Fire-and-forget by design: a relay failure must NEVER break the
 * API route that filed the request (the DB row is still the source
 * of truth; the worklog is the delivery channel).
 */
import { appendFile } from "node:fs/promises";

/** The developer agent's handover file — the one document every review
 * round is required to read before doing anything. */
const WORKLOG_PATH = "/home/z/my-project/worklog.md";

export interface DevRelayRow {
  id: string;
  title: string;
  body: string;
}

/** Append one dev-request block to the worklog. `fresh` distinguishes a
 * brand-new ask from a re-ask that updated an existing row (the agent
 * shouldn't re-do work, just notice the update). */
export async function relayDevRequestToWorklog(
  row: DevRelayRow,
  fresh: boolean,
): Promise<boolean> {
  try {
    const title = String(row.title || "").replace(/\s+/g, " ").trim().slice(0, 140);
    const body = String(row.body || "").trim().slice(0, 6000);
    if (!title) return false;
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
    const block = [
      "",
      "---",
      `DEV REQUEST INBOX — auto-relayed from Veil AI · db id ${row.id} · ${fresh ? "NEW" : "UPDATED ASK"}`,
      `Filed: ${stamp}`,
      `Title: ${title}`,
      "",
      "Body:",
      body,
      "",
      "→ Review agent: this block is the OWNER'S DIRECT ASK, relayed the moment it was filed —",
      "  treat it as this round's top work item (assess, then fix/build if feasible).",
      "  NEVER re-file it as a new dev_request; it is already in the ledger.",
      `  When you start: mark it in_progress. When done (or declined, with reason): update the row —`,
      `    cd /home/z/my-project && bun -e 'import{PrismaClient}from"@prisma/client";const p=new PrismaClient();await p.devRequest.update({where:{id:"${row.id}"},data:{status:"done",note:"what you did"}});await p.$disconnect();'`,
      "  (status: pending | in_progress | done | declined — the owner sees this in the Updates feed.)",
      "END DEV REQUEST",
      "",
    ].join("\n");
    await appendFile(WORKLOG_PATH, block, "utf8");
    return true;
  } catch {
    /* the DB row stands on its own — the relay is best-effort */
    return false;
  }
}
