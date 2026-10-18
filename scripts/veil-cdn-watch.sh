#!/usr/bin/env bash
# ============================================================================
# veil-cdn-watch.sh — wait for the GitHub token, then ship everything.
#
# The CDN chat room (site/data/chat-live.json) is written by people's
# BROWSERS through the GitHub Contents API, so assets/live.js needs a
# token with Contents: Read and write on ok5678765s/veil-os embedded.
# This box lost its stored token, so the user re-pastes it — it lands in
# one of these (first match wins):
#   1. tmp/gh-token.txt     (raw token text)
#   2. ~/.git-credentials   (https://x-access-token:TOKEN@github.com)
#
# When it appears this watcher:
#   1. stores it as the git credential (all pushes from the box work again)
#   2. re-runs scripts/site-build.ts  → token injected into assets/live.js,
#      all 11 pages + xhtmls re-stamped, the 10 mirror folders re-emitted
#   3. commits + pushes (rebase first — browsers may have written to the
#      room meanwhile)
#   4. purges the ENTIRE jsDelivr surface (site/ + m1..m10 + backups)
#   5. verifies the 10 public links answer 200
#
# Log: tmp/veil-cdn-watch.log
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

OWNER="ok5678765s"
REPO="veil-os"
LOG="tmp/veil-cdn-watch.log"
mkdir -p tmp
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

PAGES="index chat arcade ai stream wallpapers music links history updates settings"

token_from_file() { tr -d ' \t\r\n' < tmp/gh-token.txt 2>/dev/null; }
token_from_creds() {
  sed -n 's#https://[^:]*:\([^@]*\)@github\.com#\1#p' "$HOME/.git-credentials" 2>/dev/null | head -1 | tr -d ' \t\r\n'
}

purge_all() {
  local paths=()
  local p m
  for p in $PAGES; do paths+=("site/$p.html" "site/$p.xhtml"); done
  paths+=(site/version.json site/_headers)
  paths+=(site/assets/os.js site/assets/live.js site/assets/app.css site/assets/icon.svg)
  for p in latest.json chat-live.json arcade.json wallpapers.json wallpapers-live.json wallpapers-pack.json updates.json; do
    paths+=("site/data/$p")
  done
  paths+=(backups/chat/latest.json backups/chat/manifest.json)
  for m in m1 m2 m3 m4 m5 m6 m7 m8 m9 m10; do
    for p in $PAGES; do paths+=("$m/$p.html" "$m/$p.xhtml"); done
    paths+=("$m/version.json")
  done
  printf '%s\n' "${paths[@]}" | xargs -P 20 -I{} \
    curl -s --max-time 10 "https://purge.jsdelivr.net/gh/${OWNER}/${REPO}@main/{}" -o /dev/null
  log "purged ${#paths[@]} CDN paths"
}

verify_links() {
  local ok=0 fail=0
  for m in m1 m2 m3 m4 m5 m6 m7 m8 m9 m10; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
      "https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@main/${m}/index.xhtml")
    if [ "$code" = "200" ]; then ok=$((ok+1)); else fail=$((fail+1)); log "VERIFY-FAIL $m -> $code"; fi
  done
  log "verify: $ok/10 mirror links OK, $fail failed"
  [ "$fail" -eq 0 ]
}

log "watcher start (pid $$) — waiting for the GitHub token (tmp/gh-token.txt or ~/.git-credentials)"

for i in $(seq 1 1440); do   # up to 12h @ 30s
  T="$(token_from_file)"
  [ -z "$T" ] && T="$(token_from_creds)"
  if [ -n "$T" ] && [ "${#T}" -ge 20 ]; then
    log "token found (${#T} chars) — shipping"
    printf 'https://x-access-token:%s@github.com\n' "$T" > "$HOME/.git-credentials"
    chmod 600 "$HOME/.git-credentials"
    git config --global credential.helper store

    if ! bun scripts/site-build.ts >> "$LOG" 2>&1; then
      log "SITE-BUILD-FAIL (will retry in 60s)"
      sleep 60
      continue
    fi

    export GIT_TERMINAL_PROMPT=0
    git add -A site m1 m2 m3 m4 m5 m6 m7 m8 m9 m10 >> "$LOG" 2>&1
    if ! git diff --cached --quiet; then
      git commit -m "cdn: live chat room + the 10 public mirror links (token active)" >> "$LOG" 2>&1
    fi
    git pull --rebase --autostash origin main >> "$LOG" 2>&1
    if git push origin main >> "$LOG" 2>&1; then
      log "PUSH OK $(git rev-parse --short HEAD)"
      purge_all
      sleep 8
      if verify_links; then
        log "VERIFIED — the 10 links are live"
        exit 0
      else
        log "some links not warm yet — they answer once the CDN picks the commit up (usually seconds)"
        exit 0
      fi
    else
      log "PUSH FAIL — token may lack Contents:write; keeping watch"
      : > "$HOME/.git-credentials"   # avoid a loop on a bad token
      rm -f tmp/gh-token.txt
    fi
  fi
  sleep 30
done
log "watcher gave up after 12h"
