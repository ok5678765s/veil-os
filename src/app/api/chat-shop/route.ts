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
      /** one-line description the shop card shows under the preview */
      desc: string
    }

/* PFP accessories — owner refresh 2026-10-17.
 *
 * The old emoji accessories and the ring "avatar overlays" are RETIRED
 * (removed from the catalog entirely). The new set is built from the
 * owner's uploaded assets — the puppy filter (jpg) and the cat ears
 * (avif), processed into transparent PNGs at public/deco-*.png — plus
 * vector recreations of the avatar-decoration reference sheet
 * (magnific.com vectors + the screen recording in upload/).
 *
 * The reference sheet's combined "joy-cons + glowing cat ears" cell is
 * split into its four individual pieces (earL/earR/joyconL/joyconR),
 * exactly as requested. IDs match the DECORATIONS registry keys in
 * chat-app.tsx (the renderer). */
const ACCESSORY_ITEMS: Extract<ShopItem, { type: "accessory" }>[] = [
  {
    id: "acc-puppy",
    type: "accessory",
    label: "Puppy Filter",
    accessory: "puppy",
    price: 4500,
    desc: "Floppy ears + a wet nose",
  },
  {
    id: "acc-catears",
    type: "accessory",
    label: "Cat Ears",
    accessory: "catears",
    price: 3500,
    desc: "Black kitty ears, pink inside",
  },
  {
    id: "acc-ear-l",
    type: "accessory",
    label: "Cat Ear · Left",
    accessory: "earL",
    price: 1200,
    desc: "One glowing orange ear",
  },
  {
    id: "acc-ear-r",
    type: "accessory",
    label: "Cat Ear · Right",
    accessory: "earR",
    price: 1200,
    desc: "One glowing orange ear",
  },
  {
    id: "acc-joycon-l",
    type: "accessory",
    label: "Joy-Con · Left",
    accessory: "joyconL",
    price: 2200,
    desc: "Peach controller at your side",
  },
  {
    id: "acc-joycon-r",
    type: "accessory",
    label: "Joy-Con · Right",
    accessory: "joyconR",
    price: 2200,
    desc: "Lavender controller at your side",
  },
  {
    id: "acc-sprout",
    type: "accessory",
    label: "Sprout",
    accessory: "sprout",
    price: 1500,
    desc: "A little plant growing on you",
  },
  {
    id: "acc-clover",
    type: "accessory",
    label: "Clover Crown",
    accessory: "clover",
    price: 2600,
    desc: "Lucky clovers around your head",
  },
  {
    id: "acc-potion",
    type: "accessory",
    label: "Potion Bottle",
    accessory: "potion",
    price: 2800,
    desc: "Bubbling blue brew",
  },
  {
    id: "acc-afro",
    type: "accessory",
    label: "Rainbow Afro",
    accessory: "afro",
    price: 3000,
    desc: "The clown classic",
  },
  {
    id: "acc-headset",
    type: "accessory",
    label: "Neon Headset",
    accessory: "headset",
    price: 3800,
    desc: "Glowing cyan gaming audio",
  },
  {
    id: "acc-santa",
    type: "accessory",
    label: "Santa Hat",
    accessory: "santa",
    price: 4000,
    desc: "Jingle ready",
  },
  {
    id: "acc-batmoon",
    type: "accessory",
    label: "Bat & Moon",
    accessory: "batmoon",
    price: 4200,
    desc: "A bat perched on a crescent",
  },
  {
    id: "acc-gcrown",
    type: "accessory",
    label: "Golden Crown",
    accessory: "gcrown",
    price: 5000,
    desc: "Fit for royalty",
  },
  {
    id: "acc-portal",
    type: "accessory",
    label: "Blue Portal",
    accessory: "portal",
    price: 5500,
    desc: "Swirling vortex behind you",
  },
  {
    id: "acc-wolfhelm",
    type: "accessory",
    label: "Wolf Helm",
    accessory: "wolfhelm",
    price: 6000,
    desc: "With crackling sparks",
  },
  {
    id: "acc-katanas",
    type: "accessory",
    label: "Crossed Katanas",
    accessory: "katanas",
    price: 6500,
    desc: "Samurai aura, behind you",
  },
  {
    id: "acc-wreath",
    type: "accessory",
    label: "Laurel Wreath",
    accessory: "wreath",
    price: 4800,
    desc: "Champion's laurels",
  },
  {
    id: "acc-y2025",
    type: "accessory",
    label: "Gold 2025",
    accessory: "y2025",
    price: 3600,
    desc: "Shiny gold numerals",
  },
  {
    id: "acc-headdress",
    type: "accessory",
    label: "Royal Headdress",
    accessory: "headdress",
    price: 8000,
    desc: "Purple & gold wings",
  },
]

// 6 name tags + 20 PFP accessories (uploads + reference recreations).
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
  ...ACCESSORY_ITEMS,
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
