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
/* PFP accessories — owner refresh v3 (2026-10-17).
 *
 * Every accessory is the real art from the owner's picker-grid screen
 * recording, re-extracted with correct cell geometry and exported as
 * ANIMATED WebPs (the recording's live loops: glows pulse, swords
 * charge, wolves howl). The city seal is static art. The two direct
 * uploads (puppy filter, cat ears) are static PNGs.
 *
 * The 4-in-1 cell is sold both ways: the combined VR Halo and its four
 * individual pieces (earL/earR/contrL/contrR). IDs match the
 * DECORATIONS registry keys in chat-app.tsx (the renderer). */
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
    desc: "Glowing ear, your side of the halo",
  },
  {
    id: "acc-ear-r",
    type: "accessory",
    label: "Cat Ear · Right",
    accessory: "earR",
    price: 1200,
    desc: "Glowing ear, other side of the halo",
  },
  {
    id: "acc-contr-l",
    type: "accessory",
    label: "Controller · Left",
    accessory: "contrL",
    price: 2200,
    desc: "Peach controller, halo's lower left",
  },
  {
    id: "acc-contr-r",
    type: "accessory",
    label: "Controller · Right",
    accessory: "contrR",
    price: 2200,
    desc: "Lavender controller, halo's lower right",
  },
  {
    id: "acc-vrhalo",
    type: "accessory",
    label: "VR Halo",
    accessory: "vrhalo",
    price: 4600,
    desc: "The full ring — ears + controllers",
  },
  {
    id: "acc-sprout",
    type: "accessory",
    label: "Sprout",
    accessory: "sprout",
    price: 1500,
    desc: "A little plant at your side",
  },
  {
    id: "acc-fight",
    type: "accessory",
    label: "Fight Logo",
    accessory: "fight",
    price: 1600,
    desc: "03 FIGHT with rainbow arcs",
  },
  {
    id: "acc-clover",
    type: "accessory",
    label: "Clover Crown",
    accessory: "clover",
    price: 1800,
    desc: "Lucky clovers around your head",
  },
  {
    id: "acc-fur",
    type: "accessory",
    label: "Fur Halo",
    accessory: "fur",
    price: 2200,
    desc: "Fluffy white winter halo",
  },
  {
    id: "acc-visor",
    type: "accessory",
    label: "Neon Visor",
    accessory: "visor",
    price: 2400,
    desc: "Glowing blue over the eyes",
  },
  {
    id: "acc-bunny",
    type: "accessory",
    label: "Bunny",
    accessory: "bunny",
    price: 2600,
    desc: "A tall pink companion",
  },
  {
    id: "acc-seal",
    type: "accessory",
    label: "City Seal",
    accessory: "seal",
    price: 2800,
    desc: "An official-looking badge",
  },
  {
    id: "acc-stars",
    type: "accessory",
    label: "Starfield",
    accessory: "stars",
    price: 2800,
    desc: "Purple stars all around",
  },
  {
    id: "acc-potion",
    type: "accessory",
    label: "Potion",
    accessory: "potion",
    price: 2800,
    desc: "Glass jar, blue liquid",
  },
  {
    id: "acc-wolf",
    type: "accessory",
    label: "Wolf Pup",
    accessory: "wolf",
    price: 3000,
    desc: "A gray wolf at your side",
  },
  {
    id: "acc-blackcat",
    type: "accessory",
    label: "Black Cat",
    accessory: "blackcat",
    price: 3000,
    desc: "A shadow cat at your side",
  },
  {
    id: "acc-lightning",
    type: "accessory",
    label: "Lightning",
    accessory: "lightning",
    price: 3000,
    desc: "A crackling gold bolt",
  },
  {
    id: "acc-owl",
    type: "accessory",
    label: "Owl Mask",
    accessory: "owl",
    price: 3200,
    desc: "Gold wings, wise eyes",
  },
  {
    id: "acc-orb",
    type: "accessory",
    label: "Energy Orb",
    accessory: "orb",
    price: 3200,
    desc: "A swirling blue orb",
  },
  {
    id: "acc-snowglobe",
    type: "accessory",
    label: "Snow Globe",
    accessory: "snowglobe",
    price: 3400,
    desc: "Snowing forever",
  },
  {
    id: "acc-batring",
    type: "accessory",
    label: "Bat Halo",
    accessory: "batring",
    price: 3600,
    desc: "Gold arc with a bat emblem",
  },
  {
    id: "acc-y2025",
    type: "accessory",
    label: "Gold 2025",
    accessory: "y2025",
    price: 3600,
    desc: "Shiny numerals + fireworks",
  },
  {
    id: "acc-arch",
    type: "accessory",
    label: "Rainbow Arch",
    accessory: "arch",
    price: 3800,
    desc: "Rainbow arc with clovers",
  },
  {
    id: "acc-cyber",
    type: "accessory",
    label: "Cyber Mask",
    accessory: "cyber",
    price: 3800,
    desc: "Silver ears, cyan glow",
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
    id: "acc-sword",
    type: "accessory",
    label: "Crossed Swords",
    accessory: "sword",
    price: 4200,
    desc: "Samurai energy",
  },
  {
    id: "acc-dragon",
    type: "accessory",
    label: "Dragon Crown",
    accessory: "dragon",
    price: 5000,
    desc: "Gold crown with a dragon",
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
    id: "acc-owlord",
    type: "accessory",
    label: "Owl Lord",
    accessory: "owlord",
    price: 6000,
    desc: "Purple mask, glowing eyes",
  },
]

// 6 name tags + 31 real PFP accessories (owner uploads + video extraction).
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
  const purchaseRows = await db.coinTransaction.findMany({
    where: { fromId: account.id, toId: account.id, reason: { startsWith: "shop_purchase:" } },
    select: { reason: true },
  })
  const owned = [
    ...new Set(purchaseRows.map((r) => r.reason.slice("shop_purchase:".length))),
  ].filter((id) => SHOP_CATALOG.some((i) => i.id === id))
  return NextResponse.json({ ok: true, items: SHOP_CATALOG, owned })
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
      const owned = await db.coinTransaction.findFirst({
        where: { fromId: account.id, toId: account.id, reason: `shop_purchase:${item.id}` },
        select: { id: true },
      })
      if (!owned) {
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
