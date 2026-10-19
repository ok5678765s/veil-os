#!/usr/bin/env bash
# ============================================================================
# Dev-server watchdog v3 — OOM firewall for the 4GB no-swap box.
#
# HISTORY: the box randomly rebooted when idle (whole-machine restart,
# uptime reset to 0). Root cause: next-server RSS drifts toward ~2.7GB
# (V8's default heap ceiling scales with total RAM and never GCs hard
# enough), the box has 3.9GB + ZERO swap, so the kernel OOM-killer
# eventually panics and the sandbox host restarts the container.
#
# v3 fixes the RESTART STORM (2026-10-02 "it keeps restarting permanently"):
#   * COOLDOWN FILE MOVED OUT OF .next/ — the v2 cooldown lived in
#     .next/dev/, which EVERY dev-server boot wipes, so the 15-min cooldown
#     never survived a restart and emergency restarts fired 3-5 minutes
#     apart (log: 21:39 → 21:43 → 21:46 → 21:57). Now it lives in /home/z/
#     and survives every boot.
#   * SELF-DEDUP — earlier rounds left MULTIPLE watchdog instances running
#     with different thresholds (dueling "armed" lines in the log); the
#     newest instance now kills all older copies before arming.
#   * HEAP CAP LOWERED to 1024MB (package.json) so the normal RSS plateau is
#     ~1.55-1.65GB; the planned-restart line sits at 1.75GB, well under the
#     kernel kill zone AND far enough above the plateau that only true leaks
#     trip it.
#
# v4 (2026-10-09 "website should never restart" round): the restart
#   POLICY changed. v3 (and Next.js's own internal watchdog) restarted on
#   process-local metrics alone — but a big RSS with a healthy box is NOT
#   an emergency (heap cap now 1792MB; the live heap alone legitimately
#   reaches ~1.2GB on a fully-warm tree). Restarting a healthy-but-large
#   server was exactly the "website randomly restarts" bug.
#   NEW RULES:
#     * RSS alone NEVER restarts. It logs a rate-limited warning and
#       trusts the heap gardener (v5, instrumentation.ts) to compact.
#     * A planned restart needs BOTH a huge RSS (> 2.3GB) AND real box
#       pressure (MemAvailable < 700MB).
#     * MemAvailable < 320MB alone remains the emergency path (the true
#       OOM firewall — the alternative is a whole-box kernel panic).
#   Cycle tightened 15s → 10s so pressure is caught faster than ever,
#   while the 15-min cooldown still prevents any restart storm.
#
# Protections kept from v2/v3:
#   1. Corroborated RSS guard — planned restart only when the box itself
#                    is running out of memory (RSS high AND MemAvail low).
#   2. MemAvailable guard — if the box drops below ~320MB available,
#                    restart next-server to instantly free ~1.5GB.
#   3. Dedup       — if multiple next-server instances pile up, keep the
#                    :3000 holder and kill the orphans.
#
# Liveness is PORT-BASED (`ss`), not HTTP-latency based. Kills are
# PID-targeted (never name-based pkill — the freetube-service also runs
# `bun run dev`).
#
# Started detached (survives session cleanup):
#   setsid bash scripts/dev-watchdog.sh > /dev/null 2>&1 < /dev/null &
# ============================================================================
cd /home/z/my-project || exit 1

# ---- self-dedup: exactly ONE watchdog, always the newest -----------------
for pid in $(pgrep -f 'bash scripts/dev-watchdog.sh' 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  kill "$pid" 2>/dev/null
done
sleep 0.3

CYCLE=10               # seconds between checks (v4: faster reaction, zero extra restarts)
RSS_WARN_KB=1800000    # 1.76GiB — log-only: big server, gardener compacts, NO restart
RSS_LIMIT_KB=2450000   # 2.34GB — restart CANDIDATE, but only with real box pressure (v6.1, 2026-10-19: warm-compile transients legitimately push RSS to ~2.2GB even with the 1664MB heap cap — the compiler's external memory is off-heap. 2450MB leaves the warmup path alone; MemAvail corroboration still gates every restart)
PRESSURE_MIN_KB=600000 # 600MB — MemAvail below this + RSS over limit = true pressure (v4.1, 2026-10-13: was 700MB — borderline 677-683MB dips restarted the server and dumped live user sessions; the gardener already double-gcs below 600)
MEMAVAIL_MIN_KB=320000 # 320MB — whole-box emergency threshold (last resort)
COOLDOWN_S=900         # min seconds between FORCED restarts (15 min — a restart storm is worse than transient pressure)
BOOT_GRACE_S=90        # give a booting server this long before reviving
# CRITICAL: outside .next/ — the dev server wipes its dev dir on every boot,
# which destroyed the v2 cooldown file mid-storm (restarts 3-5 min apart).
COOLDOWN_FILE="/home/z/veil-watchdog-cooldown"
LAST_SEEN_PID_FILE="/home/z/veil-watchdog-lastpid"
LAST_SEEN_BOOT=0

# Durable log: dev.log is TRUNCATED by `tee` every time the dev chain
# restarts (the dev script pipes through `tee dev.log`), which wipes
# watchdog events. dev-watchdog.log is append-only and survives every
# restart — it is the authoritative record; the dev.log mirror is
# best-effort context only.
log() {
  echo "[dev-watchdog] $(date -u +%FT%TZ) $*" >> dev-watchdog.log
  echo "[dev-watchdog] $(date -u +%FT%TZ) $*" >> dev.log 2>/dev/null || true
}

# ---- helpers -------------------------------------------------------------
# PIDs of the real server processes. NOTE: comm is truncated to 15 chars
# ("next-server (v1") so pgrep -x does NOT match — must use -f. The [n]
# bracket keeps the pattern from matching this script's own cmdline.
server_pids() { pgrep -f '[n]ext-server' 2>/dev/null; }

# PID holding the :3000 listen socket (kernel truth, immune to HTTP lag).
port3000_pid() {
  ss -tlnp 'sport = :3000' 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

# RSS in kB of a PID from /proc (0 if gone).
pid_rss() {
  [ -r "/proc/$1/status" ] || { echo 0; return; }
  awk '/^VmRSS:/{print $2; exit}' "/proc/$1/status" 2>/dev/null || echo 0
}

# MemAvailable in kB.
mem_available() {
  awk '/^MemAvailable:/{print $2; exit}' /proc/meminfo 2>/dev/null || echo 9999999
}

cooldown_active() {
  [ -f "$COOLDOWN_FILE" ] || return 1
  local last now
  last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
  now=$(date +%s)
  [ $((now - last)) -lt $COOLDOWN_S ]
}

arm_cooldown() { mkdir -p .next/dev; date +%s > "$COOLDOWN_FILE"; }

# Tear down the dev tree bottom-up by PID: next-server(s), the `next dev`
# node wrapper, and the sh -c pipeline wrapper. When `next dev` dies, tee
# sees EOF and the whole bun-run-dev chain exits on its own — no name-
# based pkill needed (no collateral damage to mini-services).
kill_dev_tree() {
  local pids
  pids=$(pgrep -f '[n]ext-server' 2>/dev/null; pgrep -f '[n]ext dev' 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  sleep 3
  # anything still breathing gets SIGKILL
  pids=$(pgrep -f '[n]ext-server' 2>/dev/null; pgrep -f '[n]ext dev' 2>/dev/null)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
}

relaunch_dev() {
  ( setsid bun run dev >> dev.log 2>&1 < /dev/null & )
}

# seconds the dev tree has existed (for boot grace). Falls back from
# next-server to the `next dev` wrapper so an externally-relaunched
# booting tree gets its grace window too. Uses `ps -o etimes` — naive
# /proc/stat field parsing BREAKS here because next-server's comm
# contains spaces+parens ("next-server (v16.1.3)") which shifts every
# field after #2.
server_age() {
  local pid age
  pid=$(pgrep -f '[n]ext-server' | head -1)
  [ -z "$pid" ] && pid=$(pgrep -f '[n]ext dev' | head -1)
  [ -n "$pid" ] || { echo 999999; return; }
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  echo "${age:-999999}"
}

# ---- main loop -----------------------------------------------------------
log "v6.1 armed: heap cap 1664MB | RSS>1760MB → warn-only (gardener compacts) | RSS>2340MB + MemAvail<600MB → planned restart | MemAvail<320MB → emergency | cycle=${CYCLE}s cooldown=${COOLDOWN}s"

TICKS=0
while true; do
  # === 1. dedup: orphan next-server instances are pure memory waste ===
  mapfile -t SPIDS < <(server_pids)
  if [ "${#SPIDS[@]}" -gt 1 ]; then
    KEEP=$(port3000_pid)
    if [ -z "$KEEP" ]; then
      # no socket holder — keep the oldest (it owns the compile cache)
      KEEP="${SPIDS[0]}"
    fi
    for p in "${SPIDS[@]}"; do
      if [ "$p" != "$KEEP" ]; then
        log "duplicate next-server pid=$p found (keeping $KEEP) — killing orphan"
        kill -9 "$p" 2>/dev/null
      fi
    done
  fi

  # === 2. memory guards (the whole point of v2) ===
  MAINPID=$(port3000_pid)
  [ -z "$MAINPID" ] && MAINPID=$(server_pids | head -1)
  if [ -n "$MAINPID" ]; then
    RSS=$(pid_rss "$MAINPID")
    MEMAV=$(mem_available)
    TICKS=$((TICKS + 1))
    if [ "$RSS" -gt "$RSS_LIMIT_KB" ] && [ "$MEMAV" -lt "$PRESSURE_MIN_KB" ] && ! cooldown_active; then
      log "next-server pid=$MAINPID RSS=$((RSS/1024))MB > limit AND MemAvail=$((MEMAV/1024))MB < pressure line — PLANNED restart (real box pressure)"
      arm_cooldown
      kill_dev_tree
      relaunch_dev
      sleep 25   # let it boot before next evaluation
    elif [ "$MEMAV" -lt "$MEMAVAIL_MIN_KB" ] && ! cooldown_active; then
      log "box MemAvailable=$((MEMAV/1024))MB < emergency limit — restarting next-server to free memory"
      arm_cooldown
      kill_dev_tree
      relaunch_dev
      sleep 25
    elif [ "$RSS" -gt "$RSS_WARN_KB" ]; then
      # v4 POLICY: big server + healthy box = NOT an emergency. Log once
      # every ~5 min (every 30th tick) so dev-watchdog.log stays readable.
      if [ $((TICKS % 30)) -eq 1 ]; then
        log "RSS=$((RSS/1024))MB high but MemAvail=$((MEMAV/1024))MB healthy — trusting heap gardener, NO restart (v4 policy)"
      fi
    fi
  fi

  # === 3. revive: only when the port is truly not listening ===
  if [ -z "$(port3000_pid)" ]; then
    AGE=$(server_age)
    if [ "$AGE" -lt "$BOOT_GRACE_S" ] 2>/dev/null; then
      # a young dev tree is still booting/compiling — do not disturb
      :
    else
      # dead or ancient zombie — clean and relaunch
      if pgrep -f '[n]ext-server' >/dev/null 2>&1 || pgrep -f '[n]ext dev' >/dev/null 2>&1; then
        log "port :3000 not listening but dev processes exist (zombie) — killing and relaunching"
        kill_dev_tree
      else
        log "dev server down (port :3000 free) — relaunching"
      fi
      relaunch_dev
      sleep 25
    fi
  fi

  sleep $CYCLE
done
