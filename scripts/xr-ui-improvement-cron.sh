#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/7upa/Desktop/xr-coding-agent"
CODEX="/Users/7upa/.local/bin/codex"
LOG_DIR="$ROOT/.codex-cron"
LOCK_DIR="$LOG_DIR/xr-ui-improvement.lock"
RUN_LOG="$LOG_DIR/xr-ui-improvement.log"
LAST_MESSAGE="$LOG_DIR/xr-ui-improvement-last.md"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf '[%s] previous run still active; skipping\n' "$(date -Is)" >> "$RUN_LOG"
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

{
  printf '\n[%s] starting XR UI improvement check\n' "$(date -Is)"
  "$CODEX" exec \
    --cd "$ROOT" \
    --sandbox workspace-write \
    --ask-for-approval never \
    --search \
    --output-last-message "$LAST_MESSAGE" \
    'Every 30 minutes ask: "How can we improve the current system?" If there is a concrete, low-risk plan, implement it and verify it. If no clear plan exists, research and debug the project to find the next improvement. Primary focus: the actual XR UI in apps/metaquest-client/src/ImmersiveHermesStage.tsx. Improve panel structure, readability, minimize/hide controls, movable/recentered panels, and visibility of launched code/session context. Do not revert unrelated dirty files. Keep edits scoped, run npm run build in apps/metaquest-client when code changes, and leave a concise progress summary.'
  printf '[%s] completed XR UI improvement check\n' "$(date -Is)"
} >> "$RUN_LOG" 2>&1
