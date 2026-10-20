import { db } from "../db"

/**
 * Veil shop — shared catalog + ownership rules.
 *
 * Extracted from /api/chat-shop (2026-10-20) so the route, the backup
 * pipeline and the repair scripts all agree on ONE definition of what a
 * player owns. That matters because of the rollback problem:
 *
 * The platform periodically snapshot-restores this box, reverting the
 * live SQLite file to an older moment. Account rows survive (the chat
 * backup/restore pipeline re-imports them — tag, pfpAccessory, coins),
 * but UNTIL v1.3 the backup format never carried coinTransaction rows,
 * so every rollback silently emptied the purchase ledger. With ledger
 * ownership that made the "My Items" locker read as empty on every
 * device ("it keeps erasing my items") — even for items the account was
 * visibly WEARING.
 *
 * Two guards fix that for good:
 *   1. equipped ⇒ owned (below) — a worn item is owned even with no
 *      ledger row, so the locker can never lose what's on the account.
 *   2. backup v1.3 carries the ledger itself (see chat-backup.ts), and
 *      the backup loop auto-restores it after a detected rollback.
 */

export type ShopItem =
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
export const SHOP_CATALOG: ShopItem[] = [
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

/** Refunds return 70% of the item's shop price (owner directive
 * 2026-10-20: "add shop refunds but you only get 70% of the money you
 * spent"). */
export const REFUND_RATE = 0.7

export function refundFor(price: number): number {
  return Math.floor(price * REFUND_RATE)
}

/** Items the account is VISIBLY wearing right now. The rollback guard:
 * whatever is on the account's face/name is owned, full stop — the
 * ledger can say whatever it wants. Without this, a platform rollback
 * that predates the purchase ledger (or a pre-v1.3 restore that could
 * not re-import transactions) emptied the locker of items the player
 * was literally wearing. */
export function equippedOwnedIds(
  tag: string | null | undefined,
  pfpAccessory: string | null | undefined,
): Set<string> {
  const owned = new Set<string>()
  if (!tag && !pfpAccessory) return owned
  for (const item of SHOP_CATALOG) {
    if (item.type === "tag" && tag && item.tagText === tag) owned.add(item.id)
    if (
      item.type === "accessory" &&
      pfpAccessory &&
      item.accessory === pfpAccessory
    ) {
      owned.add(item.id)
    }
  }
  return owned
}

/* Net ownership: an item is owned while purchases − refunds > 0. The
 * ledger is append-only (a refund writes a `shop_refund:<id>` row), so
 * refunded items correctly disappear from the locker and re-buying
 * charges full price again. Works with the root client or a tx client.
 *
 * `equipped` (optional) feeds the rollback guard: ids from
 * equippedOwnedIds are unioned in, so worn items survive even with a
 * wiped/stale ledger. */
export async function netOwnedIds(
  client: Pick<typeof db, "coinTransaction">,
  accountId: string,
  equipped?: { tag?: string | null; pfpAccessory?: string | null },
): Promise<Set<string>> {
  const rows = await client.coinTransaction.findMany({
    where: {
      fromId: accountId,
      toId: accountId,
      OR: [
        { reason: { startsWith: "shop_purchase:" } },
        { reason: { startsWith: "shop_refund:" } },
      ],
    },
    select: { reason: true },
  })
  const counts = new Map<string, number>()
  for (const r of rows) {
    const purchase = r.reason.startsWith("shop_purchase:")
    const id = r.reason.slice(purchase ? "shop_purchase:".length : "shop_refund:".length)
    counts.set(id, (counts.get(id) ?? 0) + (purchase ? 1 : -1))
  }
  const owned = new Set<string>()
  for (const [id, n] of counts) if (n > 0) owned.add(id)
  if (equipped) {
    for (const id of equippedOwnedIds(equipped.tag, equipped.pfpAccessory)) {
      owned.add(id)
    }
  }
  return owned
}
