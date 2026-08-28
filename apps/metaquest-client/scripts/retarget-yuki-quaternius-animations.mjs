import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const animationDir = path.join(rootDir, "public", "animations", "yuki", "prototype");
const sourceDir = path.join(rootDir, ".animation-sources", "quaternius");
const zipPath = path.join(sourceDir, "universal_animation_librarystandard.zip");
const extractDir = path.join(sourceDir, "extracted");
const glbPath = path.join(extractDir, "Animation Library[Standard]", "Godot", "AnimationLibrary_Godot_Standard.glb");
const convertedDir = path.join(sourceDir, "bvh");
const targetReferencePath = path.join(animationDir, "neutral_idle.bvh");
const zipUrl = "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip";
const seatedRootYOffset = -3.8;
const seatedRootZOffset = -0.32;

const clips = [
  {
    output: "walk_start.bvh",
    action: "Walk_Formal_Loop",
    label: "formal walk loop",
    rotationScale: 0.72,
    rootHorizontalScale: 1.1,
    rootVerticalScale: 4.8,
  },
  {
    output: "walk_forward.bvh",
    action: "Walk_Loop",
    label: "walk loop",
    rotationScale: 0.74,
    rootHorizontalScale: 1.1,
    rootVerticalScale: 4.8,
  },
  {
    output: "sit_down.bvh",
    action: "Sitting_Enter",
    label: "sitting enter",
    rotationScale: 1,
    rootYOffset: [0, -2.19],
    rootZOffset: [0, -0.52],
    rootHorizontalScale: 0.8,
    rootVerticalScale: 4.8,
    endPose: "seated",
    endPoseBlendStart: 0.6,
  },
  {
    output: "seated_idle.bvh",
    action: "Sitting_Idle_Loop",
    label: "sitting idle loop",
    basePose: "seated",
    rotationScale: 0.78,
    rootHorizontalScale: 0.4,
    rootVerticalScale: 2.4,
  },
  {
    output: "stand_up.bvh",
    action: "Sitting_Exit",
    label: "sitting exit",
    basePose: "seated",
    rotationScale: 1,
    rootYOffset: [0, 2.19],
    rootZOffset: [0, 0.52],
    rootHorizontalScale: 0.8,
    rootVerticalScale: 4.8,
    endPose: "standing",
    endPoseBlendStart: 0.55,
  },
  {
    output: "talk_gesture.bvh",
    action: "Idle_Talking_Loop",
    label: "standing talking loop",
    rotationScale: 0.82,
    rootHorizontalScale: 0.5,
    rootVerticalScale: 3,
  },
];

const retargetMap = {
  hips: { source: "DEF-hips", rotationScale: 0.44 },
  spine: { source: "DEF-spine.001", rotationScale: 0.5 },
  chest: { source: "DEF-spine.002", rotationScale: 0.5 },
  upperChest: { source: "DEF-spine.003", rotationScale: 0.55 },
  neck: { source: "DEF-neck", rotationScale: 0.5 },
  head: { source: "DEF-head", rotationScale: 0.55 },
  leftShoulder: { source: "DEF-shoulder.L", rotationScale: 0.55 },
  leftUpperArm: { source: "DEF-upper_arm.L", rotationScale: 0.7 },
  leftLowerArm: { source: "DEF-forearm.L", rotationScale: 0.78 },
  leftHand: { source: "DEF-hand.L", rotationScale: 0.45 },
  rightShoulder: { source: "DEF-shoulder.R", rotationScale: 0.55 },
  rightUpperArm: { source: "DEF-upper_arm.R", rotationScale: 0.7 },
  rightLowerArm: { source: "DEF-forearm.R", rotationScale: 0.78 },
  rightHand: { source: "DEF-hand.R", rotationScale: 0.45 },
  leftUpperLeg: { source: "DEF-thigh.L", rotationScale: 0.88 },
  leftLowerLeg: { source: "DEF-shin.L", rotationScale: 0.9 },
  leftFoot: { source: "DEF-foot.L", rotationScale: 0.82 },
  leftToes: { source: "DEF-toe.L", rotationScale: 0.55 },
  rightUpperLeg: { source: "DEF-thigh.R", rotationScale: 0.88 },
  rightLowerLeg: { source: "DEF-shin.R", rotationScale: 0.9 },
  rightFoot: { source: "DEF-foot.R", rotationScale: 0.82 },
  rightToes: { source: "DEF-toe.R", rotationScale: 0.55 },
};

const sourceRotationAxis = {
  Xrotation: "Xrotation",
  Yrotation: "Zrotation",
  Zrotation: "Yrotation",
};

function parseBvh(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const motionIndex = text.indexOf("MOTION");
  if (motionIndex < 0) {
    throw new Error(`Could not find MOTION in ${filePath}`);
  }

  const hierarchy = text.slice(0, motionIndex).trimEnd();
  const lines = text.slice(motionIndex).split(/\r?\n/);
  const frameTimeLineIndex = lines.findIndex((line) => line.startsWith("Frame Time:"));
  if (frameTimeLineIndex < 0) {
    throw new Error(`Could not parse MOTION header in ${filePath}`);
  }

  const frameTime = Number.parseFloat(lines[frameTimeLineIndex].split(":")[1]);
  const frames = lines
    .slice(frameTimeLineIndex + 1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).map(Number));

  const channels = [];
  const stack = [];
  for (const rawLine of hierarchy.split(/\r?\n/)) {
    const line = rawLine.trim();
    const joint = line.match(/^(ROOT|JOINT)\s+(\S+)/);
    if (joint) {
      stack.push(joint[2]);
      continue;
    }
    if (line === "End Site") {
      stack.push(null);
      continue;
    }
    if (line === "}") {
      stack.pop();
      continue;
    }
    const channel = line.match(/^CHANNELS\s+(\d+)\s+(.+)$/);
    if (channel) {
      const bone = [...stack].reverse().find(Boolean);
      if (!bone) {
        throw new Error(`Could not associate channel with a BVH bone in ${filePath}`);
      }
      for (const name of channel[2].trim().split(/\s+/)) {
        channels.push({ bone, name });
      }
    }
  }

  const invalidFrame = frames.find((frame) => frame.length !== channels.length);
  if (invalidFrame) {
    throw new Error(
      `Parsed ${channels.length} channels but found a frame with ${invalidFrame.length} values in ${filePath}.`,
    );
  }

  return {
    hierarchy,
    frameTime,
    channels,
    frames,
    channelIndex: makeChannelIndex(channels),
  };
}

function makeChannelIndex(channels) {
  const index = new Map();
  channels.forEach((channel, channelIndex) => {
    index.set(`${channel.bone}.${channel.name}`, channelIndex);
  });
  return index;
}

function valueAt(frame, bvh, bone, channel, fallback = 0) {
  const index = bvh.channelIndex.get(`${bone}.${channel}`);
  return index === undefined ? fallback : frame[index] ?? fallback;
}

function setValue(frame, bvh, bone, channel, value) {
  const index = bvh.channelIndex.get(`${bone}.${channel}`);
  if (index !== undefined && Number.isFinite(value)) {
    frame[index] = value;
  }
}

function addValue(frame, bvh, bone, channel, value) {
  const index = bvh.channelIndex.get(`${bone}.${channel}`);
  if (index !== undefined && Number.isFinite(value)) {
    frame[index] += value;
  }
}

function addRot(frame, target, bone, { x = 0, y = 0, z = 0 }) {
  addValue(frame, target, bone, "Xrotation", x);
  addValue(frame, target, bone, "Yrotation", y);
  addValue(frame, target, bone, "Zrotation", z);
}

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function smoothstep(edge0, edge1, value) {
  if (value <= edge0) {
    return 0;
  }
  if (value >= edge1) {
    return 1;
  }
  const t = (value - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}

function blendFrames(frame, targetFrame, strength) {
  if (strength <= 0) {
    return frame;
  }
  return frame.map((value, index) => {
    const targetValue = targetFrame[index];
    return Number.isFinite(targetValue) ? lerp(value, targetValue, strength) : value;
  });
}

function makeSeatedBase(target) {
  const frame = [...target.frames[0]];
  addValue(frame, target, "hips", "Yposition", seatedRootYOffset);
  addValue(frame, target, "hips", "Zposition", seatedRootZOffset);
  addRot(frame, target, "hips", { x: -6 });
  addRot(frame, target, "spine", { x: -6 });
  addRot(frame, target, "chest", { x: -4 });
  addRot(frame, target, "upperChest", { x: -2 });
  addRot(frame, target, "head", { x: 2 });
  addRot(frame, target, "leftUpperLeg", { x: -64, y: 7, z: -5 });
  addRot(frame, target, "leftLowerLeg", { x: 72, z: 4 });
  addRot(frame, target, "leftFoot", { x: -10, y: 1, z: 1 });
  addRot(frame, target, "leftToes", { x: -5 });
  addRot(frame, target, "rightUpperLeg", { x: -64, y: -7, z: 5 });
  addRot(frame, target, "rightLowerLeg", { x: 72, z: -4 });
  addRot(frame, target, "rightFoot", { x: -10, y: -1, z: -1 });
  addRot(frame, target, "rightToes", { x: -5 });
  addRot(frame, target, "leftUpperArm", { x: -18, y: 8, z: -30 });
  addRot(frame, target, "leftLowerArm", { x: -38, y: 3, z: -8 });
  addRot(frame, target, "rightUpperArm", { x: -18, y: -8, z: 30 });
  addRot(frame, target, "rightLowerArm", { x: -38, y: -3, z: 8 });
  return frame;
}

function poseFrame(target, poseName) {
  if (poseName === "seated") {
    return makeSeatedBase(target);
  }
  if (poseName === "standing") {
    return target.frames[0];
  }
  return null;
}

function retargetClip(target, source, clip) {
  const sourceBase = source.frames[0];
  const targetBase = clip.basePose === "seated" ? makeSeatedBase(target) : target.frames[0];
  const endPose = poseFrame(target, clip.endPose);
  const rootYOffset = clip.rootYOffset ?? [0, 0];
  const rootZOffset = clip.rootZOffset ?? [0, 0];
  const rootHorizontalScale = clip.rootHorizontalScale ?? 1;
  const rootVerticalScale = clip.rootVerticalScale ?? 4;

  return source.frames.map((sourceFrame, frameIndex) => {
    const t = source.frames.length <= 1 ? 0 : frameIndex / (source.frames.length - 1);
    const targetFrame = [...targetBase];
    const sourceHipX = valueAt(sourceFrame, source, "DEF-hips", "Xposition");
    const sourceHipY = valueAt(sourceFrame, source, "DEF-hips", "Yposition");
    const sourceHipZ = valueAt(sourceFrame, source, "DEF-hips", "Zposition");
    const sourceBaseX = valueAt(sourceBase, source, "DEF-hips", "Xposition");
    const sourceBaseY = valueAt(sourceBase, source, "DEF-hips", "Yposition");
    const sourceBaseZ = valueAt(sourceBase, source, "DEF-hips", "Zposition");

    setValue(
      targetFrame,
      target,
      "hips",
      "Xposition",
      valueAt(targetBase, target, "hips", "Xposition") + (sourceHipX - sourceBaseX) * rootHorizontalScale,
    );
    setValue(
      targetFrame,
      target,
      "hips",
      "Yposition",
      valueAt(targetBase, target, "hips", "Yposition") +
        (sourceHipZ - sourceBaseZ) * rootVerticalScale +
        lerp(rootYOffset[0], rootYOffset[1], t),
    );
    setValue(
      targetFrame,
      target,
      "hips",
      "Zposition",
      valueAt(targetBase, target, "hips", "Zposition") +
        (sourceHipY - sourceBaseY) * rootHorizontalScale +
        lerp(rootZOffset[0], rootZOffset[1], t),
    );

    for (const [targetBone, mapping] of Object.entries(retargetMap)) {
      const scale = (mapping.rotationScale ?? 1) * (clip.rotationScale ?? 1);
      for (const targetAxis of ["Xrotation", "Yrotation", "Zrotation"]) {
        const sourceAxis = sourceRotationAxis[targetAxis];
        const delta = valueAt(sourceFrame, source, mapping.source, sourceAxis) -
          valueAt(sourceBase, source, mapping.source, sourceAxis);
        const baseRotation = valueAt(targetBase, target, targetBone, targetAxis);
        setValue(targetFrame, target, targetBone, targetAxis, baseRotation + delta * scale);
      }
    }
    if (endPose) {
      return blendFrames(targetFrame, endPose, smoothstep(clip.endPoseBlendStart ?? 0.7, 1, t));
    }
    return targetFrame;
  });
}

function writeBvh(outputPath, target, frames) {
  const body = frames
    .map((frame) =>
      frame
        .map((value) => (Number.isFinite(value) ? Number(value.toFixed(6)).toString() : "0"))
        .join(" "),
    )
    .join("\n");
  fs.writeFileSync(
    outputPath,
    [target.hierarchy, "MOTION", `Frames: ${frames.length}`, `Frame Time: ${target.frameTime}`, body, ""].join(
      "\n",
    ),
  );
}

function ensureSourcePack() {
  fs.mkdirSync(sourceDir, { recursive: true });
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    console.log("downloading Quaternius Universal Animation Library Standard pack");
    const result = spawnSync("curl", ["-L", "-sS", "-o", zipPath, zipUrl], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      throw new Error(`Could not download Quaternius pack: ${result.stderr || result.stdout}`);
    }
  }
  if (!fs.existsSync(glbPath)) {
    console.log("extracting Quaternius animation GLB");
    const result = spawnSync("unzip", ["-oq", zipPath, "-d", extractDir], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      throw new Error(`Could not extract Quaternius pack: ${result.stderr || result.stdout}`);
    }
  }
}

function exportActions() {
  fs.mkdirSync(convertedDir, { recursive: true });
  const missing = clips.filter((clip) => !fs.existsSync(path.join(convertedDir, `${clip.action}.bvh`)));
  if (missing.length === 0) {
    return;
  }

  const actionNames = [...new Set(clips.map((clip) => clip.action))];
  const blenderScript = `
import bpy
import json
import os
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(glbPath)})
armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
if not armatures:
    raise RuntimeError("No armature found in Quaternius GLB")
armature = armatures[0]
armature.animation_data_create()
for action_name in json.loads(${JSON.stringify(JSON.stringify(actionNames))}):
    action = bpy.data.actions.get(action_name)
    if action is None:
        raise RuntimeError("Missing action: " + action_name)
    armature.animation_data.action = action
    bpy.context.scene.frame_start = int(action.frame_range[0])
    bpy.context.scene.frame_end = int(action.frame_range[1])
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    output = os.path.join(${JSON.stringify(convertedDir)}, action_name + ".bvh")
    bpy.ops.export_anim.bvh(filepath=output, frame_start=bpy.context.scene.frame_start, frame_end=bpy.context.scene.frame_end, root_transform_only=False)
    print("exported", action_name, output)
`;

  console.log("exporting Quaternius named actions through Blender");
  const result = spawnSync("blender", ["--background", "--python-expr", blenderScript], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (result.status !== 0) {
    throw new Error(`Blender failed while exporting Quaternius actions:\n${result.stderr}\n${result.stdout}`);
  }
}

ensureSourcePack();
exportActions();

const target = parseBvh(targetReferencePath);
for (const clip of clips) {
  const sourcePath = path.join(convertedDir, `${clip.action}.bvh`);
  const source = parseBvh(sourcePath);
  const frames = retargetClip(target, source, clip);
  const outputPath = path.join(animationDir, clip.output);
  writeBvh(outputPath, target, frames);
  console.log(`wrote ${path.relative(rootDir, outputPath)} from Quaternius ${clip.label}`);
}
