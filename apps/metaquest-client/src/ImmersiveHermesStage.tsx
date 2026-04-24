import { useEffect, useRef, useState } from "react";
import {
  World,
  SessionMode,
  ReferenceSpaceType,
  VisibilityState,
  buildSessionInit,
  normalizeReferenceSpec,
  resolveReferenceSpaceType,
} from "@iwsdk/core";
import * as THREE from "three";
import { BVHLoader } from "three/examples/jsm/loaders/BVHLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  VRMLoaderPlugin,
  VRMHumanBoneName,
  type VRM,
} from "@pixiv/three-vrm";
import type { CodingSessionSnapshot } from "./lib/protocol";

const YUKI_ASSET_CANDIDATES = ["/vrms/Yuki.glb", "/vrms/Yuki.vrm"] as const;

type StageTone = "calm" | "working" | "attention" | "success";
type CharacterState = "idle" | "listening" | "working" | "alert" | "ready";
type AvatarMode = "idle" | "listening" | "thinking" | "speaking";
type AnimationState = "idle" | "listening" | "thinking" | "speaking" | "alert" | "ready";
type AvatarLoadState = "loading" | "ready" | "fallback";
type XRState = "checking" | "ready" | "entering" | "active" | "unsupported" | "failed";
type AvatarClipState = "idle" | "listening" | "thinking" | "speaking" | "alert";

type ImmersiveHermesStageProps = {
  characterState: CharacterState;
  avatarMode: AvatarMode;
  tone: StageTone;
  title: string;
  subtitle: string;
  latestSummary: string;
  speechPulseAt: number;
  speechSpeaking: boolean;
  latestTranscript?: string;
  leadSession?: CodingSessionSnapshot;
  sessions: CodingSessionSnapshot[];
};

type PanelCard = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
};

type FallbackRig = {
  group: THREE.Group;
  head: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  body: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshStandardMaterial>;
  core: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
};

type StageRuntime = {
  world: World;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  sceneMode: SessionMode;
  desktopPreview: boolean;
  camera: THREE.PerspectiveCamera;
  floor: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  platform: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  assistantRoot: THREE.Group;
  lookTarget: THREE.Object3D;
  auraRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  auraShell: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  beacon: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  fallbackRig: FallbackRig;
  fillLight: THREE.DirectionalLight;
  panels: {
    summary: PanelCard;
    worker: PanelCard;
    status: PanelCard;
  };
  vrm: VRM | null;
  avatarScene: THREE.Object3D | null;
  avatarMode: LoadedAvatar["mode"] | null;
  avatarRig: AvatarRig | null;
  avatarAnimations: AvatarAnimationController | null;
  avatarMorphs: SceneMorphController | null;
};

declare global {
  interface Window {
    __xrStageDebug?: {
      runtime: StageRuntime | null;
      xrState: XRState;
      avatarStatus: AvatarLoadState;
    };
  }
}

type LoadedAvatar = {
  vrm: VRM | null;
  scene: THREE.Object3D;
  mode: "vrm" | "scene";
  sourceUrl: string;
};

type AvatarRig = {
  hips?: THREE.Bone;
  spine?: THREE.Bone;
  chest?: THREE.Bone;
  upperChest?: THREE.Bone;
  neck?: THREE.Bone;
  head?: THREE.Bone;
  leftEye?: THREE.Bone;
  rightEye?: THREE.Bone;
  leftShoulder?: THREE.Bone;
  leftUpperArm?: THREE.Bone;
  leftLowerArm?: THREE.Bone;
  leftHand?: THREE.Bone;
  rightShoulder?: THREE.Bone;
  rightUpperArm?: THREE.Bone;
  rightLowerArm?: THREE.Bone;
  rightHand?: THREE.Bone;
  rest: Map<THREE.Bone, THREE.Euler>;
};

type AvatarAnimationController = {
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<AvatarClipState, THREE.AnimationAction>>;
  activeState: AvatarClipState | null;
};

type MorphTargetBinding = {
  influences: number[];
  index: number;
};

type SceneMorphController = {
  targets: Map<string, MorphTargetBinding[]>;
};

const SCENE_BACKGROUND = 0x06111c;
const STAGE_DEPTH = -1.92;
const PANEL_DEPTH = -2.18;
const ASSISTANT_BASE_Y = 0.18;
const YUKI_PROTOTYPE_ANIMATIONS: Record<AvatarClipState, string> = {
  idle: "/animations/yuki/prototype/neutral_idle.bvh",
  listening: "/animations/yuki/prototype/curiosity.bvh",
  thinking: "/animations/yuki/prototype/confusion.bvh",
  speaking: "/animations/yuki/prototype/action_attention_seeking.bvh",
  alert: "/animations/yuki/prototype/action_attention_seeking.bvh",
};
const YUKI_BVH_BONE_MAP: Record<string, string> = {
  J_Bip_C_Hips: "hips",
  J_Bip_C_Spine: "spine",
  J_Bip_C_Chest: "chest",
  J_Bip_C_UpperChest: "upperChest",
  J_Bip_C_Neck: "neck",
  J_Bip_C_Head: "head",
  J_Bip_L_Shoulder: "leftShoulder",
  J_Bip_L_UpperArm: "leftUpperArm",
  J_Bip_L_LowerArm: "leftLowerArm",
  J_Bip_L_Hand: "leftHand",
  J_Bip_R_Shoulder: "rightShoulder",
  J_Bip_R_UpperArm: "rightUpperArm",
  J_Bip_R_L_LowerArm: "rightLowerArm",
  J_Bip_R_LowerArm: "rightLowerArm",
  J_Bip_R_Hand: "rightHand",
  J_Bip_L_UpperLeg: "leftUpperLeg",
  J_Bip_L_LowerLeg: "leftLowerLeg",
  J_Bip_L_Foot: "leftFoot",
  J_Bip_L_ToeBase: "leftToes",
  J_Bip_R_UpperLeg: "rightUpperLeg",
  J_Bip_R_LowerLeg: "rightLowerLeg",
  J_Bip_R_Foot: "rightFoot",
  J_Bip_R_ToeBase: "rightToes",
  J_Adj_L_FaceEye: "leftEye",
  J_Adj_R_FaceEye: "rightEye",
};
const XR_STAGE_FEATURES = {
  handTracking: true,
  hitTest: true,
  anchors: true,
  planeDetection: true,
  meshDetection: true,
  layers: true,
} as const;
const XR_REFERENCE_SPACE = {
  type: ReferenceSpaceType.LocalFloor,
  fallbackOrder: [ReferenceSpaceType.Local, ReferenceSpaceType.Viewer] as ReferenceSpaceType[],
};
const DESKTOP_STAGE_LAYOUT = {
  cameraPosition: new THREE.Vector3(0, 1.26, 0.94),
  cameraLookAt: new THREE.Vector3(0, 1.04, -0.48),
  assistantZ: -1.18,
  assistantY: 0.03,
  avatarZOffset: 0.04,
  avatarScaleBoost: 0.84,
  panelScale: 1.08,
  summaryPanel: new THREE.Vector3(-1.16, 0.82, -1.18),
  workerPanel: new THREE.Vector3(1.16, 0.82, -1.18),
  statusPanel: new THREE.Vector3(0, 1.2, -1.22),
  auraRing: new THREE.Vector3(0, 0.02, -0.84),
  auraShell: new THREE.Vector3(0, 1.16, -0.9),
  beacon: new THREE.Vector3(0, 1.16, -0.76),
} as const;

function toneColor(tone: StageTone): number {
  switch (tone) {
    case "working":
      return 0x55c8ff;
    case "attention":
      return 0xff7a5c;
    case "success":
      return 0x57f0b7;
    default:
      return 0x90d8ff;
  }
}

function stateAccent(state: CharacterState): number {
  switch (state) {
    case "listening":
      return 0x8af2ff;
    case "working":
      return 0x58b7ff;
    case "alert":
      return 0xff8b73;
    case "ready":
      return 0x73ffc7;
    default:
      return 0xd8f6ff;
  }
}

function createPanel(position: THREE.Vector3, rotationY: number, scale: [number, number]): PanelCard {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 640;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create 2D canvas context for XR panel.");
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scale[0], scale[1]), material);
  mesh.position.copy(position);
  mesh.rotation.y = rotationY;

  return { canvas, context, texture, mesh };
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry.dispose());
    return;
  }
  material.dispose();
}

function disposeObjectTree(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      disposeMaterial(mesh.material);
    }
  });
}

function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let current = words[0] ?? "";
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

function drawPanel(
  panel: PanelCard,
  {
    eyebrow,
    title,
    body,
    tone,
  }: {
    eyebrow: string;
    title: string;
    body: string;
    tone: StageTone;
  },
) {
  const { canvas, context, texture } = panel;
  const width = canvas.width;
  const height = canvas.height;
  const accent = `#${toneColor(tone).toString(16).padStart(6, "0")}`;

  context.clearRect(0, 0, width, height);

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "rgba(6, 14, 24, 0.96)");
  background.addColorStop(1, "rgba(11, 28, 42, 0.92)");
  context.fillStyle = background;
  roundRect(context, 20, 20, width - 40, height - 40, 36);
  context.fill();

  context.strokeStyle = "rgba(175, 226, 255, 0.22)";
  context.lineWidth = 3;
  roundRect(context, 20, 20, width - 40, height - 40, 36);
  context.stroke();

  context.fillStyle = accent;
  roundRect(context, 44, 48, 176, 42, 21);
  context.fill();

  context.fillStyle = "#06111d";
  context.font = "600 22px Inter, system-ui, sans-serif";
  context.fillText(eyebrow.toUpperCase(), 66, 76);

  context.fillStyle = "#eefaff";
  context.font = "700 40px Inter, system-ui, sans-serif";
  const titleLines = wrapLines(context, title, width - 88).slice(0, 2);
  titleLines.forEach((line, index) => {
    context.fillText(line, 44, 146 + index * 46);
  });

  context.fillStyle = "rgba(239, 247, 251, 0.86)";
  const bodyLength = body.trim().length;
  const bodyFontSize = bodyLength > 300 ? 24 : bodyLength > 210 ? 26 : 28;
  const lineHeight = bodyLength > 300 ? 32 : bodyLength > 210 ? 34 : 36;
  const maxLines = bodyLength > 300 ? 10 : bodyLength > 210 ? 9 : 8;
  context.font = `500 ${bodyFontSize}px Inter, system-ui, sans-serif`;
  const lines = wrapLines(context, body, width - 88).slice(0, maxLines);
  lines.forEach((line, index) => {
    context.fillText(line, 44, 250 + index * lineHeight);
  });

  texture.needsUpdate = true;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function setExpression(vrm: VRM, name: string, value: number) {
  if (!vrm.expressionManager) {
    return;
  }

  try {
    vrm.expressionManager.setValue(name, value);
  } catch {
    // Some models do not expose the same preset names. Ignore gracefully.
  }
}

function captureSceneMorphController(scene: THREE.Object3D): SceneMorphController | null {
  const targets = new Map<string, MorphTargetBinding[]>();

  scene.traverse((object) => {
    const mesh = object as THREE.SkinnedMesh & {
      isSkinnedMesh?: boolean;
      morphTargetDictionary?: Record<string, number>;
      morphTargetInfluences?: number[];
    };
    if (!mesh.isSkinnedMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) {
      return;
    }

    Object.entries(mesh.morphTargetDictionary).forEach(([name, index]) => {
      const entry = targets.get(name) ?? [];
      entry.push({
        influences: mesh.morphTargetInfluences!,
        index,
      });
      targets.set(name, entry);
    });
  });

  return targets.size > 0 ? { targets } : null;
}

function setSceneMorph(controller: SceneMorphController, name: string, value: number) {
  const bindings = controller.targets.get(name);
  if (!bindings) {
    return;
  }
  bindings.forEach(({ influences, index }) => {
    influences[index] = value;
  });
}

function updateSceneMorphs(
  controller: SceneMorphController,
  state: AnimationState,
  timeSeconds: number,
  speechSpeaking: boolean,
  speechPulseAt: number,
) {
  controller.targets.forEach((bindings) => {
    bindings.forEach(({ influences, index }) => {
      influences[index] = 0;
    });
  });

  const blink =
    0.03 +
    Math.max(0, Math.sin(timeSeconds * (state === "alert" ? 0.82 : 0.36))) *
      (state === "alert" ? 0.03 : 0.018);
  const pulseAgeMs = speechPulseAt > 0 ? Date.now() - speechPulseAt : Number.POSITIVE_INFINITY;
  const pulseStrength =
    speechSpeaking && Number.isFinite(pulseAgeMs) && pulseAgeMs < 220
      ? 1 - pulseAgeMs / 220
      : 0;
  const mouth =
    speechSpeaking
      ? 0.08 + pulseStrength * 0.42 + Math.max(0, Math.sin(timeSeconds * 10.8)) * 0.08
      : state === "thinking"
        ? 0.03 + Math.max(0, Math.sin(timeSeconds * 4.4)) * 0.03
        : 0;

  setSceneMorph(controller, "Fcl_ALL_Neutral", 1);
  setSceneMorph(controller, "Fcl_EYE_Natural", 1);
  setSceneMorph(controller, "Fcl_EYE_Iris_Hide", 0);
  setSceneMorph(controller, "Fcl_EYE_Highlight_Hide", 0);
  setSceneMorph(controller, "Fcl_MTH_Neutral", speechSpeaking ? 0 : 0.18);
  setSceneMorph(controller, "Fcl_EYE_Close", blink);
  setSceneMorph(controller, "Fcl_EYE_Close_L", blink * 0.92);
  setSceneMorph(controller, "Fcl_EYE_Close_R", blink);
  setSceneMorph(controller, "Fcl_MTH_A", mouth);
  setSceneMorph(controller, "Fcl_MTH_E", speechSpeaking ? mouth * 0.34 : state === "listening" ? 0.04 : 0);
  setSceneMorph(controller, "Fcl_MTH_I", speechSpeaking ? mouth * 0.24 : state === "thinking" ? 0.04 : 0);
  setSceneMorph(controller, "Fcl_MTH_O", speechSpeaking ? mouth * 0.32 : 0);
  setSceneMorph(controller, "Fcl_MTH_U", speechSpeaking ? mouth * 0.16 : 0);
  setSceneMorph(controller, "Fcl_ALL_Joy", state === "ready" ? 0.2 : state === "speaking" ? 0.1 : 0);
  setSceneMorph(controller, "Fcl_ALL_Fun", state === "idle" ? 0.08 : state === "listening" ? 0.14 : 0);
  setSceneMorph(controller, "Fcl_ALL_Surprised", state === "alert" ? 0.18 : 0);
  setSceneMorph(controller, "Fcl_MTH_Neutral", state === "idle" && !speechSpeaking ? 0.08 : 0);
}

function updateExpressions(
  vrm: VRM,
  state: AnimationState,
  timeSeconds: number,
  speechSpeaking: boolean,
  speechPulseAt: number,
) {
  const blink =
    0.02 +
    Math.max(0, Math.sin(timeSeconds * (state === "alert" ? 0.8 : 0.35))) *
      (state === "alert" ? 0.018 : 0.012);
  const pulseAgeMs = speechPulseAt > 0 ? Date.now() - speechPulseAt : Number.POSITIVE_INFINITY;
  const pulseStrength =
    speechSpeaking && Number.isFinite(pulseAgeMs) && pulseAgeMs < 220
      ? 1 - pulseAgeMs / 220
      : 0;
  const mouth =
    speechSpeaking
      ? 0.08 + pulseStrength * 0.34 + Math.max(0, Math.sin(timeSeconds * 10.5)) * 0.06
      : state === "thinking"
        ? 0.04 + Math.max(0, Math.sin(timeSeconds * 4.8)) * 0.03
        : state === "ready"
          ? 0.02 + Math.max(0, Math.sin(timeSeconds * 3.1)) * 0.02
          : 0;
  const ee = speechSpeaking ? mouth * 0.28 : state === "listening" ? 0.04 : 0;
  const ih = speechSpeaking ? mouth * 0.18 : state === "thinking" ? 0.05 : 0;
  const ou = speechSpeaking ? mouth * 0.16 : 0;

  setExpression(vrm, "blink", blink);
  setExpression(vrm, "aa", mouth);
  setExpression(vrm, "ee", ee);
  setExpression(vrm, "ih", ih);
  setExpression(vrm, "oh", mouth * 0.45);
  setExpression(vrm, "ou", ou);
  setExpression(vrm, "happy", state === "ready" ? 0.34 : state === "listening" ? 0.12 : state === "speaking" ? 0.16 : 0.04);
  setExpression(vrm, "relaxed", state === "idle" ? 0.12 : state === "thinking" ? 0.08 : 0.04);
  setExpression(vrm, "lookUp", state === "alert" ? 0.22 : state === "thinking" ? 0.08 : state === "speaking" ? 0.05 : 0);
}

function normalizeAvatarScene(root: THREE.Group, scene: THREE.Object3D) {
  scene.rotation.y = 0;
  root.add(scene);

  const bounds = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const targetHeight = 1.16;
  const scale = targetHeight / Math.max(size.y, 0.001);
  scene.scale.setScalar(scale);
  scene.userData.basePresenceScale = scale;

  const scaledBounds = new THREE.Box3().setFromObject(scene);
  const scaledCenter = new THREE.Vector3();
  scaledBounds.getCenter(scaledCenter);
  scene.position.set(-scaledCenter.x, -scaledBounds.min.y, -scaledCenter.z);
}

function prepareDesktopPreviewMaterials(scene: THREE.Object3D) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & {
      isMesh?: boolean;
      isSkinnedMesh?: boolean;
      material?: THREE.Material | THREE.Material[];
    };
    if (!mesh.isMesh || !mesh.material) {
      return;
    }

    const isFaceLike = /face|eye|iris/i.test(mesh.name);

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const replacement = materials.map((material) => {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 0.2;
        material.roughness = Math.min(material.roughness ?? 0.95, 0.92);
        material.metalness = Math.min(material.metalness ?? 0.15, 0.1);
        material.side = THREE.DoubleSide;
        if (isFaceLike) {
          material.roughness = 0.98;
          material.metalness = 0;
          material.alphaTest = material.transparent ? 0.28 : 0;
          material.depthWrite = !material.transparent;
        }
        material.needsUpdate = true;
        return material;
      }

      const source = material as THREE.Material & {
        color?: THREE.Color;
        map?: THREE.Texture | null;
        transparent?: boolean;
        opacity?: number;
        emissive?: THREE.Color;
      };
      const next = new THREE.MeshStandardMaterial({
        color: source.color?.clone() ?? new THREE.Color(0xd9e8f6),
        map: source.map ?? null,
        transparent: source.transparent ?? false,
        opacity: source.opacity ?? 1,
        emissive: source.emissive?.clone() ?? new THREE.Color(0x000000),
        emissiveIntensity: 0.12,
        roughness: 0.84,
        metalness: 0.04,
        side: THREE.DoubleSide,
      });
      if (isFaceLike) {
        next.roughness = 0.98;
        next.metalness = 0;
        next.alphaTest = next.transparent ? 0.28 : 0;
        next.depthWrite = !next.transparent;
      }
      next.needsUpdate = true;
      return next;
    });

    mesh.material = Array.isArray(mesh.material) ? replacement : replacement[0];
    mesh.visible = true;
    mesh.frustumCulled = false;
  });
}

function tuneSceneFaceMaterials(scene: THREE.Object3D) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & {
      isMesh?: boolean;
      material?: THREE.Material | THREE.Material[];
      renderOrder?: number;
    };
    if (!mesh.isMesh || !mesh.material || !/face|eye|iris/i.test(mesh.name)) {
      return;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (!(material instanceof THREE.MeshStandardMaterial)) {
        return;
      }
      material.roughness = 0.98;
      material.metalness = 0;
      material.side = THREE.FrontSide;
      if (material.transparent) {
        material.alphaTest = 0.32;
        material.depthWrite = false;
      }
      material.needsUpdate = true;
    });
    mesh.renderOrder = 6;
  });
}

function toBone(object: THREE.Object3D | null | undefined): THREE.Bone | undefined {
  return object instanceof THREE.Bone ? object : undefined;
}

function captureAvatarRig(scene: THREE.Object3D, vrm?: VRM | null): AvatarRig | null {
  if (vrm?.humanoid) {
    const rig: AvatarRig = {
      hips: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Hips)),
      spine: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Spine)),
      chest: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Chest)),
      upperChest: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.UpperChest)),
      neck: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Neck)),
      head: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.Head)),
      leftShoulder: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftShoulder)),
      leftUpperArm: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftUpperArm)),
      leftLowerArm: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftLowerArm)),
      leftHand: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftHand)),
      rightShoulder: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightShoulder)),
      rightUpperArm: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightUpperArm)),
      rightLowerArm: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightLowerArm)),
      rightHand: toBone(vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightHand)),
      rest: new Map(),
    };

    const keyBones = Object.values(rig).filter((bone): bone is THREE.Bone => bone instanceof THREE.Bone);
    keyBones.forEach((bone) => {
      rig.rest.set(bone, bone.rotation.clone());
    });

    if (rig.head && rig.chest && rig.leftUpperArm && rig.rightUpperArm) {
      return rig;
    }
  }

  const lookup = new Map<string, THREE.Bone>();
  scene.traverse((object) => {
    if (object instanceof THREE.Bone) {
      lookup.set(object.name, object);
    }
  });

  const rig: AvatarRig = {
    hips: lookup.get("J_Bip_C_Hips"),
    spine: lookup.get("J_Bip_C_Spine"),
    chest: lookup.get("J_Bip_C_Chest"),
    upperChest: lookup.get("J_Bip_C_UpperChest"),
    neck: lookup.get("J_Bip_C_Neck"),
    head: lookup.get("J_Bip_C_Head"),
    leftShoulder: lookup.get("J_Bip_L_Shoulder"),
    leftUpperArm: lookup.get("J_Bip_L_UpperArm"),
    leftLowerArm: lookup.get("J_Bip_L_LowerArm"),
    leftHand: lookup.get("J_Bip_L_Hand"),
    rightShoulder: lookup.get("J_Bip_R_Shoulder"),
    rightUpperArm: lookup.get("J_Bip_R_UpperArm"),
    rightLowerArm: lookup.get("J_Bip_R_LowerArm"),
    rightHand: lookup.get("J_Bip_R_Hand"),
    rest: new Map(),
  };

  const keyBones = Object.values(rig).filter((bone): bone is THREE.Bone => bone instanceof THREE.Bone);
  keyBones.forEach((bone) => {
    rig.rest.set(bone, bone.rotation.clone());
  });

  return rig.head && rig.chest && rig.leftUpperArm && rig.rightUpperArm ? rig : null;
}

function findPrimarySkinnedMesh(scene: THREE.Object3D): THREE.SkinnedMesh | null {
  let preferred: THREE.SkinnedMesh | null = null;
  let match: THREE.SkinnedMesh | null = null;
  scene.traverse((object) => {
    const candidate = object as THREE.Object3D & { isSkinnedMesh?: boolean };
    if (!candidate.isSkinnedMesh) {
      return;
    }
    const mesh = object as THREE.SkinnedMesh;
    if (!match) {
      match = mesh;
    }
    if (!preferred && /Body_\(merged\)/.test(mesh.name)) {
      preferred = mesh;
    }
  });
  return preferred ?? match;
}

function mapClipState(state: AnimationState): AvatarClipState {
  switch (state) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "speaking":
      return "speaking";
    case "alert":
      return "alert";
    default:
      return "idle";
  }
}

async function loadPrototypeAnimationController(scene: THREE.Object3D) {
  const skinnedMesh = findPrimarySkinnedMesh(scene);
  if (!skinnedMesh?.skeleton) {
    return null;
  }

  const loader = new BVHLoader();
  const mixer = new THREE.AnimationMixer(skinnedMesh);
  const actions: Partial<Record<AvatarClipState, THREE.AnimationAction>> = {};

  for (const [state, url] of Object.entries(YUKI_PROTOTYPE_ANIMATIONS) as Array<[AvatarClipState, string]>) {
    const source = await loader.loadAsync(url);
    const clip = SkeletonUtils.retargetClip(skinnedMesh, source.skeleton, source.clip, {
      hip: "hips",
      names: YUKI_BVH_BONE_MAP,
      useFirstFramePosition: false,
      preserveBoneMatrix: true,
      preserveHipPosition: true,
      scale: 0.01,
    });
    clip.name = `yuki-${state}`;
    const action = mixer.clipAction(clip);
    action.enabled = true;
    action.setEffectiveWeight(0);
    action.setLoop(THREE.LoopRepeat, Infinity);
    actions[state] = action;
  }

  return {
    mixer,
    actions,
    activeState: null,
  } satisfies AvatarAnimationController;
}

function setAvatarClipState(controller: AvatarAnimationController, state: AvatarClipState) {
  if (controller.activeState === state) {
    return;
  }

  const nextAction = controller.actions[state];
  if (!nextAction) {
    return;
  }

  const previousAction = controller.activeState ? controller.actions[controller.activeState] : null;
  controller.activeState = state;

  nextAction.reset();
  nextAction.enabled = true;
  nextAction.setEffectiveTimeScale(1);
  nextAction.setEffectiveWeight(1);

  if (previousAction && previousAction !== nextAction) {
    previousAction.crossFadeTo(nextAction, 0.28, true);
  } else {
    nextAction.fadeIn(0.18);
  }

  nextAction.play();
}

function poseBone(rig: AvatarRig, bone: THREE.Bone | undefined, x = 0, y = 0, z = 0) {
  if (!bone) {
    return;
  }
  const rest = rig.rest.get(bone);
  if (!rest) {
    return;
  }
  bone.rotation.set(rest.x + x, rest.y + y, rest.z + z);
}

function applyAvatarRigPose(
  rig: AvatarRig,
  state: AnimationState,
  elapsed: number,
  speechSpeaking: boolean,
) {
  const breath = Math.sin(elapsed * 1.8) * 0.018;
  const nod = Math.sin(elapsed * 2.2) * 0.05;
  const gesture = Math.sin(elapsed * 3.2) * 0.22;
  const sway = Math.sin(elapsed * 1.2) * 0.03;
  const handPulse = Math.sin(elapsed * 4.1) * 0.14;

  poseBone(rig, rig.hips, 0, sway * 0.25, 0);
  poseBone(rig, rig.spine, breath * 0.4, sway * 0.16, 0);
  poseBone(rig, rig.chest, breath, sway * 0.35, 0);
  poseBone(rig, rig.upperChest, breath * 1.15, sway * 0.5, 0);

  switch (state) {
    case "listening":
      poseBone(rig, rig.neck, -0.04, 0.1, -0.03);
      poseBone(rig, rig.head, -0.08, 0.16, -0.08);
      poseBone(rig, rig.leftShoulder, 0.08, 0.08, -0.18);
      poseBone(rig, rig.leftUpperArm, -0.42, 0.18, -0.88);
      poseBone(rig, rig.leftLowerArm, -0.64, 0.06, -0.22);
      poseBone(rig, rig.leftHand, 0.1, 0.08, 0);
      poseBone(rig, rig.rightShoulder, 0.06, -0.06, 0.2);
      poseBone(rig, rig.rightUpperArm, 0.02, -0.12, 0.98);
      poseBone(rig, rig.rightLowerArm, -0.14, 0, 0.18);
      break;
    case "thinking":
      poseBone(rig, rig.neck, -0.12, -0.04, 0.02);
      poseBone(rig, rig.head, -0.18, -0.08, 0.04);
      poseBone(rig, rig.rightShoulder, 0.14, -0.18, 0.28);
      poseBone(rig, rig.rightUpperArm, -0.8, -0.2, 0.68);
      poseBone(rig, rig.rightLowerArm, -1.05, 0.2, 0.28);
      poseBone(rig, rig.rightHand, 0.18, 0.16, 0);
      poseBone(rig, rig.leftShoulder, 0.04, 0.04, -0.18);
      poseBone(rig, rig.leftUpperArm, -0.14, 0.1, -0.98);
      poseBone(rig, rig.leftLowerArm, -0.22, 0, -0.18);
      break;
    case "speaking":
      poseBone(rig, rig.neck, nod * 0.45, gesture * 0.12, 0);
      poseBone(rig, rig.head, nod, gesture * 0.18, 0);
      poseBone(rig, rig.leftShoulder, 0.08 + handPulse * 0.2, 0.1, -0.14);
      poseBone(rig, rig.leftUpperArm, -0.42 + gesture * 0.3, 0.18, -0.72);
      poseBone(rig, rig.leftLowerArm, -0.56 + handPulse * 0.28, 0.1, -0.14);
      poseBone(rig, rig.leftHand, handPulse * 0.3, 0.08, 0);
      poseBone(rig, rig.rightShoulder, 0.06 - handPulse * 0.18, -0.08, 0.14);
      poseBone(rig, rig.rightUpperArm, -0.34 - gesture * 0.26, -0.16, 0.72);
      poseBone(rig, rig.rightLowerArm, -0.48 - handPulse * 0.24, -0.08, 0.14);
      poseBone(rig, rig.rightHand, handPulse * 0.22, -0.08, 0);
      break;
    case "alert":
      poseBone(rig, rig.neck, -0.02, 0, 0);
      poseBone(rig, rig.head, -0.02, 0, 0);
      poseBone(rig, rig.leftShoulder, 0.12, 0.16, -0.12);
      poseBone(rig, rig.leftUpperArm, -0.22, 0.3, -0.2);
      poseBone(rig, rig.leftLowerArm, -0.3, 0.12, 0.08);
      poseBone(rig, rig.rightShoulder, 0.12, -0.16, 0.12);
      poseBone(rig, rig.rightUpperArm, -0.22, -0.3, 0.2);
      poseBone(rig, rig.rightLowerArm, -0.3, -0.12, -0.08);
      break;
    case "ready":
      poseBone(rig, rig.neck, -0.01, 0, 0);
      poseBone(rig, rig.head, 0.02, 0, 0);
      poseBone(rig, rig.leftUpperArm, -0.16, 0.08, -0.06);
      poseBone(rig, rig.leftLowerArm, -0.18, 0, 0.02);
      poseBone(rig, rig.rightUpperArm, -0.16, -0.08, 0.06);
      poseBone(rig, rig.rightLowerArm, -0.18, 0, -0.02);
      break;
    case "idle":
    default:
      poseBone(rig, rig.neck, 0, 0.02, 0);
      poseBone(rig, rig.head, breath * 0.6, 0.04, 0);
      poseBone(rig, rig.leftShoulder, 0.02, 0.02, -0.12);
      poseBone(rig, rig.leftUpperArm, -0.12, 0.04, -1.02);
      poseBone(rig, rig.leftLowerArm, -0.12, 0, -0.12);
      poseBone(rig, rig.rightShoulder, 0.02, -0.02, 0.12);
      poseBone(rig, rig.rightUpperArm, -0.12, -0.04, 1.02);
      poseBone(rig, rig.rightLowerArm, -0.12, 0, 0.12);
      break;
  }

  if (speechSpeaking && state !== "speaking") {
    poseBone(rig, rig.head, nod * 0.55, 0.06, 0);
  }
}

async function fetchAvatarBuffer(url: string) {
  let response: Response;

  try {
    response = await fetch(url, { cache: "force-cache" });
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Network fetch failed for ${url}: ${error.message}`
        : `Network fetch failed for ${url}.`,
    );
  }

  if (!response.ok) {
    throw new Error(`Avatar fetch failed for ${url} with ${response.status} ${response.statusText}`.trim());
  }

  try {
    return await response.arrayBuffer();
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not read avatar bytes from ${url}: ${error.message}`
        : `Could not read avatar bytes from ${url}.`,
    );
  }
}

async function parseAvatarScene(data: ArrayBuffer, url: string) {
  try {
    const loader = new GLTFLoader();
    return await loader.parseAsync(data, window.location.origin + "/");
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Fast preview parse failed for ${url}: ${error.message}`
        : `Fast preview parse failed for ${url}.`,
    );
  }
}

async function parseAvatarVrm(data: ArrayBuffer, url: string) {
  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    return await loader.parseAsync(data, window.location.origin + "/");
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `VRM parse failed for ${url}: ${error.message}`
        : `VRM parse failed for ${url}.`,
    );
  }
}

async function loadMiladyAvatar(root: THREE.Group): Promise<LoadedAvatar> {
  const fastPreview = isDesktopPreviewSession();
  const errors: string[] = [];

  for (const sourceUrl of YUKI_ASSET_CANDIDATES) {
    try {
      const data = await fetchAvatarBuffer(sourceUrl);
      try {
        const gltf = await parseAvatarVrm(data, sourceUrl);
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (!vrm) {
          throw new Error(`VRM metadata missing for ${sourceUrl}.`);
        }
        normalizeAvatarScene(root, vrm.scene);

        if (vrm.lookAt) {
          vrm.lookAt.target = root;
        }

        return {
          vrm,
          scene: vrm.scene,
          mode: "vrm",
          sourceUrl,
        };
      } catch (vrmError) {
        if (!fastPreview) {
          throw vrmError;
        }
      }

      const gltf = await parseAvatarScene(data, sourceUrl);
      if (fastPreview) {
        prepareDesktopPreviewMaterials(gltf.scene);
      }
      tuneSceneFaceMaterials(gltf.scene);
      normalizeAvatarScene(root, gltf.scene);
      return {
        vrm: null,
        scene: gltf.scene,
        mode: "scene",
        sourceUrl,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Unknown avatar load error for ${sourceUrl}.`);
    }
  }

  throw new Error(errors.join(" | "));
}

function createFallbackBody(): FallbackRig {
  const group = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x77d9ff,
    emissive: 0x0f2840,
    roughness: 0.45,
    metalness: 0.12,
  });

  const headMaterial = bodyMaterial.clone();

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 8, 16), bodyMaterial);
  body.position.set(0, 0.78, 0);
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 24), headMaterial);
  head.position.set(0, 1.38, 0.02);
  group.add(head);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 20, 20),
    new THREE.MeshStandardMaterial({
      color: 0xdffcff,
      emissive: 0x78f6e3,
      emissiveIntensity: 1.4,
      transparent: true,
      opacity: 0.92,
    }),
  );
  core.position.set(0, 0.95, 0.18);
  group.add(core);

  return { group, head, body, core };
}

function buildWorkerSummary(sessions: CodingSessionSnapshot[]): string {
  if (sessions.length === 0) {
    return "No active workers yet. Ask Hermes to open Claude or Codex and they will appear here in-space.";
  }

  return sessions
    .slice(0, 3)
    .map((session) => {
      const label = session.workerLabel ?? session.title;
      const status = session.waitingOnUser ? "waiting on you" : session.workerPhase ?? session.status;
      return `${label}: ${status}`;
    })
    .join("  •  ");
}

function normalizeWorkerStatus(session: CodingSessionSnapshot): string {
  if (session.waitingOnUser) {
    return "waiting on you";
  }
  if (session.workerPhase) {
    return session.workerPhase.replaceAll("_", " ");
  }
  return session.status;
}

function compactText(value: string | null | undefined, fallback: string, limit = 110): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return fallback;
  }
  if (cleaned.length <= limit) {
    return cleaned;
  }
  return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

function stageDebugEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("stageDebug") === "1";
  } catch {
    return false;
  }
}

function buildDecisionBoard(leadSession: CodingSessionSnapshot | undefined, sessions: CodingSessionSnapshot[]): string {
  const pendingSessions = sessions.filter((session) => session.waitingOnUser);
  const blockedSessions = sessions.filter(
    (session) => session.workerPhase === "blocked" || session.status === "failed",
  );
  const reviewSessions = sessions.filter((session) => session.needsReview);
  const doneSessions = sessions.filter((session) => session.workerPhase === "done");

  if (leadSession?.waitingOnUser) {
    return [
      `Priority: ${leadSession.workerLabel ?? leadSession.title}.`,
      compactText(leadSession.pendingQuestion, "Worker is waiting for a manager decision.", 110),
      "Reply through Hermes first.",
    ].join(" ");
  }

  const lines = [
    `${pendingSessions.length} waiting`,
    `${blockedSessions.length} blocked`,
    `${reviewSessions.length} review`,
    `${doneSessions.length} done`,
  ];
  const attentionTarget =
    blockedSessions[0] ?? reviewSessions[0] ?? sessions[0];

  if (!attentionTarget) {
    return "No workers need intervention yet. Hermes is free to open Claude or Codex when you ask.";
  }

  return [
    `${lines.join("  •  ")}.`,
    `${attentionTarget.workerLabel ?? attentionTarget.title} is ${normalizeWorkerStatus(attentionTarget)}.`,
    compactText(
      attentionTarget.managerSummary ?? attentionTarget.lastUpdate,
      "Hermes has not surfaced a higher-priority worker update yet.",
      96,
    ),
  ].join(" ");
}

function buildWorkerBoard(leadSession: CodingSessionSnapshot | undefined, sessions: CodingSessionSnapshot[]): string {
  if (sessions.length === 0) {
    return "No active workers yet. Ask Hermes to open Claude or Codex and the board will show their live task, phase, and decisions here.";
  }

  const lines = sessions.slice(0, 4).map((session) => {
    const label = session.workerLabel ?? session.title;
    const task = compactText(
      session.taskTitle ?? session.lastUpdate ?? session.managerSummary,
      "No task summary yet.",
      44,
    );
    return `${label} · ${normalizeWorkerStatus(session)} · ${task}`;
  });

  const suffix =
    leadSession?.pendingQuestion
      ? ` Priority: ${compactText(leadSession.pendingQuestion, "Waiting for your decision.", 64)}`
      : "";

  return `${lines.join("  |  ")}.${suffix}`;
}

function buildActionBoard(
  leadSession: CodingSessionSnapshot | undefined,
  sessions: CodingSessionSnapshot[],
  xrState: XRState,
  avatarStatus: AvatarLoadState,
) {
  const liveCount = sessions.length;
  const pendingCount = sessions.filter((session) => session.waitingOnUser).length;
  const blockedCount = sessions.filter(
    (session) => session.workerPhase === "blocked" || session.status === "failed",
  ).length;

  if (leadSession?.waitingOnUser) {
    return [
      `Reply to ${leadSession.workerLabel ?? leadSession.title}.`,
      compactText(leadSession.pendingQuestion, "A worker is waiting on your decision.", 88),
      `${liveCount} live · ${pendingCount} pending · ${blockedCount} blocked.`,
    ].join(" ");
  }

  if (blockedCount > 0) {
    return [
      "Inspect the blocked worker next.",
      `${liveCount} live · ${pendingCount} pending · ${blockedCount} blocked.`,
      "Keep routing through Hermes.",
    ].join(" ");
  }

  return [
    `${liveCount} live · ${pendingCount} pending · ${blockedCount} blocked.`,
    `XR ${xrStatusTitle(xrState).toLowerCase()}. Avatar ${avatarStatusTitle(avatarStatus).toLowerCase()}.`,
    "Ready for monitoring, approvals, and worker focus.",
  ].join(" ");
}

function avatarStatusTitle(status: AvatarLoadState): string {
  switch (status) {
    case "ready":
      return "Yuki avatar ready";
    case "fallback":
      return "Fallback shell active";
    default:
      return "Loading Yuki avatar";
  }
}

function xrStatusTitle(status: XRState): string {
  switch (status) {
    case "ready":
      return "XR ready on Quest";
    case "entering":
      return "Entering XR";
    case "active":
      return "XR session live";
    case "unsupported":
      return "XR unavailable here";
    case "failed":
      return "XR entry failed";
    default:
      return "Checking XR support";
  }
}

function getXRSystem(): XRSystem | null {
  const candidate = navigator as Navigator & { xr?: XRSystem };
  return candidate.xr ?? null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function hasLocalDesktopXrEmulator(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src="/@iwer-injection-runtime"]'));
}

function isDesktopPreviewSession(): boolean {
  return isLoopbackHost(window.location.hostname);
}

function applySceneMode(scene: THREE.Scene, mode: SessionMode | null) {
  if (mode === SessionMode.ImmersiveAR) {
    scene.background = null;
    scene.fog = null;
    return;
  }

  scene.background = new THREE.Color(SCENE_BACKGROUND);
  scene.fog = new THREE.Fog(SCENE_BACKGROUND, 4.5, 9.5);
}

function applyRuntimeSceneMode(runtime: StageRuntime, mode: SessionMode) {
  runtime.sceneMode = mode;
  applySceneMode(runtime.scene, mode);
  const flatGroundVisible = mode !== SessionMode.ImmersiveAR;
  runtime.floor.visible = flatGroundVisible;
  runtime.platform.visible = flatGroundVisible;
  runtime.auraRing.visible = flatGroundVisible;
}

function applyDesktopPreviewLayout(runtime: StageRuntime) {
  runtime.camera.position.copy(DESKTOP_STAGE_LAYOUT.cameraPosition);
  runtime.camera.lookAt(DESKTOP_STAGE_LAYOUT.cameraLookAt);
  runtime.assistantRoot.position.set(0, DESKTOP_STAGE_LAYOUT.assistantY, DESKTOP_STAGE_LAYOUT.assistantZ);
  runtime.auraRing.position.copy(DESKTOP_STAGE_LAYOUT.auraRing);
  runtime.auraShell.position.copy(DESKTOP_STAGE_LAYOUT.auraShell);
  runtime.beacon.position.copy(DESKTOP_STAGE_LAYOUT.beacon);
  runtime.auraRing.visible = false;
  runtime.auraShell.visible = false;
  runtime.beacon.material.opacity = 0.28;
  runtime.panels.summary.mesh.position.copy(DESKTOP_STAGE_LAYOUT.summaryPanel);
  runtime.panels.worker.mesh.position.copy(DESKTOP_STAGE_LAYOUT.workerPanel);
  runtime.panels.status.mesh.position.copy(DESKTOP_STAGE_LAYOUT.statusPanel);
  runtime.panels.summary.mesh.scale.setScalar(DESKTOP_STAGE_LAYOUT.panelScale);
  runtime.panels.worker.mesh.scale.setScalar(DESKTOP_STAGE_LAYOUT.panelScale);
  runtime.panels.status.mesh.scale.setScalar(DESKTOP_STAGE_LAYOUT.panelScale * 1.08);
  runtime.panels.summary.mesh.visible = false;
  runtime.panels.worker.mesh.visible = false;
  runtime.panels.status.mesh.visible = false;
}

function isDesktopPreviewActive(runtime?: StageRuntime | null): boolean {
  return isLoopbackHost(window.location.hostname) || Boolean(runtime?.desktopPreview);
}

function stateFeedback(state: CharacterState): string {
  switch (state) {
    case "listening":
      return "Yuki is leaning in and holding for your instruction.";
    case "working":
      return "Yuki is in focused follow-through while Hermes tracks the workers.";
    case "alert":
      return "Yuki is surfacing something blocked or waiting on you.";
    case "ready":
      return "Yuki is calm and ready with the next update.";
    default:
      return "Yuki is idling in-place while Hermes stays on standby.";
  }
}

function deriveAnimationState(
  characterState: CharacterState,
  avatarMode: AvatarMode,
  speechSpeaking: boolean,
): AnimationState {
  if (speechSpeaking || avatarMode === "speaking") {
    return "speaking";
  }
  if (characterState === "alert") {
    return "alert";
  }
  if (avatarMode === "thinking") {
    return "thinking";
  }
  if (characterState === "ready") {
    return "ready";
  }
  if (characterState === "listening" || avatarMode === "listening") {
    return "listening";
  }
  return "idle";
}

function animationFeedback(state: AnimationState): string {
  switch (state) {
    case "speaking":
      return "Yuki is actively voicing Hermes back to you.";
    case "thinking":
      return "Yuki is in the thinking hold while Hermes plans the next move.";
    case "listening":
      return "Yuki is holding for your next instruction.";
    case "alert":
      return "Yuki is surfacing an important worker interruption.";
    case "ready":
      return "Yuki has landed on a stable next step and is ready.";
    default:
      return "Yuki is idling while Hermes monitors the workspace.";
  }
}

function motionProfile(state: AnimationState) {
  switch (state) {
    case "listening":
      return {
        bobAmplitude: 0.04,
        bobSpeed: 1.8,
        swayAmplitude: 0.2,
        swaySpeed: 0.95,
        lean: -0.06,
        ringPulse: 0.09,
        ringSpeed: 3.8,
        ringOpacity: 0.86,
        shellPulse: 0.12,
        shellOpacity: 0.2,
        shellSpeed: 2.8,
        beaconPulse: 0.28,
        beaconSpeed: 4.6,
        beaconIntensity: 2.4,
        lightIntensity: 2.15,
        headTilt: 0.08,
        jitter: 0,
        shoulderRoll: 0.04,
        focusLift: 0.03,
      };
    case "thinking":
      return {
        bobAmplitude: 0.03,
        bobSpeed: 1.5,
        swayAmplitude: 0.18,
        swaySpeed: 0.9,
        lean: -0.03,
        ringPulse: 0.1,
        ringSpeed: 3.7,
        ringOpacity: 0.84,
        shellPulse: 0.11,
        shellOpacity: 0.18,
        shellSpeed: 2.7,
        beaconPulse: 0.25,
        beaconSpeed: 4.1,
        beaconIntensity: 2.2,
        lightIntensity: 1.95,
        headTilt: 0.09,
        jitter: 0,
        shoulderRoll: 0.05,
        focusLift: 0.05,
      };
    case "speaking":
      return {
        bobAmplitude: 0.045,
        bobSpeed: 2.4,
        swayAmplitude: 0.22,
        swaySpeed: 1.3,
        lean: -0.07,
        ringPulse: 0.12,
        ringSpeed: 5.2,
        ringOpacity: 0.9,
        shellPulse: 0.15,
        shellOpacity: 0.24,
        shellSpeed: 4.6,
        beaconPulse: 0.38,
        beaconSpeed: 7.1,
        beaconIntensity: 2.9,
        lightIntensity: 2.2,
        headTilt: 0.12,
        jitter: 0.01,
        shoulderRoll: 0.08,
        focusLift: 0.08,
      };
    case "alert":
      return {
        bobAmplitude: 0.016,
        bobSpeed: 2.4,
        swayAmplitude: 0.08,
        swaySpeed: 1.2,
        lean: -0.02,
        ringPulse: 0.14,
        ringSpeed: 5.6,
        ringOpacity: 0.92,
        shellPulse: 0.14,
        shellOpacity: 0.24,
        shellSpeed: 4.2,
        beaconPulse: 0.34,
        beaconSpeed: 6,
        beaconIntensity: 2.8,
        lightIntensity: 2.35,
        headTilt: 0.12,
        jitter: 0.018,
        shoulderRoll: 0.06,
        focusLift: 0.06,
      };
    case "ready":
      return {
        bobAmplitude: 0,
        bobSpeed: 1.2,
        swayAmplitude: 0,
        swaySpeed: 0.62,
        lean: 0,
        ringPulse: 0.05,
        ringSpeed: 2.2,
        ringOpacity: 0.74,
        shellPulse: 0.08,
        shellOpacity: 0.14,
        shellSpeed: 1.8,
        beaconPulse: 0.18,
        beaconSpeed: 2.4,
        beaconIntensity: 1.7,
        lightIntensity: 1.8,
        headTilt: 0.04,
        jitter: 0,
        shoulderRoll: 0.03,
        focusLift: 0.02,
      };
    default:
      return {
        bobAmplitude: 0,
        bobSpeed: 1.05,
        swayAmplitude: 0,
        swaySpeed: 0.5,
        lean: 0,
        ringPulse: 0.04,
        ringSpeed: 1.8,
        ringOpacity: 0.68,
        shellPulse: 0.06,
        shellOpacity: 0.12,
        shellSpeed: 1.5,
        beaconPulse: 0.14,
        beaconSpeed: 2,
        beaconIntensity: 1.4,
        lightIntensity: 1.65,
        headTilt: 0.03,
        jitter: 0,
        shoulderRoll: 0.02,
        focusLift: 0.01,
      };
  }
}

export function ImmersiveHermesStage({
  characterState,
  avatarMode,
  tone,
  title,
  subtitle,
  latestSummary,
  speechPulseAt,
  speechSpeaking,
  latestTranscript,
  leadSession,
  sessions,
}: ImmersiveHermesStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<StageRuntime | null>(null);
  const xrSessionRef = useRef<XRSession | null>(null);
  const xrSessionEndHandlerRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const xrProbeTokenRef = useRef(0);
  const xrModeRef = useRef<SessionMode>(SessionMode.ImmersiveVR);
  const stateRef = useRef(characterState);
  const avatarModeRef = useRef(avatarMode);
  const speechPulseRef = useRef(speechPulseAt);
  const speechSpeakingRef = useRef(speechSpeaking);
  const toneRef = useRef(tone);

  const [avatarStatus, setAvatarStatus] = useState<AvatarLoadState>("loading");
  const [avatarMessage, setAvatarMessage] = useState(
    "Loading the Quest-stage VRM. Hermes can still drive the stage if Yuki falls back.",
  );
  const [xrState, setXrState] = useState<XRState>("checking");
  const [xrMessage, setXrMessage] = useState(
    "Checking whether this browser can enter immersive mode safely.",
  );
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageGeneration, setStageGeneration] = useState(0);

  useEffect(() => {
    stateRef.current = characterState;
  }, [characterState]);

  useEffect(() => {
    avatarModeRef.current = avatarMode;
  }, [avatarMode]);

  useEffect(() => {
    speechPulseRef.current = speechPulseAt;
  }, [speechPulseAt]);

  useEffect(() => {
    speechSpeakingRef.current = speechSpeaking;
  }, [speechSpeaking]);

  useEffect(() => {
    toneRef.current = tone;
  }, [tone]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function checkXRSupport() {
    const probeToken = ++xrProbeTokenRef.current;
    if (!mountedRef.current) {
      return;
    }

    setXrState("checking");
    setXrMessage("Checking WebXR support and secure context requirements.");

    if (!window.isSecureContext && !isLoopbackHost(window.location.hostname)) {
      setXrState("failed");
      setXrMessage("Quest Browser requires HTTPS or localhost before immersive XR can start.");
      return;
    }

    const xr = getXRSystem();
    if (!xr) {
      if (isDesktopPreviewSession() && hasLocalDesktopXrEmulator()) {
        xrModeRef.current = SessionMode.ImmersiveVR;
        setXrState("ready");
        setXrMessage("Desktop Meta XR emulator is active on localhost. The fake headset preview is ready.");
        return;
      }
      setXrState("unsupported");
      setXrMessage("This browser does not expose navigator.xr, so immersive mode cannot start.");
      return;
    }

    try {
      const supportsAr = await xr.isSessionSupported(SessionMode.ImmersiveAR).catch(() => false);
      const supported = supportsAr || (await xr.isSessionSupported(SessionMode.ImmersiveVR));
      if (!mountedRef.current || probeToken !== xrProbeTokenRef.current || xrSessionRef.current !== null) {
        return;
      }
      if (!supported) {
        if (isDesktopPreviewSession() && hasLocalDesktopXrEmulator()) {
          xrModeRef.current = SessionMode.ImmersiveVR;
          setXrState("ready");
          setXrMessage("Desktop Meta XR emulator is active on localhost. The fake headset preview is ready.");
          return;
        }
        setXrState("unsupported");
        setXrMessage("Immersive VR is not reported as supported in this browser session.");
        return;
      }
      xrModeRef.current = supportsAr ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR;
      setXrState("ready");
      setXrMessage(
        supportsAr
          ? "Mixed reality entry is ready. Quest can try passthrough-style placement first, then fall back to VR if needed."
          : "XR entry is ready. Open this from Quest Browser and enter once the scene looks stable.",
      );
    } catch (error) {
      if (!mountedRef.current || probeToken !== xrProbeTokenRef.current || xrSessionRef.current !== null) {
        return;
      }
      const detail = error instanceof Error ? error.message : "Unknown WebXR support probe failure.";
      setXrState("failed");
      setXrMessage(`Could not verify WebXR support: ${detail}`);
    }
  }

  async function enterXR() {
    if (stageError) {
      return;
    }

    if (xrState === "failed" || xrState === "unsupported") {
      await checkXRSupport();
      return;
    }

    if (xrState !== "ready") {
      return;
    }

    const runtime = runtimeRef.current;
    const xr = getXRSystem();
    if (!runtime || !xr) {
      setXrState("failed");
      setXrMessage("XR runtime is not ready yet. Wait for the stage to finish initializing.");
      return;
    }

    setXrState("entering");
    setXrMessage("Requesting immersive session from the browser.");

    try {
      const sessionMode = xrModeRef.current;
      const session = await xr.requestSession(
        sessionMode,
        buildSessionInit({
          sessionMode,
          referenceSpace: XR_REFERENCE_SPACE,
          features: XR_STAGE_FEATURES,
        }),
      );
      const referenceSpace = normalizeReferenceSpec(XR_REFERENCE_SPACE);
      const webXRManager = runtime.renderer.xr as THREE.WebXRManager & {
        getDepthSensingMesh?: () => THREE.Mesh | null;
      };
      const handleSessionEnd = () => {
        if (!mountedRef.current) {
          return;
        }
        xrSessionRef.current?.removeEventListener("end", handleSessionEnd);
        xrSessionRef.current = null;
        xrSessionEndHandlerRef.current = null;
        runtime.world.session = undefined;
        applyRuntimeSceneMode(runtime, SessionMode.ImmersiveVR);
        setXrState("ready");
        setXrMessage("XR session ended. The stage is ready to re-enter.");
      };

      xrSessionRef.current = session;
      xrSessionEndHandlerRef.current = handleSessionEnd;
      session.addEventListener("end", handleSessionEnd);
      if (webXRManager.getDepthSensingMesh) {
        webXRManager.getDepthSensingMesh = () => null;
      }
      const resolvedSpace = await resolveReferenceSpaceType(
        session,
        referenceSpace.type,
        referenceSpace.required ? [] : referenceSpace.fallbackOrder,
      );
      webXRManager.setReferenceSpaceType(resolvedSpace);
      applyRuntimeSceneMode(runtime, sessionMode);
      await webXRManager.setSession(session);
      runtime.world.session = session;

      if (!mountedRef.current) {
        return;
      }
      setXrState("active");
      setXrMessage(
        sessionMode === SessionMode.ImmersiveAR
          ? "Mixed reality session live. If passthrough looks wrong, recentre from the Quest system menu or retry in VR."
          : "XR session live. If the floor feels low, recentre from the Quest system menu.",
      );
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      const detail = error instanceof Error ? error.message : "Unknown XR session failure.";
      setXrState("failed");
      setXrMessage(`Could not enter immersive mode: ${detail}`);
    }
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    mountedRef.current = true;
    let disposed = false;
    let runtime: StageRuntime | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let handleContextLost: ((event: Event) => void) | null = null;
    let handleContextRestored: (() => void) | null = null;
    let xrSessionEndHandler: (() => void) | null = null;

    const bootWorld = async () => {
      setStageError(null);
      setAvatarStatus("loading");
      setAvatarMessage("Booting the Meta IWSDK stage and loading Yuki.");

      let world: World;
      try {
        world = await World.create(host, {
          xr: {
            offer: "none",
            sessionMode: SessionMode.ImmersiveVR,
            referenceSpace: XR_REFERENCE_SPACE,
            features: XR_STAGE_FEATURES,
          },
          render: {
            fov: 42,
            near: 0.01,
            far: 100,
            defaultLighting: false,
          },
          features: {
            spatialUI: false,
            grabbing: false,
            locomotion: false,
            physics: false,
            sceneUnderstanding: false,
            environmentRaycast: false,
            camera: false,
          },
        });
      } catch (error) {
        if (!mountedRef.current || disposed) {
          return;
        }
        const detail = error instanceof Error ? error.message : "Unknown IWSDK world initialization failure.";
        setStageError(`IWSDK could not initialize the Quest stage: ${detail}`);
        setAvatarStatus("fallback");
        setAvatarMessage("The immersive world did not start. Keep using the flat shell until the stage is refreshed.");
        setXrState("failed");
        setXrMessage("XR entry is disabled because the IWSDK world could not initialize.");
        return;
      }

      if (disposed || !mountedRef.current) {
        world.renderer.setAnimationLoop(null);
        world.renderer.dispose();
        host.replaceChildren();
        return;
      }

      const { scene, camera, renderer } = world;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(host.clientWidth, host.clientHeight);
      const desktopPreview = isDesktopPreviewSession();
      world.player.position.set(0, 0, 0);
      if (desktopPreview) {
        camera.position.copy(DESKTOP_STAGE_LAYOUT.cameraPosition);
        camera.lookAt(DESKTOP_STAGE_LAYOUT.cameraLookAt);
      } else {
        camera.position.set(0, 1.48, 2.18);
        camera.lookAt(0, 1.02, -0.1);
      }

      handleContextLost = (event: Event) => {
        event.preventDefault();
        if (!mountedRef.current) {
          return;
        }
        setStageError("The Quest WebGL context was lost. Waiting for the browser to restore the stage.");
        setAvatarStatus("fallback");
        setAvatarMessage("Yuki paused because the XR graphics context dropped. The stage will rebuild if the browser restores it.");
        setXrState("failed");
        setXrMessage("The XR graphics context was lost. If this does not recover on its own, refresh the page.");
      };

      handleContextRestored = () => {
        if (!mountedRef.current) {
          return;
        }
        setStageError(null);
        setAvatarStatus("loading");
        setAvatarMessage("WebGL restored. Rebuilding the IWSDK stage and Yuki.");
        setXrState("checking");
        setXrMessage("WebGL restored. Rechecking XR support before re-entry.");
        setStageGeneration((current) => current + 1);
      };

      renderer.domElement.addEventListener("webglcontextlost", handleContextLost, false);
      renderer.domElement.addEventListener("webglcontextrestored", handleContextRestored, false);

      const hemiLight = new THREE.HemisphereLight(0xcff5ff, 0x091521, 1.8);
      scene.add(hemiLight);

      const fillLight = new THREE.DirectionalLight(0x88d5ff, 1.8);
      fillLight.position.set(1.8, 2.3, 2.1);
      scene.add(fillLight);

      const rimLight = new THREE.PointLight(0x63fff2, 6, 8, 2);
      rimLight.position.set(-1.4, 1.6, -1.1);
      scene.add(rimLight);

      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(3.4, 64),
        new THREE.MeshStandardMaterial({
          color: 0x0a1b2a,
          roughness: 0.94,
          metalness: 0.08,
        }),
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.001;
      scene.add(floor);

      const platform = new THREE.Mesh(
        new THREE.CircleGeometry(0.7, 48),
        new THREE.MeshBasicMaterial({
          color: 0x1b9cff,
          transparent: true,
          opacity: 0.12,
        }),
      );
      platform.rotation.x = -Math.PI / 2;
      platform.position.y = 0.01;
      scene.add(platform);

      const assistantRoot = new THREE.Group();
      assistantRoot.position.set(0, ASSISTANT_BASE_Y, STAGE_DEPTH);
      scene.add(assistantRoot);

      const fallbackRig = createFallbackBody();
      assistantRoot.add(fallbackRig.group);

      const lookTarget = new THREE.Object3D();
      scene.add(lookTarget);

      const auraRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.62, 0.018, 24, 128),
        new THREE.MeshStandardMaterial({
          color: toneColor(toneRef.current),
          emissive: toneColor(toneRef.current),
          emissiveIntensity: 1.1,
          transparent: true,
          opacity: 0.58,
        }),
      );
      auraRing.rotation.x = Math.PI / 2;
      auraRing.position.set(0, 0.03, STAGE_DEPTH + 0.02);
      scene.add(auraRing);

      const auraShell = new THREE.Mesh(
        new THREE.SphereGeometry(0.52, 28, 28),
        new THREE.MeshStandardMaterial({
          color: stateAccent(stateRef.current),
          emissive: stateAccent(stateRef.current),
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0.05,
          roughness: 0.3,
          metalness: 0.08,
        }),
      );
      auraShell.position.set(0, 1.28, STAGE_DEPTH - 0.06);
      scene.add(auraShell);

      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 20, 20),
        new THREE.MeshStandardMaterial({
          color: 0xebffff,
          emissive: stateAccent(stateRef.current),
          emissiveIntensity: 2,
          transparent: true,
          opacity: 0.95,
        }),
      );
      beacon.position.set(0, 1.28, STAGE_DEPTH + 0.1);
      scene.add(beacon);

      const panels = {
        summary: createPanel(new THREE.Vector3(-1.38, 1.02, PANEL_DEPTH), Math.PI / 9, [1, 0.68]),
        worker: createPanel(new THREE.Vector3(1.38, 0.96, PANEL_DEPTH), -Math.PI / 9, [1, 0.68]),
        status: createPanel(new THREE.Vector3(0, 2.34, PANEL_DEPTH - 0.12), 0, [0.84, 0.34]),
      };
      Object.values(panels).forEach((panel) => {
        scene.add(panel.mesh);
      });

      runtime = {
        world,
        renderer,
        scene,
        sceneMode: SessionMode.ImmersiveVR,
        desktopPreview,
        camera,
        floor,
        platform,
        assistantRoot,
        lookTarget,
        auraRing,
        auraShell,
        beacon,
        fallbackRig,
        fillLight,
        panels,
        vrm: null,
        avatarScene: null,
        avatarMode: null,
        avatarRig: null,
        avatarAnimations: null,
        avatarMorphs: null,
      };
      runtimeRef.current = runtime;
      window.__xrStageDebug = {
        runtime,
        xrState: "checking",
        avatarStatus: "loading",
      };
      if (runtime && isLoopbackHost(window.location.hostname)) {
        applyDesktopPreviewLayout(runtime);
      }
      if (runtime) {
        applyRuntimeSceneMode(runtime, SessionMode.ImmersiveVR);
      }

      const clock = new THREE.Clock();

      xrSessionEndHandler = () => {
        const liveRuntime = runtimeRef.current;
        if (!mountedRef.current || !liveRuntime) {
          return;
        }
        xrSessionRef.current?.removeEventListener("end", xrSessionEndHandler!);
        xrSessionRef.current = null;
        xrSessionEndHandlerRef.current = null;
        liveRuntime.world.session = undefined;
        applyRuntimeSceneMode(liveRuntime, SessionMode.ImmersiveVR);
        setXrState("ready");
        setXrMessage("XR session ended. The stage is ready to re-enter.");
      };

      void checkXRSupport();

      loadMiladyAvatar(assistantRoot)
        .then((avatar) => {
          if (!runtimeRef.current || disposed || !mountedRef.current) {
            return;
          }
          runtimeRef.current.fallbackRig.group.visible = false;
          avatar.scene.visible = true;
          runtimeRef.current.vrm = avatar.vrm;
          runtimeRef.current.avatarScene = avatar.scene;
          runtimeRef.current.avatarMode = avatar.mode;
          runtimeRef.current.avatarRig = captureAvatarRig(avatar.scene, avatar.vrm);
          runtimeRef.current.avatarMorphs =
            avatar.mode === "scene" ? captureSceneMorphController(avatar.scene) : null;
          if (avatar.vrm?.humanoid) {
            avatar.vrm.humanoid.autoUpdateHumanBones = false;
          }
          runtimeRef.current.avatarAnimations = null;
          void loadPrototypeAnimationController(avatar.scene)
            .then((controller) => {
              if (!controller || !runtimeRef.current || disposed || !mountedRef.current) {
                return;
              }
              runtimeRef.current.avatarAnimations = controller;
              setAvatarClipState(controller, "idle");
            })
            .catch((error: unknown) => {
              console.warn("Could not load prototype Yuki body clips.", error);
            });
          setAvatarStatus("ready");
          setAvatarMessage(
            avatar.mode === "vrm"
              ? `Yuki VRM loaded from ${avatar.sourceUrl}. Keeping VRM materials for the face while body clips and morph targets drive the stage performance.`
              : `Yuki loaded from ${avatar.sourceUrl} with body clips and face morph targets ready for Quest stage performance.`,
          );
        })
        .catch((error: unknown) => {
          console.error("Failed to load Yuki VRM for Quest stage.", error);
          if (runtimeRef.current && mountedRef.current) {
            runtimeRef.current.fallbackRig.group.visible = true;
            setAvatarStatus("fallback");
            setAvatarMessage(
              error instanceof Error
                ? `Yuki VRM failed to load. Staying on the fallback shell. ${error.message}`
                : "Yuki VRM failed to load. Staying on the fallback shell.",
            );
          }
        });

      const animate = () => {
        const live = runtimeRef.current;
        if (!live) {
          return;
        }
        window.__xrStageDebug = {
          runtime: live,
          xrState,
          avatarStatus,
        };

        const delta = clock.getDelta();
        const elapsed = clock.elapsedTime;
        live.world.visibilityState.value = live.world.session
          ? (live.world.session.visibilityState as VisibilityState)
          : VisibilityState.NonImmersive;
        live.world.update(delta, elapsed);

        if (live.world.session && live.world.session !== xrSessionRef.current) {
          if (xrSessionRef.current && xrSessionEndHandler) {
            xrSessionRef.current.removeEventListener("end", xrSessionEndHandler);
          }
          xrSessionRef.current = live.world.session;
          xrSessionEndHandlerRef.current = xrSessionEndHandler;
          if (xrSessionEndHandler) {
            xrSessionRef.current.addEventListener("end", xrSessionEndHandler);
          }
          if (mountedRef.current) {
            setXrState("active");
            setXrMessage(
              xrModeRef.current === SessionMode.ImmersiveAR
                ? "Mixed reality session live. If passthrough looks wrong, recentre from the Quest system menu or retry in VR."
                : "XR session live. If the floor feels low, recentre from the Quest system menu.",
            );
          }
        }

        const animationState = deriveAnimationState(
          stateRef.current,
          avatarModeRef.current,
          speechSpeakingRef.current,
        );
        const clipState = mapClipState(animationState);
        const motion = motionProfile(animationState);
        const accent = toneColor(toneRef.current);
        const stateAccentColor = stateAccent(stateRef.current);
        const bob = Math.sin(elapsed * motion.bobSpeed) * motion.bobAmplitude;
        const sway = Math.sin(elapsed * motion.swaySpeed) * motion.swayAmplitude;
        const jitter =
          motion.jitter > 0 ? Math.sin(elapsed * 16) * motion.jitter + Math.cos(elapsed * 11) * motion.jitter * 0.4 : 0;

        const desktopPreviewActive = isDesktopPreviewActive(live);
        const assistantBaseY = live.sceneMode === SessionMode.ImmersiveAR ? 0 : desktopPreviewActive ? DESKTOP_STAGE_LAYOUT.assistantY : ASSISTANT_BASE_Y;
        live.assistantRoot.position.y = assistantBaseY;
        live.assistantRoot.rotation.y = animationState === "alert" ? jitter * 0.12 : 0;
        live.assistantRoot.rotation.x = 0;
        live.assistantRoot.position.z = desktopPreviewActive ? DESKTOP_STAGE_LAYOUT.assistantZ : STAGE_DEPTH;
        live.platform.material.opacity = 0.12 + Math.max(0, Math.sin(elapsed * 2.8)) * 0.08;
        live.auraRing.visible = !desktopPreviewActive && live.sceneMode !== SessionMode.ImmersiveAR;
        live.auraShell.visible = !desktopPreviewActive;
        live.beacon.visible = !desktopPreviewActive;
        live.auraRing.scale.setScalar(1 + Math.sin(elapsed * motion.ringSpeed) * motion.ringPulse);
        live.auraRing.rotation.z += delta * (0.12 + motion.ringSpeed * 0.03);
        live.auraRing.material.opacity =
          motion.ringOpacity + Math.max(0, Math.sin(elapsed * motion.ringSpeed)) * 0.08;
        live.auraShell.scale.setScalar(
          1.02 + Math.max(0, Math.sin(elapsed * motion.shellSpeed)) * motion.shellPulse,
        );
        live.auraShell.material.opacity =
          motion.shellOpacity + Math.max(0, Math.sin(elapsed * motion.shellSpeed)) * 0.08;
        live.beacon.scale.setScalar(
          1 + Math.max(0, Math.sin(elapsed * motion.beaconSpeed)) * motion.beaconPulse,
        );
        live.beacon.material.emissiveIntensity =
          motion.beaconIntensity + Math.max(0, Math.sin(elapsed * motion.beaconSpeed)) * 0.8;
        live.camera.getWorldPosition(live.lookTarget.position);
        live.lookTarget.position.y = Math.max(live.lookTarget.position.y, 1.35);

        live.fillLight.color.setHex(accent);
        live.fillLight.intensity = motion.lightIntensity;
        live.auraRing.material.color.setHex(accent);
        live.auraRing.material.emissive.setHex(stateAccentColor);
        live.auraShell.material.color.setHex(stateAccentColor);
        live.auraShell.material.emissive.setHex(stateAccentColor);
        live.beacon.material.emissive.setHex(stateAccentColor);

        if (live.fallbackRig.group.visible) {
          live.fallbackRig.head.rotation.z = Math.sin(elapsed * 1.9) * motion.headTilt;
          live.fallbackRig.head.rotation.y = Math.sin(elapsed * (animationState === "speaking" ? 3.6 : 1.6)) * motion.shoulderRoll;
          live.fallbackRig.head.position.y = 1.38 + Math.max(0, Math.sin(elapsed * motion.bobSpeed * 1.4)) * 0.03;
          live.fallbackRig.body.scale.y = 1 + Math.max(0, Math.sin(elapsed * 1.8)) * 0.04;
          live.fallbackRig.body.rotation.z = Math.sin(elapsed * 1.2) * motion.shoulderRoll;
          live.fallbackRig.core.scale.setScalar(
            1 + Math.max(0, Math.sin(elapsed * motion.beaconSpeed)) * Math.max(motion.beaconPulse, 0.12),
          );
          live.fallbackRig.core.material.emissive.setHex(stateAccentColor);
          live.fallbackRig.head.material.emissive.setHex(stateAccentColor);
          live.fallbackRig.body.material.emissive.setHex(accent);
        }

        if (live.avatarScene && !live.fallbackRig.group.visible) {
          live.avatarScene.rotation.z = 0;
          live.avatarScene.rotation.x = 0;
          live.avatarScene.position.y = 0;
          const basePresenceScale =
            typeof live.avatarScene.userData.basePresenceScale === "number"
              ? live.avatarScene.userData.basePresenceScale
              : 1;
          live.avatarScene.position.z = desktopPreviewActive ? DESKTOP_STAGE_LAYOUT.avatarZOffset : 0;
          live.avatarScene.scale.setScalar(
            basePresenceScale * (desktopPreviewActive ? DESKTOP_STAGE_LAYOUT.avatarScaleBoost : 1),
          );
        }

        if (live.avatarAnimations && !live.fallbackRig.group.visible) {
          setAvatarClipState(live.avatarAnimations, clipState);
          live.avatarAnimations.mixer.update(delta);
        }

        if (live.avatarMorphs && !live.fallbackRig.group.visible) {
          updateSceneMorphs(
            live.avatarMorphs,
            animationState,
            elapsed,
            speechSpeakingRef.current,
            speechPulseRef.current,
          );
        }

        if (live.vrm) {
          updateExpressions(
            live.vrm,
            animationState,
            elapsed,
            speechSpeakingRef.current,
            speechPulseRef.current,
          );
          if (live.vrm.lookAt) {
            live.vrm.lookAt.target = live.lookTarget;
          }
          live.vrm.update(delta);
        }

        if (live.avatarRig && !live.avatarAnimations && !live.fallbackRig.group.visible) {
          applyAvatarRigPose(live.avatarRig, animationState, elapsed, speechSpeakingRef.current);
        }

        live.renderer.render(live.scene, live.camera);
      };

      renderer.setAnimationLoop(animate);

      resizeObserver = new ResizeObserver(() => {
        if (!runtimeRef.current) {
          return;
        }
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(host.clientHeight, 1);
        runtimeRef.current.camera.aspect = width / height;
        runtimeRef.current.camera.updateProjectionMatrix();
        runtimeRef.current.renderer.setSize(width, height);
      });
      resizeObserver.observe(host);
    };

    void bootWorld();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      const activeRuntime = runtimeRef.current;
      const activeSession = xrSessionRef.current;
      const sessionEndHandler = xrSessionEndHandlerRef.current;
      if (activeSession && sessionEndHandler) {
        activeSession.removeEventListener("end", sessionEndHandler);
      }
      xrSessionRef.current = null;
      xrSessionEndHandlerRef.current = null;
      if (activeRuntime) {
        activeRuntime.world.exitXR();
        activeRuntime.renderer.setAnimationLoop(null);
        if (handleContextLost) {
          activeRuntime.renderer.domElement.removeEventListener("webglcontextlost", handleContextLost, false);
        }
        if (handleContextRestored) {
          activeRuntime.renderer.domElement.removeEventListener("webglcontextrestored", handleContextRestored, false);
        }
        Object.values(activeRuntime.panels).forEach((panel) => {
          disposeObjectTree(panel.mesh);
        });
        disposeObjectTree(activeRuntime.floor);
        disposeObjectTree(activeRuntime.platform);
        disposeObjectTree(activeRuntime.assistantRoot);
        disposeObjectTree(activeRuntime.auraRing);
        disposeObjectTree(activeRuntime.auraShell);
        disposeObjectTree(activeRuntime.beacon);
        activeRuntime.renderer.dispose();
      }
      runtimeRef.current = null;
      host.replaceChildren();
    };
  }, [stageGeneration]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    drawPanel(runtime.panels.summary, {
      eyebrow: "Manager board",
      title: leadSession?.waitingOnUser ? "Decision needed" : title,
      body: buildDecisionBoard(leadSession, sessions),
      tone: leadSession?.waitingOnUser ? "attention" : tone,
    });

    drawPanel(runtime.panels.worker, {
      eyebrow: "Worker board",
      title:
        leadSession?.workerLabel ??
        `${sessions.length} live worker${sessions.length === 1 ? "" : "s"}`,
      body: buildWorkerBoard(leadSession, sessions),
      tone:
        leadSession?.waitingOnUser
          ? "attention"
          : sessions.some((session) => session.workerPhase === "blocked" || session.status === "failed")
            ? "attention"
            : tone,
    });

    drawPanel(runtime.panels.status, {
      eyebrow: "Next action",
      title: leadSession?.waitingOnUser ? "Reply through Hermes" : "Next move",
      body: buildActionBoard(leadSession, sessions, xrState, avatarStatus),
      tone:
        leadSession?.waitingOnUser
          ? "attention"
          : sessions.some((session) => session.workerPhase === "blocked" || session.status === "failed")
            ? "attention"
            : tone,
    });

    runtime.auraRing.material.color.setHex(toneColor(tone));
    runtime.auraRing.material.emissive.setHex(stateAccent(characterState));
    runtime.auraShell.material.color.setHex(stateAccent(characterState));
    runtime.auraShell.material.emissive.setHex(stateAccent(characterState));
    runtime.beacon.material.emissive.setHex(stateAccent(characterState));
  }, [avatarStatus, characterState, leadSession, latestSummary, sessions, subtitle, title, tone, xrState]);

  const xrButtonLabel =
    xrState === "entering"
      ? "Entering XR..."
      : xrState === "active"
        ? "XR Session Live"
        : xrState === "failed" || xrState === "unsupported"
          ? "Recheck XR"
          : xrState === "checking"
            ? "Checking XR..."
            : "Enter XR on Quest";
  const xrButtonDisabled =
    Boolean(stageError) || xrState === "checking" || xrState === "entering" || xrState === "active";
  const xrCardTone =
    stageError || xrState === "failed"
      ? "is-error"
      : xrState === "unsupported"
        ? "is-warning"
        : xrState === "active" || xrState === "ready"
          ? "is-good"
          : "";
  const avatarCardTone = avatarStatus === "ready" ? "is-good" : avatarStatus === "fallback" ? "is-warning" : "";
  const pendingSessions = sessions.filter((session) => session.waitingOnUser);
  const blockedSessions = sessions.filter(
    (session) => session.workerPhase === "blocked" || session.status === "failed",
  );
  const reviewSessions = sessions.filter((session) => session.needsReview);
  const stageAnimationState = deriveAnimationState(characterState, avatarMode, speechSpeaking);
  const speechPulseAgeMs = speechPulseAt > 0 ? Math.max(0, Date.now() - speechPulseAt) : null;
  const decisionFocus =
    leadSession?.pendingQuestion ??
    leadSession?.managerSummary ??
    latestSummary;
  const focusWorker = leadSession ?? blockedSessions[0] ?? sessions[0];
  const showStageDebug = stageDebugEnabled();

  return (
    <div className="presence-stage presence-stage-immersive">
      <div ref={hostRef} className="immersive-stage-canvas" />
      <div className="immersive-stage-overlay">
        <div className="immersive-stage-copy">
          <p className="eyebrow">Quest XR Stage</p>
          <h2>Yuki leads. Workers stay readable.</h2>
          <p>
            Hermes still manages the workers and decisions. This stage keeps the live worker board, next action, and
            approval context visible around Yuki instead of burying them in tiny status copy.
          </p>
        </div>
        <div className="immersive-stage-status-stack">
          {showStageDebug ? (
            <div className="immersive-stage-status-card immersive-stage-debug-card">
              <p className="eyebrow">Stage Debug</p>
              <div className="immersive-debug-grid">
                <span>Animation</span>
                <strong>{stageAnimationState}</strong>
                <span>Hermes mode</span>
                <strong>{avatarMode}</strong>
                <span>Speech</span>
                <strong>{speechSpeaking ? "active" : "idle"}</strong>
                <span>Pulse age</span>
                <strong>{speechPulseAgeMs === null ? "none" : `${speechPulseAgeMs} ms`}</strong>
                <span>Focus</span>
                <strong>{focusWorker?.workerLabel ?? "none"}</strong>
              </div>
              {latestTranscript ? (
                <p className="immersive-debug-transcript">
                  Heard: {compactText(latestTranscript, "No transcript yet.", 96)}
                </p>
              ) : (
                <p className="immersive-debug-transcript">Heard: No transcript yet.</p>
              )}
              <p>{animationFeedback(stageAnimationState)}</p>
            </div>
          ) : null}
          <div className="immersive-stage-status-card">
            <p className="eyebrow">Decision Queue</p>
            <strong>
              {pendingSessions.length} pending · {blockedSessions.length} blocked · {reviewSessions.length} review
            </strong>
            <p>{compactText(decisionFocus, "No worker decision is waiting right now.", 150)}</p>
          </div>
          <div className="immersive-stage-status-card">
            <p className="eyebrow">Worker Focus</p>
            <strong>{focusWorker?.workerLabel ?? `${sessions.length} live worker${sessions.length === 1 ? "" : "s"}`}</strong>
            <p>
              {focusWorker
                ? compactText(
                    `${normalizeWorkerStatus(focusWorker)} · ${
                      focusWorker.taskTitle ?? focusWorker.lastUpdate ?? focusWorker.managerSummary ?? "No live task summary yet."
                    }`,
                    "No live worker focus yet.",
                    150,
                  )
                : buildWorkerSummary(sessions)}
            </p>
          </div>
          <div className={`immersive-stage-status-card ${avatarCardTone}`}>
            <p className="eyebrow">Avatar Runtime</p>
            <strong>{avatarStatusTitle(avatarStatus)}</strong>
            <p>{avatarMessage}</p>
          </div>
          <div className={`immersive-stage-status-card ${xrCardTone}`}>
            <p className="eyebrow">XR Entry</p>
            <strong>{xrStatusTitle(xrState)}</strong>
            <p>{stageError ?? xrMessage}</p>
            <div className="xr-button-slot">
              <button
                type="button"
                className="quest-xr-button"
                disabled={xrButtonDisabled}
                onClick={() => {
                  void enterXR();
                }}
              >
                {xrButtonLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
