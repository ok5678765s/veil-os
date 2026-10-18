#!/usr/bin/env node
/**
 * Veil — dev-request pickup helper (for the recurring dev agent).
 *
 * The owner's site-change asks are filed by Veil AI into the DevRequest
 * table. This script is how the dev agent (you) reads and completes them
 * without needing the owner password on the command line:
 *
 *   node scripts/devreq.mjs list                 → pending (+ recently done) rows
 *   node scripts/devreq.mjs start <id>           → flip to in_progress
 *   node scripts/devreq.mjs done <id> "note"     → flip to done (auto-announces
 *                                                   in the Updates feed via the
 *                                                   PATCH /api/dev-requests path)
 *   node scripts/devreq.mjs decline <id> "note"  → flip to declined
 *
 * Status flips go through the real API (http://localhost:3000/api/dev-requests)
 * so the "Shipped: …" feed post fires exactly like the owner expects.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const API = "http://localhost:3000/api/dev-requests";
const PASSWORD = "T@@OTgs45+HAPP"; // built-in default (OwnerSecret row may override)

async function flip(id, status, note) {
  const res = await fetch(API, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, id, status, note }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    console.error(`flip failed (${res.status}):`, json.error || json);
    process.exitCode = 1;
  } else {
    console.log(`✔ ${id} → ${status}${note ? ` — ${note}` : ""}`);
    if (status === "done") console.log("  (a 'Shipped: …' post was added to the Updates feed)");
  }
}

const [cmd, id, ...rest] = process.argv.slice(2);
const note = rest.join(" ").trim();

try {
  if (cmd === "list" || !cmd) {
    const pending = await db.devRequest.findMany({
      where: { status: { in: ["pending", "in_progress"] } },
      orderBy: { createdAt: "asc" },
    });
    const recent = await db.devRequest.findMany({
      where: { status: { in: ["done", "declined"] } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    });
    console.log(`── PENDING (${pending.length}) ──`);
    for (const r of pending)
      console.log(`\n[${r.status}] ${r.title}\n  id:   ${r.id}\n  body: ${r.body.replace(/\n/g, "\n        ")}`);
    console.log(`\n── RECENTLY CLOSED (last 5) ──`);
    for (const r of recent) console.log(`[${r.status}] ${r.title} — ${(r.note || "").slice(0, 100)}`);
    if (pending.length === 0) console.log("\n(no pending dev requests — nothing to pick up)");
  } else if (cmd === "start") {
    if (!id) throw new Error("usage: devreq.mjs start <id>");
    await flip(id, "in_progress");
  } else if (cmd === "done" || cmd === "decline") {
    if (!id) throw new Error(`usage: devreq.mjs ${cmd} <id> "note"`);
    await flip(id, cmd, note || undefined);
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
