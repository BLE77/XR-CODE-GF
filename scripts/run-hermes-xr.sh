#!/bin/zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/mac-companion"

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

load_local_env

CONTROL_HOST="${XR_AGENT_CONTROL_HOST:-127.0.0.1}"
CONTROL_PORT="${XR_AGENT_CONTROL_PORT:-8766}"
REPO_PATH="$(default_repo_path)"

if ! command -v hermes >/dev/null 2>&1; then
  echo "Hermes CLI is not on PATH." >&2
  exit 1
fi

if ! nc -z "$CONTROL_HOST" "$CONTROL_PORT" >/dev/null 2>&1; then
  echo "XR companion control bridge is not reachable at $CONTROL_HOST:$CONTROL_PORT." >&2
  echo "Start the Mac companion first with: ./scripts/run-mac-companion.sh" >&2
  exit 1
fi

export XR_AGENT_CONTROL_HOST="$CONTROL_HOST"
export XR_AGENT_CONTROL_PORT="$CONTROL_PORT"

cd "$REPO_PATH"
exec hermes -t xr-managed-sessions "$@"
