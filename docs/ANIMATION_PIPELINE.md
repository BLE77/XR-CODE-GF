# Animation Pipeline

## Yuki Quest Animation Pipeline

Yuki's Quest Browser runtime currently loads BVH clips from:

```text
apps/metaquest-client/public/animations/yuki/prototype/
```

The runtime now has slots for:

- walk start
- walk loop
- walk stop
- turn left
- turn right
- sit down
- seated idle
- stand up
- talking gesture

Fallback placeholders can still be regenerated with:

```bash
npm run generate:yuki-animations --prefix apps/metaquest-client
```

The shipped prototype motion set should be built from downloaded animation
sources instead:

```bash
npm run retarget:yuki-animations --prefix apps/metaquest-client
```

That command downloads source assets into the ignored
`apps/metaquest-client/.animation-sources/` cache, exports source actions through
Blender, and writes Yuki-compatible BVH clips into the runtime prototype folder.
The current baseline uses Quaternius CC0 clips for walk/sit/talk and CMU-derived
mocap for turn/stop coverage.

Production sources:

- Quaternius Universal Animation Library: CC0, strongest legal/default source.
  Current mappings: `Walk_Formal_Loop`, `Walk_Loop`, `Sitting_Enter`,
  `Sitting_Exit`, `Sitting_Idle_Loop`, and `Idle_Talking_Loop`.
- CMU/RancidMilk/Hugging Face FBX conversion: best mocap coverage, document CMU
  attribution and redistribution limits. Current mappings: `16_33.fbx`,
  `69_16.fbx`, and `69_18.fbx`.
- AI4AnimationPy: useful offline tooling/reference for import, motion processing,
  contacts, root trajectories, and IK; do not bundle its CC BY-NC 4.0 code/assets
  into the shipped runtime without license review.

Retarget flow:

1. Download source FBX/GLB/BVH clips.
2. Export source actions to BVH with Blender.
3. Retarget source rotations/root motion onto Yuki's existing BVH hierarchy.
4. Replace the matching prototype clip.
5. Keep source asset credits and license terms beside the shipped clips.

Quest safety checks before shipping a regenerated set:

- CMU BVHs exported through Blender use source Z for vertical travel and source
  Y for horizontal trajectory. Do not map CMU source Y directly to Yuki root
  height, or turn/stop clips can hop vertically.
- Sit/stand transitions must land exactly on the seated/standing base poses used
  by adjacent clips. Check `sit_down -> seated_idle`, `seated_idle -> stand_up`,
  and `stand_up -> standing idle` endpoint deltas after every retarget tune.
- Looping walk/talk/idle clips should have near-zero first/last root deltas and
  no single-frame root-height spikes.

Known good mocap candidate URLs from the CMU/HF mirror use this base path:

```text
https://huggingface.co/datasets/gbionics/cmu-fbx/resolve/main/animations/
```

Candidate clips:

- `69_01.fbx`, `07_01.fbx`: walk candidates
- `69_16.fbx`, `69_18.fbx`, `69_20.fbx`, `69_24.fbx`: turn candidates
- `131_01.fbx`, `104_14.fbx`, `16_33.fbx`: start/stop candidates
- `143_18.fbx`, `13_01.fbx`, `14_31.fbx`: sit/stand candidates
- `13_04.fbx`, `75_19.fbx`, `114_05.fbx`: seated idle candidates
- `18_08.fbx`, `18_09.fbx`, `22_21.fbx`: talking gesture candidates

Video-to-animation is possible, but it should be a second production path after
the BVH/FBX retarget loop is stable. Use video pose extraction to produce an
intermediate BVH/FBX, then run the same Blender retarget/bake/export step above.
Do not feed unverified generated motion straight into Quest; always check feet,
root height, sit alignment, and clip loop seams first.

## VisionOS Vamp Animation Pipeline

`Vamp` now supports a Blender-side retarget flow for dropped humanoid animation
files.

## Current Scope

- Input format: `FBX`
- Source expectation: humanoid / Mixamo-style bone names
- Target rig: the BlenderKit `Vampire Girl` control rig
- Outputs:
  - a live retargeted walk clip (`.usdz`)
  - four baked fallback pose assets (`.usdz`)

## One-Command Import

```bash
/Users/7upa/Desktop/xr-coding-agent/apps/visionos-client/scripts/rig_animation_to_vamp.sh /absolute/path/to/animation.fbx
```

That overwrites the built-in `Vamp` walk set used by the app:

- `apps/visionos-client/Assets/Models/vamp_walk.usdz`
- `apps/visionos-client/Assets/Models/vamp_step_a.usdz`
- `apps/visionos-client/Assets/Models/vamp_step_b.usdz`
- `apps/visionos-client/Assets/Models/vamp_step_c.usdz`
- `apps/visionos-client/Assets/Models/vamp_step_d.usdz`

## Named Motion Packs

```bash
/Users/7upa/Desktop/xr-coding-agent/apps/visionos-client/scripts/rig_animation_to_vamp.sh /absolute/path/to/animation.fbx spooky_walk
```

That exports a named motion pack into:

- `apps/visionos-client/Assets/GeneratedAnimations/vamp_spooky_walk.usdz`
- `apps/visionos-client/Assets/GeneratedAnimations/vamp_spooky_walk_step_a.usdz`
- `apps/visionos-client/Assets/GeneratedAnimations/vamp_spooky_walk_step_b.usdz`
- `apps/visionos-client/Assets/GeneratedAnimations/vamp_spooky_walk_step_c.usdz`
- `apps/visionos-client/Assets/GeneratedAnimations/vamp_spooky_walk_step_d.usdz`

## Rebuild The App

After importing a new built-in walk set, rebuild the visionOS app:

```bash
cd /Users/7upa/Desktop/xr-coding-agent/apps/visionos-client/XRCodingAgentVision
xcodegen generate
xcodebuild -project XRCodingAgentVision.xcodeproj -scheme XRCodingAgentVision -destination "platform=visionOS Simulator,name=Apple Vision Pro" build
```

## Notes

- The retarget path currently drives `Vamp`'s FK control rig, not the deform
  bones directly.
- The app now prefers the live `vamp_walk.usdz` animation clip when present and
  only falls back to baked pose stepping if no walk clip exists.
- This first pass is aimed at dropped humanoid locomotion clips. More exotic
  rigs or non-humanoid animations will need a richer mapping layer.
