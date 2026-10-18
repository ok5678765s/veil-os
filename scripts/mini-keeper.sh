#!/usr/bin/env bash
# ============================================================================
# Mini-service keeper — keep ws-relay (:3003) and chat-service (:3004) alive.
#
# HISTORY (2026-09-28): a platform supervisor cull wiped every service the
# session had started except freetube-service — because freetube had its
# own watchdog (freetube-watchdog.sh, 13h+ uptime through every cull).
# This keeper extends that exact, proven pattern to the two services the
# freetube watchdog doesn't own. Deliberately does NOT touch:
#   - freetube (:3031) — owned by freetube-watchdog.sh
#   - Next dev (:3000) — owned by scripts/dev-watchdog.sh + the platform
#
# Liveness is PORT-BASED (`ss`), matching both existing watchdogs: a
# listening socket means the service is alive even if an HTTP probe would
# lag (chat's `/` legitimately answers 400 — HTTP codes are useless there).
# Revives with the doubly-detached pattern that survives session cleanup:
#   ( setsid nohup bun run dev >> <own log> 2>&1 < /dev/null & )
# ============================================================================
cd /home/z/my-project || exit 1
LOG=mini-keeper.log
CYCLE=30        # seconds between checks
BOOT_WAIT=12    # seconds to let a revived service bind before re-checking

log() { echo "[mini-keeper] $(date -u +%FT%TZ) $*" >> "$LOG"; }

port_up() { ss -tln "sport = :$1" 2>/dev/null | grep -q LISTEN; }

# revive <dir> <port> <name>
revive() {
  log "$3 down (port :$2 free) — starting"
  ( cd "$1" && setsid nohup bun run dev >> "/home/z/my-project/$LOG" 2>&1 < /dev/null & )
  sleep "$BOOT_WAIT"
}

log "armed: watching ws-relay :3003 + chat-service :3004 every ${CYCLE}s"

while true; do
  port_up 3003 || revive "$PWD/mini-services/ws-relay" 3003 "ws-relay"
  port_up 3004 || revive "$PWD/mini-services/chat-service" 3004 "chat-service"
  sleep "$CYCLE"
done
