#!/usr/bin/env bash
# ============================================================================
# github-push-watch.sh — background one-shot watcher (v2).
#
# STATE (2026-10-03 15:15): repo https://github.com/ok5678765s/veil-os
# EXISTS and is PUBLIC, and it IS in the token's Repository access list
# (authenticated reads work). BUT the token's Contents permission is
# READ-ONLY — git push answers 403 (needs contents=write).
#
# The user must flip ONE toggle: github.com/settings/personal-access-tokens
# → the token → Repository permissions → Contents → "Read and write".
#
# This watcher probes REAL push capability every 60s for up to 6h using
# `git push --dry-run` (same server-side permission negotiation as a real
# push, zero pack transfer), then pushes main for real, verifies the remote
# SHA, and exits. Log: tmp/github-push-watch.log
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

OWNER="ok5678765s"
REPO="veil-os"
LOG="tmp/github-push-watch.log"
mkdir -p tmp

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }

TOKEN="$(sed -n 's#https://[^:]*:\([^@]*\)@github\.com#\1#p' ~/.git-credentials 2>/dev/null | head -1)"
if [ -z "$TOKEN" ]; then
  log "no token in ~/.git-credentials — exiting"
  exit 1
fi

PUSH_URL="https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git"

HEAD_SHA="$(git rev-parse main 2>/dev/null)"
if [ -z "$HEAD_SHA" ]; then
  log "no local main branch — exiting"
  exit 1
fi

# idempotency: already pushed + verified this exact SHA?
if grep -q " VERIFIED ${HEAD_SHA} " "$LOG" 2>/dev/null; then
  log "watcher start (pid $$) — ${HEAD_SHA} already verified, nothing to do"
  exit 0
fi

log "watcher start (pid $$) — waiting for Contents:write on ${OWNER}/${REPO} (local main ${HEAD_SHA:0:10})"

for i in $(seq 1 360); do
  # already in sync? (e.g. someone pushed manually)
  REMOTE_SHA="$(git ls-remote "$PUSH_URL" refs/heads/main 2>/dev/null | cut -f1)"
  if [ "$REMOTE_SHA" = "$HEAD_SHA" ]; then
    log "VERIFIED ${HEAD_SHA} → https://github.com/${OWNER}/${REPO} (already in sync)"
    exit 0
  fi

  # real capability probe: dry-run push performs the same permission
  # negotiation as a push, without transferring the pack
  if git push --dry-run "$PUSH_URL" main >/dev/null 2>&1; then
    log "push capability detected — pushing main"
    if git push -u origin main >> "$LOG" 2>&1; then
      log "PUSH OK"
    else
      log "normal push rejected — retrying with --force (auto-init README case)"
      if git push --force -u origin main >> "$LOG" 2>&1; then
        log "FORCE PUSH OK"
      else
        log "push failed even with --force — continuing to retry"
        sleep 60
        continue
      fi
    fi
    sleep 5
    # verify — re-read main HERE: new commits may have landed while waiting
    REMOTE_SHA="$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)"
    HEAD_SHA="$(git rev-parse main)"
    if [ "$REMOTE_SHA" = "$HEAD_SHA" ]; then
      log "VERIFIED ${HEAD_SHA} → https://github.com/${OWNER}/${REPO}"
      exit 0
    else
      log "MISMATCH remote='${REMOTE_SHA}' local-main='${HEAD_SHA}' — exiting"
      exit 1
    fi
  fi
  sleep 60
done
log "watcher timeout after 6h — re-run scripts/github-push-watch.sh if needed"
