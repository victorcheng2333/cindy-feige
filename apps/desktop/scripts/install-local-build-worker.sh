#!/bin/bash
# Replacement worker for install-local-build.mjs. install-local-build.mjs wraps
# it in a throwaway app bundle and starts it through LaunchServices, so it is
# a child of launchd rather than of Cindy and survives Cindy quitting. It uses
# absolute system paths only. Arguments are passed by install-local-build.mjs.
set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
NEW_APP="$1"; TARGET="$2"; EXE="$3"; DELAY="$4"; STATE="$5"; STAGING="$6"
LOG="$STATE/install.log"; STATUS="$STATE/status.json"; LOCK="$STATE/worker.pid"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$STATE/backups/Cindy-$TS.app"
MAIN_EXE="$TARGET/Contents/MacOS/$EXE"
QUIT_TIMEOUT=60     # seconds Cindy gets to finish its graceful quit
START_TIMEOUT=60    # seconds the new app gets to appear
STAY_UP=10          # seconds the new app must keep running

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
status() { printf '{"state":"%s","message":"%s","at":"%s","app":"%s","backup":"%s"}\n' "$1" "$2" "$(date '+%F %T')" "$TARGET" "$BACKUP" > "$STATUS"; }
finish() { rm -f "$LOCK"; rm -rf "$STAGING"; exit "$1"; }
main_pids() { ps -axo pid=,comm= | awk -v p="$MAIN_EXE" '{ pid=$1; $1=""; sub(/^ +/, ""); if ($0 == p) print pid }'; }
# Poll every 0.5s; argument is a timeout in seconds.
wait_gone() { local i; for ((i = 0; i < $1 * 2; i++)); do [ -z "$(main_pids)" ] && return 0; sleep 0.5; done; return 1; }
wait_up() {
  local i
  for ((i = 0; i < START_TIMEOUT * 2; i++)); do [ -n "$(main_pids)" ] && break; sleep 0.5; done
  [ -n "$(main_pids)" ] || return 1
  for ((i = 0; i < STAY_UP * 2; i++)); do [ -z "$(main_pids)" ] && return 1; sleep 0.5; done
  return 0
}

# A swap must never stop halfway; record stray signals instead of dying.
trap 'log "received SIGHUP, ignored"' HUP
trap 'log "received SIGINT, ignored"' INT
trap 'log "received SIGTERM, ignored"' TERM
trap 'log "worker exit code=$?"' EXIT

echo $$ > "$LOCK"
log "worker start: pid=$$ ppid=$PPID new=$NEW_APP target=$TARGET delay=${DELAY}s"
status waiting "等待 ${DELAY} 秒后退出 Cindy"
sleep "$DELAY"

PIDS="$(main_pids)"
if [ -n "$PIDS" ]; then
  log "sending SIGTERM to $PIDS"
  status quitting "正在退出 Cindy"
  kill -TERM $PIDS 2>/dev/null
  if ! wait_gone "$QUIT_TIMEOUT"; then
    log "Cindy did not exit within ${QUIT_TIMEOUT}s; nothing changed"
    status failed "Cindy ${QUIT_TIMEOUT} 秒内没有退出，未做任何替换"
    finish 1
  fi
  log "Cindy exited"
  sleep 1
else
  log "Cindy is not running"
fi

mkdir -p "$STATE/backups"
if [ -e "$TARGET" ]; then
  if ! mv "$TARGET" "$BACKUP"; then
    log "backup move failed; reopening old app"
    status failed "备份旧版失败，未做任何替换"
    open "$TARGET"; finish 1
  fi
  log "old app moved to $BACKUP"
fi
if ! mv "$NEW_APP" "$TARGET"; then
  log "moving new app failed; restoring backup"
  [ -e "$BACKUP" ] && mv "$BACKUP" "$TARGET"
  status rolled_back "放入新版失败，已恢复旧版"
  open "$TARGET"; finish 1
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null

log "opening new app"
status starting "正在启动新版"
open "$TARGET"
if wait_up; then
  log "new app is running"
  status ok "新版已启动"
  # Keep the two newest backups.
  ls -1dt "$STATE"/backups/Cindy-*.app 2>/dev/null | tail -n +3 | while IFS= read -r old; do rm -rf "$old"; done
  finish 0
fi

log "new app did not stay up; rolling back"
PIDS="$(main_pids)"; [ -n "$PIDS" ] && { kill -TERM $PIDS 2>/dev/null; wait_gone 30; }
if [ -e "$BACKUP" ]; then
  mv "$TARGET" "$STATE/failed-$TS.app" && mv "$BACKUP" "$TARGET"
  open "$TARGET"
  status rolled_back "新版没能正常启动，已恢复旧版；失败的新版留在 $STATE/failed-$TS.app"
else
  status failed "新版没能正常启动，且没有可恢复的旧版"
fi
finish 1
