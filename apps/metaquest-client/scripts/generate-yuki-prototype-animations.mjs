import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const animationDir = path.join(rootDir, "public", "animations", "yuki", "prototype");
const sourcePath = path.join(animationDir, "neutral_idle.bvh");

const source = fs.readFileSync(sourcePath, "utf8");
const motionIndex = source.indexOf("MOTION");
if (motionIndex < 0) {
  throw new Error(`Could not find MOTION section in ${sourcePath}`);
}

const hierarchy = source.slice(0, motionIndex).trimEnd();
const motion = source.slice(motionIndex).split(/\r?\n/);
const framesLineIndex = motion.findIndex((line) => line.startsWith("Frames:"));
const frameTimeLineIndex = motion.findIndex((line) => line.startsWith("Frame Time:"));
if (framesLineIndex < 0 || frameTimeLineIndex < 0) {
  throw new Error(`Could not parse MOTION header in ${sourcePath}`);
}

const frameTime = Number.parseFloat(motion[frameTimeLineIndex].split(":")[1]);
const firstFrameLine = motion.slice(frameTimeLineIndex + 1).find((line) => line.trim().length > 0);
if (!firstFrameLine) {
  throw new Error(`Could not find a source frame in ${sourcePath}`);
}
const baseFrame = firstFrameLine.trim().split(/\s+/).map(Number);

const channels = [];
const stack = [];
for (const rawLine of hierarchy.split(/\r?\n/)) {
  const line = rawLine.trim();
  const joint = line.match(/^(ROOT|JOINT)\s+(\S+)/);
  if (joint) {
    stack.push(joint[2]);
    continue;
  }
  if (line === "}") {
    stack.pop();
    continue;
  }
  const channel = line.match(/^CHANNELS\s+(\d+)\s+(.+)$/);
  if (channel) {
    const bone = stack[stack.length - 1];
    const names = channel[2].trim().split(/\s+/);
    for (const name of names) {
      channels.push({ bone, name });
    }
  }
}
if (channels.length !== baseFrame.length) {
  throw new Error(`Parsed ${channels.length} channels but source frame has ${baseFrame.length} values.`);
}

const channelIndex = new Map();
channels.forEach((channel, index) => {
  channelIndex.set(`${channel.bone}.${channel.name}`, index);
});

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function wave01(t) {
  return Math.sin(t * Math.PI * 2);
}

function set(frame, bone, channel, value) {
  const index = channelIndex.get(`${bone}.${channel}`);
  if (index === undefined) {
    return;
  }
  frame[index] = value;
}

function add(frame, bone, channel, value) {
  const index = channelIndex.get(`${bone}.${channel}`);
  if (index === undefined) {
    return;
  }
  frame[index] += value;
}

function addRot(frame, bone, { x = 0, y = 0, z = 0 }) {
  add(frame, bone, "Xrotation", x);
  add(frame, bone, "Yrotation", y);
  add(frame, bone, "Zrotation", z);
}

function rootOffset(frame, { x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0 }) {
  add(frame, "hips", "Xposition", x);
  add(frame, "hips", "Yposition", y);
  add(frame, "hips", "Zposition", z);
  addRot(frame, "hips", { x: pitch, y: yaw, z: roll });
}

function standingTalkPose(frame, t, amount = 1) {
  const pulse = wave01(t);
  const fast = Math.sin(t * Math.PI * 4);
  addRot(frame, "spine", { x: -2 * amount, y: 2 * pulse * amount, z: 1.2 * pulse * amount });
  addRot(frame, "chest", { x: -3 * amount, y: 3 * pulse * amount, z: 1.8 * pulse * amount });
  addRot(frame, "upperChest", { x: -2 * amount, y: 4 * pulse * amount, z: 2.4 * pulse * amount });
  addRot(frame, "neck", { x: -1 * amount, y: 3 * pulse * amount, z: 1 * amount });
  addRot(frame, "head", { x: 3 * fast * amount, y: 5 * pulse * amount, z: 1.2 * pulse * amount });
  addRot(frame, "leftUpperArm", { x: -20 * amount + 8 * fast * amount, y: 8 * amount, z: -28 * amount });
  addRot(frame, "leftLowerArm", { x: -38 * amount + 7 * pulse * amount, y: 5 * amount, z: -6 * amount });
  addRot(frame, "rightUpperArm", { x: -24 * amount - 8 * fast * amount, y: -10 * amount, z: 30 * amount });
  addRot(frame, "rightLowerArm", { x: -42 * amount - 7 * pulse * amount, y: -5 * amount, z: 6 * amount });
}

function walkPose(frame, t, amount = 1) {
  const phase = t * Math.PI * 2;
  const left = Math.sin(phase);
  const right = -left;
  const leftLift = Math.max(0, Math.sin(phase));
  const rightLift = Math.max(0, -Math.sin(phase));
  const side = Math.sin(phase + Math.PI / 2);
  rootOffset(frame, {
    y: (0.18 + Math.max(leftLift, rightLift) * 0.22) * amount,
    pitch: -3 * amount,
    roll: 3.2 * side * amount,
    yaw: 1.5 * side * amount,
  });
  addRot(frame, "spine", { x: -2.5 * amount, y: -3 * side * amount, z: -2 * side * amount });
  addRot(frame, "chest", { x: -2 * amount, y: -4 * side * amount, z: -2 * side * amount });
  addRot(frame, "head", { x: 1.5 * amount, y: 2 * side * amount, z: -1.2 * side * amount });

  addRot(frame, "leftUpperLeg", { x: 26 * left * amount, y: 3 * amount, z: -2 * amount });
  addRot(frame, "leftLowerLeg", { x: (10 + 48 * leftLift) * amount });
  addRot(frame, "leftFoot", { x: (-10 * left - 12 * leftLift) * amount, z: 2 * amount });
  addRot(frame, "leftToes", { x: -8 * leftLift * amount });
  addRot(frame, "rightUpperLeg", { x: 26 * right * amount, y: -3 * amount, z: 2 * amount });
  addRot(frame, "rightLowerLeg", { x: (10 + 48 * rightLift) * amount });
  addRot(frame, "rightFoot", { x: (-10 * right - 12 * rightLift) * amount, z: -2 * amount });
  addRot(frame, "rightToes", { x: -8 * rightLift * amount });

  addRot(frame, "leftUpperArm", { x: -34 * right * amount, y: 6 * amount, z: -18 * amount });
  addRot(frame, "leftLowerArm", { x: -22 * amount - 10 * rightLift * amount, z: -4 * amount });
  addRot(frame, "rightUpperArm", { x: -34 * left * amount, y: -6 * amount, z: 18 * amount });
  addRot(frame, "rightLowerArm", { x: -22 * amount - 10 * leftLift * amount, z: 4 * amount });
}

function seatedPose(frame, amount = 1, t = 0) {
  const breath = Math.sin(t * Math.PI * 2) * 0.8;
  rootOffset(frame, { y: -3.8 * amount, z: -0.32 * amount, pitch: -6 * amount });
  addRot(frame, "spine", { x: -6 * amount + breath, z: 1 * breath });
  addRot(frame, "chest", { x: -4 * amount + breath, y: 1.4 * breath });
  addRot(frame, "upperChest", { x: -2 * amount + breath, y: 1.8 * breath });
  addRot(frame, "neck", { x: -1 * amount, y: 1.2 * breath });
  addRot(frame, "head", { x: 2 * amount + 2 * breath, y: 1.8 * breath });
  addRot(frame, "leftUpperLeg", { x: -64 * amount, y: 7 * amount, z: -5 * amount });
  addRot(frame, "leftLowerLeg", { x: 72 * amount, z: 4 * amount });
  addRot(frame, "leftFoot", { x: -10 * amount, y: 1 * amount, z: 1 * amount });
  addRot(frame, "leftToes", { x: -5 * amount });
  addRot(frame, "rightUpperLeg", { x: -64 * amount, y: -7 * amount, z: 5 * amount });
  addRot(frame, "rightLowerLeg", { x: 72 * amount, z: -4 * amount });
  addRot(frame, "rightFoot", { x: -10 * amount, y: -1 * amount, z: -1 * amount });
  addRot(frame, "rightToes", { x: -5 * amount });
  addRot(frame, "leftUpperArm", { x: -18 * amount, y: 8 * amount, z: -30 * amount });
  addRot(frame, "leftLowerArm", { x: -38 * amount, y: 3 * amount, z: -8 * amount });
  addRot(frame, "rightUpperArm", { x: -18 * amount, y: -8 * amount, z: 30 * amount });
  addRot(frame, "rightLowerArm", { x: -38 * amount, y: -3 * amount, z: 8 * amount });
}

function turnPose(frame, t, direction) {
  const pulse = wave01(t);
  const step = Math.sin(t * Math.PI * 4);
  rootOffset(frame, { yaw: direction * (36 * t - 18), y: 0.12 + Math.abs(step) * 0.14, roll: direction * pulse * 2 });
  addRot(frame, "spine", { y: direction * -8, z: direction * -2 });
  addRot(frame, "chest", { y: direction * -9, z: direction * -2 });
  addRot(frame, "head", { y: direction * 12, z: direction * 1 });
  addRot(frame, "leftUpperLeg", { x: 14 * step, z: -3 });
  addRot(frame, "rightUpperLeg", { x: -14 * step, z: 3 });
  addRot(frame, "leftLowerLeg", { x: 22 * Math.max(0, step) });
  addRot(frame, "rightLowerLeg", { x: 22 * Math.max(0, -step) });
  addRot(frame, "leftUpperArm", { x: -18 * step, z: -18 });
  addRot(frame, "rightUpperArm", { x: 18 * step, z: 18 });
}

function makeFrames({ frames, pose }) {
  return Array.from({ length: frames }, (_, index) => {
    const t = frames <= 1 ? 0 : index / (frames - 1);
    const frame = [...baseFrame];
    pose(frame, t, index);
    return frame;
  });
}

function writeBvh(name, spec) {
  const frames = makeFrames(spec);
  const body = frames.map((frame) => frame.map((value) => {
    if (!Number.isFinite(value)) {
      return "0";
    }
    return Number(value.toFixed(6)).toString();
  }).join(" ")).join("\n");
  const output = [
    hierarchy,
    "MOTION",
    `Frames: ${frames.length}`,
    `Frame Time: ${frameTime}`,
    body,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(animationDir, name), output);
}

const specs = {
  "walk_start.bvh": {
    frames: 30,
    pose: (frame, t) => walkPose(frame, t * 0.75, smoothstep(t)),
  },
  "walk_forward.bvh": {
    frames: 42,
    pose: (frame, t) => walkPose(frame, t, 1),
  },
  "walk_stop.bvh": {
    frames: 30,
    pose: (frame, t) => walkPose(frame, 0.25 + t * 0.75, 1 - smoothstep(t)),
  },
  "turn_left.bvh": {
    frames: 36,
    pose: (frame, t) => turnPose(frame, t, 1),
  },
  "turn_right.bvh": {
    frames: 36,
    pose: (frame, t) => turnPose(frame, t, -1),
  },
  "sit_down.bvh": {
    frames: 46,
    pose: (frame, t) => {
      const settle = smoothstep(t);
      addRot(frame, "hips", { x: -4 * Math.sin(Math.PI * t) });
      seatedPose(frame, settle, t);
    },
  },
  "seated_idle.bvh": {
    frames: 72,
    pose: (frame, t) => seatedPose(frame, 1, t),
  },
  "stand_up.bvh": {
    frames: 42,
    pose: (frame, t) => {
      const settle = 1 - smoothstep(t);
      seatedPose(frame, settle, t);
      addRot(frame, "hips", { x: -3 * Math.sin(Math.PI * t) });
    },
  },
  "talk_gesture.bvh": {
    frames: 54,
    pose: (frame, t) => standingTalkPose(frame, t, 1),
  },
};

for (const [name, spec] of Object.entries(specs)) {
  writeBvh(name, spec);
  console.log(`wrote ${path.relative(rootDir, path.join(animationDir, name))}`);
}
