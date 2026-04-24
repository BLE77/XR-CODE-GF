#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/mac-companion"
EVENT_HOST="${XR_AGENT_EVENT_HOST:-0.0.0.0}"
EVENT_PORT="${XR_AGENT_EVENT_PORT:-8765}"
XR_AGENT_OPEN_DEBUG_TAILS="${XR_AGENT_OPEN_DEBUG_TAILS:-1}"
LISTENER_PID=""

export PYTHONPATH="$APP_DIR/src${PYTHONPATH:+:$PYTHONPATH}"
export XR_AGENT_OPEN_DEBUG_TAILS

load_local_env() {
  local env_file
  for env_file in "$ROOT_DIR/.env.local" "$APP_DIR/.env.local"; do
    if [[ -f "$env_file" ]]; then
      set -a
      source "$env_file"
      set +a
    fi
  done
}

load_local_env

looks_like_project_root() {
  local candidate="$1"
  [[ -d "$candidate" ]] || return 1
  [[ -e "$candidate/.git" ]] && return 0
  [[ -e "$candidate/pyproject.toml" ]] && return 0
  [[ -e "$candidate/package.json" ]] && return 0
  [[ -e "$candidate/Cargo.toml" ]] && return 0
  [[ -e "$candidate/go.mod" ]] && return 0
  [[ -e "$candidate/requirements.txt" ]] && return 0

  local child
  setopt local_options null_glob
  for child in "$candidate"/*.xcodeproj "$candidate"/*.xcworkspace; do
    [[ -e "$child" ]] && return 0
  done
  return 1
}

default_repo_path() {
  if [[ -n "${XR_AGENT_REPO_PATH:-}" ]]; then
    printf '%s\n' "$XR_AGENT_REPO_PATH"
    return
  fi

  if looks_like_project_root "$PWD"; then
    printf '%s\n' "$PWD"
    return
  fi

  printf '%s\n' "$ROOT_DIR"
}

existing_listener() {
  { lsof -tiTCP:"$EVENT_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1; } || true
}

stop_existing_companion() {
  LISTENER_PID="$(existing_listener)"
  if [[ -z "$LISTENER_PID" ]]; then
    return
  fi

  local command
  command="$(ps -p "$LISTENER_PID" -o command= 2>/dev/null || true)"
  if [[ "$command" != *"xr_agent.main"* ]]; then
    echo "Port $EVENT_PORT is already in use by another process:" >&2
    echo "$command" >&2
    exit 1
  fi

  echo "Restarting existing XR companion on port $EVENT_PORT (PID $LISTENER_PID)..."
  kill "$LISTENER_PID"
  for _ in {1..50}; do
    if ! kill -0 "$LISTENER_PID" 2>/dev/null; then
      LISTENER_PID=""
      return
    fi
    sleep 0.1
  done

  echo "Existing XR companion did not stop cleanly; forcing it closed..." >&2
  kill -9 "$LISTENER_PID" 2>/dev/null || true
  LISTENER_PID=""
}

if [[ $# -eq 0 ]]; then
  stop_existing_companion
  exec python3 -m xr_agent.main --server --repo "$(default_repo_path)" --event-host "$EVENT_HOST" --event-port "$EVENT_PORT"
fi

if [[ " $* " != *" --once "* && " $* " != *" --server "* ]]; then
  stop_existing_companion
  exec python3 -m xr_agent.main --server --event-host "$EVENT_HOST" --event-port "$EVENT_PORT" "$@"
fi

exec python3 -m xr_agent.main --event-host "$EVENT_HOST" --event-port "$EVENT_PORT" "$@"
