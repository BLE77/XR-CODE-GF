#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /path/to/model.blend [asset_name]" >&2
  exit 1
fi

SRC="$1"
if [[ ! -f "$SRC" ]]; then
  echo "missing file: $SRC" >&2
  exit 1
fi

case "$SRC" in
  *.blend) ;;
  *)
    echo "expected a .blend file: $SRC" >&2
    exit 1
    ;;
esac

if ! command -v blender >/dev/null 2>&1; then
  echo "blender is required but was not found on PATH" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$ROOT/Assets/Models"
mkdir -p "$DEST_DIR"

MODEL_NAME="${2:-$(basename "${SRC%.blend}")}"
MODEL_NAME="${MODEL_NAME// /_}"
MODEL_NAME="$(printf '%s' "$MODEL_NAME" | tr '[:upper:]' '[:lower:]')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

OUT_USDZ="$TMP_DIR/$MODEL_NAME.usdz"
DEST="$DEST_DIR/$MODEL_NAME.usdz"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLENDER_SCRIPT="$SCRIPT_DIR/blender_export_avatar.py"

blender --background "$SRC" --python "$BLENDER_SCRIPT" -- \
  --output "$OUT_USDZ" \
  --model-name "$MODEL_NAME"

cp "$OUT_USDZ" "$DEST"

printf 'exported model: %s\n' "$DEST"
printf 'modelName to use in the app: %s\n' "$MODEL_NAME"
printf '\nNext steps:\n'
printf '1. Add a BundledModel entry for %s in App/ModelCatalog.swift\n' "$MODEL_NAME"
printf '2. Run xcodegen generate in apps/visionos-client/XRCodingAgentVision\n'
printf '3. Relaunch the visionOS app from Xcode\n'
