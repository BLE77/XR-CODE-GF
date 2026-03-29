# Animation Pipeline

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
