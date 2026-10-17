/* ── Avatar decorations (PFP accessories) ──────────────────────────────
 * Owner refresh v2 (2026-10-17): every decoration is now the REAL art
 * from the owner's reference — extracted pixel-for-pixel from the
 * uploaded screen recording (upload/Screen Recording 2026-10-16
 * 230602.mp4, a 5×5 picker grid on a flat (26,31,37) background) plus
 * the two directly-uploaded images (puppy filter jpg, cat ears avif).
 * No redrawn/recreated art: the video cells were background-keyed with
 * a soft color-distance ramp and are served as transparent PNGs from
 * public/deco-*.png.
 *
 * Positioning — "centered" is the rule:
 *  - FULL-CELL items: the video cell is the designer's composition
 *    around a centered avatar, so the whole 300×300 canvas is mapped
 *    onto a frame 130% of the avatar (top/left -15%), keeping the
 *    artwork centered by construction (rings wrap, hats sit on top).
 *  - COMPANIONS (wolf/bunny/sprout): trimmed to content, scaled to a
 *    fixed fraction of the avatar height, horizontally centered and
 *    anchored at the avatar's base (+6% overlap so they "stand" on it).
 *  - SPLIT pieces (cell 3,3 had ears + two controllers combined — the
 *    owner asked for the four individual ones): each piece keeps its
 *    in-cell position mapped through the same 130% frame, so wearing
 *    all four reproduces the original composition exactly.
 * Animations (veil-ov-*) are left to the PNGs' own glow art — the
 * extracted frames already carry the animated look. */

type DecoPart = {
  t: "img"
  src: string
  top?: string
  left?: string
  right?: string
  bottom?: string
  w: string
  behind?: boolean
}

type Decoration = { parts: DecoPart[] }

/** A decoration extracted from a full video cell — canvas maps onto a
 *  130% frame centered on the avatar. */
function fullCell(src: string): Decoration {
  return {
    parts: [{ t: "img", src, top: "-15%", left: "-15%", w: "130%" }],
  }
}

const DECORATIONS: Record<string, Decoration> = {
  /* ── Directly uploaded by the owner ────────────────────────────── */
  puppy: {
    parts: [
      { t: "img", src: "/deco-dog-ears.png", top: "-25%", left: "-10%", w: "120%" },
      { t: "img", src: "/deco-dog-nose.png", top: "63%", left: "27%", w: "46%" },
    ],
  },
  catears: {
    parts: [{ t: "img", src: "/deco-cat-ears.png", top: "-62%", left: "-3%", w: "106%" }],
  },

  /* ── The 4-in-1 cell, split into individual pieces ─────────────── */
  earL: {
    parts: [{ t: "img", src: "/deco-earL.png", top: "4.5%", left: "3.2%", w: "55.9%" }],
  },
  earR: {
    parts: [{ t: "img", src: "/deco-earR.png", top: "4.5%", left: "40.9%", w: "67.6%" }],
  },
  contrL: {
    parts: [{ t: "img", src: "/deco-contrL.png", top: "40.9%", left: "-3.3%", w: "68.9%" }],
  },
  contrR: {
    parts: [{ t: "img", src: "/deco-contrR.png", top: "40.9%", left: "53.9%", w: "61.1%" }],
  },

  /* ── Full-cell designs from the video ──────────────────────────── */
  arch: fullCell("/deco-arch.png"), // rainbow arch with clovers
  clover: fullCell("/deco-clover.png"), // four-leaf clover crown
  visor: fullCell("/deco-visor.png"), // blue neon visor
  dragon: fullCell("/deco-dragon.png"), // golden dragon crown
  owl: fullCell("/deco-owl.png"), // owl mask, gold wings
  seal: fullCell("/deco-seal.png"), // city seal badge
  fur: fullCell("/deco-fur.png"), // white fur halo
  cyber: fullCell("/deco-cyber.png"), // silver/blue cyber-ear mask
  fight: fullCell("/deco-fight.png"), // "03 FIGHT" logo with rainbow arcs
  stars: fullCell("/deco-stars.png"), // purple starfield halo
  sword: fullCell("/deco-sword.png"), // crossed swords with blue arc
  batring: fullCell("/deco-batring.png"), // gold arc halo with bat emblem
  orb: fullCell("/deco-orb.png"), // blue energy orb
  wreath: fullCell("/deco-wreath.png"), // laurel wreath ring
  potion: fullCell("/deco-potion.png"), // glass jar with blue liquid
  y2025: fullCell("/deco-y2025.png"), // gold "2025" with fireworks
  santa: fullCell("/deco-santa.png"), // santa hat
  snowglobe: fullCell("/deco-snowglobe.png"), // snow globe
  lightning: fullCell("/deco-lightning.png"), // lightning bolt
  owlord: fullCell("/deco-owlord.png"), // purple owl mask, glowing eyes

  /* ── Companions — trimmed, centered at the avatar's base ──────── */
  wolf: {
    parts: [{ t: "img", src: "/deco-wolffull.png", top: "26%", left: "7.2%", w: "85.6%" }],
  },
  bunny: {
    parts: [{ t: "img", src: "/deco-bunnyfull.png", top: "31%", left: "37.1%", w: "25.8%" }],
  },
  sprout: {
    parts: [{ t: "img", src: "/deco-sproutfull.png", top: "18%", left: "21.2%", w: "57.5%" }],
  },
}

/** Renders one decoration part over/under the avatar box. */
function DecoPartView({ part }: { part: DecoPart }) {
  return (
    <img
      src={part.src}
      alt=""
      aria-hidden
      className="pointer-events-none absolute select-none"
      style={{
        top: part.top,
        left: part.left,
        right: part.right,
        bottom: part.bottom,
        width: part.w,
        zIndex: part.behind ? 0 : 2,
      }}
    />
  )
}
