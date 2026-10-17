import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getAccountFromToken, toPublicAccount } from "@/lib/chat-auth"

export const runtime = "nodejs"

type ShopItem =
  | {
      id: string
      type: "tag"
      label: string
      tagText: string
      tagColor: string
      price: number
    }
  | {
      id: string
      type: "accessory"
      label: string
      accessory: string
      price: number
    }
  | {
      id: string
      type: "overlay"
      label: string
      overlay: string
      price: number
      /** one-line description the shop card shows under the preview */
      desc: string
    }

/* Avatar overlay decorations — vector-style rings/orbits drawn as SVG
 * (self-contained: no external assets, no hotlinked art). IDs match the
 * OVERLAYS registry in chat-app.tsx. */
const OVERLAY_ITEMS: Extract<ShopItem, { type: "overlay" }>[] = [
  {
    id: "ov-hearts",
    type: "overlay",
    label: "Heart Halo",
    overlay: "hearts",
    price: 1500,
    desc: "Pink hearts orbiting your avatar",
  },
  {
    id: "ov-stars",
    type: "overlay",
    label: "Star Orbit",
    overlay: "stars",
    price: 2000,
    desc: "Golden stars circling slowly",
  },
  {
    id: "ov-flames",
    type: "overlay",
    label: "Ring of Fire",
    overlay: "flames",
    price: 2500,
    desc: "A living flame ring",
  },
  {
    id: "ov-neon",
    type: "overlay",
    label: "Neon Pulse",
    overlay: "neon",
    price: 2500,
    desc: "Glowing cyan ring that breathes",
  },
  {
    id: "ov-sakura",
    type: "overlay",
    label: "Sakura Bloom",
    overlay: "sakura",
    price: 3000,
    desc: "Falling cherry petals",
  },
  {
    id: "ov-thunder",
    type: "overlay",
    label: "Storm Surge",
    overlay: "thunder",
    price: 3500,
    desc: "Crackling electric sparks",
  },
  {
    id: "ov-ice",
    type: "overlay",
    label: "Frost Crystal",
    overlay: "ice",
    price: 3500,
    desc: "Circling ice shards",
  },
  {
    id: "ov-aurora",
    type: "overlay",
    label: "Aurora Ring",
    overlay: "aurora",
    price: 4000,
    desc: "A rainbow aurora halo",
  },
  {
    id: "ov-gold",
    type: "overlay",
    label: "Gold Spin",
    overlay: "gold",
    price: 5000,
    desc: "Spinning gold with gems",
  },
  {
    id: "ov-void",
    type: "overlay",
    label: "Void Echo",
    overlay: "void",
    price: 6000,
    desc: "A dark purple pulse ring",
  },
]

// 6 name tags + 8 PFP accessories + 10 avatar overlays, prices 1000–10000.
const SHOP_CATALOG: ShopItem[] = [
  {
    id: "tag-gold",
    type: "tag",
    label: "Gold Tag",
    tagText: "Gold Member",
    tagColor: "#d4a017",
    price: 1000,
  },
  {
    id: "tag-vip",
    type: "tag",
    label: "VIP Tag",
    tagText: "VIP",
    tagColor: "#9b59b6",
    price: 2500,
  },
  {
    id: "tag-pro",
    type: "tag",
    label: "Pro Tag",
    tagText: "Pro User",
    tagColor: "#16a085",
    price: 4000,
  },
  {
    id: "tag-elite",
    type: "tag",
    label: "Elite Tag",
    tagText: "Elite",
    tagColor: "#e67e22",
    price: 6000,
  },
  {
    id: "tag-legend",
    type: "tag",
    label: "Legend Tag",
    tagText: "Legend",
    tagColor: "#c0392b",
    price: 8000,
  },
  {
    id: "tag-mythic",
    type: "tag",
    label: "Mythic Tag",
    tagText: "Mythic",
    tagColor: "#8e44ad",
    price: 10000,
  },
  {
    id: "acc-crown",
    type: "accessory",
    label: "Crown",
    accessory: "crown",
    price: 1000,
  },
  {
    id: "acc-halo",
    type: "accessory",
    label: "Halo",
    accessory: "halo",
    price: 2000,
  },
  {
    id: "acc-horns",
    type: "accessory",
    label: "Devil Horns",
    accessory: "horns",
    price: 3000,
  },
  {
    id: "acc-glasses",
    type: "accessory",
    label: "Cool Shades",
    accessory: "glasses",
    price: 4000,
  },
  {
    id: "acc-headphones",
    type: "accessory",
    label: "Headphones",
    accessory: "headphones",
    price: 5000,
  },
  {
    id: "acc-partyhat",
    type: "accessory",
    label: "Party Hat",
    accessory: "partyhat",
    price: 6000,
  },
  {
    id: "acc-witchhat",
    type: "accessory",
    label: "Witch Hat",
    accessory: "witchhat",
    price: 8000,
  },
  {
    id: "acc-flower",
    type: "accessory",
    label: "Flower Crown",
    accessory: "flower",
    price: 10000,
  },
  ...OVERLAY_ITEMS,
]

export async function GET() {
  return NextResponse.json({ ok: true, items: SHOP_CATALOG })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      token?: string
      itemId?: string
      action?: string
    }
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
      const data: { tag?: string; tagColor?: string; pfpAccessory?: string; pfpOverlay?: string } =
        {}
      if (slot === "tag") {
        data.tag = null
        data.tagColor = null
      } else if (slot === "accessory") {
        data.pfpAccessory = null
      } else if (slot === "overlay") {
        data.pfpOverlay = null
      } else {
        return NextResponse.json(
          { ok: false, error: "Unknown slot — expected tag, accessory or overlay." },
          { status: 400 },
        )
      }
      const updated = await db.chatAccount.update({
        where: { id: account.id },
        data,
      })
      return NextResponse.json({ ok: true, account: toPublicAccount(updated) })
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
    // item you ALREADY own (any past shop_purchase:<id> transaction) just
    // re-equips it for free — purchases are permanent.
    const result = await db.$transaction(async (tx) => {
      const fresh = await tx.chatAccount.findUnique({
        where: { id: account.id },
      })
      if (!fresh) throw new Error("Account not found.")

      const owned = await tx.coinTransaction.findFirst({
        where: { fromId: account.id, toId: account.id, reason: `shop_purchase:${item.id}` },
        select: { id: true },
      })
      if (!owned && fresh.coins < item.price) {
        throw new Error(
          `Insufficient balance. This item costs ${item.price} coins.`,
        )
      }

      const updateData: {
        tag?: string
        tagColor?: string
        pfpAccessory?: string
        pfpOverlay?: string
      } = {}
      if (item.type === "tag") {
        updateData.tag = item.tagText
        updateData.tagColor = item.tagColor
      } else if (item.type === "accessory") {
        updateData.pfpAccessory = item.accessory
      } else {
        updateData.pfpOverlay = item.overlay
      }

      const updated = await tx.chatAccount.update({
        where: { id: account.id },
        data: {
          ...(owned ? {} : { coins: { decrement: item.price } }),
          ...updateData,
        },
      })

      if (!owned) {
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
