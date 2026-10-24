#!/usr/bin/env bash
# ============================================================================
# verify-jsdelivr-links.sh — the exact verification code used before declaring
# the download links live. Checks every edge, byte counts, and checksums.
#
# Run from repo root:  bash uploads/verify-jsdelivr-links.sh
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="ok5678765s/veil-os"
FILES="dl/veil-os-fronts.zip dl/veil-os-wallpapers-1.zip \
       dl/veil-os-wallpapers-2.zip dl/veil-os-wallpapers-3.zip \
       dl/jsdelivr-links.md dl/checksums.txt"
EDGES="cdn.jsdelivr.net fastly.jsdelivr.net gcore.jsdelivr.net"

echo "==> HTTP status on every edge"
for f in $FILES; do
  line="  $f:"
  for e in $EDGES; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "https://$e/gh/${REPO}@main/$f")
    line="$line  $e=$code"
  done
  echo "$line"
done

echo
echo "==> byte-size match (cdn edge vs local file)"
for f in dl/veil-os-fronts.zip dl/veil-os-wallpapers-1.zip \
         dl/veil-os-wallpapers-2.zip dl/veil-os-wallpapers-3.zip; do
  remote=$(curl -s "https://cdn.jsdelivr.net/gh/${REPO}@main/$f" | wc -c)
  local_size=$(stat -c%s "$f" 2>/dev/null || echo "MISSING-LOCAL")
  [ "$remote" = "$local_size" ] && ok="OK" || ok="MISMATCH"
  echo "  $f  remote=${remote}B local=${local_size}B  [$ok]"
done

echo
echo "==> sha256 integrity (download back + compare)"
tmp=$(mktemp)
for f in dl/veil-os-fronts.zip dl/veil-os-wallpapers-1.zip \
         dl/veil-os-wallpapers-2.zip dl/veil-os-wallpapers-3.zip; do
  base=$(basename "$f")
  curl -s -o "$tmp" "https://cdn.jsdelivr.net/gh/${REPO}@main/$f"
  got=$(sha256sum "$tmp" | awk '{print $1}')
  want=$(rg -F "$base" dl/checksums.txt | awk '{print $1}')
  [ "$got" = "$want" ] && ok="OK" || ok="MISMATCH"
  echo "  $base  $ok  ${got:0:16}…"
done
rm -f "$tmp"

echo
echo "==> raw.githubusercontent cross-check (bypasses jsDelivr cache)"
for f in dl/veil-os-fronts.zip dl/checksums.txt; do
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    "https://raw.githubusercontent.com/${REPO}/main/$f")
  echo "  raw $f → $code  (404 here + 200 at @sha = gitignore ate the file)"
done
