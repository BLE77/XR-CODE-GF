# Yuki Motion Engine

The Meta Quest client uses a small original runtime in
`apps/metaquest-client/src/lib/yukiMotionEngine.ts` to make Yuki's XR body feel
more intentional without depending on WebGPU inference or third-party neural
motion assets.

## Why This Exists

`ai4anim-webgpu` is a useful reference for browser-side character motion:
trajectory smoothing, contact-aware movement, pose sequence blending, and foot
locking. It is not a direct fit for this project because it expects a WebGPU
renderer, its own skeleton/model bundles, and non-commercial upstream assets.

`facebookresearch/ai4animationpy` is useful on the research/training side. It
has Python/PyTorch tooling for motion processing, inference, IK, contacts, root
trajectories, and mocap import. We should treat it as an offline/native
reference, not as code to bundle into the Quest browser runtime. It is also
CC BY-NC 4.0, so direct product reuse needs licensing review.

This runtime keeps the parts that match our current app:

- state intent smoothing for idle, listening, thinking, speaking, alert, ready,
  walk, turn, sit-down, seated, and stand-up states
- lightweight root trajectory offsets for posture, lean, and presence
- adaptive clip speed/crossfade values for the Yuki BVH clip set
- contact-style foot lock signals for future IK/debug visualization
- floor clearance and response values consumed by the XR avatar grounding pass

## Current Integration

`ImmersiveHermesStage.tsx` owns the actual Three.js scene. Each frame it:

1. derives Yuki's animation state from Hermes and speech state
2. updates the `YukiMotionEngine`
3. applies the generated root offset/rotation to the avatar root
4. drives BVH clip timing and crossfades from the motion frame
5. runs a grounding pass so animated mesh bounds stay above the XR floor

The implementation is intentionally deterministic and small. It should be safe
for Quest Browser because it stays on the existing WebGL/WebXR render path.

## Animation Clips

The Quest app loads Yuki-skeleton BVH clips from:

```text
apps/metaquest-client/public/animations/yuki/prototype/
```

Current runtime slots:

- `neutral_idle.bvh`
- `curiosity.bvh`
- `confusion.bvh`
- `action_attention_seeking.bvh`
- `walk_start.bvh`
- `walk_forward.bvh`
- `walk_stop.bvh`
- `turn_left.bvh`
- `turn_right.bvh`
- `sit_down.bvh`
- `seated_idle.bvh`
- `stand_up.bvh`
- `talk_gesture.bvh`

The generated transition/locomotion clips are only a fallback on Yuki's existing
BVH skeleton. Regenerate the fallback set with:

```bash
npm run generate:yuki-animations --prefix apps/metaquest-client
```

The active prototype set is now built from real source clips:

```bash
npm run retarget:yuki-animations --prefix apps/metaquest-client
```

That writes Quaternius CC0 clips for walk/sit/talk and CMU-derived mocap clips
for turn/stop coverage into the same runtime folder. Source downloads stay in
the ignored `.animation-sources/` cache.

## Next Steps

Useful extensions would be:

- inspect the retargeted clips in-headset and tune the per-bone scale/signs
- add a locomotion state machine that drives walk/turn/sit/stand from targets
- apply the foot lock signals to a stronger two-bone leg IK pass
- add debug visualization for root trajectory, measured floor bounds, and foot
  contact weights
- build a separate sandbox before introducing any learned model runtime
- train or author our own model/assets if we decide to pursue neural motion
  matching later
