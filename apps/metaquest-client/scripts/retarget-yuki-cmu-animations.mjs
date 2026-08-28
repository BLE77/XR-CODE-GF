import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const animationDir = path.join(rootDir, "public", "animations", "yuki", "prototype");
const sourceDir = path.join(rootDir, ".animation-sources", "cmu-fbx");
const convertedDir = path.join(rootDir, ".animation-sources", "cmu-bvh");
const targetReferencePath = path.join(animationDir, "neutral_idle.bvh");
const baseUrl = "https://huggingface.co/datasets/gbionics/cmu-fbx/resolve/main/animations";

const clips = [
  {
    output: "walk_start.bvh",
    source: "104_14.fbx",
    label: "HappyStartWalk",
    frames: 48,
    start: 1,
    rootYOffset: [0, 0],
    rotationScale: 0.8,
  },
  {
    output: "walk_forward.bvh",
    source: "07_01.fbx",
    label: "walk",
    frames: 72,
    start: 1,
    rotationScale: 0.78,
  },
  {
    output: "walk_stop.bvh",
    source: "16_33.fbx",
    label: "slow walk, stop",
    frames: 58,
    start: 15,
    take: "head",
    rotationScale: 0.78,
  },
  {
    output: "turn_left.bvh",
    source: "69_18.fbx",
    label: "turn in place opposite direction",
    frames: 58,
    start: 1,
    rotationScale: 0.72,
  },
  {
    output: "turn_right.bvh",
    source: "69_16.fbx",
    label: "turn in place",
    frames: 58,
    start: 1,
    rotationScale: 0.72,
  },
  {
    output: "sit_down.bvh",
    source: "143_18.fbx",
    label: "Sit Down And Get Up",
    frames: 76,
    take: "head",
    rootYOffset: [0, -3.2],
    rotationScale: 0.9,
  },
  {
    output: "seated_idle.bvh",
    source: "114_05.fbx",
    label: "Sitting in chair",
    frames: 90,
    start: 1,
    rootYOffset: [-3.2, -3.2],
    rotationScale: 0.78,
  },
  {
    output: "stand_up.bvh",
    source: "143_18.fbx",
    label: "Sit Down And Get Up",
    frames: 76,
    take: "tail",
    rootYOffset: [-3.2, 0],
    rotationScale: 0.9,
  },
  {
    output: "talk_gesture.bvh",
    source: "18_08.fbx",
    label: "conversation - explain with hand gestures",
    frames: 92,
    start: 1,
    rotationScale: 0.68,
  },
];

const retargetMap = {
  hips: { source: "hip", rotationScale: 0.45 },
  spine: { source: "abdomen", rotationScale: 0.45 },
  chest: { source: "abdomen", rotationScale: 0.22 },
  upperChest: { source: "chest", rotationScale: 0.34 },
  neck: { source: "neck", rotationScale: 0.34 },
  head: { source: "head", rotationScale: 0.34 },
  leftShoulder: { source: "lCollar", rotationScale: 0.55 },
  leftUpperArm: { source: "lShldr", rotationScale: 0.82 },
  leftLowerArm: { source: "lForeArm", rotationScale: 0.86 },
  leftHand: { source: "lHand", rotationScale: 0.5 },
  rightShoulder: { source: "rCollar", rotationScale: 0.55 },
  rightUpperArm: { source: "rShldr", rotationScale: 0.82 },
  rightLowerArm: { source: "rForeArm", rotationScale: 0.86 },
  rightHand: { source: "rHand", rotationScale: 0.5 },
  leftUpperLeg: { source: "lThigh", rotationScale: 0.9 },
  leftLowerLeg: { source: "lShin", rotationScale: 0.9 },
  leftFoot: { source: "lFoot", rotationScale: 0.82 },
  rightUpperLeg: { source: "rThigh", rotationScale: 0.9 },
  rightLowerLeg: { source: "rShin", rotationScale: 0.9 },
  rightFoot: { source: "rFoot", rotationScale: 0.82 },
};

function parseBvh(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const motionIndex = text.indexOf("MOTION");
  if (motionIndex < 0) {
    throw new Error(`Could not find MOTION in ${filePath}`);
  }

  const hierarchy = text.slice(0, motionIndex).trimEnd();
  const lines = text.slice(motionIndex).split(/\r?\n/);
  const framesLineIndex = lines.findIndex((line) => line.startsWith("Frames:"));
  const frameTimeLineIndex = lines.findIndex((line) => line.startsWith("Frame Time:"));
  if (framesLineIndex < 0 || frameTimeLineIndex < 0) {
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
      const names = channel[2].trim().split(/\s+/);
      for (const name of names) {
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

function lerp(start, end, t) {
  return start + (end - start) * t;
}

function selectSourceFrames(sourceFrames, clip) {
  const skipRest = clip.start ?? 1;
  const available = sourceFrames.slice(Math.min(skipRest, Math.max(0, sourceFrames.length - 1)));
  const count = Math.min(clip.frames, available.length);
  if (count <= 0) {
    throw new Error(`No source frames available for ${clip.output}`);
  }

  if (clip.take === "tail") {
    return available.slice(available.length - count);
  }
  if (clip.take === "head") {
    return available.slice(0, count);
  }
  if (available.length <= count) {
    return available;
  }

  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index / Math.max(1, count - 1)) * (available.length - 1));
    return available[sourceIndex];
  });
}

function retargetClip(target, source, clip) {
  const selectedFrames = selectSourceFrames(source.frames, clip);
  const targetBase = target.frames[0];
  const sourceBase = selectedFrames[0];
  const rootYOffset = clip.rootYOffset ?? [0, 0];
  const rootHorizontalScale = clip.rootHorizontalScale ?? 0.006;
  const rootVerticalScale = clip.rootVerticalScale ?? 0.036;

  return selectedFrames.map((sourceFrame, frameIndex) => {
    const t = selectedFrames.length <= 1 ? 0 : frameIndex / (selectedFrames.length - 1);
    const targetFrame = [...targetBase];
    const sourceRootX = valueAt(sourceFrame, source, "hip", "Xposition");
    const sourceRootY = valueAt(sourceFrame, source, "hip", "Yposition");
    const sourceRootZ = valueAt(sourceFrame, source, "hip", "Zposition");
    const sourceBaseX = valueAt(sourceBase, source, "hip", "Xposition");
    const sourceBaseY = valueAt(sourceBase, source, "hip", "Yposition");
    const sourceBaseZ = valueAt(sourceBase, source, "hip", "Zposition");

    setValue(
      targetFrame,
      target,
      "hips",
      "Xposition",
      valueAt(targetBase, target, "hips", "Xposition") + (sourceRootX - sourceBaseX) * rootHorizontalScale,
    );
    // Blender's CMU BVH export keeps vertical travel on source Z. Source Y is
    // horizontal trajectory, so mapping it to Yuki height creates unsafe hops.
    setValue(
      targetFrame,
      target,
      "hips",
      "Yposition",
      valueAt(targetBase, target, "hips", "Yposition") +
        (sourceRootZ - sourceBaseZ) * rootVerticalScale +
        lerp(rootYOffset[0], rootYOffset[1], t),
    );
    setValue(
      targetFrame,
      target,
      "hips",
      "Zposition",
      valueAt(targetBase, target, "hips", "Zposition") + (sourceRootY - sourceBaseY) * rootHorizontalScale,
    );

    for (const [targetBone, mapping] of Object.entries(retargetMap)) {
      const scale = (mapping.rotationScale ?? 1) * (clip.rotationScale ?? 1);
      for (const axis of ["Xrotation", "Yrotation", "Zrotation"]) {
        const sourceRotation = valueAt(sourceFrame, source, mapping.source, axis);
        const baseRotation = valueAt(targetBase, target, targetBone, axis);
        setValue(targetFrame, target, targetBone, axis, baseRotation + sourceRotation * scale);
      }
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

function downloadSource(clip) {
  const destination = path.join(sourceDir, clip.source);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    return destination;
  }

  const url = `${baseUrl}/${clip.source}`;
  console.log(`downloading ${clip.source} (${clip.label})`);
  const result = spawnSync("curl", ["-L", "-sS", "-o", destination, url], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`curl failed for ${clip.source}: ${result.stderr || result.stdout}`);
  }
  return destination;
}

function convertToBvh(sourcePath) {
  const outputPath = path.join(convertedDir, `${path.basename(sourcePath, ".fbx")}.bvh`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return outputPath;
  }

  const blenderScript = `
import bpy
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.import_scene.fbx(filepath=${JSON.stringify(sourcePath)})
armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
if not armatures:
    raise RuntimeError("No armature found in ${path.basename(sourcePath)}")
armature = armatures[0]
bpy.ops.object.select_all(action="DESELECT")
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_anim.bvh(filepath=${JSON.stringify(outputPath)}, frame_start=bpy.context.scene.frame_start, frame_end=bpy.context.scene.frame_end, root_transform_only=False)
`;
  console.log(`converting ${path.basename(sourcePath)} through Blender`);
  const result = spawnSync("blender", ["--background", "--python-expr", blenderScript], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 1024 * 1024 * 8,
  });
  if (result.status !== 0) {
    throw new Error(`Blender failed for ${sourcePath}:\n${result.stderr}\n${result.stdout}`);
  }
  return outputPath;
}

fs.mkdirSync(sourceDir, { recursive: true });
fs.mkdirSync(convertedDir, { recursive: true });

const target = parseBvh(targetReferencePath);
for (const clip of clips) {
  const sourcePath = downloadSource(clip);
  const sourceBvhPath = convertToBvh(sourcePath);
  const sourceBvh = parseBvh(sourceBvhPath);
  const frames = retargetClip(target, sourceBvh, clip);
  const outputPath = path.join(animationDir, clip.output);
  writeBvh(outputPath, target, frames);
  console.log(`wrote ${path.relative(rootDir, outputPath)} from ${clip.source}`);
}
