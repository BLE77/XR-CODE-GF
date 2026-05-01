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

- state intent smoothing for idle, listening, thinking, speaking, alert, and
  ready states
- lightweight root trajectory offsets for posture, lean, and presence
- adaptive clip speed/crossfade values for the existing Yuki BVH clips
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

## Next Steps

Useful extensions would be:

- apply the foot lock signals to a real two-bone leg IK pass
- add debug visualization for root trajectory, measured floor bounds, and foot
  contact weights
- build a separate sandbox before introducing any learned model runtime
- train or author our own model/assets if we decide to pursue neural motion
  matching later
