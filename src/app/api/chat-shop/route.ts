import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"
import {
  SHOP_CATALOG,
  REFUND_RATE,
  refundFor,
  netOwnedIds,
  type ShopItem,
} from "@/lib/veil/shop"
import { readJsonBody, badBody } from "@/lib/veil/body"

export const runtime = "nodejs"

export { REFUND_RATE, refundFor }

// The catalog lives in src/lib/veil/shop.ts (shared with the backup /
// repair pipeline so ownership rules never fork).

/* Net ownership: an item is owned while purchases − refunds > 0. The
 * ledger is append-only (a refund writes a `shop_refund:<id>` row), so
 * refunded items correctly disappear from the locker and re-buying
 * charges full price again. Works with the root client or a tx client.
 * The implementation (with the equipped⇒owned rollback guard) lives in
 * src/lib/veil/shop.ts. */

export async function GET(req: NextRequest) {
  /* Catalog is public. With a ?token= the response additionally carries
   * the buyer's OWNED item ids (every shop_purchase:<id> transaction) so
   * the UI can render a "My Items" section with free equip/unequip —
   * the fix for the "I bought it, equipped something else, and my
   * purchase vanished" confusion (owner report 2026-10-17). */
  const token = req.nextUrl.searchParams.get("token")
  if (!token) return NextResponse.json({ ok: true, items: SHOP_CATALOG })

  const account = await getAccountFromToken(token)
  if (!account) {
    return NextResponse.json(
      { ok: false, error: "Invalid or expired token." },
      { status: 401 },
    )
  }
  /* Net ownership (post-refund): a refunded item leaves the locker.
   * Equipped items are unioned in — the rollback guard (see
   * src/lib/veil/shop.ts). */
  const netOwned = await netOwnedIds(db, account.id, {
    tag: account.tag,
    pfpAccessory: account.pfpAccessory,
  })
  const ownedVisible = [...netOwned].filter((id) =>
    SHOP_CATALOG.some((i) => i.id === id),
  )
  return NextResponse.json({
    ok: true,
    items: SHOP_CATALOG,
    owned: ownedVisible,
    refundRate: REFUND_RATE,
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody<{
      token?: string
      itemId?: string
      action?: string
    }>(req)
    if (!body) return badBody()
    const token = body.token
    const account = await getAccountFromToken(token)
    if (!account) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 401 },
      )
    }

    /* Unequip — takes off a worn decoration without a refund. Purchases
     * are permanent: once owned, re-equipping is always free (buying an
     * already-owned item just re-wears it). */
    if (body.action === "unequip") {
      const slot = body.itemId
      const data: { tag?: string | null; tagColor?: string | null; pfpAccessory?: string | null; pfpOverlay?: string | null } =
        {}
      if (slot === "tag") {
        data.tag = null
        data.tagColor = null
      } else if (slot === "accessory") {
        data.pfpAccessory = null
      } else if (slot === "overlay") {
        // Overlays are retired — this only clears any straggler value
        // left on an account from before the refresh.
        data.pfpOverlay = null
      } else {
        return NextResponse.json(
          { ok: false, error: "Unknown slot — expected tag or accessory." },
          { status: 400 },
        )
      }
      const updated = await db.chatAccount.update({
        where: { id: account.id },
        data,
      })
      return NextResponse.json({ ok: true, account: toPublicAccount(updated) })
    }

    /* Equip — free re-wear of an item the buyer already owns. This is the
     * explicit counterpart to "unequip": the My Items section uses it so
     * switching between owned decorations never charges (and never needs
     * the re-buy dance). Ownership is validated server-side against the
     * purchase ledger — an unowned id is a 400, not a free equip. */
    if (body.action === "equip") {
      const itemId = (body.itemId || "").trim()
      const item = SHOP_CATALOG.find((i) => i.id === itemId)
      if (!item) {
        return NextResponse.json(
          { ok: false, error: "That item does not exist in the shop." },
          { status: 404 },
        )
      }
      const ownedNow = await netOwnedIds(db, account.id, {
        tag: account.tag,
        pfpAccessory: account.pfpAccessory,
      })
      if (!ownedNow.has(item.id)) {
        return NextResponse.json(
          { ok: false, error: "You don't own that item yet — buy it first." },
          { status: 400 },
        )
      }
      const updateData: { tag?: string; tagColor?: string; pfpAccessory?: string } =
        item.type === "tag"
          ? { tag: item.tagText, tagColor: item.tagColor }
          : { pfpAccessory: item.accessory }
      const updated = await db.chatAccount.update({
        where: { id: account.id },
        data: updateData,
      })
      return NextResponse.json({ ok: true, account: toPublicAccount(updated), item })
    }

    /* Refund — sell an owned item back to the shop for 70% of its price
     * (owner directive 2026-10-20). The item leaves the locker (net
     * ownership), anything it was wearing comes off, and the payout is
     * atomic with the ledger write. */
    if (body.action === "refund") {
      const refundItemId = (body.itemId || "").trim()
      const refundItem = SHOP_CATALOG.find((i) => i.id === refundItemId)
      if (!refundItem) {
        return NextResponse.json(
          { ok: false, error: "That item does not exist in the shop." },
          { status: 404 },
        )
      }
      const refundAmount = refundFor(refundItem.price)

      const refundResult = await db
        .$transaction(async (tx) => {
          const fresh = await tx.chatAccount.findUnique({
            where: { id: account.id },
          })
          if (!fresh) throw new Error("Account not found.")
          const ownedNow = await netOwnedIds(tx, account.id, {
            tag: fresh.tag,
            pfpAccessory: fresh.pfpAccessory,
          })
          if (!ownedNow.has(refundItem.id)) {
            throw new Error("You don't own that item — nothing to refund.")
          }

          /* If the item is currently worn, take it off as part of the
           * same atomic refund. */
          const unequip: {
            tag?: string | null
            tagColor?: string | null
            pfpAccessory?: string | null
          } = {}
          if (refundItem.type === "tag" && fresh.tag === refundItem.tagText) {
            unequip.tag = null
            unequip.tagColor = null
          }
          if (
            refundItem.type === "accessory" &&
            fresh.pfpAccessory === refundItem.accessory
          ) {
            unequip.pfpAccessory = null
          }

          const updated = await tx.chatAccount.update({
            where: { id: account.id },
            data: {
              ...unequip,
              coins: { increment: refundAmount },
            },
          })
          await tx.coinTransaction.create({
            data: {
              fromId: account.id,
              toId: account.id,
              amount: refundAmount,
              reason: `shop_refund:${refundItem.id}`,
            },
          })
          return updated
        })
        .catch((e: Error) => e)

      if (refundResult instanceof Error) {
        return NextResponse.json(
          { ok: false, error: refundResult.message },
          { status: 400 },
        )
      }
      return NextResponse.json({
        ok: true,
        account: toPublicAccount(refundResult),
        refunded: refundAmount,
        item: refundItem,
      })
    }

    const itemId = (body.itemId || "").trim()

    const item = SHOP_CATALOG.find((i) => i.id === itemId)
    if (!item) {
      return NextResponse.json(
        { ok: false, error: "That item does not exist in the shop." },
        { status: 404 },
      )
    }

    // Atomic purchase: re-check balance inside the transaction. Buying an
    // item you ALREADY own (net of refunds) just re-equips it for free.
    const result = await db.$transaction(async (tx) => {
      const fresh = await tx.chatAccount.findUnique({
        where: { id: account.id },
      })
      if (!fresh) throw new Error("Account not found.")

      const owned = await netOwnedIds(tx, account.id, {
        tag: fresh.tag,
        pfpAccessory: fresh.pfpAccessory,
      })
      if (!owned.has(item.id) && fresh.coins < item.price) {
        throw new Error(
          `Insufficient balance. This item costs ${item.price} coins.`,
        )
      }

      const updateData: {
        tag?: string
        tagColor?: string
        pfpAccessory?: string
      } = {}
      if (item.type === "tag") {
        updateData.tag = item.tagText
        updateData.tagColor = item.tagColor
      } else {
        updateData.pfpAccessory = item.accessory
      }

      const updated = await tx.chatAccount.update({
        where: { id: account.id },
        data: {
          ...(owned.has(item.id) ? {} : { coins: { decrement: item.price } }),
          ...updateData,
        },
      })

      if (!owned.has(item.id)) {
        await tx.coinTransaction.create({
          data: {
            fromId: account.id,
            toId: account.id,
            amount: item.price,
            reason: `shop_purchase:${item.id}`,
          },
        })
      }

      return updated
    }).catch((e: Error) => e)

    if (result instanceof Error) {
      return NextResponse.json(
        { ok: false, error: result.message },
        { status: 400 },
      )
    }

    return NextResponse.json({
      ok: true,
      account: toPublicAccount(result),
      item,
    })
  } catch (err) {
    console.error("[chat-shop POST] error", err)
    return NextResponse.json(
      { ok: false, error: "Server error processing shop purchase." },
      { status: 500 },
    )
  }
}
