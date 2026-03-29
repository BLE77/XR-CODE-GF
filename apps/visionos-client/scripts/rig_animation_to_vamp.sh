#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 /path/to/animation.fbx [slot-name]" >&2
  exit 1
fi

ANIMATION_FILE="$1"
if [[ ! -f "$ANIMATION_FILE" ]]; then
  echo "missing file: $ANIMATION_FILE" >&2
  exit 1
fi

if ! command -v blender >/dev/null 2>&1; then
  echo "blender is required but was not found on PATH" >&2
  exit 1
fi

SLOT_NAME="${2:-walk}"
SLOT_NAME="${SLOT_NAME// /_}"
SLOT_NAME="$(printf '%s' "$SLOT_NAME" | tr '[:upper:]' '[:lower:]')"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BLEND_SOURCE="/Users/7upa/blenderkit_data/models/vampire-girl_0dc305f9-1cf0-4fc7-be55-261dcd784673/vampire-girl_2K_a3ead337-5d1c-48dd-88c2-b882bdb05494.blend"
RETARGET_SCRIPT="$SCRIPT_DIR/blender_retarget_animation.py"
MODELS_DIR="$ROOT/Assets/Models"
GENERATED_DIR="$ROOT/Assets/GeneratedAnimations"

mkdir -p "$MODELS_DIR" "$GENERATED_DIR"

if [[ "$SLOT_NAME" == "walk" ]]; then
  CLIP_OUT="$MODELS_DIR/vamp_walk.usdz"
  STEP_PREFIX="$MODELS_DIR/vamp_step"
else
  CLIP_OUT="$GENERATED_DIR/vamp_${SLOT_NAME}.usdz"
  STEP_PREFIX="$GENERATED_DIR/vamp_${SLOT_NAME}_step"
fi

blender --background "$BLEND_SOURCE" --python-exit-code 1 --python "$RETARGET_SCRIPT" -- \
  --animation-file "$ANIMATION_FILE" \
  --output "$CLIP_OUT" \
  --model-name "$(basename "${CLIP_OUT%.usdz}")" \
  --mode action \
  --action-name "Codex$(printf '%s' "$SLOT_NAME" | tr '[:lower:]' '[:upper:]')"

for index in 0 1 2 3; do
  case "$index" in
    0) percent="0.00"; suffix="a" ;;
    1) percent="0.25"; suffix="b" ;;
    2) percent="0.50"; suffix="c" ;;
    3) percent="0.75"; suffix="d" ;;
  esac

  blender --background "$BLEND_SOURCE" --python-exit-code 1 --python "$RETARGET_SCRIPT" -- \
    --animation-file "$ANIMATION_FILE" \
    --output "${STEP_PREFIX}_${suffix}.usdz" \
    --model-name "$(basename "${STEP_PREFIX}_${suffix}")" \
    --mode pose \
    --sample-percent "$percent"
done

printf 'Retargeted animation: %s\n' "$ANIMATION_FILE"
printf 'Clip asset: %s\n' "$CLIP_OUT"
printf 'Pose assets:\n'
printf '  %s_a.usdz\n' "$STEP_PREFIX"
printf '  %s_b.usdz\n' "$STEP_PREFIX"
printf '  %s_c.usdz\n' "$STEP_PREFIX"
printf '  %s_d.usdz\n' "$STEP_PREFIX"
printf '\nIf you changed built-in walk assets, rebuild the app:\n'
printf '  cd %s/XRCodingAgentVision && xcodegen generate && xcodebuild -project XRCodingAgentVision.xcodeproj -scheme XRCodingAgentVision -destination \"platform=visionOS Simulator,name=Apple Vision Pro\" build\n' "$ROOT"
