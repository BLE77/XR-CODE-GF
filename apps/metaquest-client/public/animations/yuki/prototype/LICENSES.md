# Yuki Prototype Animation Sources

The runtime BVH files in this folder are retargeted onto Yuki's prototype BVH
skeleton.

## Quaternius CC0 Clips

The primary locomotion, sitting, and talking clips are derived from Quaternius'
Universal Animation Library Standard pack:

- Source: `https://quaternius.com/packs/universalanimationlibrary.html`
- Download mirror used by the tooling:
  `https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip`
- License: CC0 1.0 Universal public domain dedication

Clip mapping:

- `walk_start.bvh`: `Walk_Formal_Loop`
- `walk_forward.bvh`: `Walk_Loop`
- `sit_down.bvh`: `Sitting_Enter`
- `seated_idle.bvh`: `Sitting_Idle_Loop`
- `stand_up.bvh`: `Sitting_Exit`
- `talk_gesture.bvh`: `Idle_Talking_Loop`

## CMU-Derived Mocap Clips

The turn and walk-stop coverage is derived from the CMU Graphics Lab Motion
Capture Database via the `gbionics/cmu-fbx` Hugging Face mirror.

CMU's published terms allow copying, modifying, and redistributing the motion data, including in commercial products, but not directly reselling the motion data itself. Please keep this notice with redistributed clips and credit `mocap.cs.cmu.edu`.

Acknowledgement:

> The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

Clip mapping:

- `walk_stop.bvh`: `16_33.fbx` (`slow walk, stop`)
- `turn_left.bvh`: `69_18.fbx` (`turn in place`, opposite direction)
- `turn_right.bvh`: `69_16.fbx` (`turn in place`)
