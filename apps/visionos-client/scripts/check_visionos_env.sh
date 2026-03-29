#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSET="$ROOT/Assets/Models/anime_girl.usdz"

printf 'visionOS client root: %s\n' "$ROOT"

if [[ -f "$ASSET" ]]; then
  printf 'USDZ asset found: %s\n' "$ASSET"
else
  printf 'USDZ asset missing: %s\n' "$ASSET"
fi

printf '\nChecking xcodebuild...\n'
if xcodebuild -version >/tmp/xr_vision_xcodebuild.txt 2>/tmp/xr_vision_xcodebuild.err; then
  cat /tmp/xr_vision_xcodebuild.txt
else
  cat /tmp/xr_vision_xcodebuild.err
fi

printf '\nRecommended next step:\n'
printf 'Create the visionOS App project in apps/visionos-client/XRCodingAgentVision, then copy in the App/*.swift files and add Assets/Models/anime_girl.usdz to the target\n'
