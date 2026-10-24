#!/usr/bin/env bash
# ============================================================================
# make-jsdelivr-links.sh — rebuild every Veil OS jsDelivr download bundle.
#
# This is the exact code used to create the live download links:
#   https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/dl/veil-os-fronts.zip
#   https://cdn.jsdelivr.net/gh/ok5678765s/veil-os@main/dl/veil-os-wallpapers-{1,2,3}.zip
#   ...and the dl/checksums.txt
#
# WHY IT'S SHAPED LIKE THIS
#   * jsDelivr caps /gh/ files at 20 MB → wallpapers are split into 3 parts,
#     each sized to stay under the cap (17.0 / 13.5 / 10.6 MB).
#   * .gitignore has a global `*.zip` rule → every bundle needs a `!` negation
#     or git silently eats it and the CDN serves a cached 404 (bit us once).
#   * Layout inside the wallpaper zips is FLAT (wp-*.png etc. at zip root)
#     except part 3 which carries the wp-thumbs/ directory.
#
# Safe to re-run: rebuilds dl/ from the current site/ + mirrors, idempotent.
# Run from repo root:  bash uploads/make-jsdelivr-links.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="ok5678765s/veil-os"
CDN="https://cdn.jsdelivr.net/gh/${REPO}@main"
MIRRORS="m1 m2 m3 m4 m5 m6 m7 m8 m9 m10"
mkdir -p dl

echo "==> [1/5] fronts bundle (mirrors + site + cdn + root, no wallpapers)"
rm -f dl/veil-os-fronts.zip
# shellcheck disable=SC2086
zip -r -q dl/veil-os-fronts.zip index.html index.xhtml site cdn $MIRRORS \
  -x "site/wp-*.png" -x "site/wp-*.jpg" -x "site/wp-*.jpeg" \
  -x "site/wp-*.mp4" -x "site/wp-*.webp"

echo "==> [2/5] wallpaper split bundles (each < 20MB jsDelivr cap)"
rm -f dl/veil-os-wallpapers-*.zip
(cd site
  # part 1 — the three big stills
  zip -q -r ../dl/veil-os-wallpapers-1.zip \
    wp-apocalyptic.png wp-aluminium.jpg wp-lake.jpg
  # part 2 — all five live videos
  zip -q -r ../dl/veil-os-wallpapers-2.zip \
    wp-mobile-video.mp4 wp-cherry-blossom.mp4 wp-mobile-video2.mp4 \
    wp-trionda-ball.mp4 wp-minecraft-earth.mp4
  # part 3 — remaining stills + the wp-thumbs/ preview directory
  zip -q -r ../dl/veil-os-wallpapers-3.zip \
    wp-minecraft-bee.png wp-spiderman.jpg wp-minecraft-blocks.jpg \
    wp-jellyfish.jpg wp-cubes.jpg wp-neon-aurora.png wp-thumbs
)

echo "==> [3/5] full bundle (fronts + ALL wallpapers; >20MB, for GitHub Releases)"
rm -f dl/veil-os-full.zip
cp dl/veil-os-fronts.zip dl/veil-os-full.zip
(cd site
  zip -q -r ../dl/veil-os-full.zip \
    wp-apocalyptic.png wp-aluminium.jpg wp-lake.jpg wp-minecraft-bee.png \
    wp-spiderman.jpg wp-minecraft-blocks.jpg wp-jellyfish.jpg wp-cubes.jpg \
    wp-neon-aurora.png wp-mobile-video.mp4 wp-cherry-blossom.mp4 \
    wp-mobile-video2.mp4 wp-trionda-ball.mp4 wp-minecraft-earth.mp4 wp-thumbs
)

echo "==> [4/5] checksums"
for z in dl/veil-os-fronts dl/veil-os-wallpapers-1 \
         dl/veil-os-wallpapers-2 dl/veil-os-wallpapers-3 dl/veil-os-full; do
  sha256sum "$z.zip" | awk -v n="$(basename "$z.zip")" '{print $1"  "n}'
done > dl/checksums.txt

echo "==> [5/5] publish"
# CRITICAL: .gitignore's global *.zip rule eats bundles unless negated.
# Keep these lines in .gitignore in sync with the bundle list:
#   !/dl/veil-os-fronts.zip
#   !/dl/veil-os-wallpapers-1.zip
#   !/dl/veil-os-wallpapers-2.zip
#   !/dl/veil-os-wallpapers-3.zip
git add dl/
git commit -q -m "dl: rebuild jsDelivr bundles (fronts + wallpapers split) $(date -u +%FT%TZ)" || true
git push origin main

# Purge the CDN edge so the new bytes serve immediately (purge is
# best-effort; jsDelivr throttles bursts but caches expire on their own).
for f in dl/veil-os-fronts.zip dl/veil-os-wallpapers-1.zip \
         dl/veil-os-wallpapers-2.zip dl/veil-os-wallpapers-3.zip \
         dl/checksums.txt; do
  curl -s -o /dev/null -w "%{http_code} purge %{url_effective}\n" \
    "https://purge.jsdelivr.net/gh/${REPO}@main/$f" || true
done

echo
echo "LIVE LINKS (after the edge syncs, ~10-20s):"
for f in veil-os-fronts.zip veil-os-wallpapers-1.zip \
         veil-os-wallpapers-2.zip veil-os-wallpapers-3.zip; do
  echo "  ${CDN}/dl/${f}"
done
echo "  ${CDN}/dl/checksums.txt"
echo
echo "Verify one:"
echo "  curl -s ${CDN}/dl/veil-os-fronts.zip | sha256sum   # compare vs dl/checksums.txt"
