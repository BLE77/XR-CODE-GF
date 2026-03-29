#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /path/to/model.usdz [asset_name]" >&2
  exit 1
fi

SRC="$1"
if [[ ! -f "$SRC" ]]; then
  echo "missing file: $SRC" >&2
  exit 1
fi

case "$SRC" in
  *.usdz) ;;
  *)
    echo "expected a .usdz file: $SRC" >&2
    exit 1
    ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$ROOT/Assets/Models"
mkdir -p "$DEST_DIR"

BASENAME="${2:-$(basename "$SRC")}" 
if [[ "$BASENAME" != *.usdz ]]; then
  BASENAME="$BASENAME.usdz"
fi

DEST="$DEST_DIR/$BASENAME"
cp "$SRC" "$DEST"

MODEL_NAME="${BASENAME%.usdz}"

printf 'staged model: %s\n' "$DEST"
printf 'modelName to use in ContentView.swift: %s\n' "$MODEL_NAME"
printf '\nNext steps:\n'
printf '1. Add %s to the Xcode target\n' "$DEST"
printf '2. Update ModelRealityView(modelName: "%s") in App/ContentView.swift if needed\n' "$MODEL_NAME"
printf '3. Run the visionOS app on simulator or Vision Pro\n'
